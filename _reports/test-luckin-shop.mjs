// 测 queryShopList 找门店拿 deptId, 然后调 searchProductForMcp 看真实返回
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
  if (resp.status >= 400 || !text) return { _err: resp.status, _raw: text };
  if (text.startsWith('data:')) return JSON.parse(text.replace(/^data:\s*/, '').trim());
  try { return JSON.parse(text); }
  catch (e) { return { _parseError: true, _raw: text.slice(0, 500) }; }
}

async function main() {
  await callMcp('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  await callMcp('notifications/initialized', {});

  // queryShopList inputSchema 看
  const tools = await callMcp('tools/list', {});
  const shopTool = tools.result?.tools?.find(t => t.name === 'queryShopList');
  console.log('\n=== queryShopList inputSchema ===');
  console.log(JSON.stringify(shopTool?.inputSchema, null, 2));

  // 试调 queryShopList (成都 + 任意 keyword, 跟用户住址一致)
  console.log('\n=== tools/call queryShopList (city=成都, keyword=青羊区洛阳路) ===');
  const shops = await callMcp('tools/call', {
    name: 'queryShopList',
    arguments: { city: '成都', keyword: '青羊区洛阳路' }
  });
  console.log(JSON.stringify(shops, null, 2)?.slice(0, 3000));
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
