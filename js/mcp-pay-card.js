// 麦当劳 / 瑞幸 / 积分商城 create-order 后的 inline 支付卡片
// 监听 McpBridge.onCard, 检测 create-order/createOrder/mall-create-order 的 result.data
// 提取支付链接 / 二维码, inline 渲染到最近一条 AI 消息气泡后面
// 不弹全屏, 不打断对话流, 跟 mcp-menu-card.js 一样紧跟 AI 消息
//
// 关键: AI 不要复述链接 / 解释二维码 / 复述订单内容 —— 那是系统渲染的, AI 自由发挥即可
//
// 数据契约 (实测):
//   麦当劳 create-order: result.data.payUrl (H5 支付链接) + result.data.orderId
//   瑞幸 createOrder:    result.data.payOrderUrl + result.data.payOrderQrCodeUrl (二维码图片) + result.data.orderId
//   mall-create-order:   result.data.prizeRecordId + (待补) — 暂只渲染 URL 字段, 没二维码

(function (global) {
    'use strict';

    // ========== 工具名匹配 ==========
    const PAY_TOOL_PATTERNS = [
        /^create[-_]?order$/i,           // 麦当劳 / 通用
        /^createOrder$/i,                // 瑞幸 (驼峰)
        /^mall[-_]?create[-_]?order$/i,  // 积分商城
    ];
    function isPayTool(toolName) {
        if (!toolName) return false;
        return PAY_TOOL_PATTERNS.some(function (re) { return re.test(toolName); });
    }

    // ========== 提取支付信息 ==========
    // 返 { type: 'mcd' | 'luckin' | 'mall' | null, url, qrUrl, orderId, amount }
    function extractPayInfo(result) {
        if (!result || !result.success) return null;
        const data = result.data;
        if (!data || typeof data !== 'object') return null;

        // 瑞幸: payOrderUrl + payOrderQrCodeUrl
        if (data.payOrderUrl || data.payOrderQrCodeUrl) {
            return {
                type: 'luckin',
                url: data.payOrderUrl || '',
                qrUrl: data.payOrderQrCodeUrl || '',
                orderId: data.orderId || data.orderNo || '',
                amount: data.amount || data.realAmount || data.totalAmount || '',
            };
        }
        // 麦当劳: payUrl (可能叫 payUrl 或 payOrderUrl, 都兼容)
        if (data.payUrl || data.payOrderUrl) {
            return {
                type: 'mcd',
                url: data.payUrl || data.payOrderUrl || '',
                qrUrl: '',
                orderId: data.orderId || data.orderNo || '',
                amount: data.amount || data.realAmount || data.totalAmount || '',
            };
        }
        // 通用: 任何 *Url / *url 字段
        const urlKeys = Object.keys(data).filter(function (k) { return /[Uu]rl$/.test(k); });
        if (urlKeys.length) {
            return {
                type: 'mall',
                url: data[urlKeys[0]] || '',
                qrUrl: '',
                orderId: data.orderId || data.orderNo || data.prizeRecordId || '',
                amount: data.amount || data.realAmount || data.totalAmount || '',
            };
        }
        return null;
    }

    // ========== 工具函数 ==========
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ========== inline 渲染 ==========
    function renderPayCard(payInfo) {
        const card = document.createElement('div');
        card.className = 'mcp-pay-card';
        card.setAttribute('data-pay-type', payInfo.type);

        // 类型小标 (瑞幸有二维码, 麦当劳只有链接, 商城看情况)
        const typeLabel = { mcd: '🍔 麦当劳', luckin: '☕ 瑞幸', mall: '🎁 积分商城' }[payInfo.type] || '💰';

        // 链接行 (始终显示)
        const linkHtml = payInfo.url
            ? '<a class="mcp-pay-link" href="' + escapeHtml(payInfo.url) + '" target="_blank" rel="noopener">' +
                  '<span class="mcp-pay-link-icon">🔗</span>' +
                  '<span class="mcp-pay-link-text">点此打开支付</span>' +
              '</a>'
            : '';

        // 二维码行 (只有瑞幸有, 其他暂时没)
        const qrHtml = payInfo.qrUrl
            ? '<div class="mcp-pay-qr-wrap">' +
                  '<img class="mcp-pay-qr" src="' + escapeHtml(payInfo.qrUrl) + '" alt="支付二维码" loading="lazy" ' +
                       'onerror="this.parentNode.innerHTML=\'<div class=&quot;mcp-pay-qr-fail&quot;>二维码加载失败, 请用上方链接</div>\'">' +
              '</div>' +
              '<div class="mcp-pay-qr-hint">用微信 / 支付宝扫这个码</div>'
            : '';

        // 订单号行 (可选, 有就显示)
        const orderHtml = payInfo.orderId
            ? '<div class="mcp-pay-orderid">订单号 ' + escapeHtml(payInfo.orderId) + '</div>'
            : '';

        // 金额行 (可选, 有就显示, 不是必须)
        const amountHtml = payInfo.amount
            ? '<div class="mcp-pay-amount">应付 ¥' + escapeHtml(String(payInfo.amount)) + '</div>'
            : '';

        card.innerHTML =
            '<div class="mcp-pay-head">' +
                '<span class="mcp-pay-icon">' + typeLabel + '</span>' +
                '<span class="mcp-pay-title">请完成支付</span>' +
            '</div>' +
            amountHtml +
            linkHtml +
            qrHtml +
            orderHtml;

        return card;
    }

    // ========== 找最近一条 AI 消息气泡, 紧跟其后插入卡片 ==========
    function appendAfterLastMessage(card) {
        // 优先找最近的 .message-bubble[data-timestamp]
        const bubbles = document.querySelectorAll('.message-bubble[data-timestamp]');
        if (bubbles.length === 0) {
            // 找不到, 兜底 append 到 .chat-area / body 末尾
            const chatArea = document.querySelector('.chat-area, .chat-messages, .messages') || document.body;
            chatArea.appendChild(card);
            console.warn('[McpPayCard] 找不到 .message-bubble, 兜底 append 到 chat-area / body');
            return;
        }
        const lastBubble = bubbles[bubbles.length - 1];
        const wrapper = lastBubble.closest('.message-wrapper') || lastBubble.parentNode;
        if (wrapper && wrapper.parentNode) {
            wrapper.parentNode.insertBefore(card, wrapper.nextSibling);
        } else {
            lastBubble.parentNode.insertBefore(card, lastBubble.nextSibling);
        }
        // 滚到底
        const scroller = document.querySelector('.chat-area, .chat-messages, .messages, .chat-scroll');
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }

    // ========== card 监听器 ==========
    function onCard(card) {
        if (!card || !isPayTool(card.toolName)) return;
        try {
            const result = card && card.result;
            const payInfo = extractPayInfo(result);
            if (!payInfo) {
                console.log('[McpPayCard] 工具', card.toolName, '没解析出支付信息 (没 url/qrUrl 字段), data keys:', result && result.data && Object.keys(result.data));
                return;
            }
            console.info('💰 [McpPayCard] 检测到支付 result, tool=' + card.toolName + ', type=' + payInfo.type + ', url=' + (payInfo.url ? 'yes' : 'no') + ', qr=' + (payInfo.qrUrl ? 'yes' : 'no'));
            // 延迟一帧再插, 等 AI 消息气泡 DOM 完成 (保险)
            const cardEl = renderPayCard(payInfo);
            requestAnimationFrame(function () { appendAfterLastMessage(cardEl); });
        } catch (e) {
            console.warn('[McpPayCard] 渲染失败:', e);
        }
    }

    // ========== 初始化 ==========
    if (global.McpBridge && typeof global.McpBridge.onCard === 'function') {
        global.McpBridge.onCard(onCard);
        console.log('[McpPayCard] 已注册 card listener, 等 create-order 触发支付卡片');
    } else {
        console.warn('[McpPayCard] McpBridge not loaded, skip init');
    }

})(typeof window !== 'undefined' ? window : globalThis);
