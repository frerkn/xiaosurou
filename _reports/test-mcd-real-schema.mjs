// 用 mcd 真实 schema 测 convertSchemaToGemini
import { readFileSync } from 'fs';

// 复制 v0.1.65 的 convertSchemaToGemini (原样)
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
    if (Array.isArray(schema.enum)) out.enum = schema.enum;
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

const mcd = JSON.parse(readFileSync('_reports/mcd-tools.json', 'utf8'));
const tools = mcd.result?.tools || [];

console.log('=== mcd 真实 schema 转换测试 ===\n');

// 找前 3 个有 enum 的工具
let count = 0;
for (const t of tools) {
    const s = JSON.stringify(t.inputSchema || {});
    if (s.includes('enum')) {
        count++;
        if (count > 3) break;
        console.log('--- ' + t.name + ' ---');
        const gemini = convertSchemaToGemini(t.inputSchema);
        console.log(JSON.stringify(gemini, null, 2));
        // 找有 enum 的属性, 看 enum 元素
        for (const k of Object.keys(gemini.properties || {})) {
            const p = gemini.properties[k];
            if (p.enum) {
                console.log('  property ' + k + '.enum = ' + JSON.stringify(p.enum) + ' (types: ' + p.enum.map(v => typeof v).join(',') + ')');
            }
        }
        console.log();
    }
}
