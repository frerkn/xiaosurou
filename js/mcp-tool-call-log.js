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
            // 2026-08-20 v0.2.30.8: 找不到 anchor 时不渲染
            // 修前 (v0.2.30.6/7): 包 group 插到 typingIndicator 之前 → log 全部堆在 chat-messages 底部
            //                     user 反馈"密密麻麻堆在底部, 不能跟随气泡, 切 chat 回来又堆"
            // 修后: 找不到 anchor = 这条 log 失去"主" = 不显示
            //       跟"调了工具自然跟随"的用户期望一致 (找不到主就别显示, 别乱堆)
            //       用户可以单独删除遗留的 log (见 attachLogGroupDeleteHandler)
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
            attachLogGroupDeleteHandler(newGroup, lineEl);  // v0.2.30.8: 绑删除
            wrapper.parentNode.insertBefore(newGroup, wrapper.nextSibling);
        } else {
            bubble.parentNode.insertBefore(lineEl, bubble.nextSibling);
        }
    }

    // ========== 单条 log 删除 (v0.2.30.8 加) ==========
    // user 反馈"必须清空聊天记录才能删 log 太麻烦, 想要单独删除"
    // 修法: group 加 data-ts + click handler, 弹 confirm 后删 DOM + 删 chat.mcpToolLogs 同步到 IndexedDB
    function attachLogGroupDeleteHandler(group, lineEl) {
        const ts = lineEl.getAttribute('data-ts');
        if (ts) group.setAttribute('data-ts', ts);
        group.addEventListener('click', function (e) {
            // 不阻断冒泡 (group 是 message-bubble 的兄弟节点, 点击 group 不应触发 chat-area 的其他逻辑)
            if (typeof showCustomConfirm === 'function') {
                showCustomConfirm('删除工具调用记录', '确定要删除这条「' + (lineEl.getAttribute('data-tool') || '工具') + '」调用记录吗？', {
                    confirmButtonClass: 'btn-danger',
                    confirmText: '删除'
                }).then(function (confirmed) {
                    if (!confirmed) return;
                    deleteLogGroupByTs(Number(group.getAttribute('data-ts')));
                });
            } else if (window.confirm('确定要删除这条工具调用记录吗？')) {
                deleteLogGroupByTs(Number(group.getAttribute('data-ts')));
            }
        });
    }

    function deleteLogGroupByTs(ts) {
        if (!ts) return;
        // 1. 删 DOM (删 group 即可, lineEl 跟着被删)
        const lineEl = document.querySelector('.mcp-tool-log-line[data-ts="' + ts + '"]');
        if (lineEl) {
            const group = lineEl.closest('.mcp-tool-log-group');
            if (group) group.remove();
        }
        // 2. 删 chat.mcpToolLogs 里对应记录 + 同步到 IndexedDB
        const st = (typeof window !== 'undefined' ? window : global).state;
        if (!st || !st.activeChatId || !st.chats) return;
        const chat = st.chats[st.activeChatId];
        if (!chat || !Array.isArray(chat.mcpToolLogs)) return;
        const idx = chat.mcpToolLogs.findIndex(function (l) { return l && l.ts === ts; });
        if (idx >= 0) {
            chat.mcpToolLogs.splice(idx, 1);
            if (typeof window !== 'undefined' && window.db && window.db.chats) {
                window.db.chats.put(chat).catch(function (err) {
                    console.warn('[McpToolLog] persist failed:', err);
                });
            }
            console.log('[McpToolLog] 已删除 ts=' + ts + ' 的 log, 剩余 ' + chat.mcpToolLogs.length + ' 条');
        } else {
            console.log('[McpToolLog] ts=' + ts + ' 不在 mcpToolLogs 里 (可能已被其他路径清掉), 只删 DOM');
        }
    }

    // ========== 找最近一条 AI 消息气泡, 紧跟其后追加日志行 (实时用) ==========
    function appendAfterLastMessage(lineEl) {
        const container = getChatContainer();
        if (!container) return;
        // 限定在 chat-messages 容器内查气泡 (避免拿到 watch-together 等其他容器)
        const bubbles = container.querySelectorAll('.message-bubble[data-timestamp]');
        const lastBubble = bubbles[bubbles.length - 1];
        if (!lastBubble) {
            // 2026-08-18 v0.2.30.6: 找不到 lastBubble 时也要包 group
            // 修复前: 直接 insertBefore/appendChild lineEl, lineEl 散在 chat-messages 里
            // 修复后: 包成 .mcp-tool-log-group div 再插入
            const typingIndicator = container.querySelector('#typing-indicator');
            const group = document.createElement('div');
            group.className = 'mcp-tool-log-group';
            group.appendChild(lineEl);
            attachLogGroupDeleteHandler(group, lineEl);  // v0.2.30.8: 绑删除
            if (typingIndicator) {
                container.insertBefore(group, typingIndicator);
            } else {
                container.appendChild(group);
            }
            return;
        }
        // 限定在 chat-messages 容器内查 group
        const allGroups = container.querySelectorAll('.mcp-tool-log-group');
        if (allGroups.length > 0) {
            const lastGroup = allGroups[allGroups.length - 1];
            const pos = lastBubble.compareDocumentPosition(lastGroup);
            if (pos & 4) { // DOCUMENT_POSITION_FOLLOWING
                lastGroup.appendChild(lineEl);
                return;
            }
        }
        const wrapper = lastBubble.closest('.message-wrapper') || lastBubble.parentNode;
        if (wrapper && wrapper.parentNode) {
            const group = document.createElement('div');
            group.className = 'mcp-tool-log-group';
            group.appendChild(lineEl);
            attachLogGroupDeleteHandler(group, lineEl);  // v0.2.30.8: 绑删除
            wrapper.parentNode.insertBefore(group, wrapper.nextSibling);
        } else {
            lastBubble.parentNode.insertBefore(lineEl, lastBubble.nextSibling);
        }
        // 2026-08-08 v0.1.78: 删 scrollChatToBottom() 调用
        // 原因: 330 appendMessage 自己会 messagesContainer.scrollTop = scrollHeight 滚到底,
        //       我多调反而跟 330 滚动逻辑冲突, 可能搞乱时序
        //       (之前用 .chat-area/.chat-messages/.messages 类名选择器, 都不存在, 啥也不做, 但保留调用是隐患)
    }

    // ========== 历史 log 重渲染 (持久化恢复) ==========
    // chat.mcpToolLogs 里的每条 log, 按 afterMsgTs 找对应气泡插入
    // 已存在 (data-ts 重复) 的跳过
    function renderHistoricalLogs(chatId) {
        const st = (typeof window !== 'undefined' ? window : global).state;
        if (!st || !chatId) return 0;
        const chat = st.chats && st.chats[chatId];
        if (!chat || !Array.isArray(chat.mcpToolLogs) || !chat.mcpToolLogs.length) return 0;
        // 2026-08-18 v0.2.30.7 兑底: chat.history 为空时 (用户清空了聊天记录) 也清掉 mcpToolLogs
        // 原因: 之前 floating-ball.js handleQuickClearChatHistory 清空路径漏了 mcpToolLogs
        // (data-management.js 那个路径有清), 修 5a 修了这个路径
        // 但还有其他清空路径 (多选删除 / 单条删除 / 数据导入 等) 可能也漏, 防御性处理
        if (!Array.isArray(chat.history) || chat.history.length === 0) {
            console.log('[McpToolLog] chat.history 为空, 清掉残留的 ' + chat.mcpToolLogs.length + ' 条 mcpToolLogs');
            chat.mcpToolLogs = [];
            // 持久化到 IndexedDB (跟 persistLog 行为一致)
            if (typeof window !== 'undefined' && window.db && window.db.chats) {
                window.db.chats.put(chat).catch(function (err) {
                    console.warn('[McpToolLog] persist failed:', err);
                });
            }
            return 0;
        }
        const container = getChatContainer();
        if (!container) return 0;

        // 收集已渲染的 ts (限定在 chat-messages 容器, 避免拿到 watch-together 等其他容器)
        const existingTs = new Set();
        const existingLines = container.querySelectorAll('.mcp-tool-log-line');
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

    // ========== 启动时清理老错位 group ==========
    // 2026-08-09 v0.2.04: 之前 v0.1.70 ~ v0.2.03 的 bug 让 group 偶尔被插到 body 末尾 / watch-together 容器
    // 硬刷不会自动清这些老错位 group, 残留撑高外层, 影响滚动布局
    // 启动时: 找不在 chat-messages 容器里的 .mcp-tool-log-group, 全 remove
    function cleanupMisplacedGroups() {
        const container = getChatContainer();
        if (!container) return 0;
        // 全局查所有 group
        const allGroups = document.querySelectorAll('.mcp-tool-log-group');
        let removed = 0;
        for (let i = 0; i < allGroups.length; i++) {
            const g = allGroups[i];
            // 在 chat-messages 容器内? (用 _contains 模式: 向上走 parent 链遇到 container)
            let cur = g.parentNode;
            let inContainer = false;
            while (cur) {
                if (cur === container) { inContainer = true; break; }
                cur = cur.parentNode;
            }
            if (!inContainer) {
                console.warn('[McpToolLog] 清理老错位 group (不在 chat-messages 内):', g);
                g.remove();
                removed++;
            }
        }
        if (removed > 0) {
            console.log('[McpToolLog] 清理了 ' + removed + ' 个老错位 group');
        }
        return removed;
    }

    // ========== 启动时清理孤儿 lineEl (v0.2.30.6 加) ==========
    // 之前 v0.1.70 ~ v0.2.30.5 的 bug: insertLogAfterBubble / appendAfterLastMessage 在
    // 找不到 anchor (bubble/lastBubble) 时直接 container.appendChild(lineEl), lineEl 没包
    // 成 .mcp-tool-log-group, 跟 message-wrapper 平级散在 chat-messages 里, 撑高容器底部
    // 几百 px, 让后续 appendMessage 新消息视觉位置被顶到中间 (user 描述"新消息出现在顶部")
    // 修法 1: 已修 insertLogAfterBubble/appendAfterLastMessage 的 fallback 分支
    // 修法 2 (本函数): 启动时把已存在的孤儿 lineEl (chat-messages 直接子元素里的
    //         .mcp-tool-log-line) 全 remove, 清掉老错位残留
    function cleanupOrphanLineEls() {
        const container = getChatContainer();
        if (!container) return 0;
        // :scope > 直接子元素选择器, 只查 chat-messages 直接子元素里的 .mcp-tool-log-line
        // (在 .mcp-tool-log-group 内的 lineEl 不会被命中, 因为 group 不是 chat-messages 直接子元素? 不, group 也可能是,
        //  所以更严格: 找"父节点是 chat-messages"的 lineEl)
        const orphans = container.querySelectorAll(':scope > .mcp-tool-log-line');
        if (orphans.length === 0) return 0;
        console.warn('[McpToolLog] 清理 ' + orphans.length + ' 个孤儿 lineEl (没包 group, 父节点是 chat-messages)');
        orphans.forEach(function (el) { el.remove(); });
        return orphans.length;
    }

    // ========== 初始化 ==========
    if (global.McpBridge && typeof global.McpBridge.onCard === 'function') {
        global.McpBridge.onCard(onCard);
        console.log('[McpToolLog] 已注册 card listener, 监听所有 MCP 工具调用 (覆盖 mcd/luckin/amap/任意通用 MCP)');
        // 2026-08-09 v0.2.04: 启动时清理老错位 group, 等容器准备好
        // 2026-08-18 v0.2.30.6: 顺便清理孤儿 lineEl (没包 group 的, 之前 bug 残留)
        setTimeout(function () {
            cleanupMisplacedGroups();
            cleanupOrphanLineEls();
            // 1s 后再清一次 (容器可能还在渲染中)
            setTimeout(function () {
                cleanupMisplacedGroups();
                cleanupOrphanLineEls();
            }, 1000);
        }, 100);
        // 启动 DOM 观察, 切聊天/loadMore 时恢复历史 log
        installHistoryObserver();
    } else {
        console.warn('[McpToolLog] McpBridge not loaded, skip init');
    }

})(typeof window !== 'undefined' ? window : globalThis);
