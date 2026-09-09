const fs = require('fs');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };

const base = 'C:\\Users\\阿乐\\Desktop\\111-main 3\\330项目\\330前端代码加瑞幸\\';
const files = {
  'modules/chat-input.js': base + 'modules\\chat-input.js',
  'modules/chat-interface.js': base + 'modules\\chat-interface.js',
  'modules/ai-response.js': base + 'modules\\ai-response.js',
  'modules/vision-image-service.js': base + 'modules\\vision-image-service.js',
  'sw.js': base + 'sw.js',
  'index.html': base + 'index.html',
  'force-update.js': base + 'force-update.js'
};

console.log('====== 改动存活检查 ======\n');

for (const [name, path] of Object.entries(files)) {
  const content = read(path);
  if (!content) {
    console.log(`❌ ${name}: 文件不存在或读不到`);
    continue;
  }

  console.log(`\n--- ${name} (${content.length} chars) ---`);

  if (name === 'modules/chat-input.js') {
    const hasUrlContent = /content: sticker\.url/.test(content);
    const hasVisionMode = /stickerVisionMode: 'direct'/.test(content);
    const hasComment = /v0\.2\.31\.5 sticker 直发图/.test(content);
    console.log('  content: sticker.url:', hasUrlContent ? '✅' : '❌');
    console.log('  stickerVisionMode: direct:', hasVisionMode ? '✅' : '❌');
    console.log('  v0.2.31.5 注释:', hasComment ? '✅' : '❌');
  }

  if (name === 'modules/chat-interface.js') {
    const hasNewRender = /stickerVisionMode === 'direct' && typeof rawContent === 'string' && \/\^https\?:\\\/\/i\.test\(rawContent\)/.test(content);
    console.log('  新 sticker 渲染 (stickerVisionMode + URL):', hasNewRender ? '✅' : '❌');
  }

  if (name === 'modules/ai-response.js') {
    const hasFetchFn = /function fetchImageAsBase64DataUrl/.test(content);
    const hasFormatFn = /function formatStickerMessageForPrompt/.test(content);
    const fetchCalls = (content.match(/await fetchImageAsBase64DataUrl/g) || []).length;
    const visionModeChecks = (content.match(/msg\.stickerVisionMode === 'direct' && typeof msg\.content === 'string'/g) || []).length;
    const oldArrayIsArray = (content.match(/msg\.type === 'sticker' && Array\.isArray\(msg\.content\)/g) || []).length;
    const hasV0315Comment = /v0\.2\.31\.5 B 方案/.test(content);
    console.log('  fetchImageAsBase64DataUrl 工具函数:', hasFetchFn ? '✅' : '❌');
    console.log('  formatStickerMessageForPrompt 工具函数:', hasFormatFn ? '✅' : '❌');
    console.log('  await fetchImageAsBase64DataUrl 调用次数 (期望 4):', fetchCalls);
    console.log('  stickerVisionMode + URL if 块 (期望 3 处 sticker 早退):', visionModeChecks);
    console.log('  老 Array.isArray 残留 (期望 0):', oldArrayIsArray);
    console.log('  v0.2.31.5 注释:', hasV0315Comment ? '✅' : '❌');
  }

  if (name === 'modules/vision-image-service.js') {
    const hasSkipSticker = /msg\.type === 'sticker' && msg\.stickerVisionMode === 'direct'/.test(content);
    console.log('  sticker 跳过条件 (stickerVisionMode=direct):', hasSkipSticker ? '✅' : '❌');
  }

  if (name === 'sw.js') {
    const versionMatch = content.match(/const CACHE_VERSION = '([^']+)'/);
    const hasV0315 = /v0\.2\.31\.5/.test(content);
    console.log('  CACHE_VERSION:', versionMatch ? versionMatch[1] : 'NOT FOUND');
    console.log('  v0.2.31.5 注释:', hasV0315 ? '✅' : '❌');
  }

  if (name === 'index.html') {
    const hasOldScript = /src="sticker-vision\.js/.test(content);
    const hasNewLabel = /启用表情包直发图/.test(content);
    const hasOldLabel = /启用表情包识图/.test(content);
    console.log('  sticker-vision.js script 引用:', hasOldScript ? '❌ 还有!' : '✅ 已删');
    console.log('  新文案 "启用表情包直发图":', hasNewLabel ? '✅' : '❌');
    console.log('  老文案 "启用表情包识图":', hasOldLabel ? '❌ 还在!' : '✅ 已改');
  }

  if (name === 'force-update.js') {
    const hasSticker = /sticker-vision\.js/.test(content);
    console.log('  sticker-vision.js 白名单:', hasSticker ? '❌ 还有!' : '✅ 已删');
  }
}
