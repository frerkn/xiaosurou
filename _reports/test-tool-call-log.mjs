// 端到端验证: mcp-tool-call-log.js 监听所有 onCard, 渲染工具调用文字行
// 测试各种通用 MCP 工具: 麦当劳/瑞幸/高德/任意/失败/成功

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// 加载 mcp-tool-call-log.js
const code = readFileSync(resolve(PROJECT_ROOT, 'js/mcp-tool-call-log.js'), 'utf8');

// ========== mock DOM minimal ==========
class MockElement {
    constructor(tag) {
        this.tag = tag;
        this.attrs = {};
        this.children = [];
        this.parent = null;
        this.classList = {
            _set: new Set(),
            add: (c) => { MockElement.callSet(this, c, true); },
            remove: (c) => { MockElement.callSet(this, c, false); },
            contains: (c) => MockElement.callHas(this, c),
        };
    }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    set className(v) {
        if (this.classList) this.classList._set.clear();
        if (this.classList && v) v.split(/\s+/).forEach(c => this.classList._set.add(c));
        this.attrs.class = v;  // 同步到 attrs (跟浏览器 element.className 一致)
    }
    get className() { return this.classList ? Array.from(this.classList._set).join(' ') : ''; }
    get nextSibling() { return null; }
    get parentNode() { return this.parent; }
    set innerHTML(html) { this._innerHTML = html; }
    get innerHTML() { return this._innerHTML || ''; }
    insertBefore(node, ref) {
        if (ref && ref.parent) {
            const idx = ref.parent.children.indexOf(ref);
            ref.parent.children.splice(idx, 0, node);
        } else if (this.children) {
            this.children.push(node);
        }
        node.parent = this;
    }
    appendChild(node) { this.insertBefore(node, null); }
    closest(selector) {
        let cur = this;
        while (cur) {
            const cls = cur.attrs && cur.attrs.class;
            const target = selector.replace('.', '');
            if (cls && cls.indexOf(target) >= 0) return cur;
            cur = cur.parent;
        }
        return null;
    }
    compareDocumentPosition(other) {
        // 简化: 用全局 _all 数组的 index 顺序判断
        const all = _mockDoc._all;
        const thisIdx = all.indexOf(this);
        const otherIdx = all.indexOf(other);
        if (thisIdx < 0 || otherIdx < 0) return 0;
        if (otherIdx > thisIdx) return 4; // DOCUMENT_POSITION_FOLLOWING
        if (otherIdx < thisIdx) return 2; // DOCUMENT_POSITION_PRECEDING
        return 0;
    }
}
MockElement.callSet = function (el, c, add) {
    if (!el.classList) el.classList = { _set: new Set(), add() {}, remove() {}, contains: () => false };
    if (add) el.classList._set.add(c); else el.classList._set.delete(c);
};
MockElement.callHas = function (el, c) {
    return el.classList && el.classList._set && el.classList._set.has(c);
};

const _mockDoc = {
    _all: [],
    createElement(tag) {
        const el = new MockElement(tag);
        this._all.push(el);
        return el;
    },
    querySelectorAll(selector) {
        // 简化: 处理 .className 选择器
        if (selector.startsWith('.')) {
            const cls = selector.replace(/^\./, '').split(/[\[\.]/)[0];
            return this._all.filter(e => e.attrs && e.attrs.class && e.attrs.class.split(/\s+/).indexOf(cls) >= 0);
        }
        return [];
    },
    querySelector(selector) {
        const all = this.querySelectorAll(selector);
        return all.length ? all[0] : null;
    },
    body: new MockElement('body'),
};

global.document = _mockDoc;
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

let _cardListener = null;
global.McpBridge = {
    onCard: (fn) => { _cardListener = fn; },
};

// mock state 让 getCurrentAIName 拿到 "沈清越" (chat.originalName 字段, 聊天设置页"对方本名 (AI识别用)"输入框)
global.state = {
    activeChatId: 'chat-1',
    chats: {
        'chat-1': { originalName: '沈清越' },
    },
};

new Function('globalThis', code)(globalThis);

if (!_cardListener) {
    console.error('❌ mcp-tool-call-log.js 没注册 card listener');
    process.exit(1);
}
console.log('✅ mcp-tool-call-log.js 加载成功, onCard 已注册');

// ========== 测试 ==========
let pass = 0, fail = 0;

function setupBubble() {
    _mockDoc._all.length = 0;
    const chatArea = new MockElement('div');
    chatArea.attrs = { class: 'chat-area' };
    const wrapper = new MockElement('div');
    wrapper.attrs = { class: 'message-wrapper' };
    const bubble = new MockElement('div');
    bubble.attrs = { class: 'message-bubble', 'data-timestamp': '99999' };
    bubble.parent = wrapper;
    wrapper.parent = chatArea;
    chatArea.parent = _mockDoc.body;
    chatArea.children = [wrapper];
    wrapper.children = [bubble];
    _mockDoc._all.push(chatArea);
    _mockDoc._all.push(wrapper);
    _mockDoc._all.push(bubble);
    return wrapper;
}

function testCase(label, toolName, result, expectedSubstrs) {
    console.log(`\n========== ${label} ==========`);
    console.log(`工具: ${toolName}, success=${result.success}`);
    const wrapper = setupBubble();

    return new Promise(resolve => {
        _cardListener({ toolName, result, serverName: 'test', ts: Date.now() });
        setTimeout(() => {
            const logLines = _mockDoc._all.filter(e => e.attrs && e.attrs.class && e.attrs.class.indexOf('mcp-tool-log-line') >= 0);
            if (logLines.length === 0) {
                console.log('  ❌ fail: 没找到 .mcp-tool-log-line');
                fail++;
                resolve();
                return;
            }
            const line = logLines[logLines.length - 1];
            const html = line._innerHTML || '';
            console.log('  → 找到日志行, HTML: ' + html.slice(0, 200));
            let ok = true;
            for (const s of expectedSubstrs) {
                if (html.indexOf(s) < 0) {
                    console.log('  ❌ 缺字段: ' + s);
                    ok = false;
                }
            }
            // 验证在正确位置 (group 或 wrapper 后)
            let inGroup = false;
            let cur = line.parent;
            while (cur && cur !== document.body) {
                if (cur.attrs && cur.attrs.class && cur.attrs.class.indexOf('mcp-tool-log-group') >= 0) {
                    inGroup = true; break;
                }
                cur = cur.parent;
            }
            if (inGroup) {
                console.log('  ✅ 插入位置正确 (在 .mcp-tool-log-group 内)');
            } else {
                console.log('  ⚠️  没在 .mcp-tool-log-group 内, 但有渲染');
            }
            if (ok) { console.log('  ✅ pass'); pass++; } else { console.log('  ❌ fail'); fail++; }
            resolve();
        }, 30);
    });
}

async function testMultiCalls() {
    console.log(`\n========== 测试: 多次调用堆叠到同一个 group ==========`);
    const wrapper = setupBubble();
    await new Promise(resolve => {
        _cardListener({ toolName: 'query-nearby-stores', result: { success: true, data: { stores: [{a:1},{a:2},{a:3}] } }, ts: Date.now() });
        _cardListener({ toolName: 'query-meals', result: { success: true, data: { categories: [{items: [1,2,3,4]}, {items: [1,2]}] } }, ts: Date.now() + 1 });
        _cardListener({ toolName: 'create-order', result: { success: true, data: { orderId: 'MCD123', amount: 86 } }, ts: Date.now() + 2 });
        setTimeout(() => {
            const groups = _mockDoc._all.filter(e => e.attrs && e.attrs.class && e.attrs.class.indexOf('mcp-tool-log-group') >= 0);
            if (groups.length !== 1) {
                console.log('  ❌ 应该只有 1 个 group, 实际 ' + groups.length);
                fail++;
            } else {
                const linesInGroup = groups[0].children.filter(c => c.attrs && c.attrs.class && c.attrs.class.indexOf('mcp-tool-log-line') >= 0);
                console.log('  → 1 个 group, 包含 ' + linesInGroup.length + ' 行');
                if (linesInGroup.length === 3) {
                    console.log('  ✅ pass: 3 个调用堆叠到 1 个 group');
                    pass++;
                } else {
                    console.log('  ❌ fail: 期望 3 行, 实际 ' + linesInGroup.length);
                    fail++;
                }
                // 验证顺序
                const names = linesInGroup.map(l => {
                    const m = /mcp-tool-log-tool[^>]*>([^<]+)</.exec(l._innerHTML);
                    return m ? m[1] : '?';
                });
                console.log('  顺序: ' + names.join(' → '));
                if (names.join(',') === 'query-nearby-stores,query-meals,create-order') {
                    console.log('  ✅ 顺序正确');
                    pass++;
                } else {
                    console.log('  ❌ 顺序错');
                    fail++;
                }
            }
            resolve();
        }, 50);
    });
}

async function main() {
    // 1. 麦当劳 query-nearby-stores
    await testCase('1. 麦当劳 query-nearby-stores (stores 数组)',
        'query-nearby-stores',
        { success: true, data: { stores: [{n:1},{n:2},{n:3},{n:4},{n:5}] } },
        ['沈清越', '调用了', 'query-nearby-stores', '5 项']
    );

    // 2. 麦当劳 query-meals (categories 结构)
    await testCase('2. 麦当劳 query-meals (categories 嵌套)',
        'query-meals',
        { success: true, data: { categories: [{name: '汉堡', items: [{},{},{},{}]}, {name: '饮料', items: [{},{}]}] } },
        ['沈清越', '调用了', 'query-meals', '2 分类', '6 餐品']
    );

    // 3. 瑞幸 searchProductForMcp
    await testCase('3. 瑞幸 searchProductForMcp (products)',
        'searchProductForMcp',
        { success: true, data: { products: [{n:1},{n:2}] } },
        ['沈清越', '调用了', 'searchProductForMcp', '2 项']
    );

    // 4. 瑞幸 previewOrder (discountPrice)
    await testCase('4. 瑞幸 previewOrder (discountPrice)',
        'previewOrder',
        { success: true, data: { discountPrice: 32, couponCodeList: [{c:1}, {c:2}] } },
        ['沈清越', '调用了', 'previewOrder', '¥32']
    );

    // 5. 高德 maps_text_search (pois)
    await testCase('5. 高德 maps_text_search (pois + count)',
        'maps_text_search',
        { success: true, data: { pois: [{},{},{}], count: '345' } },
        ['沈清越', '调用了', 'maps_text_search', '3 项']
    );

    // 6. 高德 maps_distance (distance 数字)
    await testCase('6. 高德 maps_distance (distance 字段)',
        'maps_distance',
        { success: true, data: { distance: 1446, duration: 233 } },
        ['沈清越', '调用了', 'maps_distance', '1446m']
    );

    // 7. 任意通用工具 (兜底)
    await testCase('7. 通用工具 (兜底字段数)',
        'some_custom_tool',
        { success: true, data: { foo: 1, bar: 'x', baz: true } },
        ['沈清越', '调用了', 'some_custom_tool']
    );

    // 8. 失败
    await testCase('8. 失败调用 (低调用失败)',
        'query-meals',
        { success: false, error: '门店已关闭' },
        ['沈清越', '调用失败', 'query-meals', '门店已关闭']
    );

    // 9. AI 名字 fallback (state 没设)
    console.log(`\n========== 9. AI 名字 fallback ==========`);
    _mockDoc._all.length = 0;
    const w9 = new MockElement('div'); w9.attrs = { class: 'message-wrapper' };
    const b9 = new MockElement('div'); b9.attrs = { class: 'message-bubble', 'data-timestamp': '99' };
    b9.parent = w9; w9.children = [b9];
    _mockDoc._all.push(w9); _mockDoc._all.push(b9);
    // 临时清空 state
    const oldState = global.state;
    global.state = null;
    await new Promise(resolve => {
        _cardListener({ toolName: 'test', result: { success: true, data: {} }, ts: Date.now() });
        setTimeout(() => {
            const lines = _mockDoc._all.filter(e => e.attrs && e.attrs.class && e.attrs.class.indexOf('mcp-tool-log-line') >= 0);
            if (lines.length && lines[lines.length - 1]._innerHTML.indexOf('AI') >= 0) {
                console.log('  ✅ pass: 状态拿不到时 fallback "AI"');
                pass++;
            } else {
                console.log('  ❌ fail: 应该 fallback "AI"');
                fail++;
            }
            global.state = oldState;
            resolve();
        }, 30);
    });

    // 9. 多调用堆叠
    await testMultiCalls();

    console.log(`\n========== 总结 ==========`);
    console.log(`通过 ${pass}, 失败 ${fail}`);
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('❌ 主流程异常:', e); process.exit(1); });
