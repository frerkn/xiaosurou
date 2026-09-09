// sw.js 加 3 个新 URL — 处理 CRLF/LF 兼容
import { readFileSync, writeFileSync } from 'fs';
const path = 'sw.js';
const content = readFileSync(path, 'utf8');
// 用正则匹配 (兼容 CRLF/LF)
const pattern = /(\s+)('\.\/js\/mcp-menu-card\.js',)\r?\n(\s+)('\.\/css\/mcp-miniapp-pink\.css',)/;
const match = content.match(pattern);
if (!match) {
    console.error('OLD block not found');
    process.exit(1);
}
if (content.includes('mcp-tool-progress.js')) {
    console.log('Already patched, skip');
    process.exit(0);
}
const newBlock = match[1] + match[2] + '\n' +
    match[3] + "'./js/mcp-pay-card.js',\n" +
    match[3] + "'./js/mcp-tool-call-log.js',\n" +
    match[3] + '// v0.2.31.9: 工具调用实时进度 (紧跟 AI 气泡, 完成后移除)\n' +
    match[3] + "'./js/mcp-tool-progress.js',\n" +
    match[3] + match[4];
const patched = content.replace(pattern, newBlock);
writeFileSync(path, Buffer.from(patched, 'utf8'));
console.log('Patched OK, new size:', patched.length);
