// 一次性脚本: 清理 sw.js 顶部注水 + bump CACHE_VERSION
// 输入: 1-880 行 (顶部 865 行注水 + 866-880 行 v0.2.26 改动历史 + mojibake)
// 输出: 新文件头 (5 行) + const CACHE_VERSION = 'v0.2.31.6'; + 881 行起原内容
import { readFileSync, writeFileSync } from 'node:fs';

const p = 'C:\\Users\\阿乐\\Desktop\\111-main 3\\330项目\\330前端代码加瑞幸\\sw.js';
const raw = readFileSync(p, 'utf8');

// 按行分割, 保留 \n 行尾
const lines = raw.split('\n');

// 取 881 行起 (index 880 开始)
const kept = lines.slice(880);

const header = [
  '// Service Worker (sw.js)',
  '// 白名单缓存: 只缓存已知静态资源, API 请求 pass-through',
  '// CACHE_VERSION bump 强制清缓存',
  '// 关键约束: URLS_TO_CACHE 增删需同步 sw.js 注释 + ?v= 版本号',
  '',
  "const CACHE_VERSION = 'v0.2.31.6';",
  ''
];

const out = header.concat(kept).join('\n');

writeFileSync(p, out, { encoding: 'utf8' });

// 统计
const newLines = out.split('\n');
const comment = newLines.filter(l => /^\s*\/\//.test(l)).length;
const blank = newLines.filter(l => /^\s*$/.test(l)).length;
const code = newLines.length - comment - blank;
const fffd = (out.match(/\uFFFD/g) || []).length;

console.log('总行数:', newLines.length, '| 注释:', comment, '| 空行:', blank, '| 有效代码:', code, '| U+FFFD:', fffd);
