// 实测: 高德 MCP maps_geo 查"成都市青羊区洛阳路27号"经纬度
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
  if (resp.status >= 400 || !text) return null;
  if (text.startsWith('data:')) return JSON.parse(text.replace(/^data:\s*/, '').trim());
  try { return JSON.parse(text); }
  catch (e) { return { _parseError: true, _raw: text.slice(0, 800) }; }
}

// 复制 mcp-generic-client 的 brace-match 抽 JSON
function extractJsonFromMcpText(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) {}
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

async function main() {
  // init
  await callMcp('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  await callMcp('notifications/initialized', {});

  // 1) maps_geo 查地址
  console.log('\n=== 1) maps_geo(address="成都市青羊区洛阳路27号") ===');
  const r1 = await callMcp('tools/call', {
    name: 'maps_geo',
    arguments: { address: '成都市青羊区洛阳路27号' }
  });
  const text1 = r1.result?.content?.[0]?.text || '';
  console.log('rawText 长度:', text1.length);
  console.log('rawText 前 500 字符:', text1.slice(0, 500));
  let j1 = extractJsonFromMcpText(text1);
  if (j1) {
    console.log('\n抽到的 JSON 顶层 keys:', Object.keys(j1));
    if (Array.isArray(j1)) {
      console.log('JSON 是数组, 长度:', j1.length);
      j1.forEach((item, i) => {
        console.log(`  [${i}]`, JSON.stringify(item, null, 2)?.slice(0, 600));
      });
    } else {
      console.log(JSON.stringify(j1, null, 2)?.slice(0, 1500));
    }
  } else {
    console.log('没抽出 JSON, rawText:', text1.slice(0, 500));
  }

  // 2) 测"周边搜"流程: 用 maps_geo 拿到的 location 喂给 maps_around_search
  console.log('\n=== 2) maps_around_search (location=上面拿到的经纬度) ===');
  // 抽 location 字符串 (高德 "lng,lat" 格式)
  let locStr = null;
  if (j1 && Array.isArray(j1) && j1[0]?.location) locStr = j1[0].location;
  else if (j1 && j1.location) locStr = j1.location;
  if (locStr) {
    console.log('  拿到的 location:', locStr);
    const r2 = await callMcp('tools/call', {
      name: 'maps_around_search',
      arguments: { keywords: '麦当劳', location: locStr, radius: 1000 }
    });
    const text2 = r2.result?.content?.[0]?.text || '';
    console.log('  rawText 长度:', text2.length);
    const j2 = extractJsonFromMcpText(text2);
    if (j2) {
      console.log('  抽到 JSON keys:', Object.keys(j2));
      if (Array.isArray(j2?.pois)) {
        console.log(`  拿到 ${j2.pois.length} 个 POI`);
        j2.pois.slice(0, 5).forEach((p, i) => {
          console.log(`    [${i}] ${p.name} | ${p.address || ''} | ${p.location || ''}`);
        });
      } else {
        console.log('  ', JSON.stringify(j2, null, 2)?.slice(0, 800));
      }
    } else {
      console.log('  rawText 前 500:', text2.slice(0, 500));
    }
  } else {
    console.log('  没拿到 location, 跳过 around_search');
  }

  // 3) 测 weather (要 city 不是坐标)
  console.log('\n=== 3) maps_weather(city="成都") ===');
  const r3 = await callMcp('tools/call', {
    name: 'maps_weather',
    arguments: { city: '成都' }
  });
  const text3 = r3.result?.content?.[0]?.text || '';
  const j3 = extractJsonFromMcpText(text3);
  if (j3) {
    console.log('  ', JSON.stringify(j3, null, 2)?.slice(0, 500));
  } else {
    console.log('  rawText 前 500:', text3.slice(0, 500));
  }
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
