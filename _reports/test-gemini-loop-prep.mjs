// 验证 v0.1.76b 新加的 3 个 Gemini 函数 (convertOpenAIMessagesToGemini / formatGeminiFunctionResponseContent / openAIToolsToGemini)
// 复制 mcp-tool-bridge.js 里的 3 个函数, 跑纯函数断言

function convertSchemaToGemini(schema) {
    if (!schema || typeof schema !== 'object') return { type: 'OBJECT', properties: {} };
    const typeMap = {
        'string': 'STRING', 'number': 'NUMBER', 'integer': 'INTEGER',
        'boolean': 'BOOLEAN', 'object': 'OBJECT', 'array': 'ARRAY',
        'STRING': 'STRING', 'NUMBER': 'NUMBER', 'INTEGER': 'INTEGER',
        'BOOLEAN': 'BOOLEAN', 'OBJECT': 'OBJECT', 'ARRAY': 'ARRAY',
    };
    const rawType = schema.type || 'object';
    const out = { type: typeMap[String(rawType).toLowerCase()] || 'TYPE_UNSPECIFIED' };
    if (schema.description) out.description = schema.description;
    if (Array.isArray(schema.enum)) {
        out.enum = schema.enum.map(function (v) { return String(v); });
    }
    if (schema.properties) {
        out.properties = {};
        for (const k in schema.properties) {
            out.properties[k] = convertSchemaToGemini(schema.properties[k]);
        }
    }
    if (Array.isArray(schema.required)) out.required = schema.required;
    if (schema.items) out.items = convertSchemaToGemini(schema.items);
    return out;
}

function openAIToolsToGemini(openAITools) {
    const declarations = (openAITools || []).map(function (t) {
        if (!t || t.type !== 'function') return null;
        const f = t.function || {};
        return { name: f.name, description: f.description || '', parameters: convertSchemaToGemini(f.parameters || { type: 'object', properties: {} }) };
    }).filter(Boolean);
    if (!declarations.length) return undefined;
    return [{ functionDeclarations: declarations }];
}

function convertOpenAIMessagesToGemini(messages) {
    const contents = [];
    let systemText = '';
    for (const m of (messages || [])) {
        if (!m || !m.role) continue;
        if (m.role === 'system' || m.role === 'developer') {
            systemText += (systemText ? '\n\n' : '') + (m.content || '');
        } else if (m.role === 'user') {
            contents.push({ role: 'user', parts: [{ text: String(m.content || '') }] });
        } else if (m.role === 'assistant') {
            contents.push({ role: 'model', parts: [{ text: String(m.content || '') }] });
        }
    }
    return { contents: contents, systemText: systemText };
}

function formatMcpToolResultStub(data) {
    return String(data == null ? '' : (typeof data === 'string' ? data : JSON.stringify(data)));
}

function formatGeminiFunctionResponseContent(callResult) {
    if (!callResult || !callResult.success) {
        return { success: false, error: (callResult && callResult.error) || '工具调用失败' };
    }
    return { success: true, result: formatMcpToolResultStub(callResult.data) };
}

let pass = 0, fail = 0;
function test(label, fn) {
    try {
        const ok = fn();
        if (ok === true) { console.log('  ✅ pass: ' + label); pass++; }
        else { console.log('  ❌ fail: ' + label + (typeof ok === 'string' ? ' — ' + ok : '')); fail++; }
    } catch (e) { console.log('  ❌ 异常: ' + label + ' — ' + e.message); fail++; }
}

console.log('=== v0.1.76b Gemini 循环辅助函数验证 ===\n');

// convertOpenAIMessagesToGemini
test('system + user + assistant 转换', () => {
    const r = convertOpenAIMessagesToGemini([
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '我好' },
    ]);
    return r.systemText === '你是助手'
        && r.contents.length === 2
        && r.contents[0].role === 'user' && r.contents[0].parts[0].text === '你好'
        && r.contents[1].role === 'model' && r.contents[1].parts[0].text === '我好';
});

test('多个 system 消息合并', () => {
    const r = convertOpenAIMessagesToGemini([
        { role: 'system', content: '规则 1' },
        { role: 'system', content: '规则 2' },
    ]);
    return r.systemText === '规则 1\n\n规则 2' && r.contents.length === 0;
});

test('developer 角色当 system 处理', () => {
    const r = convertOpenAIMessagesToGemini([{ role: 'developer', content: 'dev 规则' }]);
    return r.systemText === 'dev 规则' && r.contents.length === 0;
});

test('tool 角色第一版跳过 (不报错, 不入 contents)', () => {
    const r = convertOpenAIMessagesToGemini([
        { role: 'user', content: '问 1' },
        { role: 'tool', tool_call_id: 'abc', content: '工具结果' },
        { role: 'user', content: '问 2' },
    ]);
    return r.contents.length === 2 && r.contents[0].parts[0].text === '问 1' && r.contents[1].parts[0].text === '问 2';
});

test('空 messages 兜底', () => {
    const r = convertOpenAIMessagesToGemini(null);
    return r.contents.length === 0 && r.systemText === '';
});

test('assistant 空 content 兜底成空串', () => {
    const r = convertOpenAIMessagesToGemini([{ role: 'assistant', content: '' }]);
    return r.contents[0].role === 'model' && r.contents[0].parts[0].text === '';
});

// formatGeminiFunctionResponseContent
test('成功 callResult → {success: true, result: string}', () => {
    const r = formatGeminiFunctionResponseContent({ success: true, data: { foo: 'bar' } });
    return r.success === true && typeof r.result === 'string' && r.result.includes('foo') || ('result=' + JSON.stringify(r));
});

test('失败 callResult → {success: false, error: string}', () => {
    const r = formatGeminiFunctionResponseContent({ success: false, error: '服务器 500' });
    return r.success === false && r.error === '服务器 500';
});

test('null callResult → {success: false, error: 默认}', () => {
    const r = formatGeminiFunctionResponseContent(null);
    return r.success === false && r.error === '工具调用失败';
});

test('失败 callResult 缺 error 字段 → 兜底', () => {
    const r = formatGeminiFunctionResponseContent({ success: false });
    return r.success === false && r.error === '工具调用失败';
});

test('成功 callResult data=null → result 空串', () => {
    const r = formatGeminiFunctionResponseContent({ success: true, data: null });
    return r.success === true && r.result === '';
});

// openAIToolsToGemini 端到端 (mcd 真实 schema)
import { existsSync, readFileSync } from 'fs';
if (existsSync('_reports/mcd-tools.json')) {
    test('mcd 工具 → Gemini tools[{functionDeclarations}] 结构正确', () => {
        const mcd = JSON.parse(readFileSync('_reports/mcd-tools.json', 'utf8'));
        const tools = (mcd.result && mcd.result.tools) || [];
        const oaTools = tools.map(function (t) {
            return { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } } };
        });
        const g = openAIToolsToGemini(oaTools);
        return Array.isArray(g) && g.length === 1
            && Array.isArray(g[0].functionDeclarations) && g[0].functionDeclarations.length === tools.length
            && g[0].functionDeclarations.every(d => d.name && d.parameters && d.parameters.type === 'OBJECT');
    });
} else {
    console.log('  ⚠️ 跳过 mcd 真实 schema 验证 (没找到 _reports/mcd-tools.json)');
}

console.log('\n=== 总结 ===');
console.log('通过 ' + pass + ', 失败 ' + fail);
process.exit(fail > 0 ? 1 : 0);
