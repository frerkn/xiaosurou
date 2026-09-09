// geocode 洛阳路拿经纬度 -> 调 queryShopList -> 拿 deptId -> 调 searchProductForMcp 看真实菜单返回
const TOKEN = '1b11090d8c8e46aaa0de2cbd1b5922545mcpLUCKIN_MCP_AI';
const AMAP_KEY = '75508b161b1ed1a2fd11d9c1c0ff3de7'; // 用户传过, 测完建议 revoke

async function amapGeocode(addr) {
  const u = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(addr)}&key=${AMAP_KEY}`;
  const r = await fetch(u);
  const j = await r.json();
  if (j.status === '1' && j.geocodes?.[0]) {
    const loc = j.geocodes[0].location; // "lng,lat"
    const [lng, lat] = loc.split(',').map(Number);
    return { lng, lat, formatted: j.geocodes[0].formatted_address };
  }
  throw new Error('geocode 失败: ' + JSON.stringify(j));
}

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
  // 1) 直接 hardcode 洛阳路经纬度 (成都青羊区核心)
  const geo = { lng: 104.061, lat: 30.669, formatted: '四川省成都市青羊区洛阳路' };
  console.log('=== 1) hardcode 洛阳路经纬度 ===');
  console.log(`  lng,lat: ${geo.lng}, ${geo.lat}`);

  // 2) init lkcoffee
  await callMcp('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  await callMcp('notifications/initialized', {});

  // 3) queryShopList 拿 deptId
  console.log('\n=== 3) queryShopList (lng,lat) ===');
  const shops = await callMcp('tools/call', {
    name: 'queryShopList',
    arguments: { longitude: geo.lng, latitude: geo.lat }
  });
  const shopText = shops.result?.content?.[0]?.text || '';
  console.log('rawText 长度:', shopText.length);
  console.log('rawText 前 2000:', shopText.slice(0, 2000));
  let shopJson = null;
  try { shopJson = JSON.parse(shopText); }
  catch (e) {
    const m = shopText.match(/\{[\s\S]*\}/);
    if (m) { try { shopJson = JSON.parse(m[0]); } catch {} }
  }
  if (shopJson) {
    console.log('\nshops 顶层 keys:', Object.keys(shopJson));
    if (shopJson.data) {
      const list = Array.isArray(shopJson.data) ? shopJson.data : [shopJson.data];
      console.log(`门店数: ${list.length}`);
      const first = list[0];
      console.log('first 店 keys:', first ? Object.keys(first) : 'null');
      console.log('first 店:', JSON.stringify(first, null, 2)?.slice(0, 800));
      // 看 deptId 字段
      const deptId = first?.deptId || first?.id || first?.shopId;
      console.log('--- 拿到的 deptId:', deptId);
      if (deptId) {
        // 4) searchProductForMcp
        console.log(`\n=== 4) searchProductForMcp (deptId=${deptId}, query="生椰拿铁") ===`);
        const sr = await callMcp('tools/call', {
          name: 'searchProductForMcp',
          arguments: { deptId, query: '生椰拿铁' }
        });
        const sText = sr.result?.content?.[0]?.text || '';
        console.log('rawText 长度:', sText.length);
        console.log('rawText 前 2500:', sText.slice(0, 2500));
        let sJson = null;
        try { sJson = JSON.parse(sText); }
        catch (e) { const m = sText.match(/\{[\s\S]*\}/); if (m) { try { sJson = JSON.parse(m[0]); } catch {} } }
        if (sJson) {
          console.log('\nsearchProductForMcp 顶层 keys:', Object.keys(sJson));
          console.log('data 类型:', Array.isArray(sJson.data) ? `array(${sJson.data.length})` : typeof sJson.data);
          if (sJson.data && typeof sJson.data === 'object') {
            console.log('data 顶层 keys:', Object.keys(sJson.data));
          }
          if (Array.isArray(sJson.data) && sJson.data[0]) {
            console.log('first 商品 keys:', Object.keys(sJson.data[0]));
            console.log('first 商品:', JSON.stringify(sJson.data[0], null, 2)?.slice(0, 1500));
          }
        }
      }
    }
  }
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
