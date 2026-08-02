// 端到端验证: FAB 长按 1.5s 关闭
// 测试: 长按完成 → 关闭, 早松手 → 取消, 滑动 → 取消, PC mousedown/mouseup 同样 work

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const code = readFileSync(resolve(PROJECT_ROOT, 'js/mcp-menu-card.js'), 'utf8');

// ========== mock DOM minimal ==========
class MockElement {
    constructor(tag) {
        this.tag = tag;
        this.attrs = {};
        this.children = [];
        this.parent = null;
        this.classList = {
            _set: new Set(),
            add: (c) => MockElement.s(this, c, true),
            remove: (c) => MockElement.s(this, c, false),
            contains: (c) => MockElement.h(this, c),
        };
        this._listeners = {};
    }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    set id(v) { this.attrs.id = v; }
    get id() { return this.attrs.id || ''; }
    set style(v) { this.attrs.style = v; }
    get style() {
        const self = this;
        return {
            set display(val) { self.attrs.display = val; },
            get display() { return self.attrs.display; }
        };
    }
    set className(v) {
        if (this.classList) this.classList._set.clear();
        if (this.classList && v) v.split(/\s+/).forEach(c => this.classList._set.add(c));
        this.attrs.class = v;
    }
    get className() { return this.classList ? Array.from(this.classList._set).join(' ') : ''; }
    get nextSibling() { return null; }
    get parentNode() { return this.parent; }
    set innerHTML(html) {
        this._innerHTML = html;
        // 模拟 createElement('span') 等内部元素
        const spanMatch = /<span[^>]*class="([^"]+)"/.exec(html);
        if (spanMatch) {
            const inner = new MockElement('span');
            inner.attrs.class = spanMatch[1];
            this._badge = inner;
        }
    }
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
    addEventListener(type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
    }
    dispatchEvent(evt) {
        // 给 event 对象加 preventDefault/stopPropagation
        if (typeof evt.preventDefault !== 'function') {
            evt.preventDefault = function () { evt._prevented = true; };
            evt.stopPropagation = function () { evt._stopped = true; };
        }
        const listeners = this._listeners[evt.type] || [];
        for (let i = 0; i < listeners.length; i++) {
            listeners[i].call(this, evt);
        }
    }
    querySelector(sel) {
        if (sel === '.mcp-menu-fab-badge') return this._badge || null;
        return null;
    }
    closest() { return this; }
}
MockElement.s = (el, c, add) => {
    if (!el.classList) el.classList = { _set: new Set(), add() {}, remove() {}, contains: () => false };
    if (add) el.classList._set.add(c); else el.classList._set.delete(c);
};
MockElement.h = (el, c) => el.classList && el.classList._set && el.classList._set.has(c);

const _mockDoc = {
    _all: [],
    createElement(tag) {
        const el = new MockElement(tag);
        this._all.push(el);
        return el;
    },
    getElementById(id) { return this._all.find(e => e.attrs && e.attrs.id === id) || null; },
    body: new MockElement('body'),
    addEventListener() {},
};

global.document = _mockDoc;
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;

// 加载 mcp-menu-card.js
// (McpBridge 需要先 mock 才能挂 onCard 监听, 但 mcp-menu-card.js 还要调 McpBridge.onCard)
let _cardListener = null;
global.McpBridge = { onCard: (fn) => { _cardListener = fn; } };
global.McpGenericClient = { onCard: () => {}, onProgress: () => {} };

new Function('globalThis', code)(globalThis);

if (!_cardListener) {
    console.error('❌ mcp-menu-card.js 没注册 card listener');
    process.exit(1);
}
console.log('✅ mcp-menu-card.js 加载成功');

// 触发 showFab: 模拟 card 监听器拿到一个 menu card (用 mcd 真实结构)
_cardListener({
    toolName: 'query-meals',
    result: {
        success: true,
        data: {
            categories: [{ name: '汉堡', meals: [{ code: 'M001' }, { code: 'M002' }] }],
            meals: {
                'M001': { name: '麦辣鸡腿堡', currentPrice: '25' },
                'M002': { name: '巨无霸', currentPrice: '30' }
            }
        }
    },
    serverName: 'test',
    ts: Date.now(),
});

// 等一帧让 showFab 执行
setTimeout(() => {
    const fab = _mockDoc.getElementById('mcp-menu-fab');
    if (!fab) {
        console.error('❌ FAB 没创建, _all 里的元素:');
        for (const e of _mockDoc._all) {
            console.log('  -', e.tag, e.attrs);
        }
        process.exit(1);
    }
    console.log('✅ FAB 已创建, initial state: visible=' + fab.classList.contains('is-visible'));

    let pass = 0, fail = 0;

    function reset() {
        // 重置 FAB visible 状态, 清掉长按状态
        fab.classList.add('is-visible');
        fab.classList.remove('is-longpressing', 'is-longpress-done');
    }

    function checkAfter(label, expectedClosed, callback) {
        return new Promise(resolve => {
            reset();
            callback();
            // 长按是 1500ms, 等 2000ms 让 setTimeout 触发完
            setTimeout(() => {
                const closed = !fab.classList.contains('is-visible');
                if (closed === expectedClosed) {
                    console.log('  ✅ pass: ' + label);
                    pass++;
                } else {
                    console.log('  ❌ fail: ' + label + ' (expected closed=' + expectedClosed + ', actual=' + closed + ')');
                    fail++;
                }
                resolve();
            }, 1800);
        });
    }

    async function main() {
        // 1. touch 长按 1.5s → 关闭
        console.log('\n========== 1. touch 长按 1.5s → 关闭 ==========');
        await checkAfter('touchstart + 1.8s 后 touchend → 关闭', true, () => {
            fab.dispatchEvent({ type: 'touchstart', touches: [{ clientX: 100, clientY: 100 }] });
            setTimeout(() => fab.dispatchEvent({ type: 'touchend', changedTouches: [{ clientX: 100, clientY: 100 }] }), 1700);
        });

        // 2. touch 早松手 (0.5s) → 取消
        console.log('\n========== 2. touch 早松手 (0.5s) → 取消 ==========');
        await checkAfter('touchstart + 0.5s 后 touchend → 不关', false, () => {
            fab.dispatchEvent({ type: 'touchstart', touches: [{ clientX: 100, clientY: 100 }] });
            setTimeout(() => fab.dispatchEvent({ type: 'touchend', changedTouches: [{ clientX: 100, clientY: 100 }] }), 500);
        });

        // 3. touch 滑动 15px → 取消
        console.log('\n========== 3. touch 滑动 15px → 取消 ==========');
        await checkAfter('touchstart + 移动 15px + touchend → 不关', false, () => {
            fab.dispatchEvent({ type: 'touchstart', touches: [{ clientX: 100, clientY: 100 }] });
            setTimeout(() => fab.dispatchEvent({ type: 'touchend', changedTouches: [{ clientX: 115, clientY: 100 }] }), 500);
        });

        // 4. PC mousedown 1.5s + mouseup → 关闭
        console.log('\n========== 4. PC mousedown 1.5s + mouseup → 关闭 ==========');
        await checkAfter('mousedown + 1.7s 后 mouseup → 关闭', true, () => {
            fab.dispatchEvent({ type: 'mousedown' });
            setTimeout(() => fab.dispatchEvent({ type: 'mouseup' }), 1700);
        });

        // 5. 短按 (0.3s) + mouseup → 不关 (短按应该开 sheet, 不是长按)
        console.log('\n========== 5. 短按 0.3s → 不关 ==========');
        await checkAfter('mousedown + 0.3s 后 mouseup → 不关', false, () => {
            fab.dispatchEvent({ type: 'mousedown' });
            setTimeout(() => fab.dispatchEvent({ type: 'mouseup' }), 300);
        });

        // 6. mousedown 然后 mouseleave (拖出) → 取消
        console.log('\n========== 6. mouseleave → 取消 ==========');
        await checkAfter('mousedown + 0.5s 后 mouseleave → 不关', false, () => {
            fab.dispatchEvent({ type: 'mousedown' });
            setTimeout(() => fab.dispatchEvent({ type: 'mouseleave' }), 500);
        });

        console.log('\n========== 总结 ==========');
        console.log('通过 ' + pass + ', 失败 ' + fail);
        process.exit(fail > 0 ? 1 : 0);
    }

    main();
}, 100);
