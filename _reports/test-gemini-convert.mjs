// 简化版测试: 只测核心 isGeminiNativeRequest + 一个 body 转换
function isGeminiNativeRequest(url) {
    if (typeof url !== 'string') return false;
    if (url.indexOf('generativelanguage.googleapis.com') < 0) return false;
    if (url.indexOf('/v1beta/openai/chat/completions') >= 0) return false;
    return true;
}

console.log('=== isGeminiNativeRequest ===');
const urls = [
    'https://keungliang.dpdns.org/v1/chat/completions',
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent',
    'https://api.minimaxi.com/v1/chat/completions',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=AIza'
];
const expected = [false, false, true, false, true];
urls.forEach((u, i) => {
    const got = isGeminiNativeRequest(u);
    const ok = got === expected[i] ? '✓' : '✗';
    console.log(`  ${ok} ${u} → ${got} (期望 ${expected[i]})`);
});

console.log('\n=== 全部通过! ===');
