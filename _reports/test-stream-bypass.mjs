// 端到端验证: wrappedFetch v0.1.69 简化
// 核心: Gemini native 端点 永远 bypass (普通聊天 + 总结记忆 不被破坏)
// 调工具 改用 OpenAI 兼容端点 (已 work)
// 修前: v0.1.58 拦截所有 Gemini 请求, 强制 non-stream + 注入 tools, 破坏 330 原生行为
// 修后: Gemini native 走 originalFetch, OpenAI 兼容端点 + M3 走工具循环

let _origCalls = [];
let _intercepted = false;

async function wrappedFetch(input, init, originalFetch, isGeminiNativeRequest, isLLMRequest) {
    const url = (typeof input === 'string' ? input : (input && input.url)) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';

    if (method.toUpperCase() !== 'POST') {
        return originalFetch(url, init);
    }
    if (isGeminiNativeRequest(url)) {
        // Gemini native 永远 bypass
        _origCalls.push({ url, bypass: 'gemini-native' });
        return originalFetch(url, init);
    }
    if (!isLLMRequest(url)) {
        _origCalls.push({ url, bypass: 'not-llm' });
        return originalFetch(url, init);
    }

    // 这里模拟 toolsReady = true 进工具循环
    _intercepted = true;
    return { mode: 'tool-loop' };
}

function isLLMRequest(url) {
    if (typeof url !== 'string') return false;
    if (url.indexOf('/v1/chat/completions') >= 0) return true;
    if (url.indexOf('/v1beta/openai/chat/completions') >= 0) return true;
    if (url.indexOf('generativelanguage.googleapis.com') >= 0) return true;
    return false;
}

function isGeminiNativeRequest(url) {
    if (typeof url !== 'string') return false;
    if (url.indexOf('generativelanguage.googleapis.com') < 0) return false;
    if (url.indexOf('/v1beta/openai/chat/completions') >= 0) return false;
    return true;
}

const _realFetch = async (url, init) => {
    _origCalls.push({ url, body: init && init.body, real: true });
    return { mode: 'original' };
};

let pass = 0, fail = 0;
async function test(label, fn) {
    _origCalls = []; _intercepted = false;
    try {
        await fn();
        console.log('  ✅ pass: ' + label);
        pass++;
    } catch (e) {
        console.log('  ❌ fail: ' + label + ' — ' + e.message);
        fail++;
    }
}

async function main() {
    // Gemini native 端点永远 bypass (普通聊天 + 总结记忆)
    await test('Gemini native (普通聊天) → bypass, 走 original', async () => {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=AIza';
        const r = await wrappedFetch(url, { method: 'POST', body: JSON.stringify({ contents: [{role:'user',parts:[{text:'hi'}]}] }) }, _realFetch, isGeminiNativeRequest, isLLMRequest);
        if (_intercepted) throw new Error('不应该被拦截');
        if (r.mode !== 'original') throw new Error('应该走 original');
        if (_origCalls.length === 0) throw new Error('originalFetch 应该被调');
        if (_origCalls[0].bypass !== 'gemini-native') throw new Error('应该标记为 gemini-native bypass');
    });

    // Gemini native stream 模式
    await test('Gemini native stream → bypass', async () => {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=AIza';
        const r = await wrappedFetch(url, { method: 'POST', body: JSON.stringify({ contents: [], stream: true }) }, _realFetch, isGeminiNativeRequest, isLLMRequest);
        if (_intercepted) throw new Error('不应该被拦截');
        if (r.mode !== 'original') throw new Error('应该走 original');
    });

    // Gemini OpenAI 兼容端点 (调工具) → 进工具循环
    await test('Gemini OpenAI 兼容 (调工具) → 进工具循环', async () => {
        const url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
        const r = await wrappedFetch(url, { method: 'POST', body: JSON.stringify({ messages: [{role:'user',content:'hi'}] }) }, _realFetch, isGeminiNativeRequest, isLLMRequest);
        if (!_intercepted) throw new Error('应该被拦截');
        if (r.mode !== 'tool-loop') throw new Error('应该走 tool-loop');
    });

    // M3 端点 → 进工具循环
    await test('M3 端点 (调工具) → 进工具循环', async () => {
        const url = 'https://api.minimaxi.com/v1/chat/completions';
        const r = await wrappedFetch(url, { method: 'POST', body: JSON.stringify({ messages: [] }) }, _realFetch, isGeminiNativeRequest, isLLMRequest);
        if (!_intercepted) throw new Error('应该被拦截');
        if (r.mode !== 'tool-loop') throw new Error('应该走 tool-loop');
    });

    // 非 LLM URL → bypass
    await test('非 LLM URL → bypass', async () => {
        const url = 'https://example.com/some-api';
        const r = await wrappedFetch(url, { method: 'POST' }, _realFetch, isGeminiNativeRequest, isLLMRequest);
        if (_intercepted) throw new Error('不应该被拦截');
        if (r.mode !== 'original') throw new Error('应该走 original');
    });

    // GET 请求 → bypass
    await test('GET 请求 → bypass', async () => {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro';
        const r = await wrappedFetch(url, { method: 'GET' }, _realFetch, isGeminiNativeRequest, isLLMRequest);
        if (_intercepted) throw new Error('不应该被拦截');
        if (r.mode !== 'original') throw new Error('应该走 original');
    });

    // 公益站 Gemini (OpenAI 兼容) → 进工具循环
    await test('公益站 Gemini (OpenAI 兼容) → 进工具循环', async () => {
        const url = 'https://some-gongyi-station.com/v1/chat/completions';
        const r = await wrappedFetch(url, { method: 'POST', body: JSON.stringify({ messages: [] }) }, _realFetch, isGeminiNativeRequest, isLLMRequest);
        if (!_intercepted) throw new Error('应该被拦截');
        if (r.mode !== 'tool-loop') throw new Error('应该走 tool-loop');
    });

    // 公益站 Gemini (native) → bypass
    await test('公益站 Gemini (native) → bypass', async () => {
        // 公益站可能用 native 端点
        const url = 'https://some-gongyi-station.com/v1beta/models/gemini-pro:generateContent';
        // 但不是 generativelanguage.googleapis.com, 所以 isGeminiNativeRequest 返 false
        // 同时也不是 /v1/chat/completions
        // 所以 isLLMRequest 返 false → bypass
        const r = await wrappedFetch(url, { method: 'POST' }, _realFetch, isGeminiNativeRequest, isLLMRequest);
        if (_intercepted) throw new Error('不应该被拦截');
        if (r.mode !== 'original') throw new Error('应该走 original');
    });

    console.log('\n========== 总结 ==========');
    console.log('通过 ' + pass + ', 失败 ' + fail);
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('❌ 主流程异常:', e); process.exit(1); });
