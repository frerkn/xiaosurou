/**
 * 通用 MCP CORS 代理 (Netlify Function 版)
 *
 * - 接收前端 POST /.netlify/functions/mcp-proxy
 * - 透传 + 补 CORS 头 + 可选 X-Proxy-Key 校验
 * - 目标 URL 从 ?target=<url-encoded MCP服务器URL> 读取
 * - 可选 X-MCP-Forward-Headers 头告知代理"以下自定义请求头需要原样透传"
 *
 * 跟糯米机 worker/mcp-proxy/worker.js 等价 (vanilla JS + Netlify 适配)
 *
 * 部署:
 *   - 推到 330 后端代码仓库 (用户已配 GitHub 关联) → 自动部署到 Netlify
 *   - Netlify 环境变量 PROXY_KEY (可选) 防止白嫖
 *
 * 用法:
 *   330 设置 → MCP 工具服务器 → 代理 URL 填 https://<你的netlify域名>/.netlify/functions/mcp-proxy
 *   代理密钥: 跟环境变量 PROXY_KEY 一致
 */

// ========== 可调配置 ==========

// 允许转发的请求头 (含大小写不敏感匹配)
const FORWARD_REQUEST_HEADERS = [
    'content-type',
    'accept',
    'authorization',
    'mcp-session-id',
    'mcp-protocol-version',
    'last-event-id',
];

// 始终阻断透传的安全敏感头
const BLOCKED_FORWARD_HEADERS = new Set([
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'upgrade',
    'x-proxy-key',
    'x-mcp-forward-headers',
]);

// 代理请求超时
const FETCH_TIMEOUT_MS = 60_000;

// ========== CORS 配置 ==========

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Proxy-Key, X-MCP-Forward-Headers',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
    'Access-Control-Max-Age': '86400',
};

function corsJson(status, obj) {
    return {
        statusCode: status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        body: JSON.stringify(obj),
    };
}

// ========== 安全检查: 禁止代理内网/本机地址 ==========

function isPrivateIpv4(host) {
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some(function (p) { return !Number.isInteger(p) || p < 0 || p > 255; })) return false;
    const a = parts[0], b = parts[1];
    return a === 0 || a === 10 || a === 127
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127);
}

function blockedTargetReason(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch (e) { return 'target 不是合法 URL'; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '只允许 http/https';
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const blocked = host === 'localhost'
        || host.endsWith('.localhost')
        || host.endsWith('.local')
        || host.endsWith('.internal')
        || host === '::1'
        || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
        || isPrivateIpv4(host);
    return blocked ? '不允许代理内网/本机地址' : null;
}

// ========== 工具函数 ==========

function fetchWithTimeout(url, opts, timeoutMs) {
    if (typeof AbortController === 'undefined') return fetch(url, opts);
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch(url, Object.assign({}, opts, { signal: controller.signal })).finally(function () {
        clearTimeout(timer);
    });
}

// ========== 主处理 ==========

exports.handler = async function (event) {
    // 1. CORS 预检
    if (event.httpMethod === 'OPTIONS') {
        const headers = Object.assign({}, CORS_HEADERS);
        const requestedHeaders = (event.headers['access-control-request-headers'] || event.headers['Access-Control-Request-Headers']);
        if (requestedHeaders) headers['Access-Control-Allow-Headers'] = requestedHeaders;
        return { statusCode: 204, headers: headers, body: '' };
    }

    // 2. 代理密钥校验 (可选, 跟环境变量 PROXY_KEY 对齐)
    const expectedKey = process.env.PROXY_KEY;
    if (expectedKey) {
        const providedKey = event.headers['x-proxy-key'] || event.headers['X-Proxy-Key'] || '';
        if (providedKey !== expectedKey) {
            return corsJson(403, { error: '代理密钥错误 (X-Proxy-Key)' });
        }
    }

    // 3. 解析目标 URL
    const params = event.queryStringParameters || {};
    const target = params.target;
    if (!target) return corsJson(400, { error: '缺少 ?target=<MCP服务器URL> 参数' });
    const blocked = blockedTargetReason(target);
    if (blocked) return corsJson(400, { error: blocked });

    // 4. 构造转发请求头
    const fwdHeaders = {};
    for (let i = 0; i < FORWARD_REQUEST_HEADERS.length; i++) {
        const name = FORWARD_REQUEST_HEADERS[i];
        const v = event.headers[name] || event.headers[name.toUpperCase()] || event.headers[name.split('-').map(function (p, i) {
            return i === 0 ? p : p[0].toUpperCase() + p.slice(1);
        }).join('-')];
        if (v) fwdHeaders[name] = v;
    }
    const customHeaderNames = (event.headers['x-mcp-forward-headers'] || event.headers['X-MCP-Forward-Headers'] || '')
        .split(',')
        .map(function (n) { return n.trim(); })
        .filter(Boolean);
    for (let i = 0; i < customHeaderNames.length; i++) {
        const name = customHeaderNames[i];
        if (BLOCKED_FORWARD_HEADERS.has(name.toLowerCase())) continue;
        const v = event.headers[name] || event.headers[name.toLowerCase()] || event.headers[name.split('-').map(function (p, i) {
            return i === 0 ? p : p[0].toUpperCase() + p.slice(1);
        }).join('-')];
        if (v) fwdHeaders[name] = v;
    }

    // 5. 转发请求
    let upstream;
    try {
        const method = (event.httpMethod || 'POST').toUpperCase();
        const fetchOpts = {
            method: method,
            headers: fwdHeaders,
        };
        if (method !== 'GET' && method !== 'HEAD' && event.body) {
            fetchOpts.body = event.body;
            // Netlify Functions 默认 base64 编码 body, 需要标记
            if (event.isBase64Encoded) {
                fetchOpts.body = Buffer.from(event.body, 'base64');
            }
        }
        upstream = await fetchWithTimeout(target, fetchOpts, FETCH_TIMEOUT_MS);
    } catch (e) {
        const aborted = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
        return corsJson(aborted ? 504 : 502, {
            error: aborted ? '代理请求超时' : '转发失败',
            detail: (e && e.message) || String(e),
            target: target,
        });
    }

    // 6. 透传响应 (含 SSE 流)
    const respHeaders = Object.assign({}, CORS_HEADERS);
    const passthroughHeaderNames = ['content-type', 'mcp-session-id', 'www-authenticate', 'cache-control'];
    for (let i = 0; i < passthroughHeaderNames.length; i++) {
        const name = passthroughHeaderNames[i];
        const v = upstream.headers.get(name);
        if (v) respHeaders[name] = v;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    return {
        statusCode: upstream.status,
        headers: respHeaders,
        body: buf.toString('base64'),
        isBase64Encoded: true,
    };
};
