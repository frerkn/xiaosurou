/**
 * 麦当劳 MCP CORS 代理 (Cloudflare Worker)
 *
 * 部署: wrangler deploy
 * 部署后: 330 MCP 配 proxyUrl = https://<name>.<subdomain>.workers.dev
 *        server.url = https://mcp.mcd.cn/
 *        bearerToken = <你的 mcd token>
 *
 * 关键设计: **透传所有请求 header** (User-Agent / Accept-Encoding / Accept-Language 等),
 *   不像通用 worker 只透传 5 个精选头。原因: mcd.cn 看到非标准 MCP 客户端会软拒绝
 *   (返 202 + Content-Length: 0 + 0 帧 SSE), 5 秒后超时, 看起来像"没菜单"。
 *   透传浏览器默认 header 后, mcd.cn 返 200 + 完整 serverInfo, 一切正常。
 */

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate, Content-Type, Content-Length',
    'Access-Control-Max-Age': '86400',
};

// 绝对不能透传的 header (会破坏 fetch / 代理语义)
const BLOCKED = new Set([
    'host',           // Worker → 目标 server 必须用自己的 host
    'connection',
    'content-length', // fetch 会自动算
    'transfer-encoding',
    'upgrade',
    'cf-connecting-ip',
    'cf-ipcountry',
    'cf-ray',
    'cf-visitor',
    'x-forwarded-proto',
    'x-forwarded-for',
    'x-real-ip',
]);

function blockedTargetReason(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch { return 'target 不是合法 URL'; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '只允许 http/https';
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
        return '不允许代理内网/本机地址';
    }
    return null;
}

function corsJson(status, obj) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

export default {
    async fetch(request, env) {
        // 1. CORS 预检
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // 2. 可选密钥 (防白嫖流量)
        if (env.PROXY_KEY) {
            const k = request.headers.get('x-proxy-key') || '';
            if (k !== env.PROXY_KEY) return corsJson(403, { error: '代理密钥错误' });
        }

        // 3. 拿 ?target=
        const target = new URL(request.url).searchParams.get('target');
        if (!target) return corsJson(400, { error: '缺少 ?target=<MCP服务器URL> 参数' });
        const blocked = blockedTargetReason(target);
        if (blocked) return corsJson(400, { error: blocked });

        // 4. **透传所有 header** (除了 blocked 列表里的) — 这是 mcd.cn 能正常工作的关键
        const fwdHeaders = new Headers();
        for (const [name, value] of request.headers.entries()) {
            if (BLOCKED.has(name.toLowerCase())) continue;
            fwdHeaders.set(name, value);
        }

        // 5. 转发
        let upstream;
        try {
            upstream = await fetch(target, {
                method: request.method,
                headers: fwdHeaders,
                body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
            });
        } catch (e) {
            return corsJson(502, { error: `转发失败: ${e.message}` });
        }

        // 6. 透传响应 body (SSE 流也跟着透), 补 CORS 头
        const respHeaders = new Headers(CORS_HEADERS);
        // 上游关键响应头透传 (mcp-session-id 跟会话有关)
        for (const name of ['content-type', 'mcp-session-id', 'www-authenticate', 'cache-control']) {
            const v = upstream.headers.get(name);
            if (v) respHeaders.set(name, v);
        }
        return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
    },
};
