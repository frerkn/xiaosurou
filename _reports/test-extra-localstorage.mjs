// test-extra-localstorage.mjs — 验证 backup-import-export.js 的
// exportExtraLocalStorage / clearExtraLocalStorage / restoreExtraLocalStorage
// 能正确处理新加的悬浮球/生图/MCP key
//
// 跑法: node _reports/test-extra-localstorage.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = resolve(__dirname, '..', 'modules', 'backup-import-export.js');

// ============== mock localStorage ==============
class MockStorage {
  constructor() { this._data = new Map(); }
  get length() { return this._data.size; }
  key(i) { return Array.from(this._data.keys())[i] ?? null; }
  getItem(k) { return this._data.has(k) ? this._data.get(k) : null; }
  setItem(k, v) { this._data.set(String(k), String(v)); }
  removeItem(k) { this._data.delete(k); }
  clear() { this._data.clear(); }
  // debug helper
  has(k) { return this._data.has(k); }
  snapshot() { return Object.fromEntries(this._data); }
}

function makeContext() {
  const localStorage = new MockStorage();
  const ctx = {
    localStorage,
    console,
    state: {},
    db: { tables: [] },
    Number,
    Math,
    JSON,
    Object,
    Array,
    String,
    Boolean,
    Date,
    setTimeout,
    clearTimeout,
    Map,
    Promise,
    setInterval,
    clearInterval,
  };
  // 给浏览器环境一些 stub (因为 backup-import-export.js 内部有 window.xxx = ...)
  const window = { TTSService: null, fetch: () => Promise.resolve({}), streamSaver: null, JSZip: null };
  ctx.window = window;
  ctx.global = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return ctx;
}

// 抽出要测的三个函数 — 用沙箱 eval 然后取 global
function loadBackupHelpers(ctx) {
  const src = readFileSync(target, 'utf8');
  // 1) 把 IIFE 整段跑一遍, 让所有 const/let/function 都注入 ctx
  vm.runInContext(src, ctx, { filename: 'backup-import-export.js' });
  return {
    exportExtraLocalStorage: ctx.exportExtraLocalStorage,
    clearExtraLocalStorage: ctx.clearExtraLocalStorage,
    restoreExtraLocalStorage: ctx.restoreExtraLocalStorage,
    exportCoupleSpaceLocalStorage: ctx.exportCoupleSpaceLocalStorage,
    clearCoupleSpaceLocalStorage: ctx.clearCoupleSpaceLocalStorage,
    restoreCoupleSpaceLocalStorage: ctx.restoreCoupleSpaceLocalStorage,
  };
}

// ============== 准备测试数据 ==============
const TEST_FIXTURES = {
  // 情侣空间 (旧行为, 必须保持)
  'couple_space_data_v1': '{"love":100}',
  'coupleAnniversary': '2026-08-02',

  // 悬浮球 (新增)
  'floating-ball-state': JSON.stringify({
    position: { x: 50, y: 200 },
    visible: true,
    style: { type: 'image', imageUrl: 'https://example.com/ball.png' }
  }),

  // NovelAI (新增)
  'novelai-enabled': 'true',
  'novelai-model': 'nai-diffusion-4-5-full',
  'novelai-api-key': 'pst-test-xxxx',
  'novelai-settings': JSON.stringify({
    resolution: '1024x1024',
    steps: 28,
    sampler: 'k_euler_ancestral',
    cfg_scale: 7,
    cors_proxy: 'https://corsproxy.io/?'
  }),

  // Google Imagen (新增)
  'google-imagen-enabled': 'true',
  'google-imagen-model': 'imagen-4.0-ultra-generate-001',
  'google-imagen-api-key': 'AIza-test-xxxx',
  'google-imagen-settings': JSON.stringify({
    model: 'imagen-4.0-ultra-generate-001',
    endpoint: 'https://generativelanguage.googleapis.com',
    aspectRatio: '3:4'
  }),

  // Pollinations (新增)
  'pollinations-api-key': 'pk-test-xxxx',
  'pollinations-model': 'flux',

  // OpenAI 兼容生图 (新增)
  'openaiCompatImageEnabled': 'true',
  'openaiCompatImagePresetId': 'preset-123',
  'openaiCompatImageBaseUrl': 'https://api.example.com/v1',
  'openaiCompatImageApiKey': 'sk-test-xxxx',
  'openaiCompatImageModel': 'gpt-image-1',
  'openaiCompatImageAspectRatio': '16:9',

  // MCP (新增)
  'ephone.mcp.servers': JSON.stringify([
    { name: '麦当劳', url: 'https://mcp.mcd.cn/', bearerToken: 't1', proxyUrl: 'http://localhost:18099' },
    { name: '瑞幸', url: 'https://gwmcp.lkcoffee.com/order/user/mcp', bearerToken: 't2', proxyUrl: 'http://localhost:18099' }
  ]),
  'ephone.mcp.useNativeTools': '1',
  'aphone.mcp.lastCards': JSON.stringify([
    { tool: 'query-meals', args: {}, ts: Date.now() }
  ]),

  // 不应被备份的噪音 key
  'some_random_app_key': 'should-not-be-backed-up',
  'theme': 'dark',
  'imgbb-api-key': 'not-extra-pref',  // 这个有专门同步, 不在 extra 前缀
  'novelai-bad-not-prefix-key': 'should-be-skipped'  // novelai-bad 不在 novelai- 前缀下, 实际 novelai- 会匹配!
};

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}`);
  }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

// ============== Test 1: exportExtraLocalStorage 覆盖所有新 key ==============
section('Test 1: exportExtraLocalStorage 覆盖新加的所有 key');
{
  const ctx = makeContext();
  for (const [k, v] of Object.entries(TEST_FIXTURES)) ctx.localStorage.setItem(k, v);
  const { exportExtraLocalStorage } = loadBackupHelpers(ctx);
  const exported = exportExtraLocalStorage();

  // 期望被备份的 key
  const expected = [
    'couple_space_data_v1', 'coupleAnniversary',
    'floating-ball-state',
    'novelai-enabled', 'novelai-model', 'novelai-api-key', 'novelai-settings',
    'google-imagen-enabled', 'google-imagen-model', 'google-imagen-api-key', 'google-imagen-settings',
    'pollinations-api-key', 'pollinations-model',
    'openaiCompatImageEnabled', 'openaiCompatImagePresetId', 'openaiCompatImageBaseUrl',
    'openaiCompatImageApiKey', 'openaiCompatImageModel', 'openaiCompatImageAspectRatio',
    'ephone.mcp.servers', 'ephone.mcp.useNativeTools', 'aphone.mcp.lastCards',
  ];
  for (const k of expected) {
    assert(exported[k] === TEST_FIXTURES[k], `备份 ${k} 存在且值正确`);
  }

  // 期望被跳过的 key
  const skipped = ['some_random_app_key', 'theme', 'imgbb-api-key'];
  for (const k of skipped) {
    assert(!(k in exported), `跳过噪音 key: ${k}`);
  }
}

// ============== Test 2: clearExtraLocalStorage 只清新加的 key ==============
section('Test 2: clearExtraLocalStorage 只清新加的 key, 不动其他');
{
  const ctx = makeContext();
  for (const [k, v] of Object.entries(TEST_FIXTURES)) ctx.localStorage.setItem(k, v);
  const { clearExtraLocalStorage } = loadBackupHelpers(ctx);
  clearExtraLocalStorage();

  const shouldBeCleared = [
    'couple_space_data_v1', 'coupleAnniversary',
    'floating-ball-state',
    'novelai-enabled', 'novelai-model', 'novelai-api-key', 'novelai-settings',
    'google-imagen-enabled', 'google-imagen-model', 'google-imagen-api-key', 'google-imagen-settings',
    'pollinations-api-key', 'pollinations-model',
    'openaiCompatImageEnabled', 'openaiCompatImagePresetId', 'openaiCompatImageBaseUrl',
    'openaiCompatImageApiKey', 'openaiCompatImageModel', 'openaiCompatImageAspectRatio',
    'ephone.mcp.servers', 'ephone.mcp.useNativeTools', 'aphone.mcp.lastCards',
  ];
  for (const k of shouldBeCleared) {
    assert(!ctx.localStorage.has(k), `已清 ${k}`);
  }
  // 噪音应该保留
  assert(ctx.localStorage.has('some_random_app_key'), '保留 some_random_app_key');
  assert(ctx.localStorage.has('theme'), '保留 theme');
  assert(ctx.localStorage.has('imgbb-api-key'), '保留 imgbb-api-key');
}

// ============== Test 3: restoreExtraLocalStorage 写回所有 key ==============
section('Test 3: restoreExtraLocalStorage 写回所有 key');
{
  const ctx = makeContext();
  // 目标环境先有噪音
  ctx.localStorage.setItem('some_random_app_key', 'pre-existing');
  ctx.localStorage.setItem('theme', 'light');

  const { restoreExtraLocalStorage } = loadBackupHelpers(ctx);
  const backup = {
    'couple_space_data_v1': '{"love":99}',
    'floating-ball-state': JSON.stringify({ position: { x: 10, y: 10 } }),
    'novelai-api-key': 'pst-restored-xxxx',
    'google-imagen-api-key': 'AIza-restored',
    'pollinations-api-key': 'pk-restored',
    'openaiCompatImageApiKey': 'sk-restored',
    'ephone.mcp.servers': JSON.stringify([{ name: 'mcd' }]),
    'ephone.mcp.useNativeTools': '0',
  };
  restoreExtraLocalStorage(backup);

  for (const [k, v] of Object.entries(backup)) {
    assert(ctx.localStorage.getItem(k) === v, `恢复 ${k} 值正确`);
  }
  // 噪音不被覆盖
  assert(ctx.localStorage.getItem('some_random_app_key') === 'pre-existing', '不覆盖噪音 some_random_app_key');
  assert(ctx.localStorage.getItem('theme') === 'light', '不覆盖噪音 theme');
}

// ============== Test 4: 端到端 — export → clear → restore 闭环 ==============
section('Test 4: 端到端 — export → clear → restore 闭环');
{
  const ctx = makeContext();
  for (const [k, v] of Object.entries(TEST_FIXTURES)) ctx.localStorage.setItem(k, v);
  const { exportExtraLocalStorage, clearExtraLocalStorage, restoreExtraLocalStorage } = loadBackupHelpers(ctx);

  const backup = exportExtraLocalStorage();
  clearExtraLocalStorage();

  // 确认清干净
  assert(!ctx.localStorage.has('floating-ball-state'), '清后 floating-ball-state 不存在');
  assert(!ctx.localStorage.has('novelai-api-key'), '清后 novelai-api-key 不存在');
  assert(!ctx.localStorage.has('ephone.mcp.servers'), '清后 ephone.mcp.servers 不存在');

  // 恢复
  restoreExtraLocalStorage(backup);
  for (const [k, v] of Object.entries(TEST_FIXTURES)) {
    if (['some_random_app_key', 'theme', 'imgbb-api-key', 'novelai-bad-not-prefix-key'].includes(k)) continue;
    assert(ctx.localStorage.getItem(k) === v, `恢复后 ${k} 值完全一致`);
  }
}

// ============== Test 5: 旧名 exportCoupleSpaceLocalStorage 仍能 work (兼容转发) ==============
section('Test 5: 旧名 exportCoupleSpaceLocalStorage 仍能 work (兼容转发)');
{
  const ctx = makeContext();
  ctx.localStorage.setItem('couple_legacy_key', '{"a":1}');
  ctx.localStorage.setItem('floating-ball-state', '{"position":{"x":1,"y":2}}');
  ctx.localStorage.setItem('random_noise', 'x');

  const { exportCoupleSpaceLocalStorage } = loadBackupHelpers(ctx);
  const out = exportCoupleSpaceLocalStorage();

  assert('couple_legacy_key' in out, '旧名仍能导出 couple_legacy_key');
  assert('floating-ball-state' in out, '旧名也能导出 floating-ball-state (新行为)');
  assert(!('random_noise' in out), '旧名仍正确跳过噪音');
}

// ============== Test 6: API key 完整性 — value 完全没被截断/变形 ==============
section('Test 6: API key 等敏感值完整性 (e2e)');
{
  const ctx = makeContext();
  const sensitiveKeys = {
    'novelai-api-key': 'pst-1234567890abcdefghij',
    'google-imagen-api-key': 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567',
    'pollinations-api-key': 'pk_live_abcdefghijklmnop',
    'openaiCompatImageApiKey': 'sk-proj-1234567890abcdefghij',
    'ephone.mcp.servers': JSON.stringify([{ name: 'mcd', bearerToken: 'mc-donald-bearer-xxxxxx' }]),
  };
  for (const [k, v] of Object.entries(sensitiveKeys)) ctx.localStorage.setItem(k, v);

  const { exportExtraLocalStorage, clearExtraLocalStorage, restoreExtraLocalStorage } = loadBackupHelpers(ctx);
  const backup = exportExtraLocalStorage();
  clearExtraLocalStorage();
  restoreExtraLocalStorage(backup);

  for (const [k, expected] of Object.entries(sensitiveKeys)) {
    const actual = ctx.localStorage.getItem(k);
    assert(actual === expected, `${k} 长度/内容 100% 完整 (${actual?.length} === ${expected.length})`);
  }
}

// ============== Test 7: 空/无效输入不崩 ==============
section('Test 7: 边界 — 空/无效输入不崩');
{
  const ctx = makeContext();
  const { restoreExtraLocalStorage } = loadBackupHelpers(ctx);
  restoreExtraLocalStorage(null);
  restoreExtraLocalStorage(undefined);
  restoreExtraLocalStorage('not an object');
  restoreExtraLocalStorage(42);
  console.log('  ✅ restore(null/undefined/字符串/数字) 都不崩');
  pass++;
}

// ============== 汇总 ==============
console.log(`\n========== 测试结果 ==========`);
console.log(`✅ 通过: ${pass}`);
console.log(`❌ 失败: ${fail}`);
if (fail > 0) {
  process.exit(1);
} else {
  console.log(`🎉 全部通过 — 悬浮球/生图/MCP 全部能备份/清理/恢复`);
  process.exit(0);
}
