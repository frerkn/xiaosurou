// 端到端验证: 用 mcd 真实 schema 测 convertSchemaToGemini 输出是否让 Gemini API 接受
// 重点: type 大写 + enum 元素 toString (mcd 真实 schema 里 enum 是 number array)

import { readFileSync } from 'fs';

// 复制 v0.1.68 的 convertSchemaToGemini
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

const mcd = JSON.parse(readFileSync('_reports/mcd-tools.json', 'utf8'));
const tools = mcd.result?.tools || [];

let pass = 0, fail = 0;
function test(label, fn) {
    try {
        if (fn()) { console.log('  ✅ pass: ' + label); pass++; }
        else { console.log('  ❌ fail: ' + label); fail++; }
    } catch (e) { console.log('  ❌ 异常: ' + e.message); fail++; }
}

console.log('=== mcd 真实 schema → Gemini API 兼容验证 ===\n');

// 验证 1: 所有 type 都是大写 proto3 枚举
test('所有 29 个 mcd 工具的 type 都是大写', () => {
    let allTypes = new Set();
    for (const t of tools) {
        const oaTools = [{
            type: 'function',
            function: {
                name: t.name,
                description: '',
                parameters: t.inputSchema || { type: 'object', properties: {} }
            }
        }];
        const gemini = openAIToolsToGemini(oaTools);
        // 递归收集所有 type
        function collectTypes(node) {
            if (!node) return;
            if (node.type) allTypes.add(node.type);
            if (node.properties) for (const k in node.properties) collectTypes(node.properties[k]);
            if (node.items) collectTypes(node.items);
        }
        collectTypes(gemini[0].functionDeclarations[0].parameters);
    }
    const validTypes = new Set(['STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'OBJECT', 'ARRAY', 'TYPE_UNSPECIFIED']);
    for (const t of allTypes) {
        if (!validTypes.has(t)) {
            console.log('  非法 type: ' + t);
            return false;
        }
    }
    console.log('  找到的 type: ' + Array.from(allTypes).join(','));
    return true;
});

// 验证 2: 所有 enum 元素都是 string
test('所有有 enum 的工具, enum 元素都是 string', () => {
    let totalEnums = 0;
    for (const t of tools) {
        const oaTools = [{
            type: 'function',
            function: {
                name: t.name,
                description: '',
                parameters: t.inputSchema || { type: 'object', properties: {} }
            }
        }];
        const gemini = openAIToolsToGemini(oaTools);
        function checkEnums(node) {
            if (!node) return;
            if (Array.isArray(node.enum)) {
                totalEnums++;
                for (const v of node.enum) {
                    if (typeof v !== 'string') {
                        console.log('  工具 ' + t.name + ' 有非 string enum: ' + JSON.stringify(node.enum));
                        return false;
                    }
                }
            }
            if (node.properties) for (const k in node.properties) checkEnums(node.properties[k]);
            if (node.items) checkEnums(node.items);
        }
        checkEnums(gemini[0].functionDeclarations[0].parameters);
    }
    console.log('  共检查 ' + totalEnums + ' 个 enum 字段');
    return true;
});

// 验证 3: mcd query-nearby-stores 转换后 Gemini API 应该接受
test('query-nearby-stores 转换后 type 全大写 + enum 元素全 string', () => {
    const t = tools.find(x => x.name === 'query-nearby-stores');
    if (!t) return false;
    const oaTools = [{ type: 'function', function: { name: t.name, description: '', parameters: t.inputSchema } }];
    const gemini = openAIToolsToGemini(oaTools);
    const decl = gemini[0].functionDeclarations[0];
    console.log('  query-nearby-stores parameters:', JSON.stringify(decl.parameters, null, 2).slice(0, 500));
    // 验证
    if (decl.parameters.type !== 'OBJECT') return false;
    if (decl.parameters.properties.beType.type !== 'INTEGER') return false;
    if (JSON.stringify(decl.parameters.properties.beType.enum) !== '["1","5"]') return false;
    if (decl.parameters.properties.searchType.type !== 'INTEGER') return false;
    if (JSON.stringify(decl.parameters.properties.searchType.enum) !== '["1","2"]') return false;
    return true;
});

// 验证 4: query-store-coupons (3 个 enum)
test('query-store-coupons 多 enum 全转 string', () => {
    const t = tools.find(x => x.name === 'query-store-coupons');
    if (!t) return false;
    const oaTools = [{ type: 'function', function: { name: t.name, description: '', parameters: t.inputSchema } }];
    const gemini = openAIToolsToGemini(oaTools);
    const p = gemini[0].functionDeclarations[0].parameters.properties;
    if (JSON.stringify(p.beType.enum) !== '["1","2","5","6"]') return false;
    if (JSON.stringify(p.orderType.enum) !== '["1","2"]') return false;
    return true;
});

console.log('\n=== 总结 ===');
console.log('通过 ' + pass + ', 失败 ' + fail);
process.exit(fail > 0 ? 1 : 0);
