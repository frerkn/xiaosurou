// 测试: 拿 token 调 mcd.cn, 找"成都市青羊区洛阳路"附近门店
// 用 .env 或硬编码 token (本次一次性, 不存 memory)

const TOKEN = '2GoJbi6KxA6ujtTnXOwjd6q8aSF4o5mv'; // 用户传过的 token, 测完建议 revoke
const ENDPOINT = 'https://mcp.mcd.cn/';

async function callMcp(method, params) {
  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params
  };
  const resp = await fetch(ENDPOINT, {
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
  if (!text || text.length === 0) return null; // 202 empty
  // SSE 格式: data: {json}\n\n
  if (text.startsWith('data:')) {
    return JSON.parse(text.replace(/^data:\s*/, '').trim());
  }
  return JSON.parse(text);
}

async function main() {
  // 1. initialize
  console.log('\n=== 1. initialize ===');
  const init = await callMcp('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'luoyang-road-tester', version: '1.0.0' }
  });
  console.log('serverInfo:', init.result?.serverInfo);
  console.log('tools 数:', init.result?.capabilities?.tools ? '有' : '无');

  // 2. notifications/initialized (MCP 必须)
  await callMcp('notifications/initialized', {});

  // 3. tools/list
  console.log('\n=== 2. tools/list (确认 query-nearby-stores inputSchema) ===');
  const tools = await callMcp('tools/list', {});
  const qns = tools.result?.tools?.find(t => t.name === 'query-nearby-stores');
  console.log('query-nearby-stores inputSchema:', JSON.stringify(qns?.inputSchema, null, 2));

  // 4. tools/call query-nearby-stores with city=成都, keyword=青羊区洛阳路
  console.log('\n=== 3. query-nearby-stores (city=成都, keyword=青羊区洛阳路) ===');
  const call = await callMcp('tools/call', {
    name: 'query-nearby-stores',
    arguments: {
      beType: 1,        // 到店自提
      searchType: 2,    // 按位置
      city: '成都',
      keyword: '青羊区洛阳路'
    }
  });
  console.log('--- 原始返回 ---');
  console.log(JSON.stringify(call, null, 2));
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
