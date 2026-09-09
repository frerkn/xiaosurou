// Use V8's parser via require('vm')
const fs = require('fs');
const path = 'C:/Users/阿乐/Desktop/111-main 3/330项目/330前端代码加瑞幸/modules/proactive-wake-ui.js';
const src = fs.readFileSync(path, 'utf8');
const vm = require('vm');
try {
  new vm.Script(src);
  console.log('OK');
} catch (e) {
  console.log('Error: ' + e.message);
  console.log('Stack: ' + e.stack);
}
