// 测试: 调 mcd.cn query-meals 看真实 JSON 结构
// storeCode = 3450397 (青龙街餐厅, 洛阳路 513m)

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
  // init
  await callMcp('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mavis-query-meals-tester', version: '1.0.0' }
  });
  await callMcp('notifications/initialized', {});

  // tools/list 看 query-meals inputSchema
  const tools = await callMcp('tools/list', {});
  const qm = tools.result?.tools?.find(t => t.name === 'query-meals');
  console.log('=== query-meals inputSchema ===');
  console.log(JSON.stringify(qm?.inputSchema, null, 2));
  console.log('=== query-meals description ===');
  console.log(qm?.description);

  // tools/call query-meals (带 reservationDate 预约今天 12:00 试试)
  console.log('\n=== tools/call query-meals (带 reservationDate) ===');
  const call = await callMcp('tools/call', {
    name: 'query-meals',
    arguments: {
      storeCode: '3450397',  // 洛阳路 513m 青龙街餐厅
      orderType: 1,          // 堂食
      beType: 1,             // 到店自提
      reservationDate: '2026-08-01 12:00'  // 预约中午 (格式 yyyy-MM-dd HH:mm)
    }
  });

  // 抽 structuredContent 看结构
  const sc = call.result?.structuredContent;
  console.log('\n=== 完整 call.result keys ===');
  console.log(Object.keys(call.result || {}));
  console.log('\n=== structuredContent ===');
  console.log(JSON.stringify(sc, null, 2));
  console.log('\n=== content[0].text 长度 ===', call.result?.content?.[0]?.text?.length);
  if (sc) {
    console.log('\n=== structuredContent.data keys ===');
    console.log(Object.keys(sc.data || {}));
    console.log('\n=== structuredContent.data ===');
    console.log(JSON.stringify(sc.data, null, 2)?.slice(0, 3000));
  } else {
    console.log('没 structuredContent, 完整返:');
    console.log(JSON.stringify(call, null, 2).slice(0, 2000));
  }
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
