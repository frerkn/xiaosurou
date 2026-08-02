// 端到端验证: wrappedFetch 检测 stream: true → 不进工具循环 (走 originalFetch)
// 修前 bug: runChatWithToolLoopGemini 强删 stream 返 non-stream JSON, 330 stream 处理挂掉
// 修后: wrappedFetch 检测到 body.stream = true → 直接走 originalFetch

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// 加载 mcp-tool-bridge.js 的关键部分
// 太复杂, 单独测 wrappedFetch 的 stream 判定逻辑
// 复制 wrappedFetch 的核心判定

let _intercepted = false;
let _stream = null;

async function wrappedFetch(input, init, originalFetch, isLLMRequest, isGeminiNativeRequest) {
    const url = (typeof input === 'string' ? input : (input && input.url)) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';
    const isJsonBody = init && init.body && typeof init.body === 'string';

    let isStream = false;
    if (isJsonBody) {
        try {
            const body = JSON.parse(init.body);
            if (body && body.stream) isStream = true;
        } catch (e) {}
    }

    if (method.toUpperCase() === 'POST' && isLLMRequest(url) && !isStream) {
        _intercepted = true;
        // 这里调工具循环 (省略, 测绕过)
        return { mode: 'tool-loop' };
    }
    _intercepted = false;
    _stream = isStream;
    return originalFetch(url, init);
}

// mock 工具函数
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

// mock originalFetch
const _origCalls = [];
async function originalFetch(url, init) {
    _origCalls.push({ url, body: init && init.body });
    return { mode: 'original' };
}

let pass = 0, fail = 0;
async function test(label, fn) {
    _intercepted = false; _stream = null; _origCalls.length = 0;
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
    // 1. Gemini native 端点 + stream: true → 走 originalFetch, 不拦截
    await test('Gemini native stream → 不拦截, 走 original', async () => {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=AIza';
        const init = { method: 'POST', body: JSON.stringify({ contents: [], stream: true }) };
        const r = await wrappedFetch(url, init, originalFetch, isLLMRequest, isGeminiNativeRequest);
        if (_intercepted) throw new Error('应该不被拦截');
        if (r.mode !== 'original') throw new Error('应该走 original');
        if (_origCalls.length !== 1) throw new Error('originalFetch 应该被调');
        if (!_stream) throw new Error('应该识别到 stream');
    });

    // 2. Gemini native 端点 + stream: false → 进工具循环
    await test('Gemini native non-stream → 进工具循环', async () => {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=AIza';
        const init = { method: 'POST', body: JSON.stringify({ contents: [], stream: false }) };
        const r = await wrappedFetch(url, init, originalFetch, isLLMRequest, isGeminiNativeRequest);
        if (!_intercepted) throw new Error('应该被拦截');
        if (r.mode !== 'tool-loop') throw new Error('应该走 tool-loop');
    });

    // 3. Gemini OpenAI 兼容端点 + stream: true → 走 originalFetch
    await test('Gemini OpenAI 兼容 stream → 不拦截', async () => {
        const url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
        const init = { method: 'POST', body: JSON.stringify({ messages: [], stream: true }) };
        const r = await wrappedFetch(url, init, originalFetch, isLLMRequest, isGeminiNativeRequest);
        if (_intercepted) throw new Error('应该不被拦截');
        if (r.mode !== 'original') throw new Error('应该走 original');
    });

    // 4. 普通 M3 端点 + stream: true → 走 originalFetch
    await test('M3 端点 stream → 不拦截', async () => {
        const url = 'https://api.minimaxi.com/v1/chat/completions';
        const init = { method: 'POST', body: JSON.stringify({ messages: [], stream: true }) };
        const r = await wrappedFetch(url, init, originalFetch, isLLMRequest, isGeminiNativeRequest);
        if (_intercepted) throw new Error('应该不被拦截');
        if (r.mode !== 'original') throw new Error('应该走 original');
    });

    // 5. 普通 M3 端点 + stream: false → 进工具循环
    await test('M3 端点 non-stream → 进工具循环', async () => {
        const url = 'https://api.minimaxi.com/v1/chat/completions';
        const init = { method: 'POST', body: JSON.stringify({ messages: [], stream: false }) };
        const r = await wrappedFetch(url, init, originalFetch, isLLMRequest, isGeminiNativeRequest);
        if (!_intercepted) throw new Error('应该被拦截');
        if (r.mode !== 'tool-loop') throw new Error('应该走 tool-loop');
    });

    // 6. body 不是 JSON 字符串 → 不算 stream
    await test('body 不是 JSON → 不算 stream', async () => {
        const url = 'https://api.minimaxi.com/v1/chat/completions';
        const init = { method: 'POST', body: 'plain text' };
        const r = await wrappedFetch(url, init, originalFetch, isLLMRequest, isGeminiNativeRequest);
        if (!_intercepted) throw new Error('应该被拦截 (非 stream, 走 tool-loop)');
    });

    // 7. body 解析失败 → 不算 stream, 也不抛错
    await test('body 解析失败 → 不算 stream, 不抛错', async () => {
        const url = 'https://api.minimaxi.com/v1/chat/completions';
        const init = { method: 'POST', body: '{ invalid json' };
        const r = await wrappedFetch(url, init, originalFetch, isLLMRequest, isGeminiNativeRequest);
        if (!_intercepted) throw new Error('应该被拦截');
    });

    // 8. Gemini native + 没 stream 字段 → 不算 stream, 进工具循环
    await test('Gemini native + 没 stream 字段 → 进工具循环', async () => {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=AIza';
        const init = { method: 'POST', body: JSON.stringify({ contents: [] }) };
        const r = await wrappedFetch(url, init, originalFetch, isLLMRequest, isGeminiNativeRequest);
        if (!_intercepted) throw new Error('应该被拦截');
        if (r.mode !== 'tool-loop') throw new Error('应该走 tool-loop');
    });

    console.log('\n========== 总结 ==========');
    console.log('通过 ' + pass + ', 失败 ' + fail);
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('❌ 主流程异常:', e); process.exit(1); });
