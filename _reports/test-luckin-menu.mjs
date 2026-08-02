// 一次性测试: 用 token 探查瑞幸 MCP 端点, 看 menu 工具的真实返回结构
// token 测完会建议 revoke (明文传过)

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
  console.log(`[${method}] HTTP ${resp.status}, ${text.length} bytes`);
  if (resp.status === 401) {
    console.log('--- 401 响应 headers ---');
    for (const [k, v] of resp.headers) console.log(`  ${k}: ${v}`);
  }
  if (resp.status >= 400 || !text) return { _httpStatus: resp.status, _raw: text };
  if (text.startsWith('data:')) return JSON.parse(text.replace(/^data:\s*/, '').trim());
  try { return JSON.parse(text); }
  catch (e) { return { _parseError: true, _raw: text.slice(0, 200) }; }
}

async function main() {
  // initialize
  const init = await callMcp('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'luckin-menu-explorer', version: '1.0.0' }
  });
  console.log('init result keys:', Object.keys(init.result || {}));
  console.log('serverInfo:', init.result?.serverInfo);

  // notifications/initialized
  await callMcp('notifications/initialized', {});

  // tools/list - 看有哪些 menu 类工具
  console.log('\n=== tools/list ===');
  const tools = await callMcp('tools/list', {});
  const toolList = tools.result?.tools || [];
  console.log(`共 ${toolList.length} 个工具`);
  for (const t of toolList) {
    console.log(`  ${t.name} — ${(t.description || '').slice(0, 60)}`);
  }

  // 重点看 menu 相关工具的 inputSchema
  const menuTools = toolList.filter(t => /product|menu|商品|菜单/i.test(t.name));
  console.log('\n=== menu 类工具 inputSchema ===');
  for (const t of menuTools) {
    console.log(`\n--- ${t.name} ---`);
    console.log(`  description: ${(t.description || '').slice(0, 200)}`);
    console.log(`  inputSchema:`);
    console.log(JSON.stringify(t.inputSchema, null, 2).split('\n').map(l => '    ' + l).join('\n'));
  }

  // 调用 listProducts (如果有) 或 searchProduct 看真实返回
  const listTool = menuTools.find(t => /listProducts?/i.test(t.name));
  const searchTool = menuTools.find(t => /searchProduct/i.test(t.name));
  const detailTool = menuTools.find(t => /queryProductDetail|productDetail/i.test(t.name));

  if (listTool) {
    console.log(`\n=== tools/call ${listTool.name} (列全量菜单) ===`);
    const r = await callMcp('tools/call', { name: listTool.name, arguments: {} });
    const text = r.result?.content?.[0]?.text || '';
    console.log(`rawText 长度: ${text.length}`);
    console.log(`rawText 前 500 字符:\n${text.slice(0, 500)}`);
    // 试 parse
    try { const j = JSON.parse(text); console.log('\nJSON.parse 直接成功, top keys:', Object.keys(j)); } catch (e) {
      // brace match 抽
      const m = text.match(/[\{\[][\s\S]*[\}\]]/);
      if (m) console.log('\nbrace match 抽到 JSON, 前 300:', m[0].slice(0, 300));
    }
  } else if (searchTool) {
    console.log(`\n=== tools/call ${searchTool.name} keyword="生椰拿铁" ===`);
    const r = await callMcp('tools/call', { name: searchTool.name, arguments: { keyword: '生椰拿铁' } });
    const text = r.result?.content?.[0]?.text || '';
    console.log(`rawText 长度: ${text.length}`);
    console.log(`rawText 前 800 字符:\n${text.slice(0, 800)}`);
  }
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
