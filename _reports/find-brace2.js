// Better brace counter - properly handles template literals
const fs = require('fs');
const path = 'C:/Users/阿乐/Desktop/111-main 3/330项目/330前端代码加瑞幸/modules/proactive-wake-ui.js';
const src = fs.readFileSync(path, 'utf8');

let i = 0;
let depth = 0;
let line = 1;
let lastOpen = -1;
const stack = []; // stack of {line, char, depth}

function inString() {
  // find all template literal regions and replace with placeholders
}

let inStr = false;
let strCh = '';
let inBlockComment = false;
let inLineComment = false;

while (i < src.length) {
  const c = src[i];
  const c2 = src[i+1] || '';
  const cPrev = i > 0 ? src[i-1] : '';
  if (c === '\n') { line++; }

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
    i++;
    continue;
  }
  // not in any state
  if (c === '/' && c2 === '/') { inLineComment = true; i += 2; continue; }
  if (c === '/' && c2 === '*') { inBlockComment = true; i += 2; continue; }
  if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; i++; continue; }
  if (c === '{') { depth++; stack.push({line, char: c, depth}); lastOpen = line; }
  if (c === '}') {
    depth--;
    if (depth < 0) {
      console.log('Line ' + line + ': close without open. Stack:');
      stack.slice(-5).forEach(s => console.log('  ' + s.line + ': depth=' + s.depth));
      depth = 0;
    }
    if (stack.length > 0) stack.pop();
  }
  i++;
}

console.log('Final depth: ' + depth);
console.log('Last open at line: ' + lastOpen);
console.log('Stack remaining:');
stack.slice(-10).forEach(s => console.log('  line ' + s.line + ': depth=' + s.depth + ' char=' + s.char));
