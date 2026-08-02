/* ====================================================================
 * MCP 菜单卡片渲染 — 粉白色系浮动按钮 + 全屏 sheet
 *
 * 依赖:
 *   - window.McpBridge (mcp-tool-bridge.js 加载)
 *   - mcp-miniapp-pink.css (本文件对应样式)
 *
 * 触发: 注册 McpBridge.onCard 监听器, 识别 menu 类工具调用, 累积数据
 * 设计:
 *   - 浮动按钮 (右下, FAB 风) 显示"已拉取 N 项菜单"标记
 *   - 点击 → 全屏底部 sheet (iOS share sheet 风) 展示分类 + 餐品卡片
 *   - 粉白色系, 不动 chat UI, 跟 330 已有 #floating-ball (z-index:9999) 共存
 *
 * 支持的菜单工具:
 *   - query-meals                       麦当劳
 *   - searchProduct / switchProduct / queryProductDetail  瑞幸
 *   - 任何返回 meals/products/categories 字段的工具 (通用兜底)
 * ==================================================================== */

(function (global) {
    'use strict';

    if (!global.McpBridge) {
        console.warn('[McpMenuCard] McpBridge not loaded, skip init');
        return;
    }

    // ========== 常量 ==========

    const FAB_ICON = '📋';
    const SERVER_ICON = {
        '麦当劳': '🍔',
        '瑞幸': '☕',
        '瑞幸咖啡': '☕',
    };
    const MENU_TOOL_PATTERNS = [
        // 麦当劳
        /^query[-_]?meals?$/i,
        // 瑞幸 (注意: 工具名带后缀, 不是 searchProduct 而是 searchProductForMcp)
        /^searchProductForMcp$/i,
        /^queryProductDetailInfo$/i,
        /^switchProduct$/i,
        // 通用兜底 (有 schema 也不一定真用, 留作扩展)
        /^listProducts?$/i,
        /^listMeals?$/i,
    ];

    // ========== 全局状态 ==========

    let latestMenu = null; // { serverName, toolName, categories: [{name, items: [...]}] }

    // ========== 工具函数 ==========

    function getServerIcon(name) {
        if (!name) return '🍽️';
        for (const k in SERVER_ICON) {
            if (name.indexOf(k) >= 0) return SERVER_ICON[k];
        }
        return '🍽️';
    }

    function isMenuTool(toolName) {
        if (!toolName) return false;
        return MENU_TOOL_PATTERNS.some(function (re) { return re.test(toolName); });
    }

    // 从 result.content[0].text 里挖 JSON (跟糯米机 mcdMcpClient 同思路, 简化版)
    function extractJsonFromText(text) {
        if (!text || typeof text !== 'string') return null;
        try { return JSON.parse(text); } catch (e) {}
        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) {
            try { return JSON.parse(fence[1].trim()); } catch (e) {}
        }
        let best = null;
        let bestLen = 0;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch !== '{' && ch !== '[') continue;
            const close = ch === '{' ? '}' : ']';
            let depth = 0, inStr = false, esc = false;
            for (let j = i; j < text.length; j++) {
                const c = text[j];
                if (esc) { esc = false; continue; }
                if (c === '\\') { esc = true; continue; }
                if (c === '"') { inStr = !inStr; continue; }
                if (inStr) continue;
                if (c === ch) depth++;
                else if (c === close) {
                    depth--;
                    if (depth === 0) {
                        const slice = text.slice(i, j + 1);
                        try {
                            const obj = JSON.parse(slice);
                            if (slice.length > bestLen) { best = obj; bestLen = slice.length; }
                        } catch (e) {}
                        break;
                    }
                }
            }
        }
        return best;
    }

    function parseMcpResult(card) {
        const result = card && card.result;
        if (!result) return null;
        if (result.isError) return null;
        // 路径 1: MCP 协议原生 (result.content[].text 里有 JSON, 走 brace match 抽)
        if (Array.isArray(result.content) && result.content[0] && result.content[0].text) {
            return extractJsonFromText(result.content[0].text);
        }
        // 路径 2: McpGenericClient.callTool 已解析过, 包成 {success, data, rawText}
        //         这里要剥掉外层包装, 只拿真正的 data (mcd.cn 的 {success,code,data:{categories,meals}})
        if (result.data != null) return result.data;
        // 路径 3: 直接 data 字段 (兼容老格式)
        if (result.categories || result.meals || result.products) return result;
        return null;
    }

    // 麦当劳 query-meals: data.categories[].meals[].code + data.meals[code] = {name, image, currentPrice, ...}
    function parseMcdMeals(json) {
        const data = (json && json.data) || json || {};
        const categories = Array.isArray(data.categories) ? data.categories : [];
        const mealsMap = data.meals || {};
        const out = [];
        for (const cat of categories) {
            const items = [];
            const codes = Array.isArray(cat.meals) ? cat.meals : [];
            for (const ref of codes) {
                const code = ref && ref.code;
                if (!code) continue;
                const detail = mealsMap[code] || {};
                items.push({
                    code: code,
                    name: detail.name || ref.name || code,
                    image: detail.image || '',
                    currentPrice: detail.currentPrice || '',
                    originalPrice: detail.originalPrice || '',
                    tags: Array.isArray(detail.tags) ? detail.tags : (Array.isArray(ref.tags) ? ref.tags : []),
                });
            }
            if (items.length) out.push({ name: cat.name || '其他', items: items });
        }
        return out;
    }

    // 通用兜底: products[] / items[] / 顶层数组
    function parseGenericMenu(json) {
        const data = json && (json.data || json.result || json);
        if (!data) return [];
        const products = Array.isArray(data.products) ? data.products
                       : Array.isArray(data.items) ? data.items
                       : Array.isArray(data) ? data
                       : [];
        if (!products.length) return [];
        const byCat = {};
        for (const p of products) {
            const catName = p.categoryName || p.category || p.catName || '全部';
            if (!byCat[catName]) byCat[catName] = [];
            byCat[catName].push({
                code: p.productId || p.code || p.id || '',
                name: p.name || p.productName || '',
                image: p.image || p.imageUrl || '',
                currentPrice: p.price || p.currentPrice || '',
                originalPrice: p.originalPrice || '',
                tags: Array.isArray(p.tags) ? p.tags : [],
            });
        }
        return Object.keys(byCat).map(function (k) { return { name: k, items: byCat[k] }; });
    }

    // 瑞幸 searchProductForMcp / queryProductDetailInfo / switchProduct
    // 返 {code, msg, data, success}, data 是商品数组 (扁平, 没分类)
    // 每项: {productId, productName, skuCode, pictureUrl, productAttrs[], tags[], initialPrice, estimatePrice}
    // 注意: 瑞幸没"全量菜单"工具, 只能 searchProductForMcp(query="关键词") 拿相关商品
    function parseLuckinMenu(json) {
        const data = (json && (json.data || json.result || json));
        if (!data) return [];
        const products = Array.isArray(data) ? data
                       : Array.isArray(data.products) ? data.products
                       : Array.isArray(data.items) ? data.items
                       : [];
        if (!products.length) return [];
        const items = products.map(function (p) {
            // 属性折叠成可读字符串 (杯型/温度/糖度/奶油...)
            const attrText = Array.isArray(p.productAttrs)
                ? p.productAttrs.map(function (a) {
                    const sub = Array.isArray(a.productSubAttrs)
                        ? a.productSubAttrs.map(function (s) { return s.attributeName; }).join('/')
                        : '';
                    return a.attributeName + ': ' + (sub || '默认');
                }).join(' · ')
                : '';
            return {
                code: String(p.productId || p.skuCode || ''),
                name: p.productName || p.name || '未命名',
                image: p.pictureUrl || p.image || '',
                currentPrice: p.estimatePrice != null ? String(p.estimatePrice) : (p.currentPrice || ''),
                originalPrice: p.initialPrice != null ? String(p.initialPrice) : (p.originalPrice || ''),
                tags: Array.isArray(p.tags) ? p.tags : [],
                attrs: attrText,
            };
        });
        // 瑞幸没分类, 包成单分类 (用 query 文本或 "商品推荐")
        return [{ name: '商品推荐', items: items }];
    }

    function parseMenu(card) {
        const json = parseMcpResult(card);
        if (!json) return [];
        const toolName = (card.toolName || '').toLowerCase();
        if (toolName === 'query-meals' || toolName === 'query_meals') {
            return parseMcdMeals(json);
        }
        if (toolName === 'searchproductformcp' || toolName === 'queryproductdetailinfo' || toolName === 'switchproduct') {
            return parseLuckinMenu(json);
        }
        return parseGenericMenu(json);
    }

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ========== 渲染 ==========

    // ========== 长按关闭 FAB (1.5s 持续按, 松手太早取消) ==========
    const LONGPRESS_MS = 1500;
    let longpressTimer = null;
    let longpressTriggered = false;
    let longpressStartX = 0;
    let longpressStartY = 0;

    function onLongPressStart(e) {
        const fab = document.getElementById('mcp-menu-fab');
        if (!fab) return;
        // 阻止浏览器长按系统菜单 (iOS 长按 0.5s 就弹, 必加)
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        longpressTriggered = false;
        const pt = e.touches ? e.touches[0] : e;
        longpressStartX = pt.clientX || 0;
        longpressStartY = pt.clientY || 0;
        fab.classList.add('is-longpressing');
        longpressTimer = setTimeout(function () {
            longpressTriggered = true;
            fab.classList.remove('is-longpressing');
            fab.classList.add('is-longpress-done');
            // 触发关闭 (0.2s 后淡出, 让动画跑完)
            setTimeout(function () { hideFab(); }, 200);
        }, LONGPRESS_MS);
    }

    function onLongPressEnd(e) {
        const fab = document.getElementById('mcp-menu-fab');
        if (!fab) return;
        // 移动超过 10px 算滑动, 取消
        if (e.changedTouches && e.changedTouches[0]) {
            const dx = (e.changedTouches[0].clientX || 0) - longpressStartX;
            const dy = (e.changedTouches[0].clientY || 0) - longpressStartY;
            if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
                clearTimeout(longpressTimer);
                fab.classList.remove('is-longpressing');
                return;
            }
        }
        if (longpressTriggered) {
            // 长按完成触发了关闭, 不开 sheet
            setTimeout(function () { fab.classList.remove('is-longpress-done'); }, 600);
            return;
        }
        // 短按: 因为 touchstart preventDefault 阻止了 click, 这里手动开 sheet
        clearTimeout(longpressTimer);
        fab.classList.remove('is-longpressing');
        openSheet();
    }

    function onLongPressCancel() {
        const fab = document.getElementById('mcp-menu-fab');
        if (!fab) return;
        clearTimeout(longpressTimer);
        fab.classList.remove('is-longpressing');
    }

    function ensureFab() {
        let fab = document.getElementById('mcp-menu-fab');
        if (fab) return fab;
        fab = document.createElement('button');
        fab.id = 'mcp-menu-fab';
        fab.className = 'mcp-menu-fab';
        fab.setAttribute('aria-label', '查看菜单 (长按可关闭)');
        fab.innerHTML = FAB_ICON + '<span class="mcp-menu-fab-badge" style="display:none;">0</span>';
        document.body.appendChild(fab);
        // 长按检测: touch (mobile) + mouse (PC 调试) 自己控制开关, 不依赖原生 click
        // (避免 touchstart preventDefault 阻止 click 事件, 也避免 PC 短按双触发)
        fab.addEventListener('touchstart', onLongPressStart, { passive: false });
        fab.addEventListener('touchend', onLongPressEnd);
        fab.addEventListener('touchcancel', onLongPressCancel);
        fab.addEventListener('mousedown', onLongPressStart);
        fab.addEventListener('mouseup', onLongPressEnd);
        fab.addEventListener('mouseleave', onLongPressCancel);
        return fab;
    }

    function showFab(totalCount) {
        const fab = ensureFab();
        const badge = fab.querySelector('.mcp-menu-fab-badge');
        if (badge) {
            badge.textContent = totalCount > 99 ? '99+' : String(totalCount);
            badge.style.display = totalCount > 0 ? '' : 'none';
        }
        fab.classList.add('is-visible');
    }

    function hideFab() {
        const fab = document.getElementById('mcp-menu-fab');
        if (fab) fab.classList.remove('is-visible');
    }

    function ensureSheet() {
        let sheet = document.getElementById('mcp-menu-sheet');
        if (sheet) return sheet;
        sheet = document.createElement('div');
        sheet.id = 'mcp-menu-sheet';
        sheet.className = 'mcp-menu-sheet';
        sheet.innerHTML = '<div class="mcp-menu-sheet-card" data-role="card">' +
            '<div class="mcp-menu-sheet-header">' +
                '<h3 class="mcp-menu-sheet-title" data-role="title">菜单</h3>' +
                '<p class="mcp-menu-sheet-subtitle" data-role="subtitle"></p>' +
                '<button class="mcp-menu-sheet-close" data-role="close" aria-label="关闭">×</button>' +
            '</div>' +
            '<div class="mcp-menu-cats" data-role="cats"></div>' +
            '<div class="mcp-menu-body" data-role="body"></div>' +
        '</div>';
        document.body.appendChild(sheet);
        sheet.addEventListener('click', function (e) {
            if (e.target === sheet) closeSheet();
        });
        sheet.querySelector('[data-role="close"]').addEventListener('click', closeSheet);
        return sheet;
    }

    function openSheet() {
        if (!latestMenu || !latestMenu.categories.length) return;
        const sheet = ensureSheet();
        const titleEl = sheet.querySelector('[data-role="title"]');
        const subEl = sheet.querySelector('[data-role="subtitle"]');
        const catsEl = sheet.querySelector('[data-role="cats"]');
        const bodyEl = sheet.querySelector('[data-role="body"]');
        const totalItems = latestMenu.categories.reduce(function (s, c) { return s + c.items.length; }, 0);
        titleEl.innerHTML = getServerIcon(latestMenu.serverName) + ' ' + escapeHtml(latestMenu.serverName || '菜单');
        subEl.textContent = '共 ' + latestMenu.categories.length + ' 个分类 · ' + totalItems + ' 个餐品';

        catsEl.innerHTML = latestMenu.categories.map(function (c, i) {
            return '<span class="mcp-menu-cat-chip" data-cat-idx="' + i + '">' + escapeHtml(c.name) + ' (' + c.items.length + ')</span>';
        }).join('');
        catsEl.querySelectorAll('.mcp-menu-cat-chip').forEach(function (chip) {
            chip.addEventListener('click', function () {
                const idx = parseInt(chip.getAttribute('data-cat-idx'), 10);
                scrollToCategory(idx);
                catsEl.querySelectorAll('.mcp-menu-cat-chip').forEach(function (c) { c.classList.remove('is-active'); });
                chip.classList.add('is-active');
            });
        });

        bodyEl.innerHTML = latestMenu.categories.map(function (cat, idx) {
            const itemsHtml = cat.items.map(function (it) {
                const tagsHtml = (it.tags || []).slice(0, 3).map(function (t) {
                    return '<span class="mcp-menu-item-tag">' + escapeHtml(t) + '</span>';
                }).join('');
                const imgHtml = it.image
                    ? '<img src="' + escapeHtml(it.image) + '" loading="lazy" onerror="this.parentNode.textContent=\'🍽️\'">'
                    : '🍽️';
                const priceHtml = it.currentPrice
                    ? '<span class="mcp-menu-item-price">¥' + escapeHtml(it.currentPrice) + '</span>'
                    : '';
                const origHtml = it.originalPrice && it.originalPrice !== it.currentPrice
                    ? '<span class="mcp-menu-item-price-original">¥' + escapeHtml(it.originalPrice) + '</span>'
                    : '';
                return '<div class="mcp-menu-item">' +
                    '<div class="mcp-menu-item-img">' + imgHtml + '</div>' +
                    '<div class="mcp-menu-item-info">' +
                        '<div class="mcp-menu-item-name">' + escapeHtml(it.name) + '</div>' +
                        (tagsHtml ? '<div class="mcp-menu-item-tags">' + tagsHtml + '</div>' : '') +
                        (it.attrs ? '<div class="mcp-menu-item-attrs" style="font-size:11px;color:#9CA3AF;line-height:1.5;margin-top:2px;">' + escapeHtml(it.attrs) + '</div>' : '') +
                        '<div>' + priceHtml + origHtml + '</div>' +
                    '</div>' +
                '</div>';
            }).join('');
            return '<div class="mcp-menu-cat-section" data-cat-idx="' + idx + '">' +
                '<div class="mcp-menu-cat-name">' + escapeHtml(cat.name) + ' · ' + cat.items.length + '</div>' +
                itemsHtml +
            '</div>';
        }).join('');

        sheet.classList.add('is-open');
    }

    function closeSheet() {
        const sheet = document.getElementById('mcp-menu-sheet');
        if (sheet) sheet.classList.remove('is-open');
    }

    function scrollToCategory(idx) {
        const sheet = document.getElementById('mcp-menu-sheet');
        if (!sheet) return;
        const sec = sheet.querySelector('[data-cat-idx="' + idx + '"].mcp-menu-cat-section');
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ========== Card Listener ==========

    function onCard(card) {
        if (!card || !isMenuTool(card.toolName)) return;
        try {
            const result = card && card.result;
            const rSummary = result ? {
                success: result.success,
                isError: result.isError,
                hasContent: Array.isArray(result.content),
                hasData: result.data != null,
                dataType: result.data == null ? 'null' : (Array.isArray(result.data) ? 'array' : typeof result.data),
                dataKeys: result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? Object.keys(result.data) : null,
            } : 'no result';
            console.log('[McpMenuCard] 收到 card, tool=' + card.toolName + ', result shape:', rSummary);
            const categories = parseMenu(card);
            if (!categories.length) {
                console.log('[McpMenuCard] 工具', card.toolName, '没解析出菜单数据, rawText 前 200:', (result && result.rawText || '').slice(0, 200));
                return;
            }
            latestMenu = {
                serverName: card.serverName || '菜单',
                toolName: card.toolName,
                categories: categories,
                ts: card.ts || Date.now(),
            };
            const total = categories.reduce(function (s, c) { return s + c.items.length; }, 0);
            showFab(total);
            console.log('[McpMenuCard] 收到菜单:', card.serverName, '·', categories.length, '分类 ·', total, '项');
        } catch (e) {
            console.warn('[McpMenuCard] 解析失败:', e);
        }
    }

    // ========== 初始化 ==========

    global.McpBridge.onCard(onCard);
    console.log('[McpMenuCard] 已注册 card listener, 等工具调用触发菜单卡片');

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeSheet();
    });

})(typeof window !== 'undefined' ? window : this);
