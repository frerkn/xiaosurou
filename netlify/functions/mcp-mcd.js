/**
 * 麦当劳 MCP 代理 (Netlify Function 版)
 * - 接收前端 POST /.netlify/functions/mcp-mcd
 * - body: MCP JSON-RPC 2.0 请求体（透传，不解析）
 * - headers:
 *     Authorization: Bearer <user_mcp_token>     ← 必填
 *     Mcp-Session-Id: <id>                       ← 可选，从上游响应透回
 * - 透传到 https://mcp.mcd.cn
 * - 透传 Content-Type / Accept / Authorization / Mcp-Session-Id
 * - 完全不存 token（透传代理，零信任）
 *
 * 流程（参考糯米机 worker/index.js:2749-2819 + utils/mcdMcpClient.ts）：
 *   frontend fetch --this-fn--> mcp.mcd.cn (官方 MCP server)
 *
 * 配置：
 *   Netlify 环境变量 MCD_MCP_UPSTREAM（可选，默认 https://mcp.mcd.cn）
 *
 * 参考：
 *   - 糯米机 worker 的 /mcp/mcd 路由 (worker/index.js:2749-2783)
 *   - MCP 协议：https://modelcontextprotocol.io
 *   - 麦当劳开放平台：https://open.mcd.cn/mcp
 */

const MCD_MCP_UPSTREAM =
    process.env.MCD_MCP_UPSTREAM || 'https://mcp.mcd.cn';

const FETCH_TIMEOUT_MS = 30_000; // MCP tools/list / tools/call 可能稍慢，给 30s
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
            message: 'mcp-mcd proxy only accepts POST.',
        });
    }

    const auth = event.headers.authorization || event.headers.Authorization;
    if (!auth || !auth.trim()) {
        return jsonResponse(401, {
            error: 'Missing Authorization header',
            message: '请在 330 设置 → 外卖点单 里填入麦当劳 MCP Token',
        });
    }

    // 取上游所需的 headers — 透传用户的 Authorization + Content-Type + Accept + Mcp-Session-Id
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
            MCD_MCP_UPSTREAM,
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
            error: aborted ? 'McDonald MCP upstream timeout' : 'McDonald MCP upstream fetch failed',
            detail: (e && e.message) || String(e),
            upstream: MCD_MCP_UPSTREAM,
        });
    }
};
