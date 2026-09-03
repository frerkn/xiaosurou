// v0.4.3 per-chat 绑定逻辑验证脚本
// Node 隔离跑 (mock localStorage), 不写真实数据, 跑完删脚本
// 跑法: cd 330前端代码加瑞幸 && node _reports/test-live2d-binding.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// mock localStorage (Node 内存, 不污染真实数据)
const mockStore = new Map();
const mockLocalStorage = {
  getItem(k) { return mockStore.has(k) ? mockStore.get(k) : null; },
  setItem(k, v) { mockStore.set(k, String(v)); },
  removeItem(k) { mockStore.delete(k); },
  clear() { mockStore.clear(); },
};
globalThis.localStorage = mockLocalStorage;
// 不 mock crypto (Node 26 globalThis.crypto 是只读 getter), per-chat API 不依赖 crypto.randomUUID

// 加载 live2d-storage.js (IIFE 挂 globalThis.Live2DStorage)
function loadModule(relPath) {
  const code = fs.readFileSync(path.join(projectRoot, relPath), 'utf8');
  eval(code);
}
loadModule('modules/live2d-storage.js');
loadModule('modules/live2d-ui.js');
const { Live2DStorage } = globalThis;
const { Live2DUI } = globalThis;

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? ' (' + detail + ')' : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' (' + detail + ')' : '')); }
}

const TA = '__test_chat_A__';
const TB = '__test_chat_B__';
const TC = '__test_chat_no_per_chat__';
const modelA = '__test_model_A__';
const modelB = '__test_model_B__';
const bgA = '__test_bg_A__';
const bgB = '__test_bg_B__';

console.log('\n=== Test 1: per-chat modelId 隔离 ===');
await Live2DStorage.setActiveModelIdForChat(TA, modelA);
await Live2DStorage.setActiveModelIdForChat(TB, modelB);
const ra = await Live2DStorage.getActiveModelIdForChat(TA);
const rb = await Live2DStorage.getActiveModelIdForChat(TB);
assert('A 写入后读 A → ' + ra, ra === modelA);
assert('B 写入后读 B → ' + rb, rb === modelB);
assert('A 不会读到 B', ra !== modelB);
assert('B 不会读到 A', rb !== modelA);

console.log('\n=== Test 2: per-chat backgroundId 隔离 ===');
Live2DUI.setActiveBackgroundIdForChat(TA, bgA);
Live2DUI.setActiveBackgroundIdForChat(TB, bgB);
const ba = Live2DUI.getActiveBackgroundIdForChat(TA);
const bb = Live2DUI.getActiveBackgroundIdForChat(TB);
assert('A 写入后读 A → ' + ba, ba === bgA);
assert('B 写入后读 B → ' + bb, bb === bgB);
assert('A 不会读到 B', ba !== bgB);
assert('B 不会读到 A', bb !== bgA);

console.log('\n=== Test 3: 旧数据 fallback (无 per-chat 时) ===');
// 模拟旧数据: 已有全局 activeModelId / activeBackgroundId (没 per-chat)
mockLocalStorage.setItem('live2d.activeModelId', '__fallback_model__');
mockLocalStorage.setItem('live2d.activeBackgroundId', '__fallback_bg__');
const fbModel = await Live2DStorage.getActiveModelIdForChat(TC);
const fbBg = Live2DUI.getActiveBackgroundIdForChat(TC);
assert('modelId 无 per-chat → fallback 全局 → ' + fbModel, fbModel === '__fallback_model__');
assert('bgId 无 per-chat → fallback 全局 → ' + fbBg, fbBg === '__fallback_bg__');

console.log('\n=== Test 4: per-chat 优先于全局 ===');
// 同时存在 per-chat (A) + 全局, A 应该用 per-chat
mockLocalStorage.setItem('live2d.activeModelId', '__global_fallback__');
mockLocalStorage.setItem('live2d.activeBackgroundId', '__global_fallback__');
await Live2DStorage.setActiveModelIdForChat(TA, '__per_chat_A__');
Live2DUI.setActiveBackgroundIdForChat(TA, '__per_chat_A_bg__');
const ar = await Live2DStorage.getActiveModelIdForChat(TA);
const abr = Live2DUI.getActiveBackgroundIdForChat(TA);
assert('A 有 per-chat modelId → 优先用 per-chat → ' + ar, ar === '__per_chat_A__');
assert('A 有 per-chat bgId → 优先用 per-chat → ' + abr, abr === '__per_chat_A_bg__');
const c2 = await Live2DStorage.getActiveModelIdForChat(TC);
const c2b = Live2DUI.getActiveBackgroundIdForChat(TC);
assert('C 无 per-chat → 仍 fallback 全局 modelId → ' + c2, c2 === '__global_fallback__');
assert('C 无 per-chat → 仍 fallback 全局 bgId → ' + c2b, c2b === '__global_fallback__');

console.log('\n=== 清理 (mock 内存, 不污染真实 localStorage) ===');
[
  'live2d.activeModelId.__test_chat_A__',
  'live2d.activeModelId.__test_chat_B__',
  'live2d.activeBackgroundId.__test_chat_A__',
  'live2d.activeBackgroundId.__test_chat_B__',
  'live2d.activeModelId',
  'live2d.activeBackgroundId',
].forEach(k => mockLocalStorage.removeItem(k));
console.log('  ✓ 清理完成 (mock 内存)');

console.log('\n=== 总结: Pass ' + pass + ' / Fail ' + fail + ' ===');
process.exit(fail > 0 ? 1 : 0);
