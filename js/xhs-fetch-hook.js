/* ====================================================================
 * 小红书图片注入 Fetch Hook
 *
 * 跟 mcp-tool-bridge.js 一样拦截 /v1/chat/completions, 但只做一件事:
 *   把 XhsLinkPreview 缓存的图片 base64 注入到对应的 user 消息
 *   (作为 OpenAI multimodal content blocks: text + image_url)
 *
 * 时序:
 *   1. 用户发小红书链接 → XhsLinkPreview 调 xhs-card + xhs-images
 *   2. 图片 base64 缓存到 window.__xhsPendingImages[userMsgTimestamp]
 *   3. AI 调接口 → 本 hook 拦截 → 找到最近 user 消息 ts → 注入图片
 *   4. 清理已用图片 (避免重复注入)
 *
 * 不依赖 XhsLinkPreview 也能独立工作 (没缓存就透传).
 *
 * 暴露: window.XhsFetchHook
 * ==================================================================== */

(function (global) {
    'use strict';

    const PENDING_KEY = '__xhsPendingImages';
    if (!global[PENDING_KEY]) global[PENDING_KEY] = Object.create(null);

    // ========== 工具 ==========

    function isLLMRequest(url) {
        return typeof url === 'string' && url.indexOf('/v1/chat/completions') >= 0;
    }

    function safeParseJson(s) {
        try { return JSON.parse(s); } catch (e) { return null; }
    }

    function getLastUserMessage(messages) {
        if (!Array.isArray(messages)) return null;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i] && messages[i].role === 'user') return messages[i];
        }
        return null;
    }

    // 把 string content 改造为 multimodal array (text + image_url)
    function injectImagesToMessage(msg, images) {
        if (!msg || !Array.isArray(images) || !images.length) return false;

        const originalText = (typeof msg.content === 'string') ? msg.content : '';

        // 构造 image blocks
        const imageBlocks = images.map(function (img) {
            const mime = img.mime || 'image/jpeg';
            return {
                type: 'image_url',
                image_url: {
                    url: 'data:' + mime + ';base64,' + img.base64,
                },
            };
        });

        // 构造 multimodal content
        // 优先用中文注释让 AI 知道是"用户发的小红书图片"
        const noteTitle = (msg.__xhsNoteTitle || '').trim();
        const prefix = noteTitle ? ('[用户分享的小红书笔记: ' + noteTitle + ']\n') : '[用户分享的小红书笔记配图]';
        const newContent = [
            { type: 'text', text: prefix + (originalText ? '\n' + originalText : '') },
        ].concat(imageBlocks);

        msg.content = newContent;
        return true;
    }

    // ========== 拦截 ==========

    let originalFetch = null;
    let installed = false;

    function install() {
        if (installed) return;
        if (!global.fetch) {
            setTimeout(install, 200);
            return;
        }
        originalFetch = global.fetch;
        const wrappedFetch = async function (input, init) {
            const url = (typeof input === 'string' ? input : (input && input.url)) || '';
            const method = (init && init.method) || (input && input.method) || 'GET';
            const isJsonBody = init && init.body && typeof init.body === 'string';

            if (method.toUpperCase() === 'POST' && isLLMRequest(url) && isJsonBody) {
                const body = safeParseJson(init.body);
                if (body && Array.isArray(body.messages)) {
                    const lastUser = getLastUserMessage(body.messages);
                    if (lastUser && lastUser.role === 'user') {
                        // 用 ts 关联 (XhsLinkPreview 写缓存时用 msg.timestamp 当 key)
                        // 但 messages 里的 user 消息不一定有 timestamp 字段, 尝试从 history 找
                        const ts = lastUser.timestamp;
                        const pending = (ts != null) ? global[PENDING_KEY][ts] : null;
                        if (pending && pending.length) {
                            const ok = injectImagesToMessage(lastUser, pending);
                            if (ok) {
                                // 清理 (一次性的, 避免重复)
                                delete global[PENDING_KEY][ts];
                                console.log('[XHS-Hook] 注入', pending.length, '张图到 user 消息 (ts=' + ts + ')');
                            }
                        }
                    }
                }
                // 重新序列化 body
                if (body) {
                    const newOpts = Object.assign({}, init, {
                        body: JSON.stringify(body),
                        headers: Object.assign({}, init.headers || {}, { 'Content-Type': 'application/json' }),
                    });
                    try {
                        return await originalFetch(input, newOpts);
                    } catch (e) {
                        return originalFetch.apply(this, arguments);
                    }
                }
            }
            return originalFetch.apply(this, arguments);
        };

        try {
            global.fetch = wrappedFetch;
            installed = true;
            console.log('[XHS-Hook] fetch hook 已安装 (图片注入)');
        } catch (e) {
            try {
                Object.defineProperty(global, 'fetch', {
                    value: wrappedFetch, writable: true, configurable: true,
                });
                installed = true;
                console.log('[XHS-Hook] fetch hook 已安装 (defineProperty 模式)');
            } catch (e2) {
                console.warn('[XHS-Hook] 装 fetch hook 失败:', e2);
            }
        }
    }

    function uninstall() {
        if (!installed) return;
        if (originalFetch) {
            try { global.fetch = originalFetch; } catch (e) {
                try { Object.defineProperty(global, 'fetch', { value: originalFetch, writable: true, configurable: true }); } catch (e2) {}
            }
        }
        installed = false;
    }

    // ========== 暴露 ==========

    global.XhsFetchHook = {
        VERSION: 'v1.0.0',
        isInstalled: function () { return installed; },
        install: install,
        uninstall: uninstall,
        // 调试用
        _pending: function () { return Object.keys(global[PENDING_KEY]).map(function (k) {
            return { ts: k, count: (global[PENDING_KEY][k] || []).length };
        }); },
    };

    // ========== 启动 ==========

    function tryInstall() {
        if (global.fetch) {
            install();
            return;
        }
        setTimeout(tryInstall, 100);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(tryInstall, 50); });
    } else {
        setTimeout(tryInstall, 50);
    }

    console.log('[XHS-Hook] 图片注入模块已加载 (依赖 window.__xhsPendingImages)');

})(typeof window !== 'undefined' ? window : globalThis);
