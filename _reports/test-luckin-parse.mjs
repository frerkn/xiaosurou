// 端到端测试: 模拟 mcp-generic-client.callTool 返回 → mcp-menu-card.js parseLuckinMenu 走通
const TOKEN = '1b11090d8c8e46aaa0de2cbd1b5922545mcpLUCKIN_MCP_AI';

async function callMcp(method, params) {
  const body = { jsonrpc: '2.0', id: Date.now(), method, params };
  const resp = await fetch('https://gwmcp.lkcoffee.com/order/user/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${TOKEN}`,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    },
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  if (resp.status >= 400 || !text) return null;
  if (text.startsWith('data:')) return JSON.parse(text.replace(/^data:\s*/, '').trim());
  return JSON.parse(text);
}

function extractJsonFromMcpText(text) {
  if (!text) return null;
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
          try { const obj = JSON.parse(slice); if (slice.length > bestLen) { best = obj; bestLen = slice.length; } } catch (e) {}
          break;
        }
      }
    }
  }
  return best;
}

function parseLuckinMenu(json) {
  const data = (json && (json.data || json.result || json));
  if (!data) return [];
  const products = Array.isArray(data) ? data
                 : Array.isArray(data.products) ? data.products
                 : Array.isArray(data.items) ? data.items
                 : [];
  if (!products.length) return [];
  const items = products.map(function (p) {
    const attrText = Array.isArray(p.productAttrs)
      ? p.productAttrs.map(function (a) {
          const sub = Array.isArray(a.productSubAttrs)
            ? a.productSubAttrs.map(function (s) { return s.attributeName; }).join('/')
            : '';
          return a.attributeName + ': ' + (sub || '默认');
        }).join(' · ')
      : '';
    return {
      code: String(p.productId || p.skuCode || ''),
      name: p.productName || p.name || '未命名',
      image: p.pictureUrl || p.image || '',
      currentPrice: p.estimatePrice != null ? String(p.estimatePrice) : (p.currentPrice || ''),
      originalPrice: p.initialPrice != null ? String(p.initialPrice) : (p.originalPrice || ''),
      tags: Array.isArray(p.tags) ? p.tags : [],
      attrs: attrText,
    };
  });
  return [{ name: '商品推荐', items: items }];
}

async function main() {
  await callMcp('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  await callMcp('notifications/initialized', {});

  // 1) queryShopList
  const shopsResp = await callMcp('tools/call', {
    name: 'queryShopList',
    arguments: { longitude: 104.061, latitude: 30.669 }
  });
  const shopText = shopsResp.result.content[0].text;
  const shopJson = extractJsonFromMcpText(shopText);
  const deptId = shopJson.data[0].deptId;
  console.log(`查门店: ${shopJson.data.length} 家, 第一家 deptId=${deptId}, name=${shopJson.data[0].deptName}`);

  // 2) searchProductForMcp "生椰拿铁"
  const searchResp = await callMcp('tools/call', {
    name: 'searchProductForMcp',
    arguments: { deptId, query: '生椰拿铁' }
  });
  const searchText = searchResp.result.content[0].text;
  const searchJson = extractJsonFromMcpText(searchText);
  console.log(`\nsearchProductForMcp "生椰拿铁": ${searchJson.data.length} 个商品`);

  // 3) 模拟 mcp-generic-client.callTool 返回 (success/data/rawText)
  const callResult = { success: true, data: searchJson, rawText: searchText };

  // 4) 模拟 onCard(card)
  const card = {
    serverId: 'luckin', serverName: '瑞幸',
    toolName: 'searchProductForMcp',
    args: { deptId, query: '生椰拿铁' },
    result: callResult, ts: Date.now()
  };

  // 5) 模拟 parseMcpResult (从 mcp-menu-card.js 复制)
  function parseMcpResult(c) {
    const r = c && c.result;
    if (!r) return null;
    if (r.isError) return null;
    if (Array.isArray(r.content) && r.content[0] && r.content[0].text) {
      return extractJsonFromMcpText(r.content[0].text);
    }
    if (r.data != null) return r.data;  // 剥包装层
    if (r.categories || r.meals || r.products) return r;
    return null;
  }

  // 6) parseMenu 路由
  const json = parseMcpResult(card);
  if (!json) { console.log('parseMcpResult 返 null'); return; }
  const toolName = card.toolName.toLowerCase();
  let categories;
  if (toolName === 'query-meals' || toolName === 'query_meals') {
    console.log('路由到 parseMcdMeals (但 toolName 是瑞幸)');
  } else if (toolName === 'searchproductformcp' || toolName === 'queryproductdetailinfo' || toolName === 'switchproduct') {
    console.log('路由到 parseLuckinMenu ✅');
    categories = parseLuckinMenu(json);
  }

  console.log(`\n=== parseLuckinMenu 结果 ===`);
  console.log(`分类数: ${categories.length}`);
  for (const cat of categories) {
    console.log(`\n分类: ${cat.name} · ${cat.items.length} 项`);
    for (const it of cat.items) {
      console.log(`  - ${it.name}`);
      console.log(`    ¥${it.currentPrice} (原 ¥${it.originalPrice}) ${it.image ? '[有图]' : '[无图]'}`);
      if (it.tags.length) console.log(`    tags: ${it.tags.join(', ')}`);
      if (it.attrs) console.log(`    attrs: ${it.attrs.slice(0, 80)}...`);
    }
  }

  // 7) 测 queryProductDetailInfo (拿单个商品详情)
  console.log(`\n=== queryProductDetailInfo (deptId=${deptId}, productId=${searchJson.data[0].productId}) ===`);
  const detailResp = await callMcp('tools/call', {
    name: 'queryProductDetailInfo',
    arguments: { deptId, productId: searchJson.data[0].productId }
  });
  const detailText = detailResp.result.content[0].text;
  const detailJson = extractJsonFromMcpText(detailText);
  console.log('详情 keys:', detailJson.data ? Object.keys(detailJson.data) : detailJson);
  console.log('商品名:', detailJson.data?.productName);
  console.log('价格: estimatePrice=' + detailJson.data?.estimatePrice + ' initialPrice=' + detailJson.data?.initialPrice);
  console.log('productAttrs 数:', detailJson.data?.productAttrs?.length || 0);
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
