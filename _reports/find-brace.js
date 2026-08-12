const fs = require('fs');
const path = 'C:/Users/阿乐/Desktop/111-main 3/330项目/330前端代码加瑞幸/modules/proactive-wake-ui.js';
const content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');
let inStr = false;
let strCh = '';
let inBlockComment = false;
let inLineComment = false;
let depth = 0;
let lastOpenLine = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    const c2 = line[j + 1];
    if (inLineComment) continue;
    if (inBlockComment) {
      if (c === '*' && c2 === '/') { inBlockComment = false; j++; }
      continue;
    }
    if (inStr) {
      if (c === '\\') { j++; continue; }
      if (c === strCh) { inStr = false; strCh = ''; }
      continue;
    }
    if (c === '/' && c2 === '/') { inLineComment = true; continue; }
    if (c === '/' && c2 === '*') { inBlockComment = true; j++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; continue; }
    if (c === '{') { depth++; lastOpenLine = i + 1; }
    if (c === '}') {
      depth--;
      if (depth < 0) {
        console.log('Line ' + (i + 1) + ': close without open: ' + line.trim().substring(0, 80));
        depth = 0;
      }
    }
  }
  inLineComment = false;
}
console.log('Final depth: ' + depth);
console.log('Last open at line: ' + lastOpenLine);
