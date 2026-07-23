// 模拟用户场景：纯文本 → 按字数估算生成无毫秒时间戳 → parseLRC 解析
const lrcContent = `[00:00]这是我写的歌
[00:02]副歌是第一句
[00:04]这是我写的歌
[00:06]副歌是第一句`;

function parseLRC(lrcContent) {
  if (!lrcContent) return [];
  const lines = String(lrcContent).split(/\r\n?|\n/);
  const lyrics = [];
  const timeRegex = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of lines) {
    const text = line.replace(timeRegex, '').trim();
    if (!text) continue;
    timeRegex.lastIndex = 0;
    let match;
    while ((match = timeRegex.exec(line)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const msRaw = (match[3] || '0').padEnd(3, '0').slice(0, 3);
      const milliseconds = parseInt(msRaw, 10) || 0;
      const time = minutes * 60 + seconds + milliseconds / 1000;
      lyrics.push({ time, text });
    }
  }
  return lyrics.sort((a, b) => a.time - b.time);
}

const result = parseLRC(lrcContent);
console.log('解析结果:', JSON.stringify(result, null, 2));
console.log('共解析出', result.length, '行歌词');

// 模拟旧正则（带毫秒严格）解析同样的内容
const oldRegex = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]/g;
const lines2 = lrcContent.split(/\r\n?|\n/);
let oldCount = 0;
for (const line of lines2) {
  let m;
  oldRegex.lastIndex = 0;
  while ((m = oldRegex.exec(line)) !== null) oldCount++;
}
console.log('旧正则会解析出', oldCount, '行（预期 0，证明无毫秒时间戳过去被拒）');
