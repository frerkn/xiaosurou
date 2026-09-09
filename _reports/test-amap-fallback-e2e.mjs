// 端到端验证: 高德 4 个 bug 端点 MCP 返空/返 isError → REST 兜底触发 → 拿到真实数据
// mock fetch: mcp.amap.com/mcp 模拟返坏数据, restapi.amap.com 真实调

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// ========== polyfill localStorage ==========
const _lsStore = new Map();
global.localStorage = {
  getItem: (k) => _lsStore.has(k) ? _lsStore.get(k) : null,
  setItem: (k, v) => _lsStore.set(k, String(v)),
  removeItem: (k) => _lsStore.delete(k),
  clear: () => _lsStore.clear(),
};

// ========== 加载 mcp-generic-client.js (IIFE) ==========
const clientCode = readFileSync(resolve(PROJECT_ROOT, 'js/mcp-generic-client.js'), 'utf8');
// IIFE 自带 typeof window !== 'undefined' ? window : globalThis — globalThis 在 Node 是 global
// 把代码包成函数手动执行, 挂到 globalThis.McpGenericClient
new Function('globalThis', clientCode)(globalThis);
const McpGenericClient = globalThis.McpGenericClient;
if (!McpGenericClient) {
  console.error('❌ 加载 mcp-generic-client.js 失败, McpGenericClient 未挂到 globalThis');
  process.exit(1);
}
console.log('✅ 加载 mcp-generic-client.js 成功');

// ========== 配 1 个高德 server (用 Web 服务 key) ==========
// Web 服务 key-B 实测 work, 用真实 key 让 REST 兜底能拿到数据
const AMAP_KEY = '6d21531c4d4b53692015ab1ddfea25fd';
const amapServer = {
  id: 'amap-test',
  name: '高德地图',
  url: 'https://mcp.amap.com/mcp',
  bearerToken: AMAP_KEY,
  enabled: true,
};

// ========== mock fetch ==========
// 真实 MCP 端点返 4 个 bug 模式 (maps_geo 返 isError, 其他 3 个返 {pois:[]} 空)
// 真实 REST 端点放行调
const realFetch = global.fetch;
global.fetch = async function mockFetch(url, options) {
  const u = String(url);
  if (u.indexOf('mcp.amap.com') >= 0) {
    // 模拟 MCP 端点 (initialize + tools/list + tools/call)
    const body = options && options.body ? JSON.parse(options.body) : {};
    const method = body.method;

    if (method === 'initialize') {
      return mockResp({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'amap-mock', version: '1.0.0' },
        },
      });
    }
    if (method === 'tools/list') {
      return mockResp({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          tools: [
            { name: 'maps_geo', inputSchema: { type: 'object', properties: { address: { type: 'string' }, city: { type: 'string' } } } },
            { name: 'maps_text_search', inputSchema: { type: 'object', properties: { keywords: { type: 'string' }, city: { type: 'string' } } } },
            { name: 'maps_around_search', inputSchema: { type: 'object', properties: { location: { type: 'string' }, keywords: { type: 'string' }, radius: { type: 'number' } } } },
            { name: 'maps_weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } },
          ],
        },
      });
    }
    if (method === 'tools/call') {
      const toolName = body.params && body.params.name;
      // 4 个 bug 端点模拟坏数据
      if (toolName === 'maps_geo') {
        // 模拟 ENGINE_RESPONSE_DATA_ERROR (isError=true)
        return mockResp({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{ type: 'text', text: 'ENGINE_RESPONSE_DATA_ERROR: 城市级地址识别失败' }],
            isError: true,
          },
        });
      }
      if (toolName === 'maps_text_search') {
        // 模拟 {pois: []} 空 (success=true 但无数据)
        return mockResp({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ status: '1', info: 'OK', count: '0', pois: [] }) }],
            isError: false,
          },
        });
      }
      if (toolName === 'maps_around_search') {
        return mockResp({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ status: '1', info: 'OK', count: '0', pois: [] }) }],
            isError: false,
          },
        });
      }
      if (toolName === 'maps_weather') {
        return mockResp({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ status: '0', info: 'INVALID_PARAMS', city: null, forecasts: null }) }],
            isError: false,
          },
        });
      }
    }
    // 其他 MCP 端点请求
    return mockResp({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } });
  }
  if (u.indexOf('restapi.amap.com') >= 0) {
    // REST 端点放行, 真实调
    console.log('  → 🌐 REST API 请求: ' + u.replace(/key=[^&]+/, 'key=***').slice(0, 100) + '...');
    return realFetch(url, options);
  }
  // 其他 URL 真实调
  return realFetch(url, options);
};

function mockResp(obj) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: () => Promise.resolve(obj),
    text: () => Promise.resolve(JSON.stringify(obj)),
  });
}

// ========== 端到端测试 ==========
async function testCase(label, toolName, args, validate) {
  console.log(`\n========== ${label} ==========`);
  console.log(`工具: ${toolName}, 参数: ${JSON.stringify(args).slice(0, 150)}`);
  try {
    const result = await McpGenericClient.callTool(amapServer, toolName, args);
    if (!result.success) {
      console.log(`  ❌ 失败: ${result.error}`);
      return false;
    }
    return validate(result.data);
  } catch (e) {
    console.log(`  ❌ 异常: ${e.message}`);
    return false;
  }
}

async function main() {
  let pass = 0, fail = 0;

  // 1. maps_geo — isError → REST 兜底 → 拿到 {results: [...]}
  if (await testCase(
    '1. maps_geo (MCP 返 ENGINE_RESPONSE_DATA_ERROR → REST 兜底)',
    'maps_geo',
    { address: '成都青羊区洛阳路', city: '成都' },
    (data) => {
      const n = (data.results || []).length;
      console.log(`  → results=${n}`);
      if (n > 0) {
        console.log(`  ✅ pass: 拿到 ${n} 个候选, 第一个: ${data.results[0].formatted_address || data.results[0].address || '(无地址)'} @ ${data.results[0].location || '?'}`);
        return true;
      }
      console.log(`  ❌ fail: results 为空! data=${JSON.stringify(data).slice(0, 300)}`);
      return false;
    }
  )) pass++; else fail++;

  // 2. maps_text_search — 返空 {pois:[]} → REST 兜底 → 拿到真实 POI
  if (await testCase(
    '2. maps_text_search (MCP 返 {pois:[]} → REST 兜底)',
    'maps_text_search',
    { keywords: '麦当劳', city: '成都' },
    (data) => {
      const n = (data.pois || []).length;
      console.log(`  → pois=${n}, status=${data.status}`);
      if (n > 0) {
        console.log(`  ✅ pass: 拿到 ${n} 个 POI, 第一个: ${data.pois[0].name} @ ${data.pois[0].address}`);
        return true;
      }
      console.log(`  ❌ fail: pois 为空! data=${JSON.stringify(data).slice(0, 300)}`);
      return false;
    }
  )) pass++; else fail++;

  // 3. maps_around_search — 返空 {pois:[]} → REST 兜底 → 拿到周边 POI
  if (await testCase(
    '3. maps_around_search (MCP 返 {pois:[]} → REST 兜底)',
    'maps_around_search',
    { location: '104.067630,30.673755', keywords: '麦当劳', radius: 2000 },
    (data) => {
      const n = (data.pois || []).length;
      console.log(`  → pois=${n}, status=${data.status}`);
      if (n > 0) {
        console.log(`  ✅ pass: 拿到 ${n} 个周边 POI, 第一个: ${data.pois[0].name} (${data.pois[0].distance || '?'}m)`);
        return true;
      }
      console.log(`  ❌ fail: pois 为空! data=${JSON.stringify(data).slice(0, 300)}`);
      return false;
    }
  )) pass++; else fail++;

  // 4. maps_weather — 返空 {city:null,forecasts:null} → REST 兜底 → 拿到天气
  if (await testCase(
    '4. maps_weather (MCP 返 {city:null,forecasts:null} → REST 兜底)',
    'maps_weather',
    { city: '510100' },
    (data) => {
      const hasLives = (data.lives || []).length;
      const hasForecasts = (data.forecasts || []).length;
      console.log(`  → status=${data.status}, lives=${hasLives}, forecasts=${hasForecasts}`);
      if (hasLives > 0 || hasForecasts > 0) {
        if (hasLives > 0) {
          console.log(`  ✅ pass: 拿到实况, ${data.lives[0].city} 天气: ${data.lives[0].weather} 温度: ${data.lives[0].temperature}°C`);
        } else {
          console.log(`  ✅ pass: 拿到预报, ${data.forecasts[0].city} 预报: ${data.forecasts[0].casts.length} 天`);
        }
        return true;
      }
      console.log(`  ❌ fail: 无数据! data=${JSON.stringify(data).slice(0, 300)}`);
      return false;
    }
  )) pass++; else fail++;

  console.log(`\n========== 总结 ==========`);
  console.log(`通过 ${pass}/4, 失败 ${fail}/4`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('❌ 主流程异常:', e); process.exit(1); });
