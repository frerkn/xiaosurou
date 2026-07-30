/**
 * 小红书笔记抓取 (Netlify Function 版)
 *
 * 思路参考 docs: "让家机看到小红书链接思路" + 糯米机 XHSLite / bridge 模式
 * Node 18+ 自带 fetch + AbortController
 *
 * 入参: { url: "https://www.xiaohongshu.com/.../xxx" }
 * 出参: {
 *   ok,
 *   note: {
 *     title, author, desc,
 *     images: [url1, url2, ...], imageCount,
 *     likedCount, commentCount, collectedCount, shareCount,
 *     comments: [{user, content, ipLocation}],
 *     url
 *   }
 * }
 *
 * 关键点:
 *   - 必须用手机 UA (桌面 UA 拿不到完整 __INITIAL_STATE__)
 *   - 兼容两种 __INITIAL_STATE__ 路径: state.noteData.data.noteData / state.noteData.normalNotePreloadData
 *   - 图片 URL: 补 https: 协议头 + 解 \u002F 转义
 *   - 短链 xhslink.com 默认 follow redirect
 *   - 不登录不触发风控
 */

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_COUNT = 9;
const MAX_COMMENT_COUNT = 5;
const MAX_HTML_SIZE = 5 * 1024 * 1024;  // 5MB 上限, 防止胖页面撑爆内存

// ========== CORS ==========

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

function json(status, payload) {
    return {
        statusCode: status,
        headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS),
        body: JSON.stringify(payload),
    };
}

// ========== 工具 ==========

function fixImageUrl(u) {
    if (!u) return '';
    let s = String(u);
    if (s.startsWith('//')) s = 'https:' + s;
    s = s.replace(/\\u002F/g, '/');
    s = s.replace(/\\\//g, '/');
    return s;
}

function fetchWithTimeout(url, opts, timeoutMs) {
    if (typeof AbortController === 'undefined') return fetch(url, opts);
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch(url, Object.assign({}, opts, { signal: controller.signal })).finally(function () {
        clearTimeout(timer);
    });
}

// 从 HTML 提取 window.__INITIAL_STATE__ = {...}; (匹配可能跨行)
function extractInitialState(html) {
    // 兼容多种写法: window.__INITIAL_STATE__ = {...}; 或 __INITIAL_STATE__={...};
    const patterns = [
        /window\.__INITIAL_STATE__\s*=\s*(\{.+?\})\s*;\s*<\/script>/s,
        /window\.__INITIAL_STATE__\s*=\s*(\{.+?\})\s*;/s,
        /__INITIAL_STATE__\s*=\s*(\{.+?\})\s*;\s*<\/script>/s,
    ];
    for (let i = 0; i < patterns.length; i++) {
        const m = html.match(patterns[i]);
        if (m && m[1]) return m[1];
    }
    return null;
}

// 从 noteData 提取笔记核心数据
function extractNote(rawState) {
    // 路径 1: state.noteData.data.noteData (新版本)
    // 路径 2: state.noteData.data.normalNotePreloadData (新版本, preload 缓存)
    // 路径 3: state.noteData.normalNotePreloadData (旧版本, 偶尔)
    // 路径 4: state.noteData.noteData (兜底)
    const candidates = [];
    const nd = rawState && rawState.noteData;
    if (nd) {
        if (nd.data) {
            if (nd.data.noteData) candidates.push(nd.data.noteData);
            if (nd.data.normalNotePreloadData) candidates.push(nd.data.normalNotePreloadData);
        }
        if (nd.noteData) candidates.push(nd.noteData);
        if (nd.normalNotePreloadData) candidates.push(nd.normalNotePreloadData);
    }
    return candidates.length ? candidates[0] : null;
}

// ========== 主入口 ==========

exports.handler = async function (event) {
    // 1. CORS 预检
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: CORS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return json(405, { ok: false, error: 'xhs-card 仅支持 POST' });
    }

    // 2. 解析入参
    let body = {};
    try {
        body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {});
    } catch (e) {
        return json(400, { ok: false, error: '请求体不是合法 JSON' });
    }
    const url = String(body.url || '').trim();
    if (!url) return json(400, { ok: false, error: '缺少 url 参数' });
    if (!/xiaohongshu\.com|xhslink\.com/i.test(url)) {
        return json(400, { ok: false, error: '不是小红书链接' });
    }

    // 3. 抓页面 (手机 UA)
    let html;
    try {
        const resp = await fetchWithTimeout(url, {
            headers: {
                'User-Agent': MOBILE_UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Cache-Control': 'no-cache',
            },
            redirect: 'follow',
        }, FETCH_TIMEOUT_MS);
        if (!resp.ok) {
            return json(502, { ok: false, error: '抓取失败: HTTP ' + resp.status, status: resp.status });
        }
        // 限制读取大小, 防止胖页面撑爆内存
        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let received = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += decoder.decode(value, { stream: true });
            if (received.length > MAX_HTML_SIZE) {
                try { await reader.cancel(); } catch (e) {}
                return json(502, { ok: false, error: '页面过大, 超过 5MB' });
            }
        }
        received += decoder.decode();
        html = received;
    } catch (e) {
        const aborted = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
        return json(aborted ? 504 : 502, { ok: false, error: aborted ? '抓取超时' : '抓取失败: ' + (e.message || e) });
    }

    // 4. 提取 __INITIAL_STATE__
    const stateStr = extractInitialState(html);
    if (!stateStr) {
        return json(502, {
            ok: false,
            error: '页面没找到 __INITIAL_STATE__ (可能需要登录, 或页面结构变了)',
            hint: '移动端打开 xhs.com 登录一次再重试, 或检查页面结构',
        });
    }
    let rawState;
    try {
        // 解转义 + 替换 undefined 为 null (防止 JSON.parse 失败)
        const cleaned = stateStr.replace(/\\u002F/g, '/').replace(/undefined/g, 'null');
        rawState = JSON.parse(cleaned);
    } catch (e) {
        return json(502, { ok: false, error: '__INITIAL_STATE__ JSON 解析失败: ' + e.message });
    }

    // 5. 提取 noteData
    const note = extractNote(rawState);
    if (!note) {
        return json(502, { ok: false, error: 'noteData 为空 (路径可能变了, 或笔记不存在)' });
    }

    // 6. 提取字段
    const imageList = (note.imageList || [])
        .map(function (img) { return fixImageUrl((img && (img.urlDefault || img.url)) || ''); })
        .filter(Boolean)
        .slice(0, MAX_IMAGE_COUNT);

    const commentList = (note.comments && note.comments.list) || [];
    const comments = commentList.slice(0, MAX_COMMENT_COUNT).map(function (c) {
        return {
            user: (c.user && (c.user.nickname || c.user.name)) || '匿名',
            content: c.content || '',
            ipLocation: c.ipLocation || '',
        };
    });

    const interact = note.interactInfo || {};

    return json(200, {
        ok: true,
        note: {
            title: note.title || '',
            author: (note.user && (note.user.nickname || note.user.name)) || '',
            desc: note.desc || '',
            avatar: fixImageUrl((note.user && note.user.avatar) || ''),
            images: imageList,
            imageCount: imageList.length,
            likedCount: interact.likedCount || 0,
            commentCount: interact.commentCount || 0,
            collectedCount: interact.collectedCount || 0,
            shareCount: interact.shareCount || 0,
            comments: comments,
            url: url,
        },
    });
};
