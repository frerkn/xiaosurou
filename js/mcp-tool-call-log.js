// MCP 工具调用日志 — 监听所有 onCard, inline 渲染简洁文字行
// 紧跟最后一条 AI 消息后面, 每调一次工具追加一行
// 覆盖所有通用 MCP (不限 mcd/luckin/amap), 证明 AI 真调了工具
//
// 设计: 跟 mcp-menu-card / mcp-pay-card 共存, 都用 McpBridge.onCard
// 这三个独立, 互不重复:
//   mcp-menu-card    → 菜单大卡片 (query-meals / searchProductForMcp 等)
//   mcp-pay-card     → 支付链接卡片 (create-order / createOrder)
//   mcp-tool-call-log → 文字行日志 (所有工具调用, 含上面两个)
//
// 用户体验:
//   [AI: 我帮你查下附近麦当劳 + 看看菜单]
//     🔧 query-nearby-stores · 5 家店
//     🔧 query-meals · 14 分类 116 餐品
//   [菜单卡片]
//   [AI: 帮您下好啦, 扫这个码]
//     🔧 create-order · 订单 MCD20260802
//   [支付卡片]
//
// 持久化 (v0.1.70):
//   - 写: onCard 时同时 push 到 chat.mcpToolLogs + db.chats.put(chat)
//   - 读: MutationObserver 监控 #chat-messages, 容器有 childList 变化就重渲染历史 log
//   - 锚点: 每条 log 记 afterMsgTs (= 当时最近一条 assistant 消息 timestamp)
//           重新渲染时用这个 ts 找目标气泡, 插在它后面
//   - 字段: { ts, afterMsgTs, toolName, aiName, summary, success }
//   - 重复跳过: 渲染时检查 DOM .mcp-tool-log-line[data-ts], 已存在则跳过

(function (global) {
    'use strict';

    // ========== 拿当前 AI 角色名 (多路径尝试 + 兜底 "AI") ==========
    // 关键字段: chat.originalName (聊天设置页"对方本名 (AI识别用)"输入框, modules/init-event-bindingsA.js:4142 存)
    function getCurrentAIName() {
        try {
            const st = (typeof window !== 'undefined' ? window : global).state;
            if (!st) return 'AI';
            const activeId = st.activeChatId;
            if (activeId && st.chats && st.chats[activeId]) {
                const chat = st.chats[activeId];
                if (chat.originalName) return String(chat.originalName);
            }
            if (st.currentChat && st.currentChat.originalName) {
                return String(st.currentChat.originalName);
            }
            if (typeof document !== 'undefined') {
                const input = document.getElementById('ai-original-name-input');
                if (input && input.value && input.value.trim()) return input.value.trim();
            }
        } catch (e) { /* 静默 */ }
        return 'AI';
    }

    // ========== 摘要生成: 从 result.data 抽关键信息 ==========
    function summarizeResult(toolName, data) {
        if (!data || typeof data !== 'object') {
            if (typeof data === 'string') return data.slice(0, 40);
            if (typeof data === 'number') return String(data);
            return '';
        }
        const arrayKeys = ['pois', 'stores', 'meals', 'items', 'products', 'results',
            'coupons', 'addresses', 'orders', 'forecasts', 'lives', 'casts',
            'geocodes', 'routes', 'paths'];
        for (let i = 0; i < arrayKeys.length; i++) {
            const k = arrayKeys[i];
            if (Array.isArray(data[k]) && data[k].length) {
                let extra = '';
                if (k === 'pois' && data.count) extra = ' (共 ' + data.count + ')';
                if (k === 'meals') extra = ' (' + data[k].length + ' 项)';
                if (k === 'geocodes') extra = ' (地址候选)';
                return data[k].length + ' 项' + extra;
            }
        }
        if (Array.isArray(data.categories)) {
            let totalItems = 0;
            for (let i = 0; i < data.categories.length; i++) {
                const cat = data.categories[i];
                if (cat && Array.isArray(cat.items)) totalItems += cat.items.length;
            }
            if (totalItems) return data.categories.length + ' 分类 ' + totalItems + ' 餐品';
        }
        const numberKeys = [
            { k: 'count', prefix: '共 ' },
            { k: 'amount', prefix: '¥' },
            { k: 'realAmount', prefix: '¥' },
            { k: 'totalAmount', prefix: '¥' },
            { k: 'discountPrice', prefix: '¥' },
            { k: 'distance', prefix: '', suffix: 'm' },
            { k: 'duration', prefix: '', suffix: 's' },
        ];
        for (let i = 0; i < numberKeys.length; i++) {
            const { k, prefix, suffix } = numberKeys[i];
            if (typeof data[k] === 'number') {
                return prefix + data[k] + (suffix || '');
            }
        }
        if (data.orderId || data.orderNo) {
            return '订单 ' + (data.orderId || data.orderNo);
        }
        if (data.status && typeof data.status === 'string') {
            return '状态: ' + data.status;
        }
        const keys = Object.keys(data);
        if (keys.length <= 3) {
            return keys.map(function (k) {
                const v = data[k];
                if (typeof v === 'string') return v.slice(0, 20);
                if (typeof v === 'number') return String(v);
                return '';
            }).filter(Boolean).join(' / ');
        }
        return keys.length + ' 字段';
    }

    // ========== 工具函数 ==========
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ========== 渲染单行 DOM (网易云切歌提示风格) ==========
    // 接受规范化后的 log 数据 (从历史或新 card 都能渲染)
    function renderLogLineFromData(log) {
        const toolName = log.toolName || '';
        const aiName = log.aiName || 'AI';
        let verb = '调用了';
        let summary = log.summary || '';
        let cls = 'mcp-tool-log-line';

        if (log.success === false) {
            verb = '调用失败';
            if (!summary) summary = '失败';
            cls += ' mcp-tool-log-err';
        } else if (log.success === true) {
            // summary 已经有
        } else {
            verb = '调用中';
            summary = '';
        }

        const line = document.createElement('div');
        line.className = cls;
        line.setAttribute('data-tool', toolName);
        line.setAttribute('data-ts', String(log.ts || Date.now()));

        const summaryHtml = summary
            ? ' · <span class="mcp-tool-log-summary">' + escapeHtml(summary) + '</span>'
            : '';
        line.innerHTML =
            '<span class="mcp-tool-log-name">' + escapeHtml(aiName) + '</span>' +
            '<span class="mcp-tool-log-verb"> ' + escapeHtml(verb) + ' </span>' +
            '<span class="mcp-tool-log-tool">' + escapeHtml(toolName) + '</span>' +
            summaryHtml;

        return line;
    }

    // ========== 渲染单行 (从 card 对象, 给 onCard 实时调用) ==========
    function renderLogLine(card) {
        const result = card && card.result;
        const toolName = card.toolName || '';
        const aiName = getCurrentAIName();
        let success;
        let summary = '';

        if (!result) {
            success = null;
        } else if (result.success === false) {
            success = false;
            summary = (result.error || '失败').slice(0, 60);
        } else if (result.success === true) {
            success = true;
            summary = summarizeResult(toolName, result.data);
        } else {
            success = null;
        }

        return renderLogLineFromData({
            ts: card.ts || Date.now(),
            toolName: toolName,
            aiName: aiName,
            summary: summary,
            success: success,
        });
    }

    // ========== 找最近一条 assistant 消息气泡的 timestamp (作为 log 锚点) ==========
    function findLastAssistantTimestamp(chat) {
        if (!chat || !Array.isArray(chat.history)) return null;
        // 倒序找最近一条 role==='assistant' 的消息
        for (let i = chat.history.length - 1; i >= 0; i--) {
            const m = chat.history[i];
            if (m && m.role === 'assistant' && m.timestamp) return m.timestamp;
        }
        return null;
    }

    // ========== DOM 工具 ==========
    function getChatContainer() {
        return document.getElementById('chat-messages');
    }

    // 找 timestamp 等于 ts 的消息气泡 (chat-interface.js:690-693 bubble.dataset.timestamp = msg.timestamp)
    function findBubbleByTimestamp(container, ts) {
        if (!container || ts == null) return null;
        // 优先 .message-bubble[data-timestamp]
        let el = container.querySelector('.message-bubble[data-timestamp="' + ts + '"]');
        if (el) return el;
        // 兜底: wrapper 也可能带 timestamp
        el = container.querySelector('.message-wrapper[data-timestamp="' + ts + '"]');
        if (el) {
            const bubble = el.querySelector('.message-bubble');
            if (bubble) return bubble;
            return el;
        }
        return null;
    }

    // 找 timestamp 之前的最近一条消息气泡 (找不到精确匹配时的兜底)
    function findNearestBubbleBefore(container, ts) {
        if (!container || ts == null) return null;
        const bubbles = container.querySelectorAll('.message-bubble[data-timestamp]');
        let nearest = null;
        for (let i = 0; i < bubbles.length; i++) {
            const t = Number(bubbles[i].getAttribute('data-timestamp'));
            if (t <= ts) nearest = bubbles[i];
            else break;
        }
        return nearest;
    }

    // 把 lineEl 插到 bubble 后面 (group 复用逻辑)
    function insertLogAfterBubble(bubble, lineEl) {
        if (!bubble) {
            const container = getChatContainer();
            if (container) container.appendChild(lineEl);
            return;
        }
        // 优先找已有的 .mcp-tool-log-group 紧跟在 bubble 之后, 有就追加
        const wrapper = bubble.closest('.message-wrapper') || bubble.parentNode;
        if (wrapper && wrapper.parentNode) {
            // 找 wrapper 后面第一个 .mcp-tool-log-group
            let group = wrapper.nextElementSibling;
            while (group && !group.classList.contains('mcp-tool-log-group')) {
                group = group.nextElementSibling;
            }
            if (group) {
                group.appendChild(lineEl);
                return;
            }
            // 没有就新建一个 group, 插到 wrapper 后面
            const newGroup = document.createElement('div');
            newGroup.className = 'mcp-tool-log-group';
            newGroup.appendChild(lineEl);
            wrapper.parentNode.insertBefore(newGroup, wrapper.nextSibling);
        } else {
            bubble.parentNode.insertBefore(lineEl, bubble.nextSibling);
        }
    }

    // ========== 找最近一条 AI 消息气泡, 紧跟其后追加日志行 (实时用) ==========
    function appendAfterLastMessage(lineEl) {
        const bubbles = document.querySelectorAll('.message-bubble[data-timestamp]');
        const lastBubble = bubbles[bubbles.length - 1];
        if (!lastBubble) {
            const chatArea = document.querySelector('.chat-area, .chat-messages, .messages') || document.body;
            chatArea.appendChild(lineEl);
            return;
        }
        const allGroups = document.querySelectorAll('.mcp-tool-log-group');
        if (allGroups.length > 0) {
            const lastGroup = allGroups[allGroups.length - 1];
            const pos = lastBubble.compareDocumentPosition(lastGroup);
            if (pos & 4) { // DOCUMENT_POSITION_FOLLOWING
                lastGroup.appendChild(lineEl);
                scrollChatToBottom();
                return;
            }
        }
        const wrapper = lastBubble.closest('.message-wrapper') || lastBubble.parentNode;
        if (wrapper && wrapper.parentNode) {
            const group = document.createElement('div');
            group.className = 'mcp-tool-log-group';
            group.appendChild(lineEl);
            wrapper.parentNode.insertBefore(group, wrapper.nextSibling);
        } else {
            lastBubble.parentNode.insertBefore(lineEl, lastBubble.nextSibling);
        }
        scrollChatToBottom();
    }

    function scrollChatToBottom() {
        const scroller = document.querySelector('.chat-area, .chat-messages, .messages, .chat-scroll');
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }

    // ========== 历史 log 重渲染 (持久化恢复) ==========
    // chat.mcpToolLogs 里的每条 log, 按 afterMsgTs 找对应气泡插入
    // 已存在 (data-ts 重复) 的跳过
    function renderHistoricalLogs(chatId) {
        const st = (typeof window !== 'undefined' ? window : global).state;
        if (!st || !chatId) return 0;
        const chat = st.chats && st.chats[chatId];
        if (!chat || !Array.isArray(chat.mcpToolLogs) || !chat.mcpToolLogs.length) return 0;
        const container = getChatContainer();
        if (!container) return 0;

        // 收集已渲染的 ts
        const existingTs = new Set();
        const existingLines = document.querySelectorAll('.mcp-tool-log-line');
        existingLines.forEach(function (el) {
            const ts = el.getAttribute('data-ts');
            if (ts) existingTs.add(String(ts));
        });

        // 按 ts 升序
        const sorted = chat.mcpToolLogs.slice().sort(function (a, b) {
            return (a.ts || 0) - (b.ts || 0);
        });

        let rendered = 0;
        for (let i = 0; i < sorted.length; i++) {
            const log = sorted[i];
            const ts = String(log.ts || '');
            if (!ts || existingTs.has(ts)) continue;
            // 找锚点气泡
            let bubble = findBubbleByTimestamp(container, log.afterMsgTs);
            if (!bubble) {
                bubble = findNearestBubbleBefore(container, log.afterMsgTs);
            }
            const line = renderLogLineFromData(log);
            insertLogAfterBubble(bubble, line);
            existingTs.add(ts);
            rendered++;
        }
        return rendered;
    }

    // ========== 写入持久化 (Dexie / IndexedDB) ==========
    function persistLog(chat, logEntry) {
        if (!chat || !logEntry) return;
        try {
            if (!Array.isArray(chat.mcpToolLogs)) chat.mcpToolLogs = [];
            chat.mcpToolLogs.push(logEntry);
            // 写库 (window.db 是 init-db-schema.js 暴露的 Dexie 实例)
            if (typeof window !== 'undefined' && window.db && window.db.chats) {
                window.db.chats.put(chat).catch(function (err) {
                    console.warn('[McpToolLog] persist failed:', err);
                });
            }
        } catch (e) {
            console.warn('[McpToolLog] persist error:', e);
        }
    }

    // ========== 实时 card 处理 (实时 DOM 渲染 + 持久化) ==========
    function onCard(card) {
        if (!card || !card.toolName) return;
        try {
            const st = (typeof window !== 'undefined' ? window : global).state;
            const line = renderLogLine(card);
            requestAnimationFrame(function () { appendAfterLastMessage(line); });

            // 持久化
            if (st && st.activeChatId && st.chats && st.chats[st.activeChatId]) {
                const chat = st.chats[st.activeChatId];
                const result = card.result;
                let success;
                let summary = '';
                if (!result) {
                    success = null;
                } else if (result.success === false) {
                    success = false;
                    summary = (result.error || '失败').slice(0, 60);
                } else if (result.success === true) {
                    success = true;
                    summary = summarizeResult(card.toolName, result.data);
                }
                persistLog(chat, {
                    ts: card.ts || Date.now(),
                    afterMsgTs: findLastAssistantTimestamp(chat),
                    toolName: card.toolName,
                    aiName: getCurrentAIName(),
                    summary: summary,
                    success: success,
                });
            }
        } catch (e) {
            console.warn('[McpToolLog] 渲染失败:', e);
        }
    }

    // ========== DOM 监控: chat-messages 子节点变化时重渲染历史 log ==========
    // 切聊天 / appendMessage / loadMore 都会触发, 我们做幂等 (按 ts 跳过已渲染)
    let observerInstalled = false;
    let renderTimer = null;
    function installHistoryObserver() {
        if (observerInstalled) return;
        if (typeof document === 'undefined') return;
        const container = getChatContainer();
        if (!container) {
            // 容器还没准备好, 重试
            setTimeout(installHistoryObserver, 500);
            return;
        }
        observerInstalled = true;
        const observer = new MutationObserver(function (mutations) {
            // 只关心 childList 变化 (有添加子节点, 通常是 330 渲染消息)
            let hasAdded = false;
            for (let i = 0; i < mutations.length; i++) {
                if (mutations[i].type === 'childList' && mutations[i].addedNodes.length > 0) {
                    hasAdded = true;
                    break;
                }
            }
            if (!hasAdded) return;
            // debounce 100ms, 让 330 渲染完再处理
            if (renderTimer) clearTimeout(renderTimer);
            renderTimer = setTimeout(function () {
                const st = (typeof window !== 'undefined' ? window : global).state;
                if (!st || !st.activeChatId) return;
                const n = renderHistoricalLogs(st.activeChatId);
                if (n > 0) {
                    // 仅调试时输出
                    // console.log('[McpToolLog] 渲染了 ' + n + ' 条历史 log');
                }
            }, 100);
        });
        observer.observe(container, { childList: true, subtree: false });
        console.log('[McpToolLog] DOM observer 已安装 (chat-messages 变化 → 重渲染历史 log)');
    }

    // ========== 初始化 ==========
    if (global.McpBridge && typeof global.McpBridge.onCard === 'function') {
        global.McpBridge.onCard(onCard);
        console.log('[McpToolLog] 已注册 card listener, 监听所有 MCP 工具调用 (覆盖 mcd/luckin/amap/任意通用 MCP)');
        // 启动 DOM 观察, 切聊天/loadMore 时恢复历史 log
        installHistoryObserver();
    } else {
        console.warn('[McpToolLog] McpBridge not loaded, skip init');
    }

})(typeof window !== 'undefined' ? window : globalThis);
