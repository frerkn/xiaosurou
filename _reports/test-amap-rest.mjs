// 测试 3 个高德 REST 端点: place/text + place/around + weather/weatherInfo
// 跟 MCP 端点 mcp.amap.com/mcp 的 4 个 bug 工具对照
const KEY = 'ad27bf2170ff2c5ad59f98ce0cb75952';

async function getJson(url) {
  const r = await fetch(url, { method: 'GET' });
  const j = await r.json();
  return { status: r.status, json: j };
}

async function main() {
  console.log('=== 1. place/text (关键字搜索 POI) ===');
  const t1 = await getJson(
    'https://restapi.amap.com/v3/place/text?keywords=' + encodeURIComponent('麦当劳') +
    '&city=' + encodeURIComponent('成都') +
    '&key=' + KEY
  );
  console.log('HTTP', t1.status, 'status=' + t1.json.status, 'info=' + t1.json.info, 'count=' + t1.json.count);
  if (t1.json.pois && t1.json.pois.length) {
    console.log('  → 拿到', t1.json.pois.length, '个 POI');
    console.log('  第一个:', JSON.stringify({
      name: t1.json.pois[0].name,
      address: t1.json.pois[0].address,
      location: t1.json.pois[0].location,
      type: t1.json.pois[0].type
    }, null, 2));
  } else {
    console.log('  → ❌ 空数组! 完整响应:', JSON.stringify(t1.json).slice(0, 500));
  }

  console.log('\n=== 2. place/around (周边搜索 POI) ===');
  // 用 maps_distance 实测过的坐标: 104.067630,30.673755 (成都青羊区)
  const t2 = await getJson(
    'https://restapi.amap.com/v3/place/around?location=104.067630,30.673755' +
    '&keywords=' + encodeURIComponent('麦当劳') +
    '&radius=2000' +
    '&key=' + KEY
  );
  console.log('HTTP', t2.status, 'status=' + t2.json.status, 'info=' + t2.json.info, 'count=' + t2.json.count);
  if (t2.json.pois && t2.json.pois.length) {
    console.log('  → 拿到', t2.json.pois.length, '个 POI');
    console.log('  第一个:', JSON.stringify({
      name: t2.json.pois[0].name,
      address: t2.json.pois[0].address,
      location: t2.json.pois[0].location,
      distance: t2.json.pois[0].distance
    }, null, 2));
  } else {
    console.log('  → ❌ 空数组! 完整响应:', JSON.stringify(t2.json).slice(0, 500));
  }

  console.log('\n=== 3. weather/weatherInfo (天气) ===');
  // 成都 adcode = 510100 (高德用 adcode 不是 city 名)
  const t3 = await getJson(
    'https://restapi.amap.com/v3/weather/weatherInfo?city=510100' +
    '&key=' + KEY
  );
  console.log('HTTP', t3.status, 'status=' + t3.json.status, 'info=' + t3.json.info);
  if (t3.json.lives && t3.json.lives.length) {
    console.log('  → 实况:', JSON.stringify(t3.json.lives[0], null, 2));
  } else if (t3.json.forecasts && t3.json.forecasts.length) {
    console.log('  → 预报:', JSON.stringify(t3.json.forecasts[0], null, 2));
  } else {
    console.log('  → ❌ 无数据! 完整响应:', JSON.stringify(t3.json).slice(0, 500));
  }

  // 顺便试 city=城市名 是否能识别
  console.log('\n=== 3b. weather/weatherInfo (city=城市名) ===');
  const t3b = await getJson(
    'https://restapi.amap.com/v3/weather/weatherInfo?city=' + encodeURIComponent('成都') +
    '&key=' + KEY
  );
  console.log('HTTP', t3b.status, 'status=' + t3b.json.status, 'info=' + t3b.json.info);
  if (t3b.json.lives && t3b.json.lives.length) {
    console.log('  → 实况:', JSON.stringify(t3b.json.lives[0], null, 2));
  } else {
    console.log('  → 完整响应:', JSON.stringify(t3b.json).slice(0, 500));
  }
}

main().catch(e => { console.error('❌ 异常:', e); process.exit(1); });
