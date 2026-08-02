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

(function (global) {
    'use strict';

    // ========== 拿当前 AI 角色名 (多路径尝试 + 兜底 "AI") ==========
    // 关键字段: chat.originalName (聊天设置页"对方本名 (AI识别用)"输入框, modules/init-event-bindingsA.js:4142 存)
    function getCurrentAIName() {
        try {
            const st = (typeof window !== 'undefined' ? window : global).state;
            if (!st) return 'AI';
            // 1) 优先通过 activeChatId 找 chat.originalName (聊天设置页的 AI 名字)
            const activeId = st.activeChatId;
            if (activeId && st.chats && st.chats[activeId]) {
                const chat = st.chats[activeId];
                if (chat.originalName) return String(chat.originalName);
            }
            // 2) 兜底: state.currentChat.originalName
            if (st.currentChat && st.currentChat.originalName) {
                return String(st.currentChat.originalName);
            }
            // 3) 兜底: 直接读 input 框 (万一 state 没及时同步)
            if (typeof document !== 'undefined') {
                const input = document.getElementById('ai-original-name-input');
                if (input && input.value && input.value.trim()) return input.value.trim();
            }
        } catch (e) { /* 静默 */ }
        return 'AI';
    }

    // ========== 摘要生成: 从 result.data 抽关键信息 ==========
    // 通用规则: 优先看常见数组字段, 数字字段, 字符串
    function summarizeResult(toolName, data) {
        if (!data || typeof data !== 'object') {
            if (typeof data === 'string') return data.slice(0, 40);
            if (typeof data === 'number') return String(data);
            return '';
        }
        // 1) 常见数组字段 (返回长度 + 提示)
        const arrayKeys = ['pois', 'stores', 'meals', 'items', 'products', 'results',
            'coupons', 'addresses', 'orders', 'forecasts', 'lives', 'casts',
            'geocodes', 'routes', 'paths'];
        for (let i = 0; i < arrayKeys.length; i++) {
            const k = arrayKeys[i];
            if (Array.isArray(data[k]) && data[k].length) {
                let extra = '';
                // 一些特殊处理
                if (k === 'pois' && data.count) extra = ' (共 ' + data.count + ')';
                if (k === 'meals') {
                    // 麦当劳 query-meals 返的是 categories 数组, 每个有 items
                    // 但有时候直接返 items
                    extra = ' (' + data[k].length + ' 项)';
                }
                if (k === 'geocodes') extra = ' (地址候选)';
                return data[k].length + ' 项' + extra;
            }
        }
        // 麦当劳 query-meals: 实际结构是 { categories: [...] }, 需要递归
        if (Array.isArray(data.categories)) {
            let totalItems = 0;
            for (let i = 0; i < data.categories.length; i++) {
                const cat = data.categories[i];
                if (cat && Array.isArray(cat.items)) totalItems += cat.items.length;
            }
            if (totalItems) return data.categories.length + ' 分类 ' + totalItems + ' 餐品';
        }
        // 2) 数字字段
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
        // 3) 订单类
        if (data.orderId || data.orderNo) {
            return '订单 ' + (data.orderId || data.orderNo);
        }
        if (data.status && typeof data.status === 'string') {
            return '状态: ' + data.status;
        }
        // 4) 兜底: 对象顶层 key 数量
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

    // ========== 渲染单行 (像网易云切歌提示: 浅色小字) ==========
    // 格式: [角色名] 调用了 [toolName] · [summary]
    // 失败时: [角色名] 调用失败 · [toolName] · [error]
    function renderLogLine(card) {
        const result = card && card.result;
        const toolName = card.toolName || '';
        const aiName = getCurrentAIName();
        let verb = '调用了';
        let summary = '';
        let cls = 'mcp-tool-log-line';

        if (!result) {
            verb = '调用';
            summary = '无结果';
        } else if (result.success === false) {
            verb = '调用失败';
            summary = (result.error || '失败').slice(0, 60);
            cls += ' mcp-tool-log-err';
        } else if (result.success === true) {
            summary = summarizeResult(toolName, result.data);
        } else {
            verb = '调用中';
            summary = '';
        }

        const line = document.createElement('div');
        line.className = cls;
        line.setAttribute('data-tool', toolName);
        line.setAttribute('data-ts', String(card.ts || Date.now()));

        // 显示: [角色名] [verb] [toolName] · [summary]
        // 比如: "沈清越 调用了 query-meals · 14 分类 116 餐品"
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

    // ========== 找最近一条 AI 消息气泡, 紧跟其后追加日志行 ==========
    function appendAfterLastMessage(lineEl) {
        const bubbles = document.querySelectorAll('.message-bubble[data-timestamp]');
        const lastBubble = bubbles[bubbles.length - 1];
        if (!lastBubble) {
            const chatArea = document.querySelector('.chat-area, .chat-messages, .messages') || document.body;
            chatArea.appendChild(lineEl);
            return;
        }
        // 找全局最后一个 .mcp-tool-log-group, 验证它在 lastBubble 之后 (或同一个 wrapper 之后)
        // 因为同时间 AI 消息只有一个, 最后一个 group 就是当前 AI 消息的
        const allGroups = document.querySelectorAll('.mcp-tool-log-group');
        if (allGroups.length > 0) {
            const lastGroup = allGroups[allGroups.length - 1];
            // 检查 lastGroup 是不是在 lastBubble 之后 (用 document order 比较)
            // Node.DOCUMENT_POSITION_FOLLOWING = 4
            const pos = lastBubble.compareDocumentPosition(lastGroup);
            if (pos & 4) { // DOCUMENT_POSITION_FOLLOWING
                // lastGroup 在 lastBubble 之后, 追加到 lastGroup
                lastGroup.appendChild(lineEl);
                scrollChatToBottom();
                return;
            }
        }
        // 没有现成 group, 新建一个, 插在 wrapper 后面
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

    // ========== card 监听器 ==========
    function onCard(card) {
        if (!card || !card.toolName) return;
        try {
            const line = renderLogLine(card);
            requestAnimationFrame(function () { appendAfterLastMessage(line); });
        } catch (e) {
            console.warn('[McpToolLog] 渲染失败:', e);
        }
    }

    // ========== 初始化 ==========
    if (global.McpBridge && typeof global.McpBridge.onCard === 'function') {
        global.McpBridge.onCard(onCard);
        console.log('[McpToolLog] 已注册 card listener, 监听所有 MCP 工具调用 (覆盖 mcd/luckin/amap/任意通用 MCP)');
    } else {
        console.warn('[McpToolLog] McpBridge not loaded, skip init');
    }

})(typeof window !== 'undefined' ? window : globalThis);
