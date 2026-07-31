/* ====================================================================
 * 通用 MCP 工具桥接 (Tool Bridge)
 *
 * 跟糯米机 utils/mcpToolBridge.ts + useChatAI.ts 的 vanilla JS 版
 *
 * 不依赖 330 原 minified 代码：
 *   - 通过 window.fetch hook 拦截 /v1/chat/completions 请求
 *   - 把所有 enabled MCP server 的 tools 合并成 OpenAI function-calling 格式
 *   - 跨 server 重名自动加 <serverSlug>_ 前缀
 *   - LLM 返回 tool_calls 时自动循环调 McpGenericClient.callTool
 *   - 工具结果以 tool 消息回填 messages 继续循环, 直至 finish_reason != 'tool_calls'
 *   - 把每次工具调用的结果写成一条 mcp_card (server 维度), 渲染用于 UI
 *
 * 跟旧 mcd/luckin 版的差异:
 *   - 去掉 McdClient / LuckinClient 硬编码引用
 *   - 去掉 brand-specific (McdEmoji / LuckinEmoji / McdTriggers / LuckinTriggers)
 *   - 去掉 brand-specific system prompt (McdBridgePrompt / LuckinBridgePrompt)
 *   - 改用 McpGenericClient.getEnabledServers() 拿所有 enabled server
 *   - 改用 McpGenericClient.callTool(server, toolName, args) 路由工具调用
 *   - 卡片/进度事件用 serverName 替代 brand
 *
 * 暴露: window.McpBridge
 *   - onCard(fn) / onProgress(fn)     ← UI 监听
 *   - getCardHistory() / clearCardHistory()
 *   - installHook() / uninstallHook()
 *   - getStatus() / resetAll()        ← 诊断
 *   - getEnabledServerCount()         ← UI 显示 MCP 状态
 *   - isAvailable()                   ← UI 判断要不要激活
 *
 * 依赖: McpGenericClient (必须先加载)
 * ==================================================================== */

(function (global) {
    'use strict';

    // ========== 常量 ==========

    const MCP_RESULT_MAX_CHARS = 20_000;
    const CARD_HISTORY_KEY = 'aphone.mcp.lastCards';
    const MAX_CARD_HISTORY = 12;
    const TOOL_LOOP_MAX = 6;

    // ========== 工具命名 (跟糯米机 sanitizeToolName / serverSlug 等价) ==========

    function sanitizeToolName(name) {
        return (name || 'tool').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';
    }
    function serverSlug(server) {
        return sanitizeToolName(server && server.name).slice(0, 20) || 'srv';
    }

    // ========== 合并多 server 的 tools + resolve map ==========

    /**
     * 聚合当前可见 server 的所有 tools 成 OpenAI function-calling 格式
     * 跨 server 重名自动加 <serverSlug>_ 前缀; resolve map 记录 exposed name → 真实 server+tool
     */
    function buildMcpOpenAITools() {
        if (!global.McpGenericClient) return { tools: [], resolve: new Map() };
        const servers = global.McpGenericClient.getEnabledServers();
        const tools = [];
        const resolve = new Map();
        const multi = servers.length > 1;
        for (let si = 0; si < servers.length; si++) {
            const server = servers[si];
            const list = Array.isArray(server.tools) ? server.tools : [];
            for (let ti = 0; ti < list.length; ti++) {
                const t = list[ti];
                if (!t || !t.name) continue;
                let exposed = sanitizeToolName(t.name);
                if (resolve.has(exposed)) {
                    let baseExposed = sanitizeToolName(serverSlug(server) + '_' + t.name);
                    exposed = baseExposed;
                    let i = 2;
                    while (resolve.has(exposed)) {
                        exposed = sanitizeToolName(serverSlug(server) + '_' + t.name + '_' + (i++));
                    }
                }
                resolve.set(exposed, { server: server, toolName: t.name });
                const desc = (t.description || '').trim();
                tools.push({
                    type: 'function',
                    function: {
                        name: exposed,
                        description: multi ? ('[' + server.name + '] ' + desc) : desc,
                        parameters: t.inputSchema || { type: 'object', properties: {} },
                    },
                });
            }
        }
        return { tools: tools, resolve: resolve };
    }

    // ========== System prompt 注入 ==========

    function buildMcpSystemBlock() {
        if (!global.McpGenericClient) return '';
        const servers = global.McpGenericClient.getEnabledServers();
        if (!servers.length) return '';
        const lines = servers.map(function (s) {
            const names = (s.tools || []).map(function (t) { return t.name; }).filter(Boolean).join(', ');
            return '- ' + s.name + ': ' + (names || '(无工具)');
        });
        return '\n\n---\n' +
            '[外部工具已接入] 用户在设置里给你接了 MCP 工具服务器。\n\n' +
            '**核心**: 你还是原来的角色、原来的语气、原来的记忆。工具只是你顺手能用的能力, **每轮都要有角色化的文本**, 别乾巴巴复报结果。\n' +
            '可用工具来源:\n' + lines.join('\n') + '\n\n' +
            '**使用规则**:\n' +
            '- 需要时直接调工具（系统会自动执行并把结果给你），不需要时正常聊天。**别硬凑理由调工具**。\n' +
            '- 工具必须通过系统的 function calling 接口发起, **绝对不要把工具名和参数写进聊天正文**（比如输出 `工具名(参数)` 这种文字），用户会看到乱码一样的东西。\n' +
            '- 工具结果只写与对话相关的部分, 用角色语气转述, **别整段复述 JSON**。\n' +
            '- 工具失败就如实说, 并根据报错调整参数重试或换个方法, **别编造结果**。\n' +
            '- 涉及真实世界副作用的操作（发布内容、下单、删除等），先跟用户确认一句再动手。\n' +
            '---\n';
    }

    const MCP_TAIL_REMINDER = '[MCP 工具 ON · 永远用角色语气回复别空回; 工具只能走 function calling 接口、严禁写成正文文字; 工具结果别整段复述 JSON; 有副作用的操作先确认再执行]';

    // ========== 工具结果格式化 ==========

    function formatMcpToolResult(data) {
        let s;
        try { s = typeof data === 'string' ? data : JSON.stringify(data); }
        catch (e) { s = String(data); }
        if (s && s.length > MCP_RESULT_MAX_CHARS) {
            return s.slice(0, MCP_RESULT_MAX_CHARS) + '…[结果过长已截断 · 全文共 ' + s.length + ' 字符]';
        }
        return s;
    }

    // ========== 通用工具摘要 (基于工具名关键词, 不基于 brand) ==========

    function summarizeToolAction(toolName, args) {
        const n = String(toolName || '').toLowerCase();
        if (/search|query_|find|filter/.test(n)) return '🔍 查询';
        if (/create|publish|post|send|submit|write|upload/.test(n)) return '📝 创建/发布';
        if (/update|edit|modify|set_|change/.test(n)) return '✏️ 更新';
        if (/delete|remove|cancel|drop|unsubscribe/.test(n)) return '🗑️ 删除/取消';
        if (/^list|^get_.*list|browse|recommend|all_/.test(n)) return '📋 拉列表';
        if (/detail|^get_.*info|^get_.*by|view|read/.test(n)) return '🔎 看详情';
        if (/like|love|favor|collect|favorite|star|bookmark/.test(n)) return '❤️ 收藏/点赞';
        if (/comment|reply|message/.test(n)) return '💬 评论/回复';
        if (/login|auth|sign|oauth/.test(n)) return '🔐 登录';
        if (/order|pay|checkout|cart|purchase/.test(n)) return '🧾 订单/支付';
        if (/price|calculate|estimate|cost/.test(n)) return '💰 算价';
        if (/address|delivery|location/.test(n)) return '📍 地址/位置';
        if (/coupon|voucher|discount|promo/.test(n)) return '🎟️ 优惠/券';
        return '⚙️ ' + toolName;
    }

    function summarizeToolResult(toolName, callResult) {
        if (!callResult || !callResult.success) {
            return '❌ ' + ((callResult && callResult.error) || '失败');
        }
        const data = callResult.data;
        if (data == null) return '✓ 完成';
        if (typeof data === 'string') {
            const t = data.trim();
            if (t.length > 60) return '✓ 完成 (' + t.length + ' 字符)';
            return '✓ ' + t;
        }
        if (Array.isArray(data)) {
            return '✓ 拿到 ' + data.length + ' 条';
        }
        if (typeof data === 'object') {
            const keys = Object.keys(data);
            return '✓ 完成 (' + keys.slice(0, 3).join(', ') + (keys.length > 3 ? '…' : '') + ')';
        }
        return '✓ 完成';
    }

    // ========== 卡片 / 进度事件总线 ==========

    const cardListeners = [];
    function onCard(fn) { cardListeners.push(fn); }
    function emitCardMessage(server, toolName, args, result) {
        const card = {
            serverId: server && server.id,
            serverName: server && server.name,
            toolName: toolName,
            args: args,
            result: result,
            ts: Date.now(),
        };
        for (let i = 0; i < cardListeners.length; i++) {
            try { cardListeners[i](card); } catch (e) { console.warn('[McpBridge] card listener err', e); }
        }
        saveCardToHistory(card);
    }

    const progressListeners = [];
    function onProgress(fn) { progressListeners.push(fn); }
    function emitProgress(progress) {
        progress.ts = progress.ts || Date.now();
        for (let i = 0; i < progressListeners.length; i++) {
            try { progressListeners[i](progress); } catch (e) { console.warn('[McpBridge] progress listener err', e); }
        }
    }

    function saveCardToHistory(card) {
        try {
            const raw = localStorage.getItem(CARD_HISTORY_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(arr)) return;
            arr.push(card);
            while (arr.length > MAX_CARD_HISTORY) arr.shift();
            localStorage.setItem(CARD_HISTORY_KEY, JSON.stringify(arr));
        } catch (e) {}
    }
    function getCardHistory() {
        try {
            const raw = localStorage.getItem(CARD_HISTORY_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }
    function clearCardHistory() {
        try { localStorage.removeItem(CARD_HISTORY_KEY); } catch (e) {}
    }

    // ========== 工具循环 (fetch hook 注入处) ==========

    function safeParseJson(s) {
        try { return JSON.parse(s); } catch (e) { return null; }
    }

    function wrapAsJsonResp(data, originalResp) {
        const status = originalResp ? originalResp.status : 200;
        const statusText = originalResp ? originalResp.statusText : 'OK';
        const headers = originalResp ? originalResp.headers : new Headers();
        return new Response(JSON.stringify(data), {
            status: status,
            statusText: statusText,
            headers: headers,
        });
    }

    async function runChatWithToolLoop(url, options) {
        if (!global.McpGenericClient) {
            return (originalFetch || fetch)(url, options);
        }

        try {
            const built = buildMcpOpenAITools();
            const tools = built.tools;
            const resolve = built.resolve;
            if (!tools.length) {
                return (originalFetch || fetch)(url, options);
            }

            const baseBody = safeParseJson(options && options.body) || {};
            baseBody.tools = (Array.isArray(baseBody.tools) ? baseBody.tools : []).concat(tools);
            const append = buildMcpSystemBlock() + '\n' + MCP_TAIL_REMINDER;
            if (Array.isArray(baseBody.messages)) {
                baseBody.messages = baseBody.messages.map(function (m) {
                    if (m.role === 'system' || m.role === 'developer') {
                        return Object.assign({}, m, { content: (m.content || '') + append });
                    }
                    return m;
                });
                if (!baseBody.messages.some(function (m) { return m.role === 'system' || m.role === 'developer'; })) {
                    baseBody.messages.unshift({ role: 'system', content: append.trim() });
                }
            }

            const newOpts = Object.assign({}, options, {
                body: JSON.stringify(baseBody),
                headers: Object.assign({}, options.headers || {}, { 'Content-Type': 'application/json' }),
            });

            let iteration = 0;
            let conversationMessages = baseBody.messages.slice();
            let lastAssistant = null;

            emitProgress({ phase: 'session_start', summary: '已合并 ' + tools.length + ' 个 MCP 工具' });

            const fetchForLLM = originalFetch || fetch;
            while (iteration < TOOL_LOOP_MAX) {
                iteration++;
                const reqBody = Object.assign({}, baseBody, { messages: conversationMessages });
                const iterOpts = Object.assign({}, newOpts, { body: JSON.stringify(reqBody) });
                const resp = await fetchForLLM(url, iterOpts);
                if (!resp.ok) {
                    emitProgress({ phase: 'session_done', summary: 'LLM 接口返回 ' + resp.status });
                    return resp;
                }
                const data = await resp.json();
                if (!data || !data.choices || !data.choices[0]) {
                    emitProgress({ phase: 'session_done', summary: 'LLM 响应异常' });
                    return wrapAsJsonResp(data, resp);
                }

                const msg = data.choices[0].message;
                lastAssistant = msg;
                const toolCalls = msg.tool_calls || [];
                if (!toolCalls.length) {
                    emitProgress({ phase: 'session_done', summary: 'AI 已完成' });
                    return wrapAsJsonResp(data, resp);
                }

                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    const fn = (tc.function && tc.function.name) || '';
                    let args = {};
                    try {
                        args = (tc.function && tc.function.arguments) ? JSON.parse(tc.function.arguments) : {};
                    } catch (e) { args = {}; }

                    const resolved = resolve.get(fn);
                    if (!resolved) {
                        // LLM 编了不存在的工具, 报告并跳过
                        emitProgress({ phase: 'tool_err', toolName: fn, summary: '工具未注册: ' + fn });
                        conversationMessages.push(msg);
                        conversationMessages.push({
                            role: 'tool',
                            tool_call_id: tc.id,
                            content: 'error: 工具 ' + fn + ' 未在当前会话注册, 请用 resolve map 里有的工具名',
                        });
                        continue;
                    }

                    emitProgress({ phase: 'tool_start', toolName: fn, summary: summarizeToolAction(resolved.toolName, args) });

                    let callResult;
                    try {
                        callResult = await global.McpGenericClient.callTool(resolved.server, resolved.toolName, args);
                    } catch (toolErr) {
                        callResult = { success: false, error: '工具调用异常: ' + ((toolErr && toolErr.message) || String(toolErr)) };
                    }
                    emitCardMessage(resolved.server, resolved.toolName, args, callResult);

                    emitProgress({
                        phase: callResult.success ? 'tool_ok' : 'tool_err',
                        toolName: fn,
                        summary: callResult.success
                            ? summarizeToolResult(resolved.toolName, callResult)
                            : ('失败: ' + ((callResult.error || '')).slice(0, 80)),
                    });

                    conversationMessages.push(msg);
                    conversationMessages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: callResult.success
                            ? formatMcpToolResult(callResult.data)
                            : ('error: ' + callResult.error),
                    });
                }
            }

            emitProgress({ phase: 'session_done', summary: '达到工具循环上限, 安全退出' });
            return wrapAsJsonResp({ choices: [{ message: lastAssistant }], usage: {} }, null);
        } catch (loopErr) {
            console.error('[McpBridge] runChatWithToolLoop 完全失败, 回退原 fetch:', loopErr);
            lastPreloadError = { message: '工具循环异常: ' + ((loopErr && loopErr.message) || String(loopErr)), at: Date.now() };
            try { emitProgress({ phase: 'session_done', summary: '工具循环异常, 回退无工具模式' }); }
            catch (e) {}
            return (originalFetch || fetch)(url, options);
        }
    }

    // ========== fetch hook ==========

    let originalFetch = null;
    let hookInstalled = false;
    let lastPreloadError = { message: null, at: 0 };
    let lastInterceptLog = [];

    function pushIntercept(entry) {
        entry.t = Date.now();
        lastInterceptLog.unshift(entry);
        while (lastInterceptLog.length > 5) lastInterceptLog.pop();
    }
    function describeUrl(url) {
        try { return String(url).replace(/^https?:\/\//, '').split('?')[0]; }
        catch (e) { return String(url); }
    }
    function isLLMRequest(url) {
        // 2026-07-31: 用户 API proxyUrl 都带 /v1, 实际 URL 是 /v1/chat/completions, 老匹配就是对的
        // 不动用户接口补全规则, 老逻辑保留
        return typeof url === 'string' && url.indexOf('/v1/chat/completions') >= 0;
    }

    function installHook() {
        if (hookInstalled) return;
        if (!global.McpGenericClient) {
            console.warn('[McpBridge] McpGenericClient 未加载, 推迟 hook 安装');
            return false;
        }
        originalFetch = window.fetch;
        const wrappedFetch = async function (input, init) {
            const url = (typeof input === 'string' ? input : (input && input.url)) || '';
            const method = (init && init.method) || (input && input.method) || 'GET';
            const isJsonBody = init && init.body && typeof init.body === 'string';

            if (method.toUpperCase() === 'POST' && isLLMRequest(url)) {
                const servers = global.McpGenericClient.getEnabledServers();
                const toolsReady = servers.length > 0;
                pushIntercept({
                    at: 'hook',
                    kind: toolsReady ? 'intercepted' : 'no-tools',
                    url: describeUrl(url),
                    toolsReady: toolsReady,
                    serverCount: servers.length,
                });

                if (toolsReady) {
                    try {
                        return await runChatWithToolLoop(url, init);
                    } catch (e) {
                        console.warn('[McpBridge] 工具循环出错, 回退原 fetch:', e);
                        return originalFetch.apply(this, arguments);
                    }
                }
            }
            return originalFetch.apply(this, arguments);
        };

        let installErr = null;
        try {
            window.fetch = wrappedFetch;
        } catch (e) {
            installErr = e;
            try {
                Object.defineProperty(window, 'fetch', {
                    value: wrappedFetch,
                    writable: true,
                    configurable: true,
                });
            } catch (e2) {
                console.warn('[McpBridge] 装 fetch hook 双 fallback 都失败:', e2);
                lastPreloadError = { message: 'fetch hook install failed: ' + ((e2 && e2.message) || String(e2)), at: Date.now() };
                return false;
            }
        }
        hookInstalled = true;
        console.log('[McpBridge] fetch hook 已安装 (通用 MCP, mode=' + (installErr ? 'defineProperty' : 'direct') + ')');
        return true;
    }

    function uninstallHook() {
        if (!hookInstalled) return;
        if (originalFetch) {
            try { window.fetch = originalFetch; }
            catch (e) {
                try { Object.defineProperty(window, 'fetch', { value: originalFetch, writable: true, configurable: true }); }
                catch (e2) { console.warn('[McpBridge] uninstallHook 失败:', e2); }
            }
        }
        hookInstalled = false;
        console.log('[McpBridge] fetch hook 已卸载');
    }

    // ========== 诊断 ==========

    function getStatus() {
        const all = (global.McpGenericClient && global.McpGenericClient.loadServers) ? global.McpGenericClient.loadServers() : [];
        const enabled = (global.McpGenericClient && global.McpGenericClient.getEnabledServers) ? global.McpGenericClient.getEnabledServers() : [];
        return {
            bridge: !!global.McpGenericClient && !!global.McpBridge,
            client: !!global.McpGenericClient,
            totalServers: all.length,
            enabledServers: enabled.length,
            enabledList: enabled.map(function (s) {
                return { id: s.id, name: s.name, toolsCount: (s.tools || []).length };
            }),
            hookInstalled: hookInstalled,
            useNativeTools: (global.McpGenericClient && global.McpGenericClient.getUseNativeTools) ? global.McpGenericClient.getUseNativeTools() : true,
            recentIntercept: lastInterceptLog.slice(0, 5),
            lastPreloadError: lastPreloadError,
        };
    }

    function resetAll() {
        try {
            if (global.McpGenericClient) {
                const all = global.McpGenericClient.loadServers();
                for (let i = 0; i < all.length; i++) {
                    global.McpGenericClient.resetSession(all[i].id);
                }
            }
            uninstallHook();
            lastInterceptLog = [];
            lastPreloadError = { message: null, at: 0 };
            console.log('[McpBridge] all reset (保留 user config / enabled 状态)');
        } catch (e) {
            console.warn('[McpBridge] reset error:', e);
        }
    }

    // ========== 暴露 API ==========

    global.McpBridge = {
        VERSION: 'v1.0.0-generic',
        isHookInstalled: function () { return hookInstalled; },
        installHook: installHook,
        uninstallHook: uninstallHook,

        // 事件
        onCard: onCard,
        onProgress: onProgress,
        getCardHistory: getCardHistory,
        clearCardHistory: clearCardHistory,

        // UI 状态
        getEnabledServerCount: function () {
            return global.McpGenericClient ? global.McpGenericClient.getEnabledServers().length : 0;
        },
        isAvailable: function () {
            return global.McpGenericClient ? global.McpGenericClient.isAvailable() : false;
        },
        getEnabledServers: function () {
            return global.McpGenericClient ? global.McpGenericClient.getEnabledServers() : [];
        },

        // 诊断
        getStatus: getStatus,
        resetAll: resetAll,
        lastInterceptLog: lastInterceptLog,
    };

    // ========== 自动安装 hook (等 McpGenericClient 加载完) ==========
    // 跟旧版不同: 旧版等用户点工具栏按钮再装; 新版只要 McpGenericClient 加载就装
    // 因为 "启用 server = 自动激活" 的新语义下, hook 总是应该就绪
    function tryInstall() {
        if (global.McpGenericClient) {
            installHook();
            return;
        }
        setTimeout(tryInstall, 100);
    }
    if (typeof document !== 'undefined' && document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(tryInstall, 50); });
    } else {
        setTimeout(tryInstall, 50);
    }

    console.log('[McpBridge] 通用 MCP 工具桥接已加载 (依赖 McpGenericClient)');

})(typeof window !== 'undefined' ? window : globalThis);
