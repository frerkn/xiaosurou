/**
 * 通用 MCP CORS 代理 (Vercel Serverless Function 版)
 *
 * - 接收前端 POST /api/mcp-proxy
 * - 透传 + 补 CORS 头 + 可选 X-Proxy-Key 校验
 * - 跟 netlify/functions/mcp-proxy.js 行为一致, 双平台兼容
 *
 * 部署: Vercel 自动识别 api/*.js 为 Serverless Function
 * 环境变量: PROXY_KEY (可选) 防止白嫖
 *
 * 用法:
 *   330 设置 → MCP 工具服务器 → 代理 URL 填 https://<你的vercel域名>/api/mcp-proxy
 */

const FORWARD_REQUEST_HEADERS = [
    'content-type',
    'accept',
    'authorization',
    'mcp-session-id',
    'mcp-protocol-version',
    'last-event-id',
];

const BLOCKED_FORWARD_HEADERS = new Set([
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'upgrade',
    'x-proxy-key',
    'x-mcp-forward-headers',
]);

const FETCH_TIMEOUT_MS = 60_000;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Proxy-Key, X-MCP-Forward-Headers',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
    'Access-Control-Max-Age': '86400',
};

function corsJson(status, obj) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

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

function fetchWithTimeout(url, opts, timeoutMs) {
    if (typeof AbortController === 'undefined') return fetch(url, opts);
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch(url, Object.assign({}, opts, { signal: controller.signal })).finally(function () {
        clearTimeout(timer);
    });
}

export default async function handler(req) {
    // CORS 预检
    if (req.method === 'OPTIONS') {
        const headers = new Headers(CORS_HEADERS);
        const requestedHeaders = req.headers.get('access-control-request-headers');
        if (requestedHeaders) headers.set('Access-Control-Allow-Headers', requestedHeaders);
        return new Response(null, { status: 204, headers });
    }

    // 代理密钥校验
    const expectedKey = process.env.PROXY_KEY;
    if (expectedKey) {
        const providedKey = req.headers.get('x-proxy-key') || '';
        if (providedKey !== expectedKey) {
            return corsJson(403, { error: '代理密钥错误 (X-Proxy-Key)' });
        }
    }

    // 解析目标 URL
    const url = new URL(req.url);
    const target = url.searchParams.get('target');
    if (!target) return corsJson(400, { error: '缺少 ?target=<MCP服务器URL> 参数' });
    const blocked = blockedTargetReason(target);
    if (blocked) return corsJson(400, { error: blocked });

    // 构造转发请求头
    const fwdHeaders = new Headers();
    for (let i = 0; i < FORWARD_REQUEST_HEADERS.length; i++) {
        const name = FORWARD_REQUEST_HEADERS[i];
        const v = req.headers.get(name);
        if (v) fwdHeaders.set(name, v);
    }
    const customHeaderNames = (req.headers.get('x-mcp-forward-headers') || '')
        .split(',').map(function (n) { return n.trim(); }).filter(Boolean);
    for (let i = 0; i < customHeaderNames.length; i++) {
        const name = customHeaderNames[i];
        if (BLOCKED_FORWARD_HEADERS.has(name.toLowerCase())) continue;
        const v = req.headers.get(name);
        if (v) fwdHeaders.set(name, v);
    }

    // 转发
    let upstream;
    try {
        const method = req.method.toUpperCase();
        const fetchOpts = { method, headers: fwdHeaders };
        if (method !== 'GET' && method !== 'HEAD') {
            fetchOpts.body = req.body;
            fetchOpts.duplex = 'half';
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

    // 透传响应
    const respHeaders = new Headers(CORS_HEADERS);
    const passthroughHeaderNames = ['content-type', 'mcp-session-id', 'www-authenticate', 'cache-control'];
    for (let i = 0; i < passthroughHeaderNames.length; i++) {
        const name = passthroughHeaderNames[i];
        const v = upstream.headers.get(name);
        if (v) respHeaders.set(name, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

export const config = {
    // 允许 body 透传 (Vercel 默认会截断 body, runtime: 'nodejs' 解决)
    runtime: 'nodejs',
};
