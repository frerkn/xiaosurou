/**
 * 瑞幸 MCP 代理 (Netlify Function 版)
 * - 接收前端 POST /.netlify/functions/mcp-luckin
 * - body: MCP JSON-RPC 2.0 请求体（透传）
 * - headers:
 *     Authorization: Bearer <user_mcp_token>     ← 必填
 *     Mcp-Session-Id: <id>                       ← 可选
 * - 透传到 https://gwmcp.lkcoffee.com/order/user/mcp
 *
 * 流程（参考糯米机 worker/index.js:2785-2819 + utils/luckinMcpClient.ts）：
 *   frontend fetch --this-fn--> gwmcp.lkcoffee.com (官方瑞幸 MCP server)
 *
 * 配置：
 *   Netlify 环境变量 LUCKIN_MCP_UPSTREAM（可选，默认 https://gwmcp.lkcoffee.com/order/user/mcp）
 *
 * 参考：
 *   - 糯米机 worker 的 /mcp/luckin 路由 (worker/index.js:2785-2819)
 *   - 瑞幸开放平台：https://open.lkcoffee.com（Token 有效约 1 个月）
 */

const LUCKIN_MCP_UPSTREAM =
    process.env.LUCKIN_MCP_UPSTREAM ||
    'https://gwmcp.lkcoffee.com/order/user/mcp';

const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = 'ePhone-MCP-Proxy/1.0';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Accept',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, Content-Type',
    'Access-Control-Max-Age': '86400',
};

function jsonResponse(statusCode, payload, extraHeaders = {}) {
    return {
        statusCode,
        headers: {
            ...corsHeaders,
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...extraHeaders,
        },
        body: JSON.stringify(payload),
    };
}

function passthroughResponse(statusCode, contentType, text, sessionId) {
    const headers = {
        ...corsHeaders,
        'Content-Type': contentType || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    return { statusCode, headers, body: text };
}

function fetchWithTimeout(url, opts, timeoutMs) {
    if (typeof AbortController === 'undefined') return fetch(url, opts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...opts, signal: controller.signal }).finally(() =>
        clearTimeout(timer)
    );
}

exports.handler = async function (event) {
    // CORS 预检
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return jsonResponse(405, {
            error: 'Method Not Allowed',
            message: 'mcp-luckin proxy only accepts POST.',
        });
    }

    const auth = event.headers.authorization || event.headers.Authorization;
    if (!auth || !auth.trim()) {
        return jsonResponse(401, {
            error: 'Missing Authorization header',
            message: '请在 330 设置 → 外卖点单 里填入瑞幸 MCP Token（有效期约 1 个月，过期要刷新）',
        });
    }

    const fwdHeaders = {
        'Authorization': auth,
        'Content-Type':
            event.headers['content-type'] ||
            event.headers['Content-Type'] ||
            'application/json',
        'Accept':
            event.headers.accept ||
            event.headers.Accept ||
            'application/json, text/event-stream',
        'User-Agent': USER_AGENT,
    };
    const sid =
        event.headers['mcp-session-id'] ||
        event.headers['Mcp-Session-Id'];
    if (sid) fwdHeaders['Mcp-Session-Id'] = sid;

    try {
        const res = await fetchWithTimeout(
            LUCKIN_MCP_UPSTREAM,
            { method: 'POST', headers: fwdHeaders, body: event.body || '' },
            FETCH_TIMEOUT_MS
        );

        const text = await res.text();
        const respCt = res.headers.get('content-type') || 'application/json; charset=utf-8';
        const respSid =
            res.headers.get('mcp-session-id') ||
            res.headers.get('Mcp-Session-Id') ||
            undefined;

        return passthroughResponse(res.status, respCt, text, respSid);
    } catch (e) {
        const aborted = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
        return jsonResponse(aborted ? 504 : 502, {
            error: aborted ? 'Luckin MCP upstream timeout' : 'Luckin MCP upstream fetch failed',
            detail: (e && e.message) || String(e),
            upstream: LUCKIN_MCP_UPSTREAM,
        });
    }
};
