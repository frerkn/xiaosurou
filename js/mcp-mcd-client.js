/* ====================================================================
 * 麦当劳 MCP 客户端 (Model Context Protocol over HTTP+SSE, JSON-RPC 2.0)
 * 官方服务器: https://mcp.mcd.cn
 * 文档: https://open.mcd.cn/mcp/doc
 * Token 申请: https://open.mcd.cn/mcp
 *
 * 走 Netlify Function 透传代理: /.netlify/functions/mcp-mcd
 *   （CORS + 透传 Authorization/Mcp-Session-Id → mcp.mcd.cn，不存 token）
 *
 * 与糯米机 utils/mcdMcpClient.ts 等价（vanilla JS 版）
 * 暴露为 window.McpMcdClient
 * ==================================================================== */

(function (global) {
    'use strict';

    // 双平台支持：默认 Vercel (/api)，自动探测后缓存到 localStorage
    const NETLIFY_PATH = '/.netlify/functions/mcp-mcd';
    const VERCEL_PATH = '/api/mcp-mcd';
    const PROXY_BASE_KEY = 'ephone.mcpProxyBaseMcd';
    let resolvedProxyUrl = null;
    let lastFailedPath = null;

    // 根据当前域名直接判断该用哪条 path（不靠 localStorage 缓存）
    function getProxyUrlByHostname() {
        let host = '';
        try { host = (typeof location !== 'undefined' && location.hostname) || ''; } catch (e) {}
        const h = String(host).toLowerCase();
        if (!h) return null;
        if (h.indexOf('netlify') >= 0) return NETLIFY_PATH;
        if (h.indexOf('vercel') >= 0) return VERCEL_PATH;
        return null;
    }

    function getProxyUrl() {
        if (resolvedProxyUrl) return resolvedProxyUrl;
        const byHost = getProxyUrlByHostname();
        if (byHost) {
            resolvedProxyUrl = byHost;
            try { localStorage.setItem(PROXY_BASE_KEY, byHost); } catch (e) {}
            return byHost;
        }
        try {
            const cached = localStorage.getItem(PROXY_BASE_KEY);
            if (cached === NETLIFY_PATH || cached === VERCEL_PATH) {
                resolvedProxyUrl = cached;
                return cached;
            }
        } catch (e) {}
        resolvedProxyUrl = VERCEL_PATH;
        return resolvedProxyUrl;
    }
    function setProxyUrl(p) {
        resolvedProxyUrl = p;
        try { localStorage.setItem(PROXY_BASE_KEY, p); } catch (e) {}
    }
    async function detectAndCacheProxyBase() {
        const candidates = [VERCEL_PATH, NETLIFY_PATH];
        for (const c of candidates) {
            if (c === lastFailedPath) continue;
            try {
                const ctrl = new AbortController();
                const tm = setTimeout(function () { ctrl.abort(); }, 3000);
                const r = await fetch(c, { method: 'OPTIONS', signal: ctrl.signal });
                clearTimeout(tm);
                if (r.status === 204 || r.status === 200 || r.status === 405) {
                    setProxyUrl(c);
                    return c;
                }
                if (r.status === 404) lastFailedPath = c;
            } catch (e) { /* 网络错误，试下一个 */ }
        }
        if (!resolvedProxyUrl) resolvedProxyUrl = VERCEL_PATH;
        return resolvedProxyUrl;
    }
    // 404 自动重探测：当前 path 在当前域名下不存在 → 切到另一个 path 重试 fetch
    async function refetchWithProxyFallback(originalFetchArgs) {
        const failedPath = getProxyUrl();
        lastFailedPath = failedPath;
        console.warn('[MCD-MCP] 当前代理 path', failedPath, '返回 404 — 重新探测另一个平台');
        resolvedProxyUrl = null;
        const byHost = getProxyUrlByHostname();
        if (byHost && byHost !== failedPath) {
            console.log('[MCD-MCP] hostname 强制切到', byHost, '重试 fetch');
            resolvedProxyUrl = byHost;
            try { localStorage.setItem(PROXY_BASE_KEY, byHost); } catch (e) {}
            return await fetch(byHost, originalFetchArgs);
        }
        const newPath = await detectAndCacheProxyBase();
        if (newPath === failedPath) {
            console.warn('[MCD-MCP] 另一个平台也探测失败，放弃重试');
            return null;
        }
        console.log('[MCD-MCP] 切到', newPath, '重试 fetch');
        return await fetch(newPath, originalFetchArgs);
    }

    const TOKEN_KEY = 'ephone.mcd.mcpToken';
    const ENABLED_KEY = 'ephone.mcd.mcpEnabled';

    // ====== JSON-RPC 解析 ======

    function buildRequest(method, params, isNotification) {
        const req = { jsonrpc: '2.0', method, params };
        if (!isNotification) req.id = ++requestIdCounter;
        return req;
    }

    function parseSse(text) {
        const dataLines = [];
        for (const line of text.split('\n')) {
            if (line.startsWith('data: ')) dataLines.push(line.slice(6));
            else if (line.startsWith('data:')) dataLines.push(line.slice(5));
        }
        for (let i = dataLines.length - 1; i >= 0; i--) {
            try {
                return JSON.parse(dataLines[i]);
            } catch (e) { /* try previous */ }
        }
        return null;
    }

    function parseResp(text, contentType) {
        if (contentType && contentType.indexOf('text/event-stream') >= 0 || /^\s*(event:|data:)/.test(text)) {
            const parsed = parseSse(text);
            if (parsed) return parsed;
        }
        try { return JSON.parse(text); } catch (e) {
            const m = text.match(/\{[\s\S]*\}/);
            if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* fall */ } }
            throw new Error('MCP: 无法解析响应: ' + text.slice(0, 300));
        }
    }

    // ====== session 状态（内存） ======

    let requestIdCounter = 0;
    let sessionId = null;
    let initialized = false;
    let cachedTools = [];
    let initPromise = null;
    let lastInitError = null;
    let lastToolsListResp = null;

    function getToken() {
        try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
    }
    function setToken(t) {
        try { localStorage.setItem(TOKEN_KEY, (t || '').trim()); } catch (e) {}
    }
    function isEnabled() {
        try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch (e) { return false; }
    }
    function setEnabled(v) {
        try { localStorage.setItem(ENABLED_KEY, v ? '1' : '0'); } catch (e) {}
    }
    function isConfigured() { return isEnabled() && getToken().length > 0; }

    // 暴露给设置面板做本地导入导出
    function exportLocal() {
        const out = {};
        try {
            const tk = localStorage.getItem(TOKEN_KEY); if (tk) out[TOKEN_KEY] = tk;
            const en = localStorage.getItem(ENABLED_KEY); if (en) out[ENABLED_KEY] = en;
        } catch (e) {}
        return Object.keys(out).length ? out : undefined;
    }
    function importLocal(data) {
        if (!data || typeof data !== 'object') return;
        try {
            if (typeof data[TOKEN_KEY] === 'string') localStorage.setItem(TOKEN_KEY, data[TOKEN_KEY]);
            if (typeof data[ENABLED_KEY] === 'string') localStorage.setItem(ENABLED_KEY, data[ENABLED_KEY]);
        } catch (e) {}
    }

    async function post(body, expectResponse) {
        const token = getToken();
        if (!token) throw new Error('未设置麦当劳 MCP Token，请到设置 → 外卖点单 填写');

        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Authorization': 'Bearer ' + token,
        };
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;

        const fetchArgs = { method: 'POST', headers, body: JSON.stringify(body) };
        let resp = await fetch(getProxyUrl(), fetchArgs);

        // 404 = 当前 path 在当前域名下根本不存在，自动切到另一个平台重试一次
        if (resp.status === 404) {
            const retried = await refetchWithProxyFallback(fetchArgs);
            if (retried) resp = retried;
        }

        const newSid = resp.headers.get('Mcp-Session-Id') || resp.headers.get('mcp-session-id');
        if (newSid) sessionId = newSid;

        if (resp.status === 401 || resp.status === 403) {
            const txt = await resp.text().catch(() => '');
            throw new Error('MCP 鉴权失败 (' + resp.status + '): Token 可能过期，请重新到 open.mcd.cn/mcp 申请。' + txt.slice(0, 120));
        }
        if (resp.status === 202) return { response: null };
        if (!resp.ok) {
            const txt = await resp.text().catch(() => '');
            throw new Error('MCP HTTP ' + resp.status + ': ' + txt.slice(0, 200));
        }
        if (!expectResponse) return { response: null };

        const ct = resp.headers.get('content-type') || '';
        const text = await resp.text();
        return { response: parseResp(text, ct) };
    }

    async function doInitialize() {
        lastInitError = null;
        lastToolsListResp = null;
        const initReq = buildRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'EPhone-AI-Takeout', version: '1.0.0' },
        });
        const { response } = await post(initReq);
        if (response && response.error) {
            lastInitError = 'initialize: ' + (response.error.message || JSON.stringify(response.error));
            throw new Error('Initialize 失败: ' + response.error.message);
        }
        const notif = buildRequest('notifications/initialized', {}, true);
        await post(notif, false).catch(() => { /* notification 不必在意 */ });

        // 仿糯米机：silent catch + initialized=true —— 即使 tools/list 失败也保留 session
        // 失败原因存 lastInitError 让诊断 modal 能看到（不影响 callTool 直接调）
        try {
            const { response: toolsResp } = await post(buildRequest('tools/list'));
            lastToolsListResp = toolsResp;
            if (toolsResp && toolsResp.result && Array.isArray(toolsResp.result.tools)) {
                cachedTools = toolsResp.result.tools.map(function (t) {
                    return {
                        name: t.name,
                        description: t.description || '',
                        inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
                    };
                });
                console.log('[MCD-MCP] 工具清单:', cachedTools.map(function (t) { return t.name; }).join(', '));
            } else if (toolsResp && toolsResp.error) {
                lastInitError = 'tools/list error: ' + (toolsResp.error.message || JSON.stringify(toolsResp.error));
                console.warn('[MCD-MCP] tools/list 返回 error，初始化标记成功但工具为空:', lastInitError);
            } else {
                lastInitError = 'tools/list 返回空 / 形态异常: keys=' + JSON.stringify(Object.keys((toolsResp && toolsResp.result) || {}));
                console.warn('[MCD-MCP] tools/list 空响应，初始化标记成功但工具为空');
            }
        } catch (e) {
            lastInitError = 'tools/list threw: ' + (e && e.message || String(e));
            console.warn('[MCD-MCP] tools/list 抛错，初始化标记成功但工具为空:', lastInitError);
        }
        // 关键：不管 tools/list 结果如何，initialized 都置 true —— 这样 callTool 还能直接调
        initialized = true;
    }

    function ensureInitialized() {
        if (initialized) return Promise.resolve();
        if (!initPromise) {
            initPromise = doInitialize().catch(function (e) {
                initPromise = null;
                throw e;
            });
        }
        return initPromise;
    }

    // ====== 工具名规范化（清掉模型偶尔加的前缀 / 点分命名空间） ======

    function normalizeToolName(toolName) {
        const raw = (toolName || '').trim();
        if (!raw) return raw;
        let s = raw;
        const lastDot = s.lastIndexOf('.');
        if (lastDot >= 0 && lastDot < s.length - 1) s = s.slice(lastDot + 1);
        s = s
            .replace(/^mcd[_-]?tools?[_-]/i, '')
            .replace(/^mcd[_-]?goodies[_-]/i, '')
            .trim();
        return s || raw;
    }

    function hasAnyCodeArg(args, keys) {
        return keys.some(function (k) {
            const v = args && args[k];
            if (Array.isArray(v)) return v.length > 0;
            if (typeof v === 'string') return v.trim().length > 0;
            return false;
        });
    }

    // ====== 参数归一化 ======
    //   - orderType 1/2 字符串 → 数字
    //   - items[].productCode 别名（code / skuCode / mealCode）→ productCode
    //   - orderType=1（堂食）时 beCode 留空

    function normalizeMcdArgs(toolName, args) {
        if (!/calculate[-_]?price|create[-_]?order|submit[-_]?order/i.test(toolName)) return args;
        const out = Object.assign({}, args || {});
        if (out.orderType != null) {
            const t = out.orderType;
            if (typeof t === 'string') {
                const s = t.trim().toLowerCase();
                if (s === '1' || s === 'pickup' || s === 'dine-in' || s === 'dine_in' || s === 'carryout' || s === 'in-store') out.orderType = 1;
                else if (s === '2' || s === 'delivery') out.orderType = 2;
                else if (/^\d+$/.test(s)) out.orderType = parseInt(s, 10);
            }
        }
        if (Array.isArray(out.items)) {
            out.items = out.items.map(function (it) {
                if (!it || typeof it !== 'object') return it;
                const ni = Object.assign({}, it);
                if (ni.quantity != null && typeof ni.quantity === 'string' && /^\d+$/.test(ni.quantity.trim())) {
                    ni.quantity = parseInt(ni.quantity.trim(), 10);
                }
                if (!ni.productCode) {
                    if (ni.code) ni.productCode = ni.code;
                    else if (ni.skuCode) ni.productCode = ni.skuCode;
                    else if (ni.mealCode) ni.productCode = ni.mealCode;
                }
                return ni;
            });
        }
        if (out.orderType === 1 && out.beCode === '') delete out.beCode;
        return out;
    }

    // ====== 响应解析（兼容 markdown 嵌 JSON / 信封包 / SSE） ======

    function tryDeepParse(v) {
        if (typeof v === 'string') {
            const s = v.trim();
            if (s.startsWith('{') || s.startsWith('[')) {
                try { return tryDeepParse(JSON.parse(s)); } catch (e) { return v; }
            }
            return v;
        }
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const envelopeKeys = ['success', 'code', 'message', 'datetime', 'traceId', 'msg', 'errorCode', 'errMsg'];
            if ('data' in v && envelopeKeys.some(function (k) { return k in v; })) {
                const inner = v.data;
                if (inner && typeof inner === 'object') return tryDeepParse(inner);
                if (typeof inner === 'string') {
                    const s = inner.trim();
                    if (s.startsWith('{') || s.startsWith('[')) {
                        try { return tryDeepParse(JSON.parse(s)); } catch (e) { return s; }
                    }
                    return s;
                }
                return inner;
            }
            const wrapKeys = ['data', 'result', 'response', 'body', 'payload'];
            const keys = Object.keys(v);
            if (keys.length === 1 && wrapKeys.indexOf(keys[0]) >= 0 && typeof v[keys[0]] === 'string') {
                const inner = tryDeepParse(v[keys[0]]);
                if (inner && typeof inner === 'object') return inner;
            }
            const out = {};
            for (const k of keys) {
                const cv = v[k];
                if (typeof cv === 'string') {
                    const s = cv.trim();
                    if (s.startsWith('{') || s.startsWith('[')) {
                        try { out[k] = JSON.parse(s); continue; } catch (e) {}
                    }
                }
                out[k] = cv;
            }
            return out;
        }
        return v;
    }

    function tryExtractJsonFromMixed(text) {
        if (!text) return undefined;
        function safeParse(s) {
            try { return JSON.parse(s); } catch (e) { /* repair */ }
            try {
                let inStr = false, esc = false, out = '';
                for (let i = 0; i < s.length; i++) {
                    const ch = s[i];
                    if (esc) { out += ch; esc = false; continue; }
                    if (ch === '\\') { out += ch; esc = true; continue; }
                    if (ch === '"') { inStr = !inStr; out += ch; continue; }
                    if (inStr && ch === '\n') { out += '\\n'; continue; }
                    if (inStr && ch === '\r') { out += '\\r'; continue; }
                    if (inStr && ch === '\t') { out += '\\t'; continue; }
                    out += ch;
                }
                return JSON.parse(out);
            } catch (e) { return undefined; }
        }
        const direct = safeParse(text);
        if (direct !== undefined) return direct;
        const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenceMatch) {
            const fenced = safeParse(fenceMatch[1].trim());
            if (fenced !== undefined) return fenced;
        }
        const candidates = [];
        function tryBalanced(start, open, close) {
            let depth = 0, inStr = false, esc = false;
            for (let i = start; i < text.length; i++) {
                const ch = text[i];
                if (esc) { esc = false; continue; }
                if (ch === '\\') { esc = true; continue; }
                if (ch === '"') { inStr = !inStr; continue; }
                if (inStr) continue;
                if (ch === open) depth++;
                else if (ch === close) {
                    depth--;
                    if (depth === 0) {
                        const slice = text.slice(start, i + 1);
                        const parsed = safeParse(slice);
                        if (parsed && typeof parsed === 'object') {
                            candidates.push({ parsed: parsed, len: slice.length });
                        }
                        return;
                    }
                }
            }
        }
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '{') tryBalanced(i, '{', '}');
            else if (text[i] === '[') tryBalanced(i, '[', ']');
        }
        if (candidates.length) {
            function scoreCandidate(obj, len) {
                let score = Math.min(len, 4000) / 4000;
                if (!obj || typeof obj !== 'object') return score;
                if (Array.isArray(obj)) return score + (obj.length > 0 ? 2 : 0);
                const keys = Object.keys(obj);
                const envKeys = ['success', 'code', 'message', 'datetime', 'traceId', 'data'];
                const envHits = envKeys.filter(function (k) { return k in obj; }).length;
                if (envHits >= 4) score += 2;
                const data = obj.data;
                if (Array.isArray(data)) score += data.length > 0 ? 8 : -2;
                else if (data && typeof data === 'object') score += Object.keys(data).length > 0 ? 8 : -2;
                else if (typeof data === 'string') {
                    const s = data.trim();
                    if (s && s !== '{}' && s !== '[]' && s.toLowerCase() !== 'null') score += 3;
                } else if (data == null) score -= 3;
                if ('properties' in obj || '$schema' in obj || 'required' in obj) score -= 3;
                return score;
            }
            candidates.sort(function (a, b) { return scoreCandidate(b.parsed, b.len) - scoreCandidate(a.parsed, a.len); });
            return candidates[0].parsed;
        }
        return undefined;
    }

    function buildSmartCalcHint(toolName, args) {
        const ot = args && args.orderType;
        const beCode = args && args.beCode;
        const hasBeCode = !!(beCode && String(beCode).trim());
        const items = args && args.items;
        const itemArr = Array.isArray(items) ? items : [];
        const isCalc = /calculate[-_]?price/i.test(toolName);
        if (ot === 1 && hasBeCode) {
            return " 参数诊断: 堂食模式 (orderType=1) 不该带 beCode='" + beCode + "'，去掉试试。";
        } else if (ot === 2 && !hasBeCode) {
            return " 参数诊断: 外卖模式 (orderType=2) 缺 beCode，beCode 跟 storeCode 是一对的（来自 delivery-query-addresses）。";
        } else if (itemArr.length === 0) {
            return ' 参数诊断: items 数组是空的。';
        } else if (isCalc) {
            const codes = itemArr.map(function (i) { return i && i.productCode; }).filter(Boolean);
            const suspect = codes.find(function (c) { return /^[A-Za-z]/.test(c); });
            if (suspect) {
                return " 参数诊断: productCode='" + suspect + "' 字母开头，可能是优惠券而非商品 code（商品 code 全是数字）。要用优惠请同传 couponId + couponCode。";
            }
            return " 参数诊断: (storeCode=" + (args && args.storeCode) + ", orderType=" + ot + ", beCode=" + (hasBeCode ? beCode : '无') + ", items=" + JSON.stringify(itemArr) + ') 请确认同一 (storeCode, orderType[, beCode]) 下 query-meals 返回的 code 是什么再传。';
        }
        return ' 参数诊断: storeCode=' + (args && args.storeCode) + ', orderType=' + ot + ', beCode=' + (hasBeCode ? beCode : '无');
    }

    async function callTool(toolName, args) {
        args = args || {};
        try {
            const normalizedToolName = normalizeToolName(toolName);

            // 前置校验
            const codeRules = [
                { pattern: /^query[-_]?meal[-_]?detail$/i, keys: ['code', 'productCode', 'mealCode'] },
            ];
            const hit = codeRules.find(function (r) { return r.pattern.test(normalizedToolName); });
            if (hit && !hasAnyCodeArg(args, hit.keys)) {
                return {
                    success: false,
                    error: '工具 ' + normalizedToolName + ' 需要提供商品 code；请先调 query-meals 拿到 code 再查。',
                };
            }
            if (/calculate[-_]?price|create[-_]?order|submit[-_]?order/i.test(normalizedToolName)) {
                const items = args && args.items;
                if (!Array.isArray(items) || items.length === 0) {
                    return {
                        success: false,
                        error: '工具 ' + normalizedToolName + ' 需要 items 数组，请先调 query-meals / list-products 拿到商品 code 再下。',
                    };
                }
                const bad = items.find(function (it) { return !it || !it.productCode || it.quantity == null; });
                if (bad) {
                    return {
                        success: false,
                        error: '工具 ' + normalizedToolName + ' 的 items 形态不对：每项要有 productCode + quantity，当前: ' + JSON.stringify(items).slice(0, 200),
                    };
                }
                if (!(args && args.storeCode)) {
                    return {
                        success: false,
                        error: '工具 ' + normalizedToolName + ' 需要 storeCode（来自 query-nearby-stores 或 delivery-query-addresses）。',
                    };
                }
                const ot = args && args.orderType;
                if (ot == null || (typeof ot !== 'number' && !/^[12]$/.test(String(ot).trim()))) {
                    return {
                        success: false,
                        error: '工具 ' + normalizedToolName + ' 的 orderType 必须是数字 1（堂食）或 2（外卖）；当前: ' + JSON.stringify(ot),
                    };
                }
            }

            args = normalizeMcdArgs(normalizedToolName, args);

            await ensureInitialized();
            const body = buildRequest('tools/call', { name: normalizedToolName, arguments: args });
            const { response } = await post(body);
            if (!response) return { success: false, error: '无响应' };
            if (response.error) {
                return { success: false, error: 'MCP 错误 [' + response.error.code + ']: ' + response.error.message };
            }
            const result = response.result;
            if (result && result.content && Array.isArray(result.content)) {
                const textParts = result.content.filter(function (c) { return c && c.type === 'text'; }).map(function (c) { return c.text || ''; });
                const fullText = textParts.join('\n').trim();
                if (result.isError) {
                    return { success: false, error: fullText || '远端工具执行失败', rawText: fullText };
                }
                let parsed = undefined;
                let parseRoute = 'none';
                try {
                    parsed = JSON.parse(fullText);
                    parseRoute = 'direct';
                } catch (e) {
                    parsed = tryExtractJsonFromMixed(fullText);
                    if (parsed !== undefined) parseRoute = 'extracted';
                }
                if (parsed !== undefined) {
                    const finalData = tryDeepParse(parsed);
                    if (Array.isArray(finalData) && finalData.length === 0
                        && /calculate[-_]?price|query[-_]?meals/i.test(normalizedToolName)) {
                        let argsEcho = '';
                        try { argsEcho = '\n发过去的参数: ' + JSON.stringify(args); } catch (e) {}
                        const isCalc = /calculate[-_]?price/i.test(normalizedToolName);
                        const errBody = isCalc
                            ? 'calculate-price 返回空列表（按文档应当返回定价数组，说明参数不对被拒）。' + buildSmartCalcHint(normalizedToolName, args)
                            : 'query-meals 返回空列表（按文档应返回 {categories, meals}，说明 storeCode+beCode+orderType 三元组合不对）。' + buildSmartCalcHint(normalizedToolName, args);
                        return { success: false, error: errBody + argsEcho, rawText: fullText };
                    }
                    console.log('[MCD-MCP] ' + normalizedToolName + ' 解析 ' + parseRoute + ' | topKeys=' +
                        (finalData && typeof finalData === 'object' && !Array.isArray(finalData)
                            ? Object.keys(finalData).slice(0, 8).join(',')
                            : Array.isArray(finalData) ? '[len=' + finalData.length + ']' : typeof finalData));
                    return { success: true, data: finalData, rawText: fullText };
                }
                return { success: true, data: fullText, rawText: fullText };
            }
            return { success: true, data: result };
        } catch (e) {
            return { success: false, error: (e && e.message) || String(e) };
        }
    }

    async function listTools(forceRefresh) {
        if (forceRefresh) {
            initialized = false;
            sessionId = null;
            cachedTools = [];
            initPromise = null;
        }
        await ensureInitialized();
        return cachedTools;
    }

    async function testConnection() {
        try {
            initialized = false;
            sessionId = null;
            cachedTools = [];
            initPromise = null;
            const tools = await listTools(false);
            if (!tools.length) return { ok: true, message: '连上了，但工具清单为空（可能对方还没发布工具）', tools: tools };
            return { ok: true, message: '连上了，得到 ' + tools.length + ' 个工具', tools: tools };
        } catch (e) {
            return { ok: false, message: (e && e.message) || String(e) };
        }
    }

    function resetSession() {
        initialized = false;
        sessionId = null;
        cachedTools = [];
        initPromise = null;
    }

    global.McpMcdClient = {
        PROXY_PATH: { netlify: NETLIFY_PATH, vercel: VERCEL_PATH },
        getProxyUrl: getProxyUrl,
        getToken: getToken,
        setToken: setToken,
        isEnabled: isEnabled,
        setEnabled: setEnabled,
        isConfigured: isConfigured,
        exportLocal: exportLocal,
        importLocal: importLocal,
        listTools: listTools,
        getCachedTools: function () { return cachedTools; },
        getInitError: function () { return lastInitError; },
        getToolsListResp: function () { return lastToolsListResp; },
        callTool: callTool,
        testConnection: testConnection,
        resetSession: resetSession,
        normalizeToolName: normalizeToolName,
    };
})(typeof window !== 'undefined' ? window : globalThis);
