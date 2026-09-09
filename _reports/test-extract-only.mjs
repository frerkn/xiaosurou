// 简化测试: 只验证 extractJsonFromMcpText (复制自 mcp-generic-client.js) 能从 mcd.cn rawText 抽出 categories
const TOKEN = '2GoJbi6KxA6ujtTnXOwjd6q8aSF4o5mv';

async function callMcp(method, params) {
  const body = { jsonrpc: '2.0', id: Date.now(), method, params };
  const resp = await fetch('https://mcp.mcd.cn/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${TOKEN}`,
      'User-Agent': 'Mozilla/5.0',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    },
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  if (!text) return null;
  if (text.startsWith('data:')) return JSON.parse(text.replace(/^data:\s*/, '').trim());
  return JSON.parse(text);
}

function extractJsonFromMcpText(text) {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch (e) {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch (e) {} }
  let best = null, bestLen = 0;
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
        code, name: detail.name || ref.name || code,
        image: detail.image || '',
        currentPrice: detail.currentPrice || '',
        originalPrice: detail.originalPrice || '',
        tags: Array.isArray(detail.tags) ? detail.tags : (Array.isArray(ref.tags) ? ref.tags : []),
      });
    }
    if (items.length) out.push({ name: cat.name || '其他', items });
  }
  return out;
}

async function main() {
  await callMcp('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  await callMcp('notifications/initialized', {});

  // 1) 凌晨 (没 reservationDate) — 应该返门店关闭
  console.log('=== 凌晨调 (无 reservationDate) ===');
  const r1 = await callMcp('tools/call', { name: 'query-meals', arguments: { storeCode: '3450397', orderType: 1, beType: 1 } });
  const text1 = r1.result.content[0].text;
  const j1 = extractJsonFromMcpText(text1);
  console.log('  success:', j1?.success, '| code:', j1?.code, '| message:', j1?.message);

  // 2) 营业时段 (带 reservationDate) — 应该返完整菜单
  console.log('\n=== 营业时段调 (带 reservationDate=2026-08-01 12:00) ===');
  const r2 = await callMcp('tools/call', { name: 'query-meals', arguments: { storeCode: '3450397', orderType: 1, beType: 1, reservationDate: '2026-08-01 12:00' } });
  const text2 = r2.result.content[0].text;
  const j2 = extractJsonFromMcpText(text2);
  console.log('  extractJsonFromMcpText 成功:', !!j2);
  console.log('  j2.data 形状:', Object.keys(j2?.data || {}));
  console.log('  categories 数:', j2?.data?.categories?.length);

  // 3) parseMcdMeals 拿到分类 + 餐品
  const cats = parseMcdMeals(j2);
  console.log('  parseMcdMeals 拿到分类数:', cats.length);
  const total = cats.reduce((s, c) => s + c.items.length, 0);
  console.log('  总餐品数:', total);
  console.log('\n  前 3 个分类:');
  cats.slice(0, 3).forEach(c => {
    console.log('    -', c.name, '·', c.items.length, '项, 第一个:', c.items[0]?.name, c.items[0]?.currentPrice, '元');
  });
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
