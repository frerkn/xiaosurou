// 用 3 个候选 key 测 3 个 REST 端点
const KEYS = [
  { name: 'key-A', val: '75508b161b1ed1a2fd11d9c1c0ff3de7' },
  { name: 'key-B', val: '6d21531c4d4b53692015ab1ddfea25fd' },
  { name: 'key-C', val: 'a431fe55541f51f385d6833520d5bb1b' },
  { name: 'key-D', val: 'ad27bf2170ff2c5ad59f98ce0cb75952' }
];

async function getJson(url) {
  try {
    const r = await fetch(url, { method: 'GET' });
    const j = await r.json();
    return j;
  } catch (e) { return { _err: e.message }; }
}

async function testKey(keyName, keyVal) {
  console.log(`\n========== ${keyName} (${keyVal.slice(0, 8)}...) ==========`);
  // 测 4 个端点
  const tests = [
    { label: 'geocode/geo', url: `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent('成都青羊区洛阳路')}&key=${keyVal}` },
    { label: 'place/text', url: `https://restapi.amap.com/v3/place/text?keywords=${encodeURIComponent('麦当劳')}&city=${encodeURIComponent('成都')}&key=${keyVal}` },
    { label: 'place/around', url: `https://restapi.amap.com/v3/place/around?location=104.067630,30.673755&keywords=${encodeURIComponent('麦当劳')}&radius=2000&key=${keyVal}` },
    { label: 'weather/weatherInfo', url: `https://restapi.amap.com/v3/weather/weatherInfo?city=510100&key=${keyVal}` }
  ];
  for (const t of tests) {
    const j = await getJson(t.url);
    if (j._err) {
      console.log(`  ${t.label.padEnd(25)} → ❌ ${j._err}`);
    } else {
      const ok = j.status === '1';
      const tag = ok ? '✅' : '❌';
      let extra = '';
      if (j.pois) extra = ` pois=${j.pois.length}`;
      else if (j.geocodes) extra = ` geocodes=${j.geocodes.length}`;
      else if (j.lives) extra = ` lives=${j.lives.length}`;
      console.log(`  ${t.label.padEnd(25)} → ${tag} status=${j.status} info=${j.info}${extra}`);
    }
  }
}

async function main() {
  for (const k of KEYS) {
    await testKey(k.name, k.val);
  }
}

main().catch(e => { console.error('❌ 异常:', e); process.exit(1); });
