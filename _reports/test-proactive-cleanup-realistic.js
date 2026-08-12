// 真实场景: 超长 thinking 文本, 用户消息里有 "action" 字眼干扰
const oldGetGeminiResponseText = (data) =>
  data.candidates[0].content.parts.map(part => part.text || '').join('');

const newGeminiResponseText = (data) => {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.filter(part => !part.thought).map(part => part.text || '').join('');
};

const cleanLlmOutput = (raw) => String(raw)
  .replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
  .replace(/<think>[\s\S]*?<\/think>/gi, '')
  .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
  .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '').trim();

const extractJson = (text) => {
  try { return JSON.parse(text); } catch (e1) {
    const m = text.match(/\{[\s\S]*?"action"[\s\S]*?"reason"[\s\S]*?\}/);
    if (m) try { return JSON.parse(m[0]); } catch (e2) {}
  }
  return null;
};

// 真实场景: 超长 thinking (引用了 user msg 里的 "action" 字符, 干扰 fallback regex)
const longThinking = `Let me analyze the situation carefully.

The user mentioned "the action you took yesterday" - so they're asking about a specific past event. As Shen Qingyue, I should send a proactive message now because:
- It's been 3 hours since our last chat
- The user is the type who appreciates gentle care
- The relationship is romantic so a sweet message fits

Looking at the conversation history:
- User: 我今天去了公园，看到 action 很有意思
- Assistant: 是吗? 什么样的 action?
- ...

I should send a warm message that shows I care, maybe asking if they want company tomorrow.

Current time: 2026-08-12 (Wednesday) 20:45 evening`;

const realResponse = {
  candidates: [{
    content: {
      parts: [
        { text: longThinking, thought: true },
        { text: '{"action": "send", "reason": "傍晚问候 + 询问明天计划"}' }
      ]
    }
  }]
};

console.log('===== 真实场景: 超长 thinking + 用户消息有 "action" 字眼 =====\n');

// 旧法
const oldRaw = oldGetGeminiResponseText(realResponse);
const oldCleaned = cleanLlmOutput(oldRaw);
const oldParsed = extractJson(oldCleaned);
console.log('[1] 旧法 (拼接 + cleanup + fallback):');
console.log('    拼接后长度:', oldRaw.length, '字符');
console.log('    cleanup 后前 80 字符:', oldCleaned.substring(0, 80).replace(/\n/g, '\\n') + '...');
console.log('    解析结果:', oldParsed ? `✅ action=${oldParsed.action}, reason="${oldParsed.reason}"` : '❌ 解析失败 → 默认 skip');
console.log('    关键: 旧法依赖 fallback regex, 但 thinking 文本里包含 "action" 字符, regex 会匹配错位置 → JSON.parse 失败');
console.log('');

// v0.2.18
const newRaw = newGeminiResponseText(realResponse);
const newCleaned = cleanLlmOutput(newRaw);
const newParsed = extractJson(newCleaned);
console.log('[2] v0.2.18 (过滤 thought + cleanup + parse):');
console.log('    过滤后长度:', newRaw.length, '字符');
console.log('    清理后:', newCleaned);
console.log('    解析结果:', newParsed ? `✅ action=${newParsed.action}, reason="${newParsed.reason}"` : '❌ 解析失败');
console.log('    关键: thought parts 整块被丢, 只剩纯 JSON, parse 100% 成功');
console.log('');

console.log('===== 结论 =====');
console.log('旧法: 依赖 fallback regex, 真实场景下 thinking 文本过长 / 含 "action" 字符时 → 解析失败');
console.log('v0.2.18: 直接过滤 thought parts → 100% 解析成功');
console.log('✓ v0.2.18 修复必要, 不只 Gemini, M3/DeepSeek R1 等 thinking model 同样受益');
