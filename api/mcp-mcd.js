/**
 * 麦当劳 MCP 代理 (Vercel API Route - CommonJS 版)
 *
 * 跟同目录的 openai-proxy.js 保持 CommonJS 风格
 * 关闭 Vercel 默认 bodyParser，自己从 stream 读 rawBody（仿糯米机 worker request.text() 模式）
 *
 * 测试：
 *   curl -X POST https://<app>.vercel.app/api/mcp-mcd \
 *     -H "Authorization: Bearer xxx" \
 *     -H "Content-Type: application/json" \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'
 *
 * 配置 (Vercel Environment Variables, 可选):
 *   MCD_MCP_UPSTREAM  默认 https://mcp.mcd.cn
 */

const MCD_MCP_UPSTREAM =
    process.env.MCD_MCP_UPSTREAM || 'https://mcp.mcd.cn';

const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = 'ePhone-MCP-Proxy/1.0';

// 用 Vercel 默认 bodyParser（开启）—— req.body 已经是解析后的对象/字符串
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
    console.log('[mcp-mcd]', req.method, '| host:', req.headers.host, '| ct:', req.headers['content-type']);

    applyCors(res);

    if (req.method === 'OPTIONS') {
        console.log('[mcp-mcd] OPTIONS preflight → 204');
        res.statusCode = 204;
        res.end();
        return;
    }

    if (req.method !== 'POST') {
        console.warn('[mcp-mcd] wrong method:', req.method);
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
            error: 'Method Not Allowed',
            message: 'mcp-mcd proxy only accepts POST.',
        }));
        return;
    }

    const auth = req.headers.authorization || req.headers.Authorization;
    if (!auth || !String(auth).trim()) {
        console.warn('[mcp-mcd] missing Authorization header');
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
            error: 'Missing Authorization header',
            message: '请在 330 设置 → 外卖点单 里填入麦当劳 MCP Token',
        }));
        return;
    }

    // 走 raw stream 读 body（仿糯米机 worker 的 await request.text()）
    let rawBody = '';
    try {
        rawBody = await readRawBody(req);
    } catch (e) {
        console.error('[mcp-mcd] readRawBody error:', e);
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Failed to read request body', detail: e.message }));
        return;
    }
    console.log('[mcp-mcd] body len:', rawBody.length, '| first 200:', rawBody.slice(0, 200) || '(empty)');

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

    console.log('[mcp-mcd] forwarding to upstream:', MCD_MCP_UPSTREAM);

    try {
        const upstreamRes = await fetchWithTimeout(
            MCD_MCP_UPSTREAM,
            { method: 'POST', headers: fwdHeaders, body: rawBody },
            FETCH_TIMEOUT_MS
        );

        const text = await upstreamRes.text();
        const ct = upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8';
        const newSid =
            upstreamRes.headers.get('mcp-session-id') ||
            upstreamRes.headers.get('Mcp-Session-Id');

        console.log('[mcp-mcd] upstream', upstreamRes.status, '| body len:', text.length, '| took:', (Date.now() - startedAt), 'ms');

        if (newSid) res.setHeader('Mcp-Session-Id', newSid);
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'no-store');
        res.statusCode = upstreamRes.status;
        res.end(text);
    } catch (e) {
        const aborted = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
        console.error('[mcp-mcd] upstream fetch failed:', aborted ? 'TIMEOUT' : 'NETWORK', '|', e && e.message);
        res.statusCode = aborted ? 504 : 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
            error: aborted ? 'McDonald MCP upstream timeout' : 'McDonald MCP upstream fetch failed',
            detail: (e && e.message) || String(e),
            upstream: MCD_MCP_UPSTREAM,
        }));
    }
};