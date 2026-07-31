// Mock 验证: 不连 mcd, 用我之前测过的真实数据格式验证解析
// 跑: node test-menu-mock.mjs

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
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ========== Mock 数据 (基于之前真实拉到的 query-meals 响应) ==========

const mockText = `# API Response Information

Below is the response from an API call. To help you understand the data, I've provided:
1. A detailed description of all fields in the response structure
2. The complete API response

## Response Structure

- **data**: ...
  - **data.categories**: 菜单分类列表
    - **name**: 菜单分类名称
    - **meals**: 该分类下的餐品列表
      - **code**: 餐品唯一编码
  - **data.meals**: 餐品详情映射表
    - **name**: 餐品名称
    - **image**: 商品图片
    - **currentPrice**: 餐品现价
    - **originalPrice**: 商品原价
    - **tags**: 餐品标签列表

## Original Response

{
  "success": true,
  "code": 200,
  "message": "请求成功",
  "datetime": "2026-07-31 18:00:48",
  "traceId": "1cdf44d6a0ac814ee835e4455318d938",
  "data": {
    "categories": [
      { "name": "人气热卖", "meals": [{"code": "9900015236"}, {"code": "9900015265"}] },
      { "name": "蘸酱炸鸡", "meals": [{"code": "9900015254"}] },
      { "name": "巨无霸牛鱼肉堡", "meals": [{"code": "9900015267"}] }
    ],
    "meals": {
      "9900015236": {
        "name": "巨无霸",
        "image": "https://example.com/bigmac.jpg",
        "currentPrice": "25.00",
        "originalPrice": "27.00",
        "tags": ["招牌", "牛肉"]
      },
      "9900015265": {
        "name": "麦辣鸡腿堡",
        "image": "https://example.com/mcll.jpg",
        "currentPrice": "22.00",
        "originalPrice": "22.00",
        "tags": ["人气"]
      },
      "9900015254": {
        "name": "麦辣鸡翅 2 块",
        "image": "",
        "currentPrice": "12.50",
        "originalPrice": "12.50",
        "tags": ["小食"]
      },
      "9900015267": {
        "name": "双层吉士堡",
        "image": "https://example.com/cheese.jpg",
        "currentPrice": "20.00",
        "originalPrice": "",
        "tags": []
      }
    }
  }
}

## End of response.`;

console.log('=== 1. extractJsonFromText 抽取 ===');
const json = extractJsonFromText(mockText);
console.log('  顶层 keys:', Object.keys(json));
console.log('  data.categories.length:', json.data.categories.length);
console.log('  data.meals keys:', Object.keys(json.data.meals));

console.log('\n=== 2. parseMcdMeals 解析 ===');
const categories = parseMcdMeals(json);
const total = categories.reduce((s, c) => s + c.items.length, 0);
console.log('  分类数:', categories.length, '总餐品:', total);
categories.forEach((c) => console.log('   - ' + c.name + ': ' + c.items.length + ' 项'));
categories.forEach((c) => {
    c.items.forEach((it) => {
        console.log('     · ' + it.name + ' ¥' + it.currentPrice + ' [' + (it.tags || []).join('/') + '] img=' + (it.image ? 'yes' : 'no'));
    });
});

console.log('\n=== 3. 渲染 HTML (前 2 个) ===');
categories[0].items.slice(0, 2).forEach((it) => {
    const tagsHtml = (it.tags || []).slice(0, 3).map((t) => '<span class="mcp-menu-item-tag">' + escapeHtml(t) + '</span>').join('');
    const imgHtml = it.image
        ? '<img src="' + escapeHtml(it.image) + '" loading="lazy" onerror="this.parentNode.textContent=\'🍽️\'">'
        : '🍽️';
    const priceHtml = it.currentPrice ? '<span class="mcp-menu-item-price">¥' + escapeHtml(it.currentPrice) + '</span>' : '';
    const origHtml = it.originalPrice && it.originalPrice !== it.currentPrice
        ? '<span class="mcp-menu-item-price-original">¥' + escapeHtml(it.originalPrice) + '</span>' : '';
    const html = '<div class="mcp-menu-item">' +
        '<div class="mcp-menu-item-img">' + imgHtml + '</div>' +
        '<div class="mcp-menu-item-info">' +
            '<div class="mcp-menu-item-name">' + escapeHtml(it.name) + '</div>' +
            (tagsHtml ? '<div class="mcp-menu-item-tags">' + tagsHtml + '</div>' : '') +
            '<div>' + priceHtml + origHtml + '</div>' +
        '</div></div>';
    console.log('  ' + it.name + ':');
    console.log('  ' + html);
});

console.log('\n✓ 全部 OK');
