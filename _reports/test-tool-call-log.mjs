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
    get nextElementSibling() {
        if (!this.parent || !this.parent.children) return null;
        const idx = this.parent.children.indexOf(this);
        for (let i = idx + 1; i < this.parent.children.length; i++) {
            return this.parent.children[i];
        }
        return null;
    }
    get previousElementSibling() {
        if (!this.parent || !this.parent.children) return null;
        const idx = this.parent.children.indexOf(this);
        for (let i = idx - 1; i >= 0; i--) {
            return this.parent.children[i];
        }
        return null;
    }
    querySelectorAll(selector) { return _mockDoc.querySelectorAll(selector).filter(e => this._contains(e)); }
    querySelector(selector) { const all = this.querySelectorAll(selector); return all.length ? all[0] : null; }
    _contains(node) {
        let cur = node;
        while (cur && cur !== this) cur = cur.parent;
        return cur === this;
    }
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
    _byId: {},
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
        if (selector.startsWith('#')) {
            const id = selector.replace(/^#/, '');
            return this._byId[id] ? [this._byId[id]] : [];
        }
        return [];
    },
    querySelector(selector) {
        const all = this.querySelectorAll(selector);
        return all.length ? all[0] : null;
    },
    getElementById(id) {
        return this._byId[id] || null;
    },
    body: new MockElement('body'),
};

// mock MutationObserver
let _observerCb = null;
let _observerTarget = null;
class MockMutationObserver {
    constructor(cb) { _observerCb = cb; }
    observe(target) { _observerTarget = target; }
    disconnect() { _observerCb = null; _observerTarget = null; }
}
function triggerObserver(addedNodes) {
    if (_observerCb && _observerTarget) {
        _observerCb([{ type: 'childList', addedNodes, target: _observerTarget }]);
    }
}

global.document = _mockDoc;
global.MutationObserver = MockMutationObserver;
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

let _cardListener = null;
global.McpBridge = {
    onCard: (fn) => { _cardListener = fn; },
};

// mock state 让 getCurrentAIName 拿到 "沈清越" (chat.originalName 字段, 聊天设置页"对方本名 (AI识别用)"输入框)
// mock chat 1 包含 history (用于 findLastAssistantTimestamp 找锚点)
// mock chat 2 用于"切聊天"测试 (有 mcpToolLogs 历史但 history 不全)
global.state = {
    activeChatId: 'chat-1',
    chats: {
        'chat-1': {
            originalName: '沈清越',
            history: [
                { role: 'user', timestamp: 1000, content: '你好' },
                { role: 'assistant', timestamp: 2000, content: '在的' },
            ],
        },
        'chat-2': {
            originalName: '李泽',
            history: [
                { role: 'assistant', timestamp: 3000, content: 'ok' },
            ],
            mcpToolLogs: [
                { ts: 2500, afterMsgTs: 2000, toolName: 'query-meals', aiName: '沈清越', summary: '3 分类 10 餐品', success: true },
                { ts: 4000, afterMsgTs: 3000, toolName: 'searchProductForMcp', aiName: '李泽', summary: '5 项', success: true },
                { ts: 4100, afterMsgTs: 3000, toolName: 'create-order', aiName: '李泽', summary: '订单 A100', success: false },
            ],
        },
    },
};

// mock Dexie db: 记录所有 put 调用
const _putCalls = [];
global.window = global;
global.window.db = {
    chats: {
        put: async (chat) => { _putCalls.push(chat); return 'ok'; },
    },
};
// 留一个引用给测试用
global._putCalls = _putCalls;
global._mockDoc = _mockDoc;

// ========== 创建 chat-messages 容器 (v0.1.70 持久化用) ==========
const chatMessagesContainer = new MockElement('div');
chatMessagesContainer.attrs = { id: 'chat-messages' };
_mockDoc._all.push(chatMessagesContainer);
_mockDoc._byId['chat-messages'] = chatMessagesContainer;
chatMessagesContainer.parent = _mockDoc.body;

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
    // 重新挂 chat-messages 容器
    _mockDoc._all.push(chatMessagesContainer);
    _mockDoc._byId['chat-messages'] = chatMessagesContainer;
    chatMessagesContainer.parent = _mockDoc.body;
    chatMessagesContainer.children = [];
    const wrapper = new MockElement('div');
    wrapper.attrs = { class: 'message-wrapper' };
    const bubble = new MockElement('div');
    bubble.attrs = { class: 'message-bubble', 'data-timestamp': '99999' };
    bubble.parent = wrapper;
    wrapper.parent = chatMessagesContainer;
    chatMessagesContainer.children = [wrapper];
    wrapper.children = [bubble];
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

    // ========== v0.1.70 持久化测试 ==========

    // 10. onCard 写持久化 (chat.mcpToolLogs.push + db.chats.put)
    console.log(`\n========== 10. onCard 写持久化到 chat.mcpToolLogs + db.chats.put ==========`);
    {
        _putCalls.length = 0;
        const chat = global.state.chats['chat-1'];
        const beforeLen = (chat.mcpToolLogs || []).length;
        const wrapper = setupBubble();
        await new Promise(resolve => {
            _cardListener({
                toolName: 'query-meals',
                result: { success: true, data: { categories: [{items:[1,2,3]}, {items:[1,2,3,4]}] } },
                ts: 1000000,
            });
            setTimeout(() => {
                // 1) chat.mcpToolLogs 应新增 1 条
                const afterLen = (chat.mcpToolLogs || []).length;
                if (afterLen === beforeLen + 1) {
                    console.log('  ✅ chat.mcpToolLogs 新增 1 条');
                    pass++;
                } else {
                    console.log('  ❌ chat.mcpToolLogs 长度不对: before=' + beforeLen + ' after=' + afterLen);
                    fail++;
                }
                // 2) 新增的 entry 字段正确
                const entry = chat.mcpToolLogs[chat.mcpToolLogs.length - 1];
                const requiredFields = ['ts', 'afterMsgTs', 'toolName', 'aiName', 'summary', 'success'];
                let allFields = true;
                for (const f of requiredFields) {
                    if (!(f in entry)) { console.log('  ❌ 缺字段: ' + f); allFields = false; fail++; }
                }
                if (allFields) { console.log('  ✅ entry 6 字段齐全: ' + JSON.stringify(entry)); pass++; }
                // 3) afterMsgTs 应该 = 2000 (chat-1 最后一条 assistant)
                if (entry.afterMsgTs === 2000) { console.log('  ✅ afterMsgTs = 2000 (chat-1 最后 assistant)'); pass++; }
                else { console.log('  ❌ afterMsgTs 应为 2000, 实际 ' + entry.afterMsgTs); fail++; }
                // 4) db.chats.put 被调
                if (_putCalls.length === 1 && _putCalls[0] === chat) { console.log('  ✅ db.chats.put(chat) 调用正确'); pass++; }
                else { console.log('  ❌ db.chats.put 调用错: ' + _putCalls.length + ' 次'); fail++; }
                resolve();
            }, 30);
        });
    }

    // 11. renderHistoricalLogs 重新渲染历史 log (模拟切聊天)
    console.log(`\n========== 11. 切聊天 → renderHistoricalLogs 恢复历史 log ==========`);
    {
        // 切到 chat-2 (有 3 条 mcpToolLogs: query-meals + searchProduct + create-order)
        const oldActive = global.state.activeChatId;
        global.state.activeChatId = 'chat-2';
        // 设置 chat-2 的 DOM: 一条 wrapper + bubble (timestamp=3000), 模拟 330 renderChatInterface 渲染完
        _mockDoc._all.length = 0;
        _mockDoc._all.push(chatMessagesContainer);
        _mockDoc._byId['chat-messages'] = chatMessagesContainer;
        chatMessagesContainer.parent = _mockDoc.body;
        chatMessagesContainer.children = [];
        const w2 = new MockElement('div');
        w2.attrs = { class: 'message-wrapper' };
        const b2 = new MockElement('div');
        b2.attrs = { class: 'message-bubble', 'data-timestamp': '3000' };
        b2.parent = w2;
        w2.parent = chatMessagesContainer;
        chatMessagesContainer.children = [w2];
        w2.children = [b2];
        _mockDoc._all.push(w2);
        _mockDoc._all.push(b2);

        // 触发 onCard (它会调内部 renderHistoricalLogs 吗? — 不会, 这个函数需要手动暴露)
        // 看代码: 我没暴露 renderHistoricalLogs, 只通过 MutationObserver 触发
        // 那测试直接 triggerObserver 模拟 330 渲染消息后触发
        triggerObserver([b2]);
        // 等 debounce 100ms + 一些缓冲
        await new Promise(resolve => setTimeout(resolve, 200));

        const lines = _mockDoc._all.filter(e => e.attrs && e.attrs.class && e.attrs.class.indexOf('mcp-tool-log-line') >= 0);
        console.log('  → 找到 ' + lines.length + ' 个 .mcp-tool-log-line');
        if (lines.length === 3) { console.log('  ✅ 3 条历史 log 全部渲染'); pass++; }
        else { console.log('  ❌ 应为 3 条, 实际 ' + lines.length); fail++; }
        // 验证: 第一条 (ts=2500, afterMsgTs=2000) 应该找 nearest bubble before 2000 — 找不到 (3000 之后), 兜底到末尾
        // 第二/三条 (ts=4000/4100, afterMsgTs=3000) 应该插到 b2 后面
        if (lines.length >= 2) {
            const tsList = lines.map(l => l.getAttribute('data-ts'));
            console.log('  → ts 列表: ' + tsList.join(', '));
            const ok = tsList.indexOf('2500') >= 0 && tsList.indexOf('4000') >= 0 && tsList.indexOf('4100') >= 0;
            if (ok) { console.log('  ✅ 3 条 ts 都在 DOM 里'); pass++; }
            else { console.log('  ❌ 缺 ts'); fail++; }
        }
        // 验证失败样式: create-order (ts=4100) 应有 mcp-tool-log-err
        const errLine = lines.find(l => l.getAttribute('data-ts') === '4100');
        if (errLine && errLine.attrs.class && errLine.attrs.class.indexOf('mcp-tool-log-err') >= 0) {
            console.log('  ✅ create-order 失败样式正确 (mcp-tool-log-err)');
            pass++;
        } else {
            console.log('  ❌ create-order 失败样式错: ' + (errLine && errLine.attrs.class));
            fail++;
        }
        global.state.activeChatId = oldActive;
    }

    // 12. renderHistoricalLogs 幂等 (重复 ts 跳过)
    console.log(`\n========== 12. 幂等: 重复触发不重复渲染 ==========`);
    {
        // 复用 chat-2, 再 triggerObserver 一次
        _mockDoc._all.length = 0;
        _mockDoc._all.push(chatMessagesContainer);
        _mockDoc._byId['chat-messages'] = chatMessagesContainer;
        chatMessagesContainer.parent = _mockDoc.body;
        // 把上次渲染的 lines 全留 (chatMessagesContainer.children 没被清, 但 _mockDoc._all 清了)
        // 这里要保留 DOM 结构, 所以重建 wrapper + 之前的 log lines
        chatMessagesContainer.children = [];
        const w3 = new MockElement('div');
        w3.attrs = { class: 'message-wrapper' };
        const b3 = new MockElement('div');
        b3.attrs = { class: 'message-bubble', 'data-timestamp': '3000' };
        b3.parent = w3;
        w3.parent = chatMessagesContainer;
        chatMessagesContainer.children = [w3];
        w3.children = [b3];
        _mockDoc._all.push(w3);
        _mockDoc._all.push(b3);
        // 把之前 3 条 log line 复制回来
        // 简化: 直接模拟"已经有 3 条 log line"在容器里
        const oldActive = global.state.activeChatId;
        global.state.activeChatId = 'chat-2';
        for (let i = 0; i < 3; i++) {
            const fakeTs = ['2500', '4000', '4100'][i];
            const fakeLine = new MockElement('div');
            fakeLine.attrs = { class: 'mcp-tool-log-line', 'data-ts': fakeTs };
            // 挂到 chatMessagesContainer (顺序按 ts) — 用 appendChild 设 parent, _contains 才返回 true
            chatMessagesContainer.appendChild(fakeLine);
            _mockDoc._all.push(fakeLine);
        }
        const beforeCount = chatMessagesContainer.children.length;
        // 触发 observer
        triggerObserver([b3]);
        await new Promise(resolve => setTimeout(resolve, 200));
        const afterCount = chatMessagesContainer.children.length;
        if (afterCount === beforeCount) {
            console.log('  ✅ 重复触发不新增 log (before=' + beforeCount + ' after=' + afterCount + ')');
            pass++;
        } else {
            console.log('  ❌ 重复触发多渲染了 (before=' + beforeCount + ' after=' + afterCount + ')');
            fail++;
        }
        global.state.activeChatId = oldActive;
    }

    // 13. 完全没锚点气泡的兜底
    console.log(`\n========== 13. 找不到锚点气泡 → 兜底到末尾 ==========`);
    {
        // 新聊天: chat-3 只有 mcpToolLogs, 没 history 也没 DOM
        global.state.chats['chat-3'] = {
            originalName: '小王',
            mcpToolLogs: [
                { ts: 5000, afterMsgTs: 9999, toolName: 'geocodes', aiName: '小王', summary: '3 地址候选', success: true },
            ],
        };
        _mockDoc._all.length = 0;
        _mockDoc._all.push(chatMessagesContainer);
        _mockDoc._byId['chat-messages'] = chatMessagesContainer;
        chatMessagesContainer.parent = _mockDoc.body;
        chatMessagesContainer.children = [];  // 空容器, 无气泡
        const oldActive = global.state.activeChatId;
        global.state.activeChatId = 'chat-3';
        // 模拟 330 切聊天后渲染消息: triggerObserver 传一个 addNode
        triggerObserver([new MockElement('div')]);
        await new Promise(resolve => setTimeout(resolve, 200));
        const lines = _mockDoc._all.filter(e => e.attrs && e.attrs.class && e.attrs.class.indexOf('mcp-tool-log-line') >= 0);
        if (lines.length === 1) {
            console.log('  ✅ 找不到锚点时, 兜底渲染 1 条 log (插到容器末尾)');
            pass++;
        } else {
            console.log('  ❌ 应渲染 1 条, 实际 ' + lines.length);
            fail++;
        }
        global.state.activeChatId = oldActive;
        delete global.state.chats['chat-3'];
    }

    // 14. 没 mcpToolLogs 字段时不报错
    console.log(`\n========== 14. 老聊天 (没 mcpToolLogs 字段) 不报错 ==========`);
    {
        // chat-1 没 mcpToolLogs 字段 (v0.1.63 之前建的)
        const chat1 = global.state.chats['chat-1'];
        delete chat1.mcpToolLogs;
        const oldActive = global.state.activeChatId;
        global.state.activeChatId = 'chat-1';
        _mockDoc._all.length = 0;
        _mockDoc._all.push(chatMessagesContainer);
        _mockDoc._byId['chat-messages'] = chatMessagesContainer;
        chatMessagesContainer.parent = _mockDoc.body;
        chatMessagesContainer.children = [];
        const w4 = new MockElement('div');
        w4.attrs = { class: 'message-wrapper' };
        const b4 = new MockElement('div');
        b4.attrs = { class: 'message-bubble', 'data-timestamp': '2000' };
        b4.parent = w4; w4.parent = chatMessagesContainer;
        chatMessagesContainer.children = [w4]; w4.children = [b4];
        _mockDoc._all.push(w4); _mockDoc._all.push(b4);
        let errored = false;
        try {
            triggerObserver([b4]);
            await new Promise(resolve => setTimeout(resolve, 200));
        } catch (e) {
            errored = true;
        }
        if (!errored) {
            console.log('  ✅ 老聊天没 mcpToolLogs 也不报错');
            pass++;
        } else {
            console.log('  ❌ 老聊天报错');
            fail++;
        }
        global.state.activeChatId = oldActive;
    }

    // 15. 实时 onCard summary 正确 (amount 优先于 orderId — v0.1.63 numberKeys 顺序)
    console.log(`\n========== 15. 实时 onCard summary 正确 ==========`);
    {
        const chat = global.state.chats['chat-1'];
        if (!chat.mcpToolLogs) chat.mcpToolLogs = [];
        setupBubble();
        await new Promise(resolve => {
            _cardListener({
                toolName: 'query-store-coupons',
                result: { success: true, data: { orderId: 'MCD999', amount: 45.5 } },
                ts: 2000000,
            });
            setTimeout(() => {
                const entry = chat.mcpToolLogs[chat.mcpToolLogs.length - 1];
                if (entry.toolName === 'query-store-coupons' && entry.summary === '¥45.5' && entry.success === true) {
                    console.log('  ✅ 实时 entry 字段/summary/success 都对');
                    pass++;
                } else {
                    console.log('  ❌ 实时 entry 错: ' + JSON.stringify(entry));
                    fail++;
                }
                resolve();
            }, 30);
        });
    }

    // 16. 纯 status 字段 → "状态: xxx" summary
    console.log(`\n========== 16. 纯 status → "状态: xxx" summary ==========`);
    {
        const chat = global.state.chats['chat-1'];
        if (!chat.mcpToolLogs) chat.mcpToolLogs = [];
        setupBubble();
        await new Promise(resolve => {
            _cardListener({
                toolName: 'query-order',
                result: { success: true, data: { status: 'paid' } },
                ts: 3000000,
            });
            setTimeout(() => {
                const entry = chat.mcpToolLogs[chat.mcpToolLogs.length - 1];
                if (entry.toolName === 'query-order' && entry.summary === '状态: paid' && entry.success === true) {
                    console.log('  ✅ 纯 status → "状态: paid"');
                    pass++;
                } else {
                    console.log('  ❌ 期望 "状态: paid", 实际: ' + entry.summary);
                    fail++;
                }
                resolve();
            }, 30);
        });
    }

    console.log(`\n========== 总结 ==========`);
    console.log(`通过 ${pass}, 失败 ${fail}`);
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('❌ 主流程异常:', e); process.exit(1); });
