// 完整模拟：用户粘贴纯文本 → handleManualLrcImport 按字数估算 → parseLRC 解析
const pastedText = `周一 我打开窗
窗外 是你的模样
你笑着不说话
风吹过你的发`;

console.log('=== 用户粘贴的纯文本 ===');
console.log(pastedText);

// 模拟 handleManualLrcImport 的按字数估算逻辑（line 1944-1957）
let raw = pastedText.replace(/\[/g, '\n[').trim();
if (!/\[\d{1,2}:\d{1,2}/.test(raw)) {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let acc = 0;
  raw = lines.map((line) => {
    const cjkCount = (line.match(/[\u4e00-\u9fa5\u3400-\u4dbf]/g) || []).length;
    const nonCjkCount = line.replace(/[\u4e00-\u9fa5\u3400-\u4dbf]/g, '').replace(/\s+/g, '').length;
    const sec = Math.max(2, Math.min(10, cjkCount / 3 + nonCjkCount / 5));
    const startSec = Math.round(acc);
    acc += sec;
    const m = String(Math.floor(startSec / 60)).padStart(2, '0');
    const s = String(startSec % 60).padStart(2, '0');
    return `[${m}:${s}]${line}`;
  }).join('\n');
}

console.log('\n=== 按字数估算生成的时间戳 ===');
console.log(raw);

// 模拟新 parseLRC
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

const parsed = parseLRC(raw);
console.log('\n=== parseLRC 解析结果 ===');
console.log(JSON.stringify(parsed, null, 2));
console.log(`\n共 ${parsed.length} 行歌词可显示`);
