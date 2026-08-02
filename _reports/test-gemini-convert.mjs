// 端到端验证: Gemini 原生 API tools.type 必须大写 (proto3 枚举)
// 修前 bug: OpenAI 风格小写 "string" Gemini API 400 Invalid value
// 修后: convertSchemaToGemini 递归转所有 type 字段

// 直接复制 mcp-tool-bridge.js 的 convertSchemaToGemini / openAIToolsToGemini
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

let pass = 0, fail = 0;

function test(label, fn) {
    try {
        const ok = fn();
        if (ok) { console.log('  ✅ pass: ' + label); pass++; }
        else { console.log('  ❌ fail: ' + label); fail++; }
    } catch (e) { console.log('  ❌ 异常: ' + e.message); fail++; }
}

console.log('=== 1. isGeminiNativeRequest 识别 (保留老测试) ===');
function isGeminiNativeRequest(url) {
    if (typeof url !== 'string') return false;
    if (url.indexOf('generativelanguage.googleapis.com') < 0) return false;
    if (url.indexOf('/v1beta/openai/chat/completions') >= 0) return false;
    return true;
}
const urls = [
    ['https://keungliang.dpdns.org/v1/chat/completions', false],
    ['https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', false],
    ['https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent', true],
    ['https://api.minimaxi.com/v1/chat/completions', false],
    ['https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=AIza', true],
];
urls.forEach(([u, expected]) => {
    test('isGeminiNativeRequest ' + u.slice(0, 60) + ' → ' + expected, () => {
        return isGeminiNativeRequest(u) === expected;
    });
});

console.log('\n=== 2. type 大写转换 (核心 bug 修复) ===');
test('mcp.mcd.cn query-nearby-stores 参数 type 全转大写', () => {
    // 模拟 mcd query-nearby-stores 实际 inputSchema (OpenAI 风格小写)
    const oaTools = [{
        type: 'function',
        function: {
            name: 'query-nearby-stores',
            description: '查询附近门店',
            parameters: {
                type: 'object',
                properties: {
                    beType: { type: 'string', description: '门店类型' },
                    searchType: { type: 'string', description: '搜索类型' },
                    city: { type: 'string' },
                    keyword: { type: 'string' },
                    is24h: { type: 'boolean' },
                },
                required: ['beType', 'searchType'],
            }
        }
    }];
    const gemini = openAIToolsToGemini(oaTools);
    const decl = gemini[0].functionDeclarations[0];
    console.log('    转换后:', JSON.stringify(decl, null, 2).slice(0, 300));
    // 验证
    if (decl.parameters.type !== 'OBJECT') return false;
    if (decl.parameters.properties.beType.type !== 'STRING') return false;
    if (decl.parameters.properties.searchType.type !== 'STRING') return false;
    if (decl.parameters.properties.is24h.type !== 'BOOLEAN') return false;
    return true;
});

test('嵌套 object + array + integer 全转大写', () => {
    const oaTools = [{
        type: 'function',
        function: {
            name: 'complex-tool',
            description: '',
            parameters: {
                type: 'object',
                properties: {
                    count: { type: 'integer' },
                    amount: { type: 'number' },
                    tags: { type: 'array', items: { type: 'string' } },
                    options: { type: 'object', properties: {
                        flag: { type: 'boolean' },
                    }},
                },
            }
        }
    }];
    const gemini = openAIToolsToGemini(oaTools);
    const p = gemini[0].functionDeclarations[0].parameters.properties;
    console.log('    嵌套转换:', JSON.stringify({
        count: p.count.type, amount: p.amount.type, tags: p.tags.type,
        tags_items: p.tags.items.type, options: p.options.type, options_flag: p.options.properties.flag.type,
    }));
    if (p.count.type !== 'INTEGER') return false;
    if (p.amount.type !== 'NUMBER') return false;
    if (p.tags.type !== 'ARRAY') return false;
    if (p.tags.items.type !== 'STRING') return false;
    if (p.options.type !== 'OBJECT') return false;
    if (p.options.properties.flag.type !== 'BOOLEAN') return false;
    return true;
});

test('enum 字段保留 + 元素 toString (Gemini 限制 repeated string)', () => {
    const oaTools = [{
        type: 'function',
        function: {
            name: 'enum-tool',
            description: '',
            parameters: {
                type: 'object',
                properties: {
                    color: { type: 'string', enum: ['red', 'green', 'blue'] },
                },
            }
        }
    }];
    const gemini = openAIToolsToGemini(oaTools);
    const p = gemini[0].functionDeclarations[0].parameters.properties;
    console.log('    enum (string):', JSON.stringify(p.color));
    if (p.color.type !== 'STRING') return false;
    if (JSON.stringify(p.color.enum) !== '["red","green","blue"]') return false;
    return true;
});

test('enum 元素 number → string (mcd integer enum 真实场景)', () => {
    // mcd query-nearby-stores beType: type=integer, enum=[1, 5]
    const oaTools = [{
        type: 'function',
        function: {
            name: 'mcd-test',
            description: '',
            parameters: {
                type: 'object',
                properties: {
                    beType: { type: 'integer', enum: [1, 5] },
                    orderType: { type: 'integer', enum: [1, 2] },
                },
            }
        }
    }];
    const gemini = openAIToolsToGemini(oaTools);
    const p = gemini[0].functionDeclarations[0].parameters.properties;
    console.log('    mcd enum:', JSON.stringify(p));
    // 验证 type 转大写
    if (p.beType.type !== 'INTEGER') return false;
    // 验证 enum 元素全部转 string
    if (JSON.stringify(p.beType.enum) !== '["1","5"]') return false;
    if (JSON.stringify(p.orderType.enum) !== '["1","2"]') return false;
    return true;
});

test('description / required 保留', () => {
    const oaTools = [{
        type: 'function',
        function: {
            name: 'desc-tool',
            description: 'desc-tool-desc',
            parameters: {
                type: 'object',
                properties: {
                    x: { type: 'string', description: 'X param' },
                },
                required: ['x'],
            }
        }
    }];
    const gemini = openAIToolsToGemini(oaTools);
    const decl = gemini[0].functionDeclarations[0];
    console.log('    desc/required:', JSON.stringify({ d: decl.description, p: decl.parameters.required, xd: decl.parameters.properties.x.description }));
    if (decl.description !== 'desc-tool-desc') return false;
    if (JSON.stringify(decl.parameters.required) !== '["x"]') return false;
    if (decl.parameters.properties.x.description !== 'X param') return false;
    return true;
});

test('空 tools 数组返 undefined', () => {
    return openAIToolsToGemini([]) === undefined;
});

test('空 parameters 兜底', () => {
    const oaTools = [{ type: 'function', function: { name: 'x' } }];
    const gemini = openAIToolsToGemini(oaTools);
    if (gemini[0].functionDeclarations[0].parameters.type !== 'OBJECT') return false;
    return true;
});

console.log('\n=== 总结 ===');
console.log('通过 ' + pass + ', 失败 ' + fail);
process.exit(fail > 0 ? 1 : 0);
