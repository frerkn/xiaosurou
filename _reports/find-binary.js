// Find the exact line where syntax error occurs by trying different cut points
const fs = require('fs');
const path = 'C:/Users/阿乐/Desktop/111-main 3/330项目/330前端代码加瑞幸/modules/proactive-wake-ui.js';
const src = fs.readFileSync(path, 'utf8');
const lines = src.split('\n');

// Try parsing each prefix wrapped in IIFE
function tryPrefix(numLines) {
  const content = lines.slice(0, numLines).join('\n');
  // Wrap in IIFE to make it valid (in case the closing })(); is missing)
  const wrapped = '(function(){\n' + content + '\n})()';
  try {
    new Function(wrapped);
    return true;
  } catch (e) {
    return e.message;
  }
}

// Binary search
let lo = 0;
let hi = lines.length;
let lastValid = 0;
while (lo < hi) {
  const mid = Math.floor((lo + hi + 1) / 2);
  const result = tryPrefix(mid);
  if (result === true) {
    lastValid = mid;
    lo = mid;
  } else {
    hi = mid - 1;
  }
}
console.log('Last valid line: ' + lastValid);
console.log('Total lines: ' + lines.length);
console.log('Problem around line: ' + (lastValid + 1));
// Show 5 lines around the problem
for (let i = Math.max(0, lastValid - 3); i < Math.min(lines.length, lastValid + 5); i++) {
  console.log((i+1) + ': ' + lines[i].substring(0, 100));
}
