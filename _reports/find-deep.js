// Find brace imbalance by reporting depth at each line
const fs = require('fs');
const path = 'C:/Users/阿乐/Desktop/111-main 3/330项目/330前端代码加瑞幸/modules/proactive-wake-ui.js';
const src = fs.readFileSync(path, 'utf8');

let i = 0;
let line = 1;
let inStr = false;
let strCh = '';
let inBlockComment = false;
let inLineComment = false;
let depth = 0;
let lineStart = true;

const lines = src.split('\n');

while (i < src.length) {
  const c = src[i];
  const c2 = src[i+1] || '';
  if (c === '\n') {
    if (depth !== 0) {
      // Report end of line
    }
    line++;
  }
  if (inLineComment) {
    if (c === '\n') inLineComment = false;
    i++;
    continue;
  }
  if (inBlockComment) {
    if (c === '*' && c2 === '/') { inBlockComment = false; i += 2; continue; }
    i++;
    continue;
  }
  if (inStr) {
    if (c === '\\') { i += 2; continue; }
    if (c === strCh) { inStr = false; strCh = ''; i++; continue; }
    if (c === '\n') inStr = false;
    i++;
    continue;
  }
  if (c === '/' && c2 === '/') { inLineComment = true; i += 2; continue; }
  if (c === '/' && c2 === '*') { inBlockComment = true; i += 2; continue; }
  if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; i++; continue; }
  if (c === '{') depth++;
  if (c === '}') depth--;
  i++;
}

console.log('Final depth: ' + depth);
