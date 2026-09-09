// 本地 MCP 代理 (常驻版, 替代 CF worker)
// 用途: 330 MCP 配 proxyUrl = http://localhost:18099, 浏览器 fetch localhost 不需要梯
// 跑: node mcp-bridge-local.mjs
// 停: Ctrl+C

import { createServer } from 'node:http';

const PORT = 18099;
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate, Content-Type, Content-Length',
    'Access-Control-Max-Age': '86400',
};

const BLOCKED = new Set([
    'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
    'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
    'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip',
]);

function corsJson(status, obj) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS },
    });
}

const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const target = url.searchParams.get('target');
    if (!target) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: '缺 ?target= 参数' }));
        return;
    }

    // 透传所有 header (除了 blocked)
    const fwdHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
        if (BLOCKED.has(name.toLowerCase())) continue;
        fwdHeaders[name] = value;
    }

    // 收 body
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    console.log(`[proxy] ${req.method} ${target}  hdrs=${Object.keys(fwdHeaders).length} body=${body.length}B`);

    try {
        const upstream = await fetch(target, {
            method: req.method,
            headers: fwdHeaders,
            body: body.length ? body : undefined,
        });
        const out = { ...CORS };
        for (const h of ['content-type', 'mcp-session-id', 'www-authenticate', 'cache-control']) {
            const v = upstream.headers.get(h);
            if (v) out[h] = v;
        }
        res.writeHead(upstream.status, out);
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.end(buf);
        console.log(`[proxy]   <- ${upstream.status} ${buf.length}B ct=${upstream.headers.get('content-type')}`);
    } catch (e) {
        console.log(`[proxy]   ERR ${e.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: e.message }));
    }
});

server.listen(PORT, () => {
    console.log(`✓ 本地 MCP 代理跑在 http://localhost:${PORT}`);
    console.log(`  330 配 proxyUrl = http://localhost:${PORT}`);
    console.log(`  浏览器 fetch localhost 不需要梯`);
    console.log(`  按 Ctrl+C 停止`);
});
