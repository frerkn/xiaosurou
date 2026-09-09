// 端到端验证: mcp-pay-card.js extractPayInfo 解析 3 种 create-order 数据
// (麦当劳 / 瑞幸 / 通用) + renderPayCard 渲染 HTML 验证

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// 加载 mcp-pay-card.js
const code = readFileSync(resolve(PROJECT_ROOT, 'js/mcp-pay-card.js'), 'utf8');

// ========== mock DOM minimal ==========
const _elements = new Map();
class MockElement {
    constructor(tag) {
        this.tag = tag;
        this.attrs = {};
        this.children = [];
        this.parent = null;
        this.className = '';
        this._innerHTML = '';
    }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    set className(v) { this.attrs.class = v; }
    get className() { return this.attrs.class || ''; }
    get nextSibling() { return null; }
    get parentNode() { return this.parent; }
    set innerHTML(html) {
        this._innerHTML = html;
        // 解析 onclick="..." 等
        const onclick = /onerror="([^"]+)"/.exec(html);
        if (onclick) this.attrs._onerror = onclick[1];
    }
    get innerHTML() { return this._innerHTML; }
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
        // 简化: 找带 .message-wrapper class 的祖先
        let cur = this;
        while (cur) {
            if (cur.attrs && cur.attrs.class && cur.attrs.class.indexOf(selector.replace('.', '')) >= 0) {
                return cur;
            }
            cur = cur.parent;
        }
        return null;
    }
}

const _mockDoc = {
    _all: [],
    createElement(tag) {
        const el = new MockElement(tag);
        this._all.push(el);
        return el;
    },
    querySelectorAll(selector) {
        // 简化: 找 .message-bubble
        if (selector === '.message-bubble[data-timestamp]') {
            return this._all.filter(e => e.attrs && e.attrs.class && e.attrs.class.indexOf('message-bubble') >= 0);
        }
        return [];
    },
    querySelector(selector) {
        const all = this.querySelectorAll(selector);
        return all.length ? all[0] : null;
    },
    body: new MockElement('body'),
};

// 把 mock document 注入到 global (不要 mock window — 会让 IIFE 拿到 mock window 而非 globalThis, 错过 global.McpBridge)
global.document = _mockDoc;
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

// McpBridge mock
let _cardListener = null;
global.McpBridge = {
    onCard: (fn) => { _cardListener = fn; },
};

// 加载并执行
console.log('[debug] before load: global.McpBridge =', !!global.McpBridge, typeof global.McpBridge?.onCard);
console.log('[debug] typeof window =', typeof window, 'typeof globalThis =', typeof globalThis);
new Function('globalThis', code)(globalThis);
console.log('[debug] after load: _cardListener =', typeof _cardListener, _cardListener);

if (!_cardListener) {
    console.error('❌ mcp-pay-card.js 没注册 card listener');
    process.exit(1);
}
console.log('✅ mcp-pay-card.js 加载成功, onCard 已注册');

// ========== 拿到 onCard 内部函数 (通过 console.log 间接验证) ==========
// 我们没暴露 extractPayInfo, 但可以通过传 card 让 onCard 走完, 看 console.log 输出

// ========== 端到端测试 ==========
let pass = 0, fail = 0;

function testCase(label, toolName, result, expectedFields, shouldRender) {
    console.log(`\n========== ${label} ==========`);
    console.log(`工具: ${toolName}, success=${result.success}, data keys: ${Object.keys(result.data || {}).join(', ')}`);

    // 清空 mock DOM (避免上一个 case 残留)
    _mockDoc._all.length = 0;

    // mock 一些 message-bubble 在 DOM 里 (模拟"最后一条 AI 消息")
    const wrapper = new MockElement('div');
    wrapper.attrs = { class: 'message-wrapper' };
    const bubble = new MockElement('div');
    bubble.attrs = { class: 'message-bubble', 'data-timestamp': '12345' };
    bubble.parent = wrapper;
    wrapper.children = [bubble];
    _mockDoc._all.push(wrapper);
    _mockDoc._all.push(bubble);

    try {
        _cardListener({ toolName, result, serverName: 'test' });
        // 等一帧
        return new Promise(resolve => {
            setTimeout(() => {
                // 看 _mockDoc._all 里有没有新加的 mcp-pay-card
                const payCards = _mockDoc._all.filter(e => e.attrs && e.attrs.class && e.attrs.class.indexOf('mcp-pay-card') >= 0);
                if (!shouldRender) {
                    if (payCards.length === 0) {
                        console.log('  ✅ pass: 正确不渲染');
                        pass++;
                    } else {
                        console.log('  ❌ fail: 不该渲染但渲染了 ' + payCards.length + ' 个');
                        fail++;
                    }
                    resolve();
                    return;
                }
                if (payCards.length === 0) {
                    console.log('  ❌ fail: 没找到 mcp-pay-card DOM');
                    fail++;
                    resolve();
                    return;
                }
                const card = payCards[payCards.length - 1];
                const html = card._innerHTML;
                console.log('  → 找到 mcp-pay-card, type=' + card.attrs['data-pay-type']);
                // 验证 expectedFields
                let ok = true;
                for (const field of expectedFields) {
                    if (html.indexOf(field) < 0) {
                        console.log(`  ❌ 缺字段: ${field}`);
                        ok = false;
                    }
                }
                // 验证插到了 wrapper 后面
                if (card.parent === wrapper.parent) {
                    console.log('  ✅ 插入位置正确 (wrapper 后面)');
                } else if (card.parent) {
                    console.log('  ✅ 插入位置 (parent tag: ' + card.parent.tag + ')');
                }
                if (ok) {
                    console.log('  ✅ pass');
                    pass++;
                } else {
                    console.log('  ❌ fail: 渲染 HTML 缺字段');
                    console.log('  HTML 预览: ' + html.slice(0, 400));
                    fail++;
                }
                resolve();
            }, 50);
        });
    } catch (e) {
        console.log('  ❌ 异常: ' + e.message);
        fail++;
        return Promise.resolve();
    }
}

async function main() {
    // 1. 麦当劳 create-order
    await testCase(
        '1. 麦当劳 create-order (payUrl)',
        'create-order',
        {
            success: true,
            data: {
                payUrl: 'https://pay.mcd.cn/order/12345',
                orderId: 'MCD20260802001234',
                amount: 86.5,
            },
        },
        ['点此打开支付', 'MCD20260802001234', '86.5', '麦当劳'],
        true
    );

    // 2. 瑞幸 createOrder (payOrderUrl + payOrderQrCodeUrl)
    await testCase(
        '2. 瑞幸 createOrder (payOrderUrl + qrCode)',
        'createOrder',
        {
            success: true,
            data: {
                payOrderUrl: 'https://pay.lkcoffee.com/order/67890',
                payOrderQrCodeUrl: 'https://qr.lkcoffee.com/img/67890.png',
                orderId: 'LK20260802005678',
                realAmount: 32.0,
            },
        },
        ['点此打开支付', 'LK20260802005678', '32', '瑞幸', '用微信', 'mcp-pay-qr'],
        true
    );

    // 3. 通用 mall-create-order
    await testCase(
        '3. 积分商城 mall-create-order (无二维码)',
        'mall-create-order',
        {
            success: true,
            data: {
                mallUrl: 'https://mall.mcd.cn/exchange/12345',
                prizeRecordId: 'PRIZE12345',
            },
        },
        ['点此打开支付', 'PRIZE12345', '积分商城'],
        true
    );

    // 4. 失败的不渲染
    await testCase(
        '4. 失败订单 (不渲染)',
        'create-order',
        { success: false, error: '门店已关闭' },
        [],
        false
    );

    // 5. 没 url 字段的不渲染
    await testCase(
        '5. 成功但没 url (不渲染)',
        'create-order',
        { success: true, data: { orderId: 'X123' } },
        [],
        false
    );

    console.log(`\n========== 总结 ==========`);
    console.log(`通过 ${pass}, 失败 ${fail}`);
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('❌ 主流程异常:', e); process.exit(1); });
