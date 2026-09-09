// 测试: 模拟 mcp-generic-client.callTool 返回 → 喂给 mcp-menu-card.js parseMcpResult → parseMcdMeals
// 验证 parse 链路是否 work

const TOKEN = '2GoJbi6KxA6ujtTnXOwjd6q8aSF4o5mv';

async function callMcp(method, params) {
  const body = { jsonrpc: '2.0', id: Date.now(), method, params };
  const resp = await fetch('https://mcp.mcd.cn/', {
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
  if (!text) return null;
  if (text.startsWith('data:')) return JSON.parse(text.replace(/^data:\s*/, '').trim());
  return JSON.parse(text);
}

async function main() {
  await callMcp('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  await callMcp('notifications/initialized', {});

  const resp = await callMcp('tools/call', {
    name: 'query-meals',
    arguments: { storeCode: '3450397', orderType: 1, beType: 1, reservationDate: '2026-08-01 12:00' }
  });
  const text = resp.result.content[0].text;
  console.log('mcd.cn rawText 长度:', text.length);
  console.log('  rawText 前 100:', text.slice(0, 100));

  // 模拟 mcp-generic-client.callTool 的处理 (新版: 失败时 brace match 抽)
  const parsed = (function () {
    try { return JSON.parse(text); } catch (e) { return null; }
  })() || (function () {
    // 复制 mcp-generic-client.js 的 extractJsonFromMcpText
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
  })();
  console.log('parsed 类型:', typeof parsed, '是对象:', parsed && typeof parsed === 'object');
  if (parsed) console.log('parsed.data keys:', Object.keys(parsed.data || {}));
  const callResult = { success: true, data: parsed, rawText: text };
  console.log('mcp-generic-client.callResult 形状:', Object.keys(callResult));
  console.log('  callResult.data 形状:', Object.keys(callResult.data));
  console.log('  callResult.data.data 形状:', Object.keys(callResult.data.data));
  console.log('  callResult.data.data.categories 长度:', callResult.data.data.categories.length);

  // 模拟 mcp-tool-bridge.js emitCardMessage 传给 onCard
  const card = {
    serverId: 'mcd', serverName: '麦当劳',
    toolName: 'query-meals', args: {},
    result: callResult, ts: Date.now()
  };

  // 加载 mcp-menu-card.js 跑 parseMcpResult + parseMcdMeals
  const fs = await import('fs');
  const src = fs.readFileSync('js/mcp-menu-card.js', 'utf-8');
  // 在 node 环境下运行, 把 window 替成 global, 注入 McpBridge stub
  const mock = {};
  global.window = mock;
  global.McpBridge = { onCard: () => {} };  // stub
  // 把 IIFE 里的 'use strict' 留着, 直接 eval 跑
  const fn = new Function('window', 'McpBridge', src + '\n;return window.McpMenuCard || null;');
  // 但 IIFE 内部没暴露 McpMenuCard, 所以从闭包拿不到
  // 改: 直接看 parseMcpResult 输出的 json, 再手动跑 parseMcdMeals
  // 用更简单方法: 把 IIFE 跑一下, 然后 patch parseMcpResult 暴露
  const wrapped = src
    .replace("})(typeof window !== 'undefined' ? window : this);", "})(window); /* exposed */ window.__parseMcpResult = parseMcpResult; window.__parseMcdMeals = parseMcdMeals;")
    .replace('global.McpBridge.onCard(onCard);', '');
  const fn2 = new Function('window', 'McpBridge', wrapped);
  fn2(mock, { onCard: () => {} });

  console.log('\n=== 模拟 mcp-menu-card.js 解析 ===');
  const json = mock.__parseMcpResult(card);
  console.log('parseMcpResult 返回类型:', typeof json);
  if (json) {
    console.log('  top-level keys:', Object.keys(json));
    console.log('  json.data keys:', Object.keys(json.data || {}));
    const cats = mock.__parseMcdMeals(json);
    console.log('parseMcdMeals 返 categories:', cats.length, '分类');
    if (cats.length) {
      console.log('  第一个分类:', cats[0].name, '·', cats[0].items.length, '项');
      console.log('  第一个餐品:', JSON.stringify(cats[0].items[0], null, 2));
    }
  }
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
