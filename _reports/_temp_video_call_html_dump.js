const fs = require('fs');
const html = fs.readFileSync('C:/Users/阿乐/Desktop/111-main 3/330项目/330视频通话页面做前/index.html', 'utf8');
const start = html.indexOf('id="video-call-screen"');
const end = html.indexOf('id="live2d-call-prep-screen"');
console.log(html.substring(start, end));
