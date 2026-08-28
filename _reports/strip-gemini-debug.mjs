// 精准删 Gemini 调试代码 v3 - 用 indexOf 找精确位置
import { readFileSync, writeFileSync } from 'fs';
const path = 'js/mcp-tool-bridge.js';
let content = readFileSync(path, 'utf8');
const before = content.length;

// 1. 删 MCP_DEBUG_GEMINI + debugGeminiToast helper 块
//    起: "    // Gemini 调试:"  (line 43)
//    止: "    // ========== 工具命名"  (line 58) 之前
const helperStart = content.indexOf('    // Gemini 调试:');
if (helperStart < 0) { console.error('helper 块起点没找到'); process.exit(1); }
const helperEnd = content.indexOf('    // ========== 工具命名', helperStart);
if (helperEnd < 0) { console.error('helper 块终点没找到'); process.exit(1); }
content = content.slice(0, helperStart) + content.slice(helperEnd);
console.log('1. 删 helper 块: 截至', helperEnd - helperStart, '字节');

// 2. 删每行 debugGeminiToast 调用 (用 ^...$ 锁定整行)
const callRegex = /^[ \t]*debugGeminiToast\([^)]*\);\s*\n/gm;
let m2 = content.match(callRegex);
if (m2) {
    content = content.replace(callRegex, '');
    console.log('2. 删 debugGeminiToast 调用:', m2.length, '处');
} else {
    console.log('2. ⚠️ 没找到调用');
}

// 3. 删 [Gemini Debug] console.log 块 (try {...} catch (e) {} 整段)
const consoleRegex = /^[ \t]*try \{ console\.log\('\[Gemini Debug\]'[\s\S]*?\} catch \(e\) \{\}\s*\n/gm;
let m3 = content.match(consoleRegex);
if (m3) {
    content = content.replace(consoleRegex, '');
    console.log('3. 删 [Gemini Debug] console.log:', m3.length, '处');
} else {
    console.log('3. ⚠️ 没找到 console.log');
}

// 4. 删 debugGeminiToolLoop 函数
//    起: "    // 诊断: 不发请求" 注释
//    止: 下一个 "    function getChatContainer() {" 之前
const fnStart = content.indexOf('    // 诊断: 不发请求');
if (fnStart >= 0) {
    const fnEnd = content.indexOf('    function getChatContainer() {', fnStart);
    if (fnEnd >= 0) {
        content = content.slice(0, fnStart) + content.slice(fnEnd);
        console.log('4. 删 debugGeminiToolLoop 函数');
    } else {
        console.log('4. ⚠️ 函数结束没找到');
    }
} else {
    console.log('4. ⚠️ 函数定义没找到');
}

// 5. 删 McpBridge 暴露行
const apiLine = '        debugGeminiToolLoop: debugGeminiToolLoop,\n';
if (content.includes(apiLine)) {
    content = content.replace(apiLine, '');
    console.log('5. 删 McpBridge.debugGeminiToolLoop 暴露');
} else {
    console.log('5. ⚠️ 暴露行没找到');
}

writeFileSync(path, Buffer.from(content, 'utf8'));
console.log('---');
console.log('原大小:', before, '字节');
console.log('新大小:', content.length, '字节');
console.log('删了:', before - content.length, '字节');
