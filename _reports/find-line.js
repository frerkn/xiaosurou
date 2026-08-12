// Find the exact line where the extra { is
const fs = require('fs');
const path = 'C:/Users/阿乐/Desktop/111-main 3/330项目/330前端代码加瑞幸/modules/proactive-wake-ui.js';
const src = fs.readFileSync(path, 'utf8');
const lines = src.split('\n');

let depth = 0;
let lastOpenLine = -1;
const lastOpens = []; // stack of line numbers

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // Simple count - we're looking for major structural imbalance
  for (const c of line) {
    if (c === '{') {
      depth++;
      lastOpens.push(i + 1);
    } else if (c === '}') {
      depth--;
      if (lastOpens.length > 0) lastOpens.pop();
    }
  }
}

console.log('Final depth: ' + depth);
console.log('Stack:');
lastOpens.forEach(l => console.log('  line ' + l));
