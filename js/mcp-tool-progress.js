// MCP 工具调用实时进度 — 紧跟最近 AI 气泡显示"AI 正在调 工具名..."
// 跟 mcp-tool-call-log 共存: log 持久化(完成后保留), progress 临时(完成后移除)
//
// 订阅 McpBridge.onProgress:
//   tool_start  → 紧跟最近 AI 气泡显示进度条
//   tool_ok     → 移除该工具的进度
//   tool_err    → 移除该工具的进度
//   session_done → 移除所有进度
//
// 关键安全 (跟 mcp-tool-call-log v0.2.30.6/8 一致):
//   - 永远包成 .mcp-tool-progress-group 再插入, 跟 message-bubble 平级
//   - 找不到 anchor (最近 AI 气泡) → 不显示, 绝不堆到 chat-messages 底部
//   - 启动时清孤儿 (chat-messages 直接子元素里的 .mcp-tool-progress-line)

(function (global) {
    'use strict';

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

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function getChatContainer() {
        return document.getElementById('chat-messages');
    }

    function findBubbleByTimestamp(container, ts) {
        if (!container || ts == null) return null;
        let el = container.querySelector('.message-bubble[data-timestamp="' + ts + '"]');
        if (el) return el;
        el = container.querySelector('.message-wrapper[data-timestamp="' + ts + '"]');
        if (el) {
            const bubble = el.querySelector('.message-bubble');
            return bubble || el;
        }
        return null;
    }

    function findLastAssistantBubble() {
        const container = getChatContainer();
        if (!container) return null;
        const st = (typeof window !== 'undefined' ? window : global).state;
        if (!st || !st.activeChatId || !st.chats || !st.chats[st.activeChatId]) return null;
        const chat = st.chats[st.activeChatId];
        if (!chat || !Array.isArray(chat.history)) return null;
        for (let i = chat.history.length - 1; i >= 0; i--) {
            const m = chat.history[i];
            if (m && m.role === 'assistant' && m.timestamp) {
                return findBubbleByTimestamp(container, m.timestamp);
            }
        }
        return null;
    }

    function buildProgressGroup(aiName, toolName) {
        const group = document.createElement('div');
        group.className = 'mcp-tool-progress-group';
        group.setAttribute('data-tool', toolName);
        const line = document.createElement('div');
        line.className = 'mcp-tool-progress-line';
        line.innerHTML =
            '<span class="mcp-tool-progress-name">' + escapeHtml(aiName) + '</span>' +
            '<span class="mcp-tool-progress-verb"> 正在调 </span>' +
            '<span class="mcp-tool-progress-tool">' + escapeHtml(toolName) + '</span>' +
            '<span class="mcp-tool-progress-spinner"><i></i><i></i><i></i></span>';
        group.appendChild(line);
        return group;
    }

    function showProgress(toolName) {
        if (!toolName) return;
        const lastBubble = findLastAssistantBubble();
        if (!lastBubble) return;
        const old = document.querySelector('.mcp-tool-progress-group[data-tool="' + toolName + '"]');
        if (old) old.remove();
        const group = buildProgressGroup(getCurrentAIName(), toolName);
        const wrapper = lastBubble.closest('.message-wrapper') || lastBubble.parentNode;
        if (wrapper && wrapper.parentNode) {
            wrapper.parentNode.insertBefore(group, wrapper.nextSibling);
        } else {
            lastBubble.parentNode.insertBefore(group, lastBubble.nextSibling);
        }
    }

    function hideProgress(toolName) {
        if (toolName) {
            const el = document.querySelector('.mcp-tool-progress-group[data-tool="' + toolName + '"]');
            if (el) el.remove();
        } else {
            document.querySelectorAll('.mcp-tool-progress-group').forEach(function (g) { g.remove(); });
        }
    }

    function onProgress(p) {
        if (!p || !p.phase) return;
        if (p.phase === 'tool_start') {
            showProgress(p.toolName);
        } else if (p.phase === 'tool_ok' || p.phase === 'tool_err') {
            hideProgress(p.toolName);
        } else if (p.phase === 'session_done') {
            hideProgress();
        }
    }

    function cleanupMisplacedGroups() {
        const container = getChatContainer();
        if (!container) return 0;
        const allGroups = document.querySelectorAll('.mcp-tool-progress-group');
        let removed = 0;
        for (let i = 0; i < allGroups.length; i++) {
            const g = allGroups[i];
            let cur = g.parentNode;
            let inContainer = false;
            while (cur) {
                if (cur === container) { inContainer = true; break; }
                cur = cur.parentNode;
            }
            if (!inContainer) { g.remove(); removed++; }
        }
        return removed;
    }

    function cleanupOrphanLineEls() {
        const container = getChatContainer();
        if (!container) return 0;
        const orphans = container.querySelectorAll(':scope > .mcp-tool-progress-line');
        orphans.forEach(function (el) { el.remove(); });
        return orphans.length;
    }

    function install() {
        if (!global.McpBridge || typeof global.McpBridge.onProgress !== 'function') {
            setTimeout(install, 500);
            return;
        }
        global.McpBridge.onProgress(onProgress);
        console.log('[McpToolProgress] 已注册 progress listener');
        cleanupMisplacedGroups();
        cleanupOrphanLineEls();
    }

    install();
})(typeof window !== 'undefined' ? window : this);
