// 本地模拟 worker 行为, 跑通到 mcd.cn 的端到端, 证明 worker.js 逻辑没问题
// 用法: node verify-locally.mjs <mcd_token>
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const token = process.argv[2];
if (!token) { console.error('用法: node verify-locally.mjs <mcd_token>'); process.exit(1); }

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate, Content-Type',
};

const BLOCKED = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade']);

const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
    }
    const url = new URL(req.url, `http://localhost`);
    const target = url.searchParams.get('target');
    if (!target) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: '缺 target' }));
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

    const upstream = await fetch(target, { method: req.method, headers: fwdHeaders, body: body.length ? body : undefined });

    const out = new Headers(CORS);
    for (const h of ['content-type', 'mcp-session-id', 'cache-control']) {
        const v = upstream.headers.get(h);
        if (v) out.set(h, v);
    }
    res.writeHead(upstream.status, out);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
    console.log(`[proxy]   <- ${upstream.status} ${buf.length}B ct=${upstream.headers.get('content-type')}`);
});

const PORT = 18099;
server.listen(PORT, async () => {
    console.log(`本地代理跑在 http://127.0.0.1:${PORT}`);
    console.log('--- 端到端验证 ---');

    async function call(body, label) {
        const r = await fetch(`http://127.0.0.1:${PORT}/?target=${encodeURIComponent('https://mcp.mcd.cn/')}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(body),
        });
        const text = await r.text();
        console.log(`[${label}] status=${r.status} len=${text.length}`);
        if (text.length < 500) console.log(`   ${text}`);
        return text;
    }

    await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'local-verify', version: '0' } } }, 'initialize');
    await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'initialized');

    const qnsText = await call({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'query-nearby-stores', arguments: { beType: 1, searchType: 2, city: '北京', keyword: '朝阳' } } }, 'qns');
    const scMatch = qnsText.match(/"storeCode":"([^"]+)"/);
    if (scMatch) {
        const sc = scMatch[1];
        console.log(`\n>>> 拿到 storeCode: ${sc}`);
        const qmText = await call({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'query-meals', arguments: { storeCode: sc, orderType: 1, beType: 1 } } }, 'qm');
        const catCount = (qmText.match(/"name":"[^"]+"/g) || []).length;
        const codeCount = (qmText.match(/"code":"[^"]+"/g) || []).length;
        console.log(`\n>>> 菜单: 分类数=${catCount}, 餐品 code=${codeCount}`);
    }
    server.close();
});
