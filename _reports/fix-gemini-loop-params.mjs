// 精准改 runChatWithToolLoopGemini 函数体: options → init (统一参数名, 跟 fetch hook 调用点 init 一致)
import { readFileSync, writeFileSync } from 'fs';
const path = 'js/mcp-tool-bridge.js';
const content = readFileSync(path, 'utf8');

// 找函数定义起始
const start = content.indexOf('async function runChatWithToolLoopGemini(url, options)');
if (start < 0) { console.error('function not found'); process.exit(1); }
// 找函数体结束 (下一个 async function runChatWithToolLoop 开始之前)
const end = content.indexOf('async function runChatWithToolLoop(url, options)', start);
if (end < 0) { console.error('function end not found'); process.exit(1); }

const fnBody = content.slice(start, end);
let fixed = fnBody
    .replace('async function runChatWithToolLoopGemini(url, options)', 'async function runChatWithToolLoopGemini(url, init)');

// 函数体内其他位置的 options 都改成 init (这次 replace_all 只在 fnBody 范围内)
fixed = fixed.replaceAll('options', 'init');

const patched = content.slice(0, start) + fixed + content.slice(end);
writeFileSync(path, Buffer.from(patched, 'utf8'));

console.log('Patched', path);
console.log('New size:', patched.length);
// 验证: 看看函数体内还有没有 options 残留
const remaining = (patched.match(/runChatWithToolLoopGemini[\s\S]*?async function runChatWithToolLoop/) || [''])[0].match(/options/g);
console.log('options occurrences in Gemini function body:', remaining ? remaining.length : 0);
