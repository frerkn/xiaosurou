// 测试高德 MCP token: initialize + tools/list
const URL = 'https://mcp.amap.com/mcp?key=ad27bf2170ff2c5ad59f98ce0cb75952';

async function callMcp(method, params) {
  const body = { jsonrpc: '2.0', id: Date.now(), method, params };
  const resp = await fetch(URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
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
  try { return JSON.parse(text); } catch (e) { return { _parseError: true, _raw: text.slice(0, 500) }; }
}

async function main() {
  // initialize
  const init = await callMcp('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'amap-mcp-tester', version: '1.0.0' }
  });
  console.log('serverInfo:', init.result?.serverInfo);

  // notifications
  await callMcp('notifications/initialized', {});

  // tools/list
  const tools = await callMcp('tools/list', {});
  const toolList = tools.result?.tools || [];
  console.log(`\n=== 共 ${toolList.length} 个工具 ===`);
  for (const t of toolList) {
    console.log(`  ${t.name} — ${(t.description || '').slice(0, 80)}`);
  }

  // 保存完整工具列表到文件 (供我后续分析)
  const fs = await import('fs');
  fs.writeFileSync('_reports/amap-tools-list.json', JSON.stringify(tools, null, 2));
  console.log('\n完整工具列表 (含 inputSchema) 已保存到 _reports/amap-tools-list.json');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
