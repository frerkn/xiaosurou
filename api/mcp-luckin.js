/**
 * 瑞幸 MCP 代理 (Vercel API Route - CommonJS 版)
 *
 * 跟同目录的 openai-proxy.js 保持 CommonJS 风格 (require / module.exports)
 * 关闭 Vercel 默认 bodyParser 自己从 stream 读 rawBody（仿糯米机 worker 的 request.text() 模式）
 *
 * 测试：
 *   curl -X POST https://<app>.vercel.app/api/mcp-luckin \
 *     -H "Authorization: Bearer xxx" \
 *     -H "Content-Type: application/json" \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'
 *
 * 配置 (Vercel Environment Variables, 可选):
 *   LUCKIN_MCP_UPSTREAM  默认 https://gwmcp.lkcoffee.com/order/user/mcp
 *
 * 参考：糯米机 utils/luckinMcpClient.ts + worker/index.js 路由模式
 */

const LUCKIN_MCP_UPSTREAM =
    process.env.LUCKIN_MCP_UPSTREAM ||
    'https://gwmcp.lkcoffee.com/order/user/mcp';

const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = 'ePhone-MCP-Proxy/1.0';

// 关掉 Vercel 默认 bodyParser，自己读 raw stream（仿糯米机 worker await request.text()）
module.exports.config = {
    runtime: 'nodejs18.x',
    api: {
        bodyParser: false,
    },
};

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Accept',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, Content-Type',
    'Access-Control-Max-Age': '86400',
};

function applyCors(res) {
    for (const k of Object.keys(CORS_HEADERS)) res.setHeader(k, CORS_HEADERS[k]);
}

function readRawBody(req) {
    return new Promise(function (resolve, reject) {
        const chunks = [];
        req.on('data', function (c) { chunks.push(c); });
        req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
        req.on('error', reject);
    });
}

function fetchWithTimeout(url, opts, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch(url, Object.assign({}, opts, { signal: controller.signal }))
        .finally(function () { clearTimeout(timer); });
}

module.exports = async function handler(req, res) {
    const startedAt = Date.now();
    console.log('[mcp-luckin]', req.method, '| host:', req.headers.host, '| ct:', req.headers['content-type']);

    applyCors(res);

    if (req.method === 'OPTIONS') {
        console.log('[mcp-luckin] OPTIONS preflight → 204');
        res.statusCode = 204;
        res.end();
        return;
    }

    if (req.method !== 'POST') {
        console.warn('[mcp-luckin] wrong method:', req.method);
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
            error: 'Method Not Allowed',
            message: 'mcp-luckin proxy only accepts POST.',
        }));
        return;
    }

    const auth = req.headers.authorization || req.headers.Authorization;
    if (!auth || !String(auth).trim()) {
        console.warn('[mcp-luckin] missing Authorization header');
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
            error: 'Missing Authorization header',
            message: '请在 330 设置 → 外卖点单 里填入瑞幸 MCP Token（有效期约 1 个月，过期要刷新）',
        }));
        return;
    }

    // 走 raw stream 读 body（仿糯米机 worker 的 await request.text()）
    let rawBody = '';
    try {
        rawBody = await readRawBody(req);
    } catch (e) {
        console.error('[mcp-luckin] readRawBody error:', e);
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Failed to read request body', detail: e.message }));
        return;
    }
    console.log('[mcp-luckin] body len:', rawBody.length, '| first 200:', rawBody.slice(0, 200) || '(empty)');

    const fwdHeaders = {
        'Authorization': auth,
        'Content-Type':
            req.headers['content-type'] ||
            req.headers['Content-Type'] ||
            'application/json',
        'Accept':
            req.headers.accept ||
            req.headers.Accept ||
            'application/json, text/event-stream',
        'User-Agent': USER_AGENT,
    };
    const sid = req.headers['mcp-session-id'] || req.headers['Mcp-Session-Id'];
    if (sid) fwdHeaders['Mcp-Session-Id'] = sid;

    console.log('[mcp-luckin] forwarding to upstream:', LUCKIN_MCP_UPSTREAM);

    try {
        const upstreamRes = await fetchWithTimeout(
            LUCKIN_MCP_UPSTREAM,
            { method: 'POST', headers: fwdHeaders, body: rawBody },
            FETCH_TIMEOUT_MS
        );

        const text = await upstreamRes.text();
        const ct = upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8';
        const newSid =
            upstreamRes.headers.get('mcp-session-id') ||
            upstreamRes.headers.get('Mcp-Session-Id');

        console.log('[mcp-luckin] upstream', upstreamRes.status, '| body len:', text.length, '| took:', (Date.now() - startedAt), 'ms');

        if (newSid) res.setHeader('Mcp-Session-Id', newSid);
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'no-store');
        res.statusCode = upstreamRes.status;
        res.end(text);
    } catch (e) {
        const aborted = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
        console.error('[mcp-luckin] upstream fetch failed:', aborted ? 'TIMEOUT' : 'NETWORK', '|', e && e.message);
        res.statusCode = aborted ? 504 : 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
            error: aborted ? 'Luckin MCP upstream timeout' : 'Luckin MCP upstream fetch failed',
            detail: (e && e.message) || String(e),
            upstream: LUCKIN_MCP_UPSTREAM,
        }));
    }
};