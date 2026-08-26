// 验证 v0.1.76a 新加的 2 个 Gemini 转换函数
// 复制 mcp-tool-bridge.js 里的 convertSchemaToGemini / openAIToolsToGemini, 跑 mcd 真实 schema
// 重点: type 大写 + enum 元素 toString (mcd 真实 schema 里 enum 是 number array)

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
        return {
            name: f.name,
            description: f.description || '',
            parameters: convertSchemaToGemini(f.parameters || { type: 'object', properties: {} })
        };
    }).filter(Boolean);
    if (!declarations.length) return undefined;
    return [{ functionDeclarations: declarations }];
}

import { readFileSync, existsSync } from 'fs';

let pass = 0, fail = 0;
function test(label, fn) {
    try {
        const ok = fn();
        if (ok === true) { console.log('  ✅ pass: ' + label); pass++; }
        else { console.log('  ❌ fail: ' + label + (typeof ok === 'string' ? ' — ' + ok : '')); fail++; }
    } catch (e) { console.log('  ❌ 异常: ' + label + ' — ' + e.message); fail++; }
}

console.log('=== v0.1.76a Gemini 转换函数验证 ===\n');

// 1. 空 tools 返 undefined
test('openAIToolsToGemini([]) === undefined', () => {
    return openAIToolsToGemini([]) === undefined;
});

// 2. type 大写
test('小写 "string" → "STRING"', () => {
    const r = convertSchemaToGemini({ type: 'string' });
    return r.type === 'STRING' || ('type 实际=' + r.type);
});

// 3. enum 元素 number → string
test('enum [1, 5] → ["1", "5"]', () => {
    const r = convertSchemaToGemini({ type: 'integer', enum: [1, 5] });
    return JSON.stringify(r.enum) === '["1","5"]' || ('enum 实际=' + JSON.stringify(r.enum));
});

// 4. 嵌套 object 递归
test('嵌套 object 递归大写', () => {
    const r = convertSchemaToGemini({
        type: 'object',
        properties: {
            flag: { type: 'boolean' },
            tags: { type: 'array', items: { type: 'string' } },
            inner: { type: 'object', properties: { x: { type: 'number' } } }
        }
    });
    return r.properties.flag.type === 'BOOLEAN'
        && r.properties.tags.type === 'ARRAY'
        && r.properties.tags.items.type === 'STRING'
        && r.properties.inner.type === 'OBJECT'
        && r.properties.inner.properties.x.type === 'NUMBER';
});

// 5. description / required 保留
test('description + required 保留', () => {
    const r = convertSchemaToGemini({
        type: 'object',
        description: '顶层描述',
        properties: { x: { type: 'string', description: 'X 描述' } },
        required: ['x']
    });
    return r.description === '顶层描述'
        && r.required[0] === 'x'
        && r.properties.x.description === 'X 描述';
});

// 6. 空 schema 兜底
test('null schema → OBJECT 空 properties', () => {
    const r = convertSchemaToGemini(null);
    return r.type === 'OBJECT' && JSON.stringify(r.properties) === '{}';
});

// 7. mcd 真实 schema (如果文件存在)
const mcdPath = '_reports/mcd-tools.json';
if (existsSync(mcdPath)) {
    const mcd = JSON.parse(readFileSync(mcdPath, 'utf8'));
    const tools = (mcd.result && mcd.result.tools) || [];
    test('mcd 真实 ' + tools.length + ' 个工具转换后 type 全大写', () => {
        const allTypes = new Set();
        const oaTools = tools.map(function (t) {
            return { type: 'function', function: { name: t.name, description: '', parameters: t.inputSchema || { type: 'object', properties: {} } } };
        });
        const gemini = openAIToolsToGemini(oaTools);
        if (!gemini || !gemini[0] || !gemini[0].functionDeclarations) return 'gemini 转换返空';
        function collectTypes(node) {
            if (!node) return;
            if (node.type) allTypes.add(node.type);
            if (node.properties) for (const k in node.properties) collectTypes(node.properties[k]);
            if (node.items) collectTypes(node.items);
        }
        for (const decl of gemini[0].functionDeclarations) collectTypes(decl.parameters);
        const validTypes = new Set(['STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'OBJECT', 'ARRAY', 'TYPE_UNSPECIFIED']);
        for (const t of allTypes) {
            if (!validTypes.has(t)) return '非法 type=' + t;
        }
        return true;
    });

    test('mcd query-nearby-stores 转换正确', () => {
        const t = tools.find(function (x) { return x.name === 'query-nearby-stores'; });
        if (!t) return '没找到该工具';
        const oaTools = [{ type: 'function', function: { name: t.name, description: '', parameters: t.inputSchema } }];
        const gemini = openAIToolsToGemini(oaTools);
        const decl = gemini[0].functionDeclarations[0];
        const p = decl.parameters.properties;
        return p.beType.type === 'INTEGER'
            && JSON.stringify(p.beType.enum) === '["1","5"]'
            && p.searchType.type === 'INTEGER'
            && JSON.stringify(p.searchType.enum) === '["1","2"]';
    });
} else {
    console.log('  ⚠️ 跳过 mcd 真实 schema 验证 (没找到 _reports/mcd-tools.json)');
}

console.log('\n=== 总结 ===');
console.log('通过 ' + pass + ', 失败 ' + fail);
process.exit(fail > 0 ? 1 : 0);
