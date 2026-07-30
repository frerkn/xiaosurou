/* ====================================================================
 * 小红书链接预览 (前端)
 *
 * 思路参考 docs: "让家机看到小红书链接思路"
 * 不修改 330 现有代码, 通过 capture-phase 监听 #send-btn click:
 *   1. 检测用户消息里的小红书链接 (短链/标准链/长链)
 *   2. 在用户消息元素下方追加骨架卡 (灰色脉动)
 *   3. 调 /.netlify/functions/xhs-card 拿笔记数据
 *   4. 替换骨架为真实预览卡 (封面 + 标题 + 作者 + 互动数据)
 *   5. 调 /.netlify/functions/xhs-images 拿图片 base64
 *   6. 把图片 base64 缓存到 window.__xhsPendingImages, 供 xhs-fetch-hook 注入到 AI 消息
 *
 * 失败兜底:
 *   - xhs-card 失败 → 降级为普通链接, 不显示卡
 *   - xhs-images 失败 → 卡照常显示, 但 AI 看不到图片
 *
 * 暴露: window.XhsLinkPreview
 *   - extractUrls(text)      从文本抽所有 xhs URL
 *   - isXhsUrl(url)          判断是否小红书链接
 *   - getPendingImages(ts)   给 fetch hook 拿图片
 *   - clearPendingImages(ts) 清理已用图片
 * ==================================================================== */

(function (global) {
    'use strict';

    // ========== 常量 ==========

    const XHS_HOST_PATTERNS = [
        /^https?:\/\/(?:www\.)?xiaohongshu\.com\//i,
        /^https?:\/\/xhslink\.com\//i,
    ];
    const XHS_URL_REGEX = /https?:\/\/(?:www\.)?xiaohongshu\.com\/[^\s<>'"]+|https?:\/\/xhslink\.com\/[^\s<>'"]+/gi;

    const SKELETON_ID_PREFIX = 'xhs-preview-skel-';
    const CARD_CLASS = 'xhs-preview-card';
    const CARD_LOADING_CLASS = 'xhs-preview-loading';
    const CARD_ERROR_CLASS = 'xhs-preview-error';

    // Netlify Function 路径 (双平台: Netlify + Vercel)
    const NETLIFY_PATH = '/.netlify/functions/xhs-card';
    const VERCEL_PATH = '/api/xhs-card';
    const NETLIFY_IMAGES_PATH = '/.netlify/functions/xhs-images';
    const VERCEL_IMAGES_PATH = '/api/xhs-images';

    // 全局图片缓存 (key: msg timestamp, value: [{base64, mime}])
    // 注: 不放 localStorage 因为 base64 单图可能几 MB, 5 张图容易超 5MB 配额
    global.__xhsPendingImages = global.__xhsPendingImages || Object.create(null);

    // ========== 工具 ==========

    function isXhsUrl(url) {
        if (!url) return false;
        return XHS_HOST_PATTERNS.some(function (re) { return re.test(url); });
    }

    function extractUrls(text) {
        if (!text) return [];
        const matches = String(text).match(XHS_URL_REGEX);
        return matches ? matches : [];
    }

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function shortId() {
        return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    function findChatContainer() {
        // 兼容多种可能的容器 ID
        const ids = ['chat-messages', 'message-list', 'messages-container', 'chat-message-list'];
        for (let i = 0; i < ids.length; i++) {
            const el = document.getElementById(ids[i]);
            if (el) return el;
        }
        return document.querySelector('.chat-messages, .message-list, [data-role="messages"]');
    }

    // 找当前活跃 chat 的 history 数组
    function getCurrentChat() {
        if (global.state && global.state.chats && global.state.activeChatId) {
            return global.state.chats[global.state.activeChatId];
        }
        return null;
    }

    function getLastUserMessage() {
        const chat = getCurrentChat();
        if (!chat || !Array.isArray(chat.history)) return null;
        for (let i = chat.history.length - 1; i >= 0; i--) {
            if (chat.history[i] && chat.history[i].role === 'user') return chat.history[i];
        }
        return null;
    }

    // 滚动到底
    function scrollToBottom(container) {
        try { container.scrollTop = container.scrollHeight; } catch (e) {}
    }

    // ========== 链接检测 (暴露给外部) ==========

    function detectAndPreview(text) {
        const urls = extractUrls(text);
        if (!urls.length) return null;
        // 同一消息只处理第一个 URL (避免多条同时加载卡爆)
        return { url: urls[0], allUrls: urls };
    }

    // ========== 渲染 ==========

    function renderSkeleton(uniqueId, url) {
        return '' +
            '<div id="' + SKELETON_ID_PREFIX + uniqueId + '" class="' + CARD_CLASS + ' ' + CARD_LOADING_CLASS + '" data-xhs-url="' + escapeHtml(url) + '" ' +
                'style="max-width:340px;margin:6px 0 10px;background:#F5F5F5;border:1px solid #E0E0E0;border-radius:10px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.04);">' +
                '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' +
                    '<div style="font-size:18px;line-height:1;">📕</div>' +
                    '<div style="flex:1;height:14px;background:linear-gradient(90deg,#E0E0E0 0%,#F0F0F0 50%,#E0E0E0 100%);background-size:200% 100%;animation:xhs-shimmer 1.4s linear infinite;border-radius:4px;"></div>' +
                '</div>' +
                '<div style="height:120px;background:linear-gradient(90deg,#E0E0E0 0%,#F0F0F0 50%,#E0E0E0 100%);background-size:200% 100%;animation:xhs-shimmer 1.4s linear infinite;border-radius:8px;margin-bottom:10px;"></div>' +
                '<div style="height:12px;background:linear-gradient(90deg,#E0E0E0 0%,#F0F0F0 50%,#E0E0E0 100%);background-size:200% 100%;animation:xhs-shimmer 1.4s linear infinite;border-radius:4px;margin-bottom:6px;"></div>' +
                '<div style="height:12px;width:60%;background:linear-gradient(90deg,#E0E0E0 0%,#F0F0F0 50%,#E0E0E0 100%);background-size:200% 100%;animation:xhs-shimmer 1.4s linear infinite;border-radius:4px;"></div>' +
                '<div style="margin-top:8px;font-size:11px;color:#999;">📕 正在读取笔记...</div>' +
            '</div>';
    }

    function renderCard(note, url) {
        if (!note) return renderError(url, '数据为空');
        const title = (note.title || '').slice(0, 80);
        const desc = (note.desc || '').slice(0, 140);
        const author = note.author || '匿名';
        const cover = (note.images && note.images[0]) || '';
        const imageCount = note.imageCount || 0;
        const liked = note.likedCount || 0;
        const comment = note.commentCount || 0;
        const collected = note.collectedCount || 0;
        const comments = note.comments || [];

        const commentItems = comments.slice(0, 3).map(function (c) {
            return '<div style="margin-top:4px;font-size:11px;color:#666;line-height:1.5;">' +
                '<span style="color:#FF2442;font-weight:600;">' + escapeHtml(c.user) + '</span>: ' +
                escapeHtml((c.content || '').slice(0, 60)) +
            '</div>';
        }).join('');

        return '' +
            '<div class="' + CARD_CLASS + '" data-xhs-url="' + escapeHtml(url) + '" ' +
                'style="max-width:340px;margin:6px 0 10px;background:#fff;border:1px solid #FFC1C8;border-radius:10px;padding:0;box-shadow:0 2px 6px rgba(255,36,66,.08);overflow:hidden;cursor:pointer;" ' +
                'onclick="window.open(\'' + escapeHtml(url) + '\', \'_blank\', \'noopener\')">' +
                (cover ? '<div style="position:relative;width:100%;padding-bottom:75%;background:#F5F5F5;background-image:url(\'' + escapeHtml(cover) + '\');background-size:cover;background-position:center;">' +
                    (imageCount > 1 ? '<div style="position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;padding:3px 8px;border-radius:10px;">🖼 ' + imageCount + '</div>' : '') +
                '</div>' : '') +
                '<div style="padding:10px 12px 12px;">' +
                    '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">' +
                        '<span style="background:#FF2442;color:#fff;font-size:10px;padding:1px 6px;border-radius:3px;font-weight:600;">笔记</span>' +
                        '<span style="font-size:11px;color:#999;">' + escapeHtml(author) + '</span>' +
                    '</div>' +
                    (title ? '<div style="font-size:14px;font-weight:600;color:#222;line-height:1.4;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + escapeHtml(title) + '</div>' : '') +
                    (desc ? '<div style="font-size:12px;color:#666;line-height:1.5;margin-bottom:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + escapeHtml(desc) + '</div>' : '') +
                    '<div style="display:flex;gap:10px;font-size:11px;color:#999;">' +
                        (liked > 0 ? '<span>❤️ ' + formatCount(liked) + '</span>' : '') +
                        (comment > 0 ? '<span>💬 ' + formatCount(comment) + '</span>' : '') +
                        (collected > 0 ? '<span>⭐ ' + formatCount(collected) + '</span>' : '') +
                    '</div>' +
                    (commentItems ? '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #F0F0F0;">' + commentItems + '</div>' : '') +
                '</div>' +
            '</div>';
    }

    function renderError(url, errorMsg) {
        return '' +
            '<div class="' + CARD_CLASS + ' ' + CARD_ERROR_CLASS + '" data-xhs-url="' + escapeHtml(url) + '" ' +
                'style="max-width:340px;margin:6px 0 10px;background:#FFF7F0;border:1px solid #FFD8B5;border-radius:10px;padding:10px 12px;font-size:12px;color:#A04A1A;">' +
                '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' +
                    '<span>📕</span>' +
                    '<span style="font-weight:600;">卡片加载失败</span>' +
                '</div>' +
                '<div style="color:#666;font-size:11px;">' + escapeHtml(errorMsg || '未知错误') + '</div>' +
                '<div style="color:#999;font-size:11px;margin-top:4px;word-break:break-all;">' + escapeHtml(url) + '</div>' +
            '</div>';
    }

    function formatCount(n) {
        if (!n) return '0';
        if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
        return String(n);
    }

    // ========== 注入 shimmer CSS (一次性) ==========

    function ensureShimmerStyle() {
        if (document.getElementById('xhs-shimmer-style')) return;
        const style = document.createElement('style');
        style.id = 'xhs-shimmer-style';
        style.textContent = '@keyframes xhs-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }';
        document.head.appendChild(style);
    }

    // ========== 调后端 ==========

    // 探测 Netlify vs Vercel (一次探测, 缓存)
    let resolvedCardPath = null;
    let resolvedImagesPath = null;
    let probeDone = false;

    async function resolvePath(netlifyP, vercelP) {
        for (let i = 0; i < 2; i++) {
            const path = i === 0 ? netlifyP : vercelP;
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(function () { ctrl.abort(); }, 2000);
                const r = await fetch(path, { method: 'OPTIONS', signal: ctrl.signal });
                clearTimeout(timer);
                if (r.status === 204 || r.status === 200 || r.status === 405) {
                    return path;
                }
            } catch (e) { /* try next */ }
        }
        return netlifyP; // 兜底
    }

    async function getCardPath() {
        if (resolvedCardPath) return resolvedCardPath;
        if (!probeDone) {
            resolvedCardPath = await resolvePath(NETLIFY_PATH, VERCEL_PATH);
            probeDone = true;
        }
        return resolvedCardPath;
    }
    async function getImagesPath() {
        if (resolvedImagesPath) return resolvedImagesPath;
        if (!probeDone) {
            resolvedImagesPath = await resolvePath(NETLIFY_IMAGES_PATH, VERCEL_IMAGES_PATH);
            probeDone = true;
        }
        return resolvedImagesPath;
    }

    async function fetchCard(url) {
        const path = await getCardPath();
        const resp = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url }),
        });
        const data = await resp.json().catch(function () { return { ok: false, error: '响应不是 JSON' }; });
        if (!resp.ok || !data.ok) {
            throw new Error((data && data.error) || ('HTTP ' + resp.status));
        }
        return data.note;
    }

    async function fetchImages(urls) {
        if (!urls || !urls.length) return [];
        const path = await getImagesPath();
        const resp = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: urls }),
        });
        const data = await resp.json().catch(function () { return { ok: false, images: [], errors: [{ error: '响应不是 JSON' }] }; });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return (data && data.images) || [];
    }

    // ========== 主流程 ==========

    async function handleXhsUrl(detection, container) {
        const url = detection.url;
        const uniqueId = shortId();
        const skelId = SKELETON_ID_PREFIX + uniqueId;

        // 1. 渲染骨架
        const skel = document.createElement('div');
        skel.innerHTML = renderSkeleton(uniqueId, url);
        const skelEl = skel.firstElementChild;
        if (!skelEl) return;
        container.appendChild(skelEl);
        scrollToBottom(container);

        // 2. 找最近 user 消息的时间戳 (给 fetch hook 关联图片用)
        const lastUserMsg = getLastUserMessage();
        const msgTs = lastUserMsg ? lastUserMsg.timestamp : Date.now();

        // 3. 调后端拿笔记
        let note;
        try {
            note = await fetchCard(url);
        } catch (e) {
            console.warn('[XHS] xhs-card 失败:', e);
            // 替换骨架为错误卡 (静默, 不打扰用户)
            const errEl = skelEl;
            errEl.outerHTML = renderError(url, e.message || String(e));
            scrollToBottom(container);
            return;
        }

        // 4. 替换骨架为真实卡
        const newCard = document.createElement('div');
        newCard.innerHTML = renderCard(note, url);
        const newCardEl = newCard.firstElementChild;
        if (newCardEl) {
            skelEl.outerHTML = newCardEl.outerHTML;
            scrollToBottom(container);
        }

        // 5. 调后端拿图片 (仅前 5 张, 给 AI 看到)
        const images = (note.images || []).slice(0, 5);
        if (!images.length) return;

        // 替换为带加载进度的卡
        const cardEl = container.querySelector('.' + CARD_CLASS + '[data-xhs-url="' + cssEscape(url) + '"]');
        if (cardEl) {
            const progressDiv = document.createElement('div');
            progressDiv.style.cssText = 'font-size:11px;color:#999;padding:6px 12px 8px;border-top:1px dashed #FFE0E5;background:#FFF8F9;';
            progressDiv.textContent = '正在加载图片 0/' + images.length + '...';
            cardEl.appendChild(progressDiv);
        }

        let loadedImages = [];
        try {
            loadedImages = await fetchImages(images);
        } catch (e) {
            console.warn('[XHS] xhs-images 失败:', e);
            if (cardEl) {
                const pg = cardEl.querySelector('div:last-child');
                if (pg && pg.style && pg.style.fontSize === '11px') {
                    pg.textContent = '⚠️ 图片加载失败, AI 看不到图片: ' + (e.message || String(e));
                }
            }
            return;
        }

        // 6. 缓存到全局, 供 fetch hook 注入
        if (loadedImages.length) {
            global.__xhsPendingImages[msgTs] = loadedImages;
            console.log('[XHS] 已缓存', loadedImages.length, '张图, ts=', msgTs);
        }

        // 7. 更新加载进度
        if (cardEl) {
            const pg = cardEl.querySelector('div:last-child');
            if (pg && pg.style && pg.style.fontSize === '11px') {
                if (loadedImages.length === images.length) {
                    pg.textContent = '✅ ' + loadedImages.length + ' 张图已就绪, AI 正在看...';
                    pg.style.color = '#10B981';
                } else {
                    pg.textContent = '⚠️ ' + loadedImages.length + '/' + images.length + ' 张图加载成功';
                    pg.style.color = '#F59E0B';
                }
            }
        }
    }

    // CSS escape for attribute selector
    function cssEscape(s) {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
        return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
    }

    // ========== 监听发送按钮 (capture phase, 不阻塞原 handler) ==========

    function attachSendListener() {
        const sendBtn = document.getElementById('send-btn');
        const chatInput = document.getElementById('chat-input');
        if (!sendBtn || !chatInput) {
            setTimeout(attachSendListener, 500);
            return;
        }

        sendBtn.addEventListener('click', function () {
            // 不阻止原 handler, 不阻塞 UI
            const text = chatInput.value || '';
            const detection = detectAndPreview(text);
            if (!detection) return;
            // 等原 handler 渲染完用户消息再追加卡 (用 setTimeout 0)
            setTimeout(function () {
                const container = findChatContainer();
                if (!container) return;
                ensureShimmerStyle();
                handleXhsUrl(detection, container).catch(function (e) {
                    console.error('[XHS] handleXhsUrl 失败:', e);
                });
            }, 50);
        }, true);  // capture phase, 先于原 handler 触发

        console.log('[XHS] 链接预览监听已安装 (capture)');
    }

    // ========== 暴露 API ==========

    global.XhsLinkPreview = {
        isXhsUrl: isXhsUrl,
        extractUrls: extractUrls,
        detectAndPreview: detectAndPreview,
        getPendingImages: function (ts) { return global.__xhsPendingImages[ts] || null; },
        clearPendingImages: function (ts) { delete global.__xhsPendingImages[ts]; },
        // 调试用
        _allPending: function () { return Object.keys(global.__xhsPendingImages).map(function (k) { return { ts: k, count: (global.__xhsPendingImages[k] || []).length }; }); },
    };

    // ========== 启动 ==========

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attachSendListener);
    } else {
        setTimeout(attachSendListener, 100);
    }

    console.log('[XHS] 链接预览模块已加载 (依赖 #send-btn + #chat-input)');

})(typeof window !== 'undefined' ? window : globalThis);
