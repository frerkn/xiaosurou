// 端到端验证: 拿 mcd 真实数据, 跑 mcp-menu-card.js 里的解析函数
// 用法: node test-menu-parse.mjs

// 复制 mcp-menu-card.js 里的核心解析函数 (不依赖 DOM)
function extractJsonFromText(text) {
    if (!text || typeof text !== 'string') return null;
    try { return JSON.parse(text); } catch (e) {}
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
        try { return JSON.parse(fence[1].trim()); } catch (e) {}
    }
    let best = null;
    let bestLen = 0;
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

function parseMcdMeals(json) {
    const data = (json && json.data) || json || {};
    const categories = Array.isArray(data.categories) ? data.categories : [];
    const mealsMap = data.meals || {};
    const out = [];
    for (const cat of categories) {
        const items = [];
        const codes = Array.isArray(cat.meals) ? cat.meals : [];
        for (const ref of codes) {
            const code = ref && ref.code;
            if (!code) continue;
            const detail = mealsMap[code] || {};
            items.push({
                code: code,
                name: detail.name || ref.name || code,
                image: detail.image || '',
                currentPrice: detail.currentPrice || '',
                originalPrice: detail.originalPrice || '',
                tags: Array.isArray(detail.tags) ? detail.tags : (Array.isArray(ref.tags) ? ref.tags : []),
            });
        }
        if (items.length) out.push({ name: cat.name || '其他', items: items });
    }
    return out;
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 拿 mcd 真实数据
const token = process.env.MCD_TOKEN || '2GoJbi6KxA6ujtTnXOwjd6q8aSF4o5mv';
const workerUrl = 'https://mcp.lhualan338.workers.dev/?target=' + encodeURIComponent('https://mcp.mcd.cn/');

async function rpc(body) {
    const r = await fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body),
    });
    return await r.text();
}

(async () => {
    console.log('=== 1. initialize ===');
    await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

    console.log('=== 2. 拿一家门店 ===');
    const qnsText = await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'query-nearby-stores', arguments: { beType: 1, searchType: 2, city: '北京', keyword: '朝阳' } } });
    const qnsJson = JSON.parse(qnsText);
    const qnsContent = qnsJson.result.content[0].text;
    const qnsData = extractJsonFromText(qnsContent);
    const sc = qnsData.data[0].storeCode;
    console.log('  拿到 storeCode:', sc);

    console.log('=== 3. 拉菜单 (query-meals) ===');
    const qmText = await rpc({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'query-meals', arguments: { storeCode: sc, orderType: 1, beType: 1 } } });
    const qmJson = JSON.parse(qmText);

    // 模拟 mcp-tool-bridge emit card 时传进来的 result
    const mockCard = {
        toolName: 'query-meals',
        serverName: '麦当劳',
        result: qmJson.result,
    };

    console.log('=== 4. 解析 result.content[0].text 里的 JSON ===');
    const result = mockCard.result;
    const text = result.content[0].text;
    console.log('  text 长度:', text.length);
    const json = extractJsonFromText(text);
    console.log('  解出 JSON 顶层 keys:', Object.keys(json));

    console.log('=== 5. 跑 parseMcdMeals ===');
    const categories = parseMcdMeals(json);
    const total = categories.reduce((s, c) => s + c.items.length, 0);
    console.log('  解析出', categories.length, '个分类, 共', total, '个餐品');
    categories.forEach((c, i) => console.log('   ' + (i + 1) + '. ' + c.name + ': ' + c.items.length + ' 项'));

    console.log('\n=== 6. 渲染前 3 个餐品 HTML ===');
    const firstCat = categories[0];
    if (firstCat) {
        firstCat.items.slice(0, 3).forEach((it) => {
            const tagsHtml = (it.tags || []).slice(0, 3).map((t) => '<span class="mcp-menu-item-tag">' + escapeHtml(t) + '</span>').join('');
            const imgHtml = it.image
                ? '<img src="' + escapeHtml(it.image) + '" loading="lazy" onerror="this.parentNode.textContent=\'🍽️\'">'
                : '🍽️';
            const priceHtml = it.currentPrice
                ? '<span class="mcp-menu-item-price">¥' + escapeHtml(it.currentPrice) + '</span>'
                : '';
            const html = '<div class="mcp-menu-item">' +
                '<div class="mcp-menu-item-img">' + imgHtml + '</div>' +
                '<div class="mcp-menu-item-info">' +
                    '<div class="mcp-menu-item-name">' + escapeHtml(it.name) + '</div>' +
                    (tagsHtml ? '<div class="mcp-menu-item-tags">' + tagsHtml + '</div>' : '') +
                    '<div>' + priceHtml + '</div>' +
                '</div></div>';
            console.log('  --- ' + it.name + ' (¥' + it.currentPrice + ') ---');
            console.log('  ' + html);
        });
    }
})();
