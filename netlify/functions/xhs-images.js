/**
 * 小红书图片下载代理 (Netlify Function 版)
 *
 * 思路参考 docs: "让家机看到小红书链接思路"
 *
 * 关键点:
 *   - 伪装 Referer 为 xhs.com (绕 CDN 防盗链)
 *   - 并行下载 + base64 编码
 *   - 单图大小上限 10MB (防止胖图撑爆函数内存)
 *   - 单次最多 5 张 (Netlify 免费版 10s timeout 限制)
 *   - 失败不中断, 部分成功也算 ok
 *
 * 入参: { urls: ["url1", "url2", ...] }
 * 出参: {
 *   ok,
 *   images: [{url, base64, mime}],
 *   errors: [{url, error}]
 * }
 */

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const XHS_REFERER = 'https://www.xiaohongshu.com/';

const MAX_IMAGES_PER_CALL = 5;        // 单次最多 5 张 (Netlify 免费版 10s timeout 限制)
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;  // 单图 10MB 上限
const PER_IMAGE_TIMEOUT_MS = 8_000;   // 单图 8s
const TOTAL_TIMEOUT_MS = 25_000;      // 总 25s

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

function fetchWithTimeout(url, opts, timeoutMs) {
    if (typeof AbortController === 'undefined') return fetch(url, opts);
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch(url, Object.assign({}, opts, { signal: controller.signal })).finally(function () {
        clearTimeout(timer);
    });
}

function normalizeMime(ct) {
    let m = String(ct || '').split(';')[0].trim().toLowerCase();
    if (!m) m = 'image/jpeg';
    if (m === 'image/jpg') m = 'image/jpeg';
    if (m.indexOf('image/') !== 0) m = 'image/jpeg';  // 兜底
    return m;
}

// 校验 URL 是否合法 (防 SSRF: 禁止内网)
function isBlockedUrl(rawUrl) {
    try {
        const u = new URL(rawUrl);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return true;
        const host = u.hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
        if (host.endsWith('.local') || host.endsWith('.internal')) return true;
        // 简单 IPv4 私网段检查
        const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
        if (m) {
            const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
            if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return true;
        }
        return false;
    } catch (e) { return true; }
}

async function downloadOne(url) {
    if (isBlockedUrl(url)) throw new Error('URL 不合法 (内网/非 http)');
    const resp = await fetchWithTimeout(url, {
        headers: {
            'User-Agent': MOBILE_UA,
            'Referer': XHS_REFERER,
            'Accept': 'image/webp,image/avif,image/png,image/jpeg,image/*,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        redirect: 'follow',
    }, PER_IMAGE_TIMEOUT_MS);

    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    // 检查 content-length (大图提前拒)
    const lenHeader = parseInt(resp.headers.get('content-length') || '0', 10);
    if (lenHeader > MAX_IMAGE_SIZE) throw new Error('图片过大 (content-length ' + lenHeader + ')');

    // 读 buffer, 检查实际大小
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_SIZE) throw new Error('图片过大 (实际 ' + buf.byteLength + ' 字节)');

    const mime = normalizeMime(resp.headers.get('content-type'));
    const base64 = Buffer.from(buf).toString('base64');
    return {
        url: url,
        base64: base64,
        mime: mime,
        size: buf.byteLength,
    };
}

// ========== 主入口 ==========

exports.handler = async function (event) {
    // 1. CORS
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: CORS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return json(405, { ok: false, error: 'xhs-images 仅支持 POST' });
    }

    // 2. 解析入参
    let body = {};
    try {
        body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {});
    } catch (e) {
        return json(400, { ok: false, error: '请求体不是合法 JSON' });
    }
    const rawUrls = Array.isArray(body.urls) ? body.urls : [];
    if (!rawUrls.length) return json(400, { ok: false, error: '缺少 urls 数组' });
    const urls = rawUrls.filter(Boolean).slice(0, MAX_IMAGES_PER_CALL);
    if (!urls.length) return json(400, { ok: false, error: 'urls 数组为空' });

    // 3. 总超时 (兜底)
    const totalController = new AbortController();
    const totalTimer = setTimeout(function () { totalController.abort(); }, TOTAL_TIMEOUT_MS);
    totalController.signal.addEventListener('abort', function () {
        // 这里不做事, Promise.allSettled 自己超时由 per-image 处理
    });

    // 4. 并行下载 (任一失败不影响其他)
    const settled = await Promise.allSettled(urls.map(function (u) { return downloadOne(u); }));
    clearTimeout(totalTimer);

    // 5. 整理结果
    const images = [];
    const errors = [];
    for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        const u = urls[i];
        if (r.status === 'fulfilled' && r.value) {
            images.push(r.value);
        } else {
            errors.push({
                url: u,
                error: r.reason ? (r.reason.message || String(r.reason)) : '未知错误',
            });
        }
    }

    return json(200, {
        ok: images.length > 0,
        images: images,
        errors: errors,
        stats: {
            requested: urls.length,
            succeeded: images.length,
            failed: errors.length,
        },
    });
};
