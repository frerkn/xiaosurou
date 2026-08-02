/* ====================================================================
 * 通用 MCP 客户端 (Model Context Protocol, Streamable HTTP)
 *
 * 跟糯米机 utils/mcpClient.ts 等价 (vanilla JS 版)
 *
 * 跟 mcdMcpClient / luckinMcpClient 的差异:
 *   - 单一 client 服务任意远程 MCP 服务器 (用户在设置里配的)
 *   - 每个 server 独立 session / init 状态
 *   - 支持 Bearer Token + 自定义请求头 + 代理 URL + 代理密钥
 *   - 工具名用 server ID 前缀做命名空间 (避免跨 server 冲突)
 *
 * 网络路径 (用户三选一, 跟糯米机 docs/mcp-user-guide.md 一致):
 *   1. 直连 — MCP 服务器 CORS 配置正确时
 *   2. 本地代理 — node scripts/mcp-proxy.mjs, 代理 URL 填 http://localhost:18061
 *   3. 用户自部署 Cloudflare Worker (330 这边走 Netlify Function 替代)
 *   代理约定: <代理URL>?target=<url-encoded 服务器URL>, 可带 X-Proxy-Key 头
 *
 * 暴露: window.McpGenericClient
 *   - loadServers() / saveServers()              // localStorage CRUD
 *   - getUseNativeTools() / setUseNativeTools()  // 工具调用总开关 (默认开)
 *   - createServer(name, url)                    // 创建空 server config
 *   - getEnabledServers(charId?)                 // 过滤当前聊天可见的 server
 *   - isAvailable(charId?)                       // 是否有可激活 server
 *   - exportLocal() / importLocal(data)          // 备份恢复
 *   - resetSession(serverId)                     // 重置单个 server 的 session
 *   - discoverTools(server)                      // 握手 + 拉工具清单
 *   - callTool(server, toolName, args)           // 调一个工具 (含参数归一化)
 *   - testConnection(server)                     // 测试连接 + 拉工具清单
 *   - normalizeToolArguments(args, schema)       // 工具参数 schema 归一化
 *
 * 依赖: 无
 * ==================================================================== */

(function (global) {
    'use strict';

    // ========== 常量 ==========

    const SERVERS_KEY = 'ephone.mcp.servers';
    const USE_NATIVE_TOOLS_KEY = 'ephone.mcp.useNativeTools';
    const PROTOCOL_VERSION = '2024-11-05';
    const REQUEST_TIMEOUT_MS = 60_000;

    // ========== 工具函数 ==========

    function safeParseJson(s, fallback) {
        try { return JSON.parse(s); } catch (e) { return fallback; }
    }

    // 兜底: 很多 MCP 端点 (mcd.cn / 百度 / ...) 的 content[0].text 不是纯 JSON,
    // 前面会带 markdown 描述 (如 "## 展示规则: ..."), 直接 JSON.parse 会炸.
    // 用 brace-match 抽最大的 balanced {}/[] 块, 拿真正的数据对象.
    function extractJsonFromMcpText(text) {
        if (!text || typeof text !== 'string') return null;
        // 1. 先试直接 parse
        try { return JSON.parse(text); } catch (e) {}
        // 2. markdown ```json ... ``` 围栏
        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) {
            try { return JSON.parse(fence[1].trim()); } catch (e) {}
        }
        // 3. brace match 找最大 balanced 块
        let best = null, bestLen = 0;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch !== '{' && ch !== '[') continue;
            const close = ch === '{' ? '}' : ']';
            let depth = 0, inStr = false, esc = false;
            for (let j = i; j < text.length; j++) {
                const c = text[j];
                if (esc) { esc = false; continue; }
                if (c === '\\') { esc = true; continue; }
                if (c === '"') { inStr = !inStr; continue; }
                if (inStr) continue;
                if (c === ch) depth++;
                else if (c === close) {
                    depth--;
                    if (depth === 0) {
                        const slice = text.slice(i, j + 1);
                        try {
                            const obj = JSON.parse(slice);
                            if (slice.length > bestLen) { best = obj; bestLen = slice.length; }
                        } catch (e) {}
                        break;
                    }
                }
            }
        }
        return best;
    }
    function isRecord(v) {
        return v != null && typeof v === 'object' && !Array.isArray(v);
    }
    function shortId() {
        return 'mcp_' + Date.now().toString(36) + '_' +
            Math.random().toString(36).slice(2, 7);
    }

    // ========== localStorage CRUD ==========

    function loadServers() {
        try {
            const raw = global.localStorage ? global.localStorage.getItem(SERVERS_KEY) : null;
            const parsed = raw ? safeParseJson(raw, []) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.warn('[MCP-Generic] loadServers failed:', e);
            return [];
        }
    }
    function saveServers(servers) {
        try {
            if (!global.localStorage) return;
            global.localStorage.setItem(SERVERS_KEY, JSON.stringify(servers || []));
        } catch (e) {
            console.warn('[MCP-Generic] saveServers failed:', e);
        }
    }
    function getUseNativeTools() {
        try {
            if (!global.localStorage) return true;
            return global.localStorage.getItem(USE_NATIVE_TOOLS_KEY) !== '0';
        } catch (e) { return true; }
    }
    function setUseNativeTools(enabled) {
        try {
            if (!global.localStorage) return;
            global.localStorage.setItem(USE_NATIVE_TOOLS_KEY, enabled ? '1' : '0');
        } catch (e) { /* ignore */ }
    }
    function createServer(name, url) {
        return {
            id: shortId(),
            name: String(name || '').trim() || 'MCP Server',
            url: String(url || '').trim(),
            token: '',
            customHeaders: [],
            proxyUrl: '',
            proxyKey: '',
            enabled: false,
            tools: [],
            charIds: [],
            updatedAt: Date.now(),
        };
    }

    /**
     * 启用且已发现工具、且对当前聊天可见的 server
     * charId: 角色 ID 或群聊 ID；省略时只返回通用 server
     * charIds 为空数组 = 通用 (所有私聊和群聊可见)
     */
    function getEnabledServers(charId) {
        return loadServers().filter(function (s) {
            if (!s.enabled) return false;
            if (!s.url) return false;
            if (!Array.isArray(s.tools) || s.tools.length === 0) return false;
            const scope = Array.isArray(s.charIds) ? s.charIds : [];
            if (scope.length === 0) return true; // 通用
            return charId != null && scope.indexOf(charId) >= 0;
        });
    }
    function isAvailable(charId) {
        return getEnabledServers(charId).length > 0;
    }

    // ========== 备份恢复 ==========

    function exportLocal() {
        const out = {};
        try {
            if (!global.localStorage) return undefined;
            const s = global.localStorage.getItem(SERVERS_KEY);
            const n = global.localStorage.getItem(USE_NATIVE_TOOLS_KEY);
            if (s) out[SERVERS_KEY] = s;
            if (n) out[USE_NATIVE_TOOLS_KEY] = n;
        } catch (e) { /* ignore */ }
        return Object.keys(out).length ? out : undefined;
    }
    function importLocal(data) {
        if (!data || typeof data !== 'object') return;
        try {
            if (!global.localStorage) return;
            if (typeof data[SERVERS_KEY] === 'string') {
                global.localStorage.setItem(SERVERS_KEY, data[SERVERS_KEY]);
            }
            if (typeof data[USE_NATIVE_TOOLS_KEY] === 'string') {
                global.localStorage.setItem(USE_NATIVE_TOOLS_KEY, data[USE_NATIVE_TOOLS_KEY]);
            }
        } catch (e) { /* ignore */ }
    }

    // ========== Session 状态 (内存, 每 server 一份) ==========

    const sessions = Object.create(null); // serverId -> { sessionId, initialized, initPromise }

    function getSession(serverId) {
        let s = sessions[serverId];
        if (!s) {
            s = { sessionId: null, initialized: false, initPromise: null };
            sessions[serverId] = s;
        }
        return s;
    }
    function resetSession(serverId) {
        delete sessions[serverId];
    }

    // ========== URL / Headers 构造 ==========

    /**
     * 实际请求地址: 配了代理就 <代理>?target=<url-encoded 服务器URL>, 否则直连
     */
    function buildFetchUrl(server) {
        const proxy = String(server && server.proxyUrl || '').trim().replace(/\/+$/, '');
        if (!proxy) return server.url;
        const sep = proxy.indexOf('?') >= 0 ? '&' : '?';
        return proxy + sep + 'target=' + encodeURIComponent(server.url);
    }

    /**
     * 拼请求头: 自定义头先于 Bearer 写入 (用户可以在没填 Bearer 时自定义 Authorization)
     * 走代理时附带 X-MCP-Forward-Headers 告知代理"以下自定义头需要原样透传"
     */
    function buildRequestHeaders(server, sessionId) {
        const h = new Headers();
        h.set('Content-Type', 'application/json');
        h.set('Accept', 'application/json, text/event-stream');
        const customNames = [];
        const customs = Array.isArray(server && server.customHeaders) ? server.customHeaders : [];
        for (let i = 0; i < customs.length; i++) {
            const item = customs[i] || {};
            const name = String(item.name || '').trim();
            const value = String(item.value || '').trim();
            if (!name || !value) continue;
            try {
                h.set(name, value);
                customNames.push(name);
            } catch (e) {
                // 非法 header 名字/值, 跳过
            }
        }
        const token = String(server && server.token || '').trim();
        if (token) h.set('Authorization', 'Bearer ' + token);
        if (server && server.proxyUrl && server.proxyKey) {
            h.set('X-Proxy-Key', String(server.proxyKey).trim());
        }
        if (server && server.proxyUrl && customNames.length) {
            h.set('X-MCP-Forward-Headers', customNames.join(','));
        }
        if (sessionId) h.set('Mcp-Session-Id', sessionId);
        return h;
    }

    // ========== JSON-RPC 基础 ==========

    let requestIdCounter = 0;
    function buildRequest(method, params, isNotification) {
        const req = { jsonrpc: '2.0', method: method };
        if (params !== undefined) req.params = params;
        if (!isNotification) req.id = ++requestIdCounter;
        return req;
    }

    function parseSse(text) {
        const dataLines = [];
        const lines = String(text || '').split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('data: ')) dataLines.push(line.slice(6));
            else if (line.startsWith('data:')) dataLines.push(line.slice(5));
        }
        for (let i = dataLines.length - 1; i >= 0; i--) {
            const parsed = safeParseJson(dataLines[i], null);
            if (parsed) return parsed;
        }
        return null;
    }

    function parseResp(text, contentType) {
        const ct = String(contentType || '');
        if (ct.indexOf('text/event-stream') >= 0 || /^\s*(event:|data:)/.test(text)) {
            const parsed = parseSse(text);
            if (parsed) return parsed;
        }
        const direct = safeParseJson(text, null);
        if (direct) return direct;
        const m = String(text || '').match(/\{[\s\S]*\}/);
        if (m) {
            const inner = safeParseJson(m[0], null);
            if (inner) return inner;
        }
        throw new Error('MCP: 无法解析响应: ' + String(text || '').slice(0, 300));
    }

    /**
     * Streamable HTTP 的 SSE 可能保持连接; 读到当前 JSON-RPC id 的结果即返回
     */
    function readSseResponse(resp, expectedId) {
        const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
        if (!reader) {
            return resp.text().then(function (text) {
                return parseResp(text, 'text/event-stream');
            });
        }
        const decoder = new TextDecoder();
        let buffer = '';
        function parseEvent(event) {
            const data = event.split(/\r?\n/)
                .filter(function (line) { return line.startsWith('data:'); })
                .map(function (line) { return line.slice(5).replace(/^\s+/, ''); })
                .join('\n');
            if (!data || data === '[DONE]') return null;
            const parsed = safeParseJson(data, null);
            if (!parsed) return null;
            if (expectedId == null) return parsed;
            return parsed.id === expectedId ? parsed : null;
        }
        function pump() {
            return reader.read().then(function (r) {
                buffer += decoder.decode(r.value, { stream: !r.done });
                const events = buffer.split(/\r?\n\r?\n/);
                buffer = events.pop() || '';
                for (let i = 0; i < events.length; i++) {
                    const parsed = parseEvent(events[i]);
                    if (parsed) return parsed;
                }
                if (r.done) {
                    const tail = parseEvent(buffer);
                    if (tail) return tail;
                    throw new Error('MCP SSE 流结束, 但没收到本次请求的响应');
                }
                return pump();
            });
        }
        return pump().finally(function () {
            try { return reader.cancel(); } catch (e) { /* ignore */ }
        });
    }

    // ========== 实际 POST 请求 ==========

    function post(server, body, expectResponse) {
        expectResponse = expectResponse !== false;
        const session = getSession(server.id);
        const headersObj = buildRequestHeaders(server, session.sessionId);
        const url = buildFetchUrl(server);
        const payload = JSON.stringify(body);
        const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timeoutId = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;

        function withTimeoutMessage(e) {
            if (controller && controller.signal.aborted) {
                const sec = Math.round(REQUEST_TIMEOUT_MS / 1000);
                return new Error('MCP 请求超时 (' + sec + ' 秒)');
            }
            return e;
        }

        return fetch(url, {
            method: 'POST',
            headers: headersObj,
            body: payload,
            signal: controller ? controller.signal : undefined,
        }).then(function (resp) {
            if (timeoutId) clearTimeout(timeoutId);
            const newSid = resp.headers.get('Mcp-Session-Id') || resp.headers.get('mcp-session-id');
            if (newSid) session.sessionId = newSid;

            if (resp.status === 401 || resp.status === 403) {
                return resp.text().catch(function () { return ''; }).then(function (txt) {
                    throw new Error('MCP 鉴权失败 (' + resp.status + '): Token 可能无效或过期. ' + String(txt).slice(0, 120));
                });
            }
            if (resp.status === 202) return { response: null };
            if (!resp.ok) {
                return resp.text().catch(function () { return ''; }).then(function (txt) {
                    throw new Error('MCP HTTP ' + resp.status + ': ' + String(txt).slice(0, 200));
                });
            }
            if (!expectResponse) return { response: null };

            const ct = resp.headers.get('content-type') || '';
            if (ct.indexOf('text/event-stream') >= 0) {
                return readSseResponse(resp, body.id).then(function (response) {
                    return { response: response };
                });
            }
            return resp.text().then(function (text) {
                return { response: parseResp(text, ct) };
            });
        }, function (e) {
            if (timeoutId) clearTimeout(timeoutId);
            const wrapped = withTimeoutMessage(e);
            if (wrapped !== e) throw wrapped;
            // 直连时 fetch 抛 TypeError 十有八九是 CORS
            const hint = server && server.proxyUrl
                ? '请检查代理 URL 是否可访问、代理密钥是否正确.'
                : '很可能是浏览器 CORS 限制. 请在这个服务器的"代理 URL"里配置代理 (本地 node scripts/mcp-proxy.mjs 或自部署 worker/mcp-proxy).';
            throw new Error('MCP 请求失败: ' + (e && e.message || e) + '. ' + hint);
        });
    }

    // ========== 握手 / 初始化 ==========

    function doInitialize(server) {
        const session = getSession(server.id);
        const initReq = buildRequest('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'EPhone-MCP-Generic', version: '1.0.0' },
        });
        return post(server, initReq).then(function (r) {
            if (r.response && r.response.error) {
                throw new Error('Initialize 失败: ' + r.response.error.message);
            }
            // notification 失败不阻断 (直连时拿不到 Session-Id 也能跑)
            const notif = buildRequest('notifications/initialized', {}, true);
            return post(server, notif, false).catch(function () { /* ignore */ });
        }).then(function () {
            session.initialized = true;
        });
    }

    function ensureInitialized(server) {
        const session = getSession(server.id);
        if (session.initialized) return Promise.resolve();
        if (!session.initPromise) {
            session.initPromise = doInitialize(server).catch(function (e) {
                session.initPromise = null;
                throw e;
            });
        }
        return session.initPromise;
    }

    // ========== 工具发现 ==========

    function discoverTools(server) {
        // 重新握手 (清掉旧 session)
        resetSession(server.id);
        return ensureInitialized(server).then(function () {
            return post(server, buildRequest('tools/list'));
        }).then(function (r) {
            if (r.response && r.response.error) {
                throw new Error('tools/list 失败: ' + r.response.error.message);
            }
            const tools = r.response && r.response.result && r.response.result.tools;
            if (!Array.isArray(tools)) return [];
            return tools.map(function (t) {
                return {
                    name: t.name,
                    description: t.description || '',
                    inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
                };
            });
        });
    }

    // ========== Schema 归一化 (OpenAI 兼容中转会把 object/array 再编码成 JSON 字符串) ==========

    function resolveLocalSchemaRef(schema, root) {
        const ref = schema && typeof schema.$ref === 'string' ? schema.$ref : '';
        if (!ref.startsWith('#/')) return schema;
        const parts = ref.slice(2).split('/');
        let cur = root;
        for (let i = 0; i < parts.length; i++) {
            const key = parts[i].replace(/~1/g, '/').replace(/~0/g, '~');
            cur = cur && cur[key];
            if (cur == null) return schema;
        }
        return cur;
    }

    function schemaAccepts(schema, kind) {
        if (!schema) return false;
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (types.indexOf(kind) >= 0) return true;
        if (kind === 'object' && schema.properties) return true;
        if (kind === 'array' && schema.items) return true;
        const alts = [].concat(schema.oneOf || [], schema.anyOf || []);
        for (let i = 0; i < alts.length; i++) {
            if (schemaAccepts(alts[i], kind)) return true;
        }
        return false;
    }

    function normalizeValueBySchema(value, rawSchema, rootSchema, depth) {
        if (!rawSchema || depth > 20) return value;
        const schema = resolveLocalSchemaRef(rawSchema, rootSchema);
        const acceptsObject = schemaAccepts(schema, 'object');
        const acceptsArray = schemaAccepts(schema, 'array');
        let normalized = value;

        if (typeof normalized === 'string' && (acceptsObject || acceptsArray)) {
            // 最多解 3 层 (避免误判 URL/文本)
            for (let i = 0; i < 3 && typeof normalized === 'string'; i++) {
                const text = normalized.trim();
                if (!text) break;
                const parsed = safeParseJson(text, null);
                if (parsed == null) break;
                normalized = parsed;
            }
            const matches = (acceptsObject && isRecord(normalized)) || (acceptsArray && Array.isArray(normalized));
            if (!matches) normalized = value;
        }

        const alts = [].concat(schema && schema.oneOf || [], schema && schema.anyOf || []);
        for (let i = 0; i < alts.length; i++) {
            const item = alts[i];
            const ok = (isRecord(normalized) && schemaAccepts(item, 'object'))
                || (Array.isArray(normalized) && schemaAccepts(item, 'array'));
            if (ok) {
                normalized = normalizeValueBySchema(normalized, item, rootSchema, depth + 1);
                break;
            }
        }

        if (isRecord(normalized) && acceptsObject) {
            const result = Object.assign({}, normalized);
            const properties = (schema && schema.properties) || {};
            Object.keys(properties).forEach(function (key) {
                if (key in result) {
                    result[key] = normalizeValueBySchema(result[key], properties[key], rootSchema, depth + 1);
                }
            });
            if (schema && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
                Object.keys(result).forEach(function (key) {
                    if (!(key in properties)) {
                        result[key] = normalizeValueBySchema(result[key], schema.additionalProperties, rootSchema, depth + 1);
                    }
                });
            }
            const allOf = (schema && schema.allOf) || [];
            for (let i = 0; i < allOf.length; i++) {
                const merged = normalizeValueBySchema(result, allOf[i], rootSchema, depth + 1);
                if (isRecord(merged)) Object.assign(result, merged);
            }
            return result;
        }

        if (Array.isArray(normalized) && acceptsArray && schema && schema.items) {
            return normalized.map(function (item) {
                return normalizeValueBySchema(item, schema.items, rootSchema, depth + 1);
            });
        }
        return normalized;
    }

    function normalizeToolArguments(args, inputSchema) {
        return normalizeValueBySchema(args || {}, inputSchema, inputSchema, 0);
    }

    // ========== 工具调用 ==========

    // 高德 maps_geo REST 兜底 (mcp.amap.com/mcp 端点坏, 返 ENGINE_RESPONSE_DATA_ERROR)
    // AI 完全无感 — 拿到跟 MCP 端点同结构的 {results: [...]}
    function amapGeoRestFallback(server, args, originalError) {
        const key = server.bearerToken;
        const address = (args && args.address) || '';
        const city = (args && args.city) || '';
        if (!address || !key) {
            return Promise.resolve({
                success: false,
                error: '高德 maps_geo REST 兜底失败: 缺 address 或 key. 原 MCP 错误: ' + originalError,
                rawText: originalError,
            });
        }
        let url = 'https://restapi.amap.com/v3/geocode/geo?address=' + encodeURIComponent(address) +
                  '&key=' + encodeURIComponent(key);
        if (city) url += '&city=' + encodeURIComponent(city);
        return fetch(url, { method: 'GET' }).then(function (r) { return r.json(); }).then(function (j) {
            if (j && j.status === '1' && j.geocodes && j.geocodes.length) {
                // 转成 MCP 端点 maps_geo 风格: {results: [...]}
                const mcpStyle = { results: j.geocodes };
                console.info('🗺️ [MCP] 高德 maps_geo REST 兜底成功, address="' + address + '" → ' + j.geocodes.length + ' 个候选');
                return { success: true, data: mcpStyle, rawText: JSON.stringify(mcpStyle) };
            }
            return {
                success: false,
                error: '高德 REST API 也无结果 (status=' + (j && j.status) + ', info=' + (j && j.info) + '). 原 MCP 错误: ' + originalError,
                rawText: originalError,
            };
        }).catch(function (e) {
            return {
                success: false,
                error: '高德 REST 兜底异常: ' + ((e && e.message) || String(e)) + '. 原 MCP 错误: ' + originalError,
                rawText: originalError,
            };
        });
    }

    // 高德 maps_text_search REST 兜底 (MCP 端点返 {pois:[]} 空数组)
    // 直接返 REST 原 JSON, AI 看到 data.pois 即可
    function amapTextSearchRestFallback(server, args, originalError) {
        const key = server.bearerToken;
        const keywords = (args && args.keywords) || '';
        if (!key || !keywords) {
            return Promise.resolve({
                success: false,
                error: 'maps_text_search REST 兜底失败: 缺 key 或 keywords. 原 MCP 数据: ' + originalError,
            });
        }
        let url = 'https://restapi.amap.com/v3/place/text?keywords=' + encodeURIComponent(keywords) +
                  '&key=' + encodeURIComponent(key);
        if (args.city) url += '&city=' + encodeURIComponent(args.city);
        if (args.types) url += '&types=' + encodeURIComponent(args.types);
        if (args.page) url += '&page=' + encodeURIComponent(args.page);
        if (args.offset) url += '&offset=' + encodeURIComponent(args.offset);
        if (args.extensions) url += '&extensions=' + encodeURIComponent(args.extensions);
        return fetch(url, { method: 'GET' }).then(function (r) { return r.json(); }).then(function (j) {
            if (j && j.status === '1') {
                const n = (j.pois || []).length;
                console.info('🗺️ [MCP] maps_text_search REST 兜底成功, keywords="' + keywords + '" → ' + n + ' 个 POI');
                return { success: true, data: j, rawText: JSON.stringify(j) };
            }
            return {
                success: false,
                error: 'maps_text_search REST 兜底失败: status=' + (j && j.status) + ' info=' + (j && j.info),
            };
        }).catch(function (e) {
            return { success: false, error: 'maps_text_search REST 兜底异常: ' + ((e && e.message) || String(e)) };
        });
    }

    // 高德 maps_around_search REST 兜底 (MCP 端点返 {pois:[]} 空数组)
    function amapAroundSearchRestFallback(server, args, originalError) {
        const key = server.bearerToken;
        const location = (args && args.location) || '';
        if (!key || !location) {
            return Promise.resolve({
                success: false,
                error: 'maps_around_search REST 兜底失败: 缺 key 或 location. 原 MCP 数据: ' + originalError,
            });
        }
        let url = 'https://restapi.amap.com/v3/place/around?location=' + encodeURIComponent(location) +
                  '&key=' + encodeURIComponent(key);
        if (args.keywords) url += '&keywords=' + encodeURIComponent(args.keywords);
        if (args.types) url += '&types=' + encodeURIComponent(args.types);
        if (args.radius) url += '&radius=' + encodeURIComponent(args.radius);
        if (args.page) url += '&page=' + encodeURIComponent(args.page);
        if (args.offset) url += '&offset=' + encodeURIComponent(args.offset);
        if (args.extensions) url += '&extensions=' + encodeURIComponent(args.extensions);
        return fetch(url, { method: 'GET' }).then(function (r) { return r.json(); }).then(function (j) {
            if (j && j.status === '1') {
                const n = (j.pois || []).length;
                console.info('🗺️ [MCP] maps_around_search REST 兜底成功, location="' + location + '" keywords="' + (args.keywords || '') + '" → ' + n + ' 个 POI');
                return { success: true, data: j, rawText: JSON.stringify(j) };
            }
            return {
                success: false,
                error: 'maps_around_search REST 兜底失败: status=' + (j && j.status) + ' info=' + (j && j.info),
            };
        }).catch(function (e) {
            return { success: false, error: 'maps_around_search REST 兜底异常: ' + ((e && e.message) || String(e)) };
        });
    }

    // 高德 maps_weather REST 兜底 (MCP 端点返 {city:null, forecasts:null})
    function amapWeatherRestFallback(server, args, originalError) {
        const key = server.bearerToken;
        const city = (args && args.city) || '';
        if (!key || !city) {
            return Promise.resolve({
                success: false,
                error: 'maps_weather REST 兜底失败: 缺 key 或 city. 原 MCP 数据: ' + originalError,
            });
        }
        // city 可以是 adcode (数字) 或 城市名, REST 都接受
        let url = 'https://restapi.amap.com/v3/weather/weatherInfo?city=' + encodeURIComponent(city) +
                  '&key=' + encodeURIComponent(key);
        if (args.extensions) url += '&extensions=' + encodeURIComponent(args.extensions);
        return fetch(url, { method: 'GET' }).then(function (r) { return r.json(); }).then(function (j) {
            if (j && j.status === '1') {
                const hasLives = (j.lives || []).length;
                const hasForecasts = (j.forecasts || []).length;
                console.info('🌤️ [MCP] maps_weather REST 兜底成功, city="' + city + '" → lives=' + hasLives + ' forecasts=' + hasForecasts);
                return { success: true, data: j, rawText: JSON.stringify(j) };
            }
            return {
                success: false,
                error: 'maps_weather REST 兜底失败: status=' + (j && j.status) + ' info=' + (j && j.info),
            };
        }).catch(function (e) {
            return { success: false, error: 'maps_weather REST 兜底异常: ' + ((e && e.message) || String(e)) };
        });
    }

    // 高德 4 个已知 bug 端点 — 集中分发
    function tryAmapRestFallback(toolName, server, args, originalError) {
        if (toolName === 'maps_geo') return amapGeoRestFallback(server, args, originalError);
        if (toolName === 'maps_text_search') return amapTextSearchRestFallback(server, args, originalError);
        if (toolName === 'maps_around_search') return amapAroundSearchRestFallback(server, args, originalError);
        if (toolName === 'maps_weather') return amapWeatherRestFallback(server, args, originalError);
        return Promise.resolve({ success: false, error: 'tryAmapRestFallback: 未知 toolName ' + toolName, rawText: originalError });
    }

    // 高德 4 个已知 bug 端点 — 是不是"返空数据"? (注意 maps_geo 是 isError=true, 走另一条分支)
    function amapMcpDataIsEmpty(toolName, data) {
        if (!data || typeof data !== 'object') return true;
        if (toolName === 'maps_text_search' || toolName === 'maps_around_search') {
            return !Array.isArray(data.pois) || data.pois.length === 0;
        }
        if (toolName === 'maps_weather') {
            const livesEmpty = !Array.isArray(data.lives) || data.lives.length === 0;
            const forecastsEmpty = !Array.isArray(data.forecasts) || data.forecasts.length === 0;
            return livesEmpty && forecastsEmpty;
        }
        return false;
    }

    function isAmapBugTool(toolName) {
        return toolName === 'maps_geo' || toolName === 'maps_text_search' ||
               toolName === 'maps_around_search' || toolName === 'maps_weather';
    }

    function callTool(server, toolName, args) {
        args = args || {};
        const inputSchema = (server.tools || []).find(function (t) { return t.name === toolName; });
        const inputSchemaDef = inputSchema ? inputSchema.inputSchema : null;
        const normalizedArgs = normalizeToolArguments(args, inputSchemaDef);

        function finish(result) {
            // 不记 URL/Token, 只证真实 tools/call 的目标/参数/结果摘要
            let preview = '';
            if (result.success) {
                try { preview = JSON.stringify(result.data).slice(0, 800); }
                catch (e) { preview = String(result.data).slice(0, 800); }
            }
            console.info('🧲 [MCP] tools/call 完成', {
                server: server.name,
                tool: toolName,
                args: normalizedArgs,
                success: result.success,
                ...(result.success ? { result: preview } : { error: result.error }),
            });
            return result;
        }

        return ensureInitialized(server).then(function () {
            const body = buildRequest('tools/call', { name: toolName, arguments: normalizedArgs });
            return post(server, body);
        }).then(function (r) { return r.response; }).catch(function (e) {
            // 400/404 多半是 session 失效, 重置再试一次
            if (e && /HTTP (400|404)/.test(e.message || '')) {
                resetSession(server.id);
                return ensureInitialized(server).then(function () {
                    const body = buildRequest('tools/call', { name: toolName, arguments: normalizedArgs });
                    return post(server, body);
                }).then(function (r) { return r.response; });
            }
            throw e;
        }).then(function (response) {
            if (!response) return finish({ success: false, error: '空响应' });
            if (response.error) {
                return finish({
                    success: false,
                    error: 'MCP 错误 [' + (response.error.code || '?') + ']: ' + (response.error.message || ''),
                });
            }
            const result = response.result;
            if (result && Array.isArray(result.content)) {
                const textParts = result.content
                    .filter(function (c) { return c && c.type === 'text'; })
                    .map(function (c) { return c.text || ''; });
                const fullText = textParts.join('\n').trim();
                if (result.isError) {
                    // 高德 4 个端点 bug: isError=true (maps_geo 返 ENGINE_RESPONSE_DATA_ERROR), 自动 fallback 到 REST API
                    if (isAmapBugTool(toolName) && server.bearerToken) {
                        return tryAmapRestFallback(toolName, server, normalizedArgs, fullText).then(finish);
                    }
                    return finish({ success: false, error: fullText || 'MCP 工具执行失败', rawText: fullText });
                }
                const parsed = safeParseJson(fullText, null) || extractJsonFromMcpText(fullText);
                // 高德 3 个端点 bug: success=true 但 data 空 (text_search/around_search 返 {pois:[]}, weather 返 {city:null,forecasts:null})
                // 也触发 REST 兜底 — AI 完全无感
                if (isAmapBugTool(toolName) && server.bearerToken && amapMcpDataIsEmpty(toolName, parsed)) {
                    console.info('🗺️ [MCP] 高德 ' + toolName + ' MCP 端点返空数据, 触发 REST 兜底. parsed=' + JSON.stringify(parsed).slice(0, 200));
                    return tryAmapRestFallback(toolName, server, normalizedArgs, '').then(finish);
                }
                if (parsed != null) {
                    return finish({ success: true, data: parsed, rawText: fullText });
                }
                return finish({ success: true, data: fullText, rawText: fullText });
            }
            return finish({ success: true, data: result });
        }).catch(function (e) {
            return finish({ success: false, error: (e && e.message) || String(e) });
        });
    }

    // ========== 测试连接 ==========

    function testConnection(server) {
        return discoverTools(server).then(function (tools) {
            if (!tools.length) {
                return { ok: true, message: '已连接, 但工具清单为空', tools: tools };
            }
            const names = tools.map(function (t) { return t.name; });
            const preview = names.slice(0, 8).join(', ') + (names.length > 8 ? '…' : '');
            return { ok: true, message: '已连接, 发现 ' + tools.length + ' 个工具: ' + preview, tools: tools };
        }).catch(function (e) {
            return { ok: false, message: (e && e.message) || String(e) };
        });
    }

    // ========== 暴露 API ==========

    global.McpGenericClient = {
        // CRUD
        loadServers: loadServers,
        saveServers: saveServers,
        createServer: createServer,
        // 工具调用总开关
        getUseNativeTools: getUseNativeTools,
        setUseNativeTools: setUseNativeTools,
        // 过滤
        getEnabledServers: getEnabledServers,
        isAvailable: isAvailable,
        // 备份恢复
        exportLocal: exportLocal,
        importLocal: importLocal,
        // session
        resetSession: resetSession,
        // URL / Headers (桥接层用)
        buildFetchUrl: buildFetchUrl,
        buildRequestHeaders: buildRequestHeaders,
        // 核心
        discoverTools: discoverTools,
        callTool: callTool,
        testConnection: testConnection,
        normalizeToolArguments: normalizeToolArguments,
    };

    console.log('[MCP-Generic] 通用 MCP 客户端已加载 (Streamable HTTP + 代理 + 自定义头)');

})(typeof window !== 'undefined' ? window : globalThis);
