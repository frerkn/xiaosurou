// sw.js bump CACHE_VERSION (Node 脚本, 避免 PowerShell GBK 陷阱)
import { readFileSync, writeFileSync } from 'fs';
const path = 'sw.js';
const content = readFileSync(path, 'utf8');
const pattern = /const CACHE_VERSION = 'v0\.2\.31\.\d+';/;
const m = content.match(pattern);
if (!m) { console.error('CACHE_VERSION not found'); process.exit(1); }
const currentVer = m[0];
const num = parseInt(currentVer.match(/v0\.2\.31\.(\d+)/)[1], 10);
const newVer = `const CACHE_VERSION = 'v0.2.31.${num + 1}';`;
const patched = content.replace(pattern, newVer);
writeFileSync(path, Buffer.from(patched, 'utf8'));
console.log('Bumped', currentVer, '→', newVer);
