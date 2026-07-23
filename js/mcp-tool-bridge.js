/* ====================================================================
 * 外卖点单 · Tool Bridge（麦当劳 / 瑞幸 MCP 工具桥接）
 *
 * 跟糯米机的 useChatAI + mcdToolBridge + luckinToolBridge 等价（vanilla JS 版）
 * 不依赖 330 原 minified 代码：
 *   - 通过 window.fetch hook 拦截 /v1/chat/completions 请求
 *   - 当用户激活"点麦当劳"或"点瑞幸"时，在 request body 里塞 tools
 *   - 当 LLM 返回 tool_calls 时自动循环调 callTool，直至 finish_reason != 'tool_calls'
 *   - 把每次工具调用的结果写成一条 mcd_card / luckin_card 消息，**不**写回 LLM 上下文循环
 *     （普通文本回复才进 messages；卡片消息只渲染用于 UI）
 *
 * 暴露: window.McpBridge
 *   - activate(brand)   'mcd' | 'luckin' | null  ← 安装 / 卸载 hook
 *   - setHooksEnabled()  ← 让用户在工具栏按钮 click handler 里调用
 *
 * 依赖: McpMcdClient / McpLuckinClient / ChatStorage（用于推断消息上下文）
 * ==================================================================== */

(function (global) {
    'use strict';

    // ====== 商品名 → emoji 映射（照搬糯米机 mcdEmoji.ts + 瑞幸版） ======

    const MCD_EMOJI_RULES = [
        [/安格斯|牛肉/i, '🍔'],
        [/巨无霸|双层/i, '🍔'],
        [/麦辣|辣鸡|麦香/i, '🌶️'],
        [/麦乐鸡|鸡块/i, '🍗'],
        [/麦乐鸡块/i, '🍗'],
        [/鸡翅/i, '🍗'],
        [/薯条/i, '🍟'],
        [/麦旋风|圣代|圆筒|冰淇淋/i, '🍦'],
        [/奶昔|可乐|雪碧|芬达/i, '🥤'],
        [/咖啡|拿铁|摩卡|美式/i, '☕'],
        [/热朱|朱乐|橙汁/i, '🧃'],
        [/牛奶|豆浆/i, '🥛'],
        [/派|苹果|菠萝/i, '🥧'],
        [/蛋糕|圣代/i, '🍰'],
        [/沙拉/i, '🥗'],
        [/麦满分|早餐/i, '🍳'],
        [/油条/i, '🥖'],
        [/雪菜|花生/i, '🥜'],
        [/套餐|值到|全餐桶|超值/i, '🍱'],
    ];

    function mcdItemEmoji(name) {
        if (!name) return '🍽️';
        for (const [re, em] of MCD_EMOJI_RULES) if (re.test(name)) return em;
        return '🍽️';
    }

    const LUCKIN_EMOJI_RULES = [
        [/美式/i, '☕'],
        [/拿铁/i, '☕'],
        [/摩卡|卡布|馥芮/i, '☕'],
        [/澳瑞白/i, '☕'],
        [/生椰|椰云|椰乳/i, '🥥'],
        [/瑞纳/i, '🥛'],
        [/橙汁|柚子|柠檬/i, '🍋'],
        [/气泡|苏打/i, '🥤'],
        [/厚乳/i, '🥛'],
        [/茶/i, '🍵'],
        [/可可|巧克力/i, '🍫'],
    ];

    function luckinItemEmoji(name) {
        if (!name) return '☕';
        for (const [re, em] of LUCKIN_EMOJI_RULES) if (re.test(name)) return em;
        return '☕';
    }

    function itemEmoji(brand, name) {
        return brand === 'luckin' ? luckinItemEmoji(name) : mcdItemEmoji(name);
    }

    // ====== 触发词检测 ======

    const MCD_TRIGGERS_ON = ['点麦当劳', '叫麦当劳', '想买麦当劳', '麦麦', '来份麦当劳', '帮我点麦当劳', '点个麦当劳', '想点麦当劳'];
    const MCD_TRIGGERS_OFF = ['取消点麦当劳', '取消麦麦', '不要麦当劳', '不要麦麦', '退出麦当劳'];
    const LUCKIN_TRIGGERS_ON = ['点瑞幸', '叫瑞幸', '点luckin', 'luckin', '来杯瑞幸', '瑞幸一杯', '想点瑞幸', '点个瑞幸'];
    const LUCKIN_TRIGGERS_OFF = ['取消点瑞幸', '不要瑞幸', '退出瑞幸'];

    function findMcdActivation(userInput) {
        if (!userInput) return null;
        const t = (userInput || '').trim();
        if (!t) return null;
        for (const re of MCD_TRIGGERS_OFF) if (new RegExp(re).test(t)) return 'off';
        for (const re of MCD_TRIGGERS_ON) if (new RegExp(re).test(t)) return 'on';
        return null;
    }
    function findLuckinActivation(userInput) {
        if (!userInput) return null;
        const t = (userInput || '').trim();
        if (!t) return null;
        for (const re of LUCKIN_TRIGGERS_OFF) if (new RegExp(re).test(t)) return 'off';
        for (const re of LUCKIN_TRIGGERS_ON) if (new RegExp(re).test(t)) return 'on';
        return null;
    }

    // ====== Active state（跨聊天持久） ======
    //   用 localStorage 备份（避免 SPA 重启丢激活）

    const ACTIVE_KEY = 'ephone.mcp.activeBrand';

    function getActiveBrand() {
        try {
            const v = localStorage.getItem(ACTIVE_KEY);
            return (v === 'mcd' || v === 'luckin') ? v : null;
        } catch (e) { return null; }
    }
    function setActiveBrand(brand) {
        try {
            if (brand === 'mcd' || brand === 'luckin') localStorage.setItem(ACTIVE_KEY, brand);
            else localStorage.removeItem(ACTIVE_KEY);
        } catch (e) {}
    }

    // ====== System prompt 注入文本 ======

    const BRAND_PROMPT_HEADERS = {
        mcd: '麦当劳外卖',
        luckin: '瑞幸咖啡外卖',
    };

    function buildBridgePrompt(brand) {
        if (brand !== 'mcd') return '';
        // 用 \n 拼接避免反引号嵌套歧义
        var p = [];
        p.push('');
        p.push('---');
        p.push('[点单能力已开启 · 麦当劳 MCP]');
        p.push('');
        p.push('你这角色是用户的 AI 好友。用户开了外卖点单权限，不等于你自动下单。每一步都要跟用户商量好，用户说「就这个」或「下单」才真正下单。');
        p.push('');
        p.push('# 必须先问清楚的（违了等于闯祸）');
        p.push('用户首次说「想吃麦当劳 / 想点麦麦」还没指定具体商品的——');
        p.push('你说第一句话必须是反问，先问清楚这几件：');
        p.push('1. 吃啥：主食 / 套餐 / 单品 / 饮料 / 小食');
        p.push('2. 几个：1 份还是分给几个人');
        p.push('3. 堂食 or 外卖：1 = 进店吃 / 2 = 送门口');
        p.push('4. 口味：辣 / 不辣 / 冷 / 热 / 甜 / 咸 / 大杯 / 中杯 / 去冰 / 多冰');
        p.push('5. 地址（仅外卖）：家里 / 公司？需不需要新建地址让他自己来 App 加');
        p.push('');
        p.push('用户没主动说的 ≠ 你帮他选。用户说「随便 / 你定」→ 默认按最常见的（中等份量 + 中辣 + 大杯饮料），并告诉他「我帮你按中辣大杯走，要改吗？」');
        p.push('');
        p.push('用户随时可能岔话题聊别的（「我今天心情不好」），你不硬把话题拽回点单；他自己说「继续点麦当劳」再回来。');
        p.push('');
        p.push('# 默认行为：用户首次说「想吃」时，你主动拉菜单 + 推荐，不等他问');
        p.push('');
        p.push('用户首次说「想吃麦当劳 / 想点麦麦 / 中午吃麦麦」之类还没指定具体商品的——');
        p.push('你不要等他问「有哪些」，而是主动：');
        p.push('1. 调 query-nearby-stores（堂食）或 delivery-query-addresses（外卖先问他家/公司）');
        p.push('2. 调 query-meals（拿到菜单）');
        p.push('3. 用文字主动推荐 2-3 款常见套餐（吉士蛋堡 / 麦辣鸡腿堡 / 巨无霸 / 板烧鸡腿堡 / 麦香鱼等），每款一句话简介');
        p.push('4. 反问：「看你喜欢哪个？要堂食还是外卖？」');
        p.push('');
        p.push('这样用户第一轮对话就看到菜单。反过来具体推荐 vs 咨询「你想吃啥」——同等服务。');
        p.push('');
        p.push('但拉到菜单 + 推荐后 → 必须停，等他下指令（「就要 A」/「不要换一个」/「加个派」/「就这个，下单」）。');
        p.push('');
        p.push('# 工具调用的准确时刻');
        p.push('');
        p.push('用户说啥                                → 你干啥                                                   → 工具');
        p.push('「麦当劳有什么 / 推荐」                 → 不调工具：直说「我帮你拉菜单看看」 → query-meals       → tools: list');
        p.push('「送到 XX 公司 / XX 店 / 家」            → 直接搜附近门店 → 用户挑                                 → query-nearby-stores');
        p.push('「这店行 / 就这家」                     → 拉门店菜单 → 帮他筛                                       → query-meals');
        p.push('「我要 X + Y + Z」                       → 先跟用户逐项确认他清单（数量/口味）→ 都同意再调          → prepare → calculate');
        p.push('「下单 / 就这个 / 全要」                  → 算价 → 用 takeWayCode + 地址 → 下单                       → calculate → create-order');
        p.push('「用券 / 帮我用 XX 优惠」                → 先查券 → 算价时带上 couponId + couponCode                → query-store-coupons');
        p.push('「取消 / 退」                            → 调 cancel-order（仅已下订单）                            → cancel-order');
        p.push('');
        p.push('# 工具调用前后必做的事');
        p.push('');
        p.push('调用前：说一句自然中文短句（「帮你查下家附近的」「看看麦辣鸡套餐划算不划算」等）。');
        p.push('调用后：用一句自然话向用户汇报本次结果（「找到 3 家，最近的是 XX 店，800m」「套餐配中可乐 + 中薯，¥38.50 一份」）。');
        p.push('不要在文本里写真实菜单/价格/产品名（那是卡片的事）。');
        p.push('');
        p.push('# 卡片展示规则');
        p.push('');
        p.push('工具结果会以卡片形式贴在聊天里（用户能看到菜单/订单/优惠）。你不重复——文本只讲判断和下一步建议，具体数据交给卡片。');
        p.push('');
        p.push('# 严格禁止');
        p.push('- 禁编 productCode / storeCode / beCode / 价格 / 订单号——以工具返回为准');
        p.push('- 禁替用户下最终单——必须用户明确「下单 / 要」才能调 create-order');
        p.push('- 禁忽视用户的拒/换/不要——他拒绝就停，他换就重头问');
        p.push('');
        return p.join('\n');
    }

    function buildLuckinPrompt() {
        var p = [];
        p.push('');
        p.push('---');
        p.push('[点单能力已开启 · 瑞幸 MCP]');
        p.push('');
        p.push('你这角色是用户的 AI 好友。用户开了瑞幸点单权限，不等于你自动下单。每一步都要跟用户商量清楚，用户说「就这个 / 下单」才真正下单。');
        p.push('');
        p.push('# 必须先问清楚的（用户不说你不能帮他选）');
        p.push('');
        p.push('用户首次说「想喝瑞幸 / 来杯瑞幸」时——');
        p.push('先问这几件：');
        p.push('1. 喝啥：单品 / 拼单 / 冷 / 热（瑞幸没有套餐，只有单品）');
        p.push('2. 规格：大杯 / 中杯 / 少糖 / 半糖 / 标准糖 / 去冰 / 少冰 / 标准冰 / 加浓缩 / 多奶');
        p.push('3. 几个：1 杯？自己喝还是分人');
        p.push('4. 门店：家里附近？还是公司附近？还是给关键词（如「国贸」）');
        p.push('5. 取货方式：到店自取（默认）vs 外送（默认得加地址）');
        p.push('6. 支付：会员余额 / 微信 / 支付宝（瑞幸有券的话再问一下「用券吗」）');
        p.push('');
        p.push('用户没说的，不替他选。用户说「随便」→ 按最常见的默认（中杯 / 标准糖 / 标准冰 / 到店自取），并告诉他「我按中杯标准走行不？」');
        p.push('');
        p.push('# 默认行为：用户首次说「想喝」时，你主动拉菜单 + 推荐几款，不等他问');
        p.push('');
        p.push('用户首次说「想喝瑞幸 / 来杯瑞幸」之类还没指定具体商品的——');
        p.push('不要等他问「有什么」，主动：');
        p.push('1. **先试 queryShopList 不传经纬度**（用 0,0 或省略）—— 服务器会自动用用户的默认地址（用户在瑞幸 APP 填的那个）');
        p.push('2. 如果 server 报错说缺经纬度，再问用户位置（「你家还是公司？给个大概位置 / 公司名」）');
        p.push('3. 拿到 deptId 后调 searchProductForMcp(deptId, "生椰拿铁") 等商品关键词');
        p.push('4. 反问「看哪款？大杯还是中杯？糖 / 冰怎么定？」');
        p.push('');
        p.push('拉到菜单 + 推荐后必须停——等他下指令（「生椰拿铁大杯半糖」/ 「厚乳」/ 「就这个」/ 「不要甜」等）。');
        p.push('');
        p.push('# 工具调用的准确时刻');
        p.push('');
        p.push('用户大概率在瑞幸 APP 填了默认地址（token 绑账号），第一次工具调用先试不传经纬度：');
        p.push('- 用户没主动说地址 → 先试 queryShopList(longitude=0, latitude=0) 让 server fallback');
        p.push('- server 报错说缺经纬度 → 才需要问用户「你大概在哪边？」');
        p.push('- 用户说「送到 XX / 我在 XX」→ 立刻按那个位置查门店');
        p.push('');
        p.push('用户动作                         → 你的反应                                              → 工具');
        p.push('「瑞幸有啥 / 推荐」                  → 先试默认地址查门店，失败再问位置 → 查门店 + 找商品       → queryShopList + searchProductForMcp');
        p.push('「送到 XX / 我在 XX」             → 立刻按那个位置查门店                                    → queryShopList(longitude, latitude)');
        p.push('「这店 / 就这家」                  → 拉门店菜单 → 候选商品                                → searchProductForMcp(deptId, query)');
        p.push('「生椰拿铁大杯 / 半糖 / 热」        → 逐项再确认（特别是地址和门店），同意后算价            → previewOrder');
        p.push('「下单 / 就这个 / 全要」           → 算价后调创建订单；如用户提「用券」额外带上 couponCodeList → createOrder');
        p.push('「查 / 取消订单」                  → 查订单 / 取消                                          → queryOrderDetailInfo / cancelOrder');
        p.push('');
        p.push('# 工具调用前后必做的事');
        p.push('');
        p.push('调用前：说一句自然中文短句。');
        p.push('调用后：用一句自然话向用户汇报（「找到 2 家店，最近的是国贸店 200m」「生椰拿铁中杯标准 ¥24.80」）。不要重复卡片里的菜单/价格。');
        p.push('');
        p.push('# 卡片展示规则');
        p.push('');
        p.push('工具结果以卡片形式贴在聊天里——价格/列表/订单都在卡片上。你只讲判断和下一步。');
        p.push('');
        p.push('# 严格禁止');
        p.push('- 禁编 productId / deptId / 价格 / 订单号——以工具返回为准');
        p.push('- 禁替用户下最终单——必须用户明确「下单 / 就这个」才能调 createOrder');
        p.push('- 瑞幸 Token 1 个月有效，过期会失效，失效前主动告知用户刷新');
        p.push('');
        return p.join('\n');
    }

    // ====== OpenAI tools schema 构造 ======

    function mcpToolsToOpenAI(toolList, hintMap) {
        return toolList.map(function (t) {
            const base = t.description || 'MCP 工具 ' + t.name;
            const hint = hintMap && hintMap[t.name];
            return {
                type: 'function',
                function: {
                    name: t.name,
                    description: hint ? base + '\n[重要] ' + hint : base,
                    parameters: t.inputSchema && typeof t.inputSchema === 'object'
                        ? t.inputSchema
                        : { type: 'object', properties: {} },
                },
            };
        });
    }

    // 重点工具的 function description 补一句提示（提升模型 function-selection 准确率）
    const MCD_HINTS = {
        'query-meal-detail': '本工具需要先有 code（单个字符串，不是数组），调 query-meals 拿到 code 再来；套餐（套餐名 = meals 字典里某个 key 整体）直接当 productCode 传，不要进 query-meal-detail 拆单品。',
        'query-meals': '要点：必须给 storeCode + orderType（1=堂食 2=外卖）。如果是外卖（2），还要给 beCode——beCode 与 storeCode 是关联的，从 delivery-query-addresses 那一步一起拿到。返回的 meals 是 {code: {name, currentPrice}} 字典，code 是数字串（如 "9900008139"）。',
        'calculate-price': '4 个字段必填：storeCode, orderType（数字 1 或 2，**必须是数字不是字符串**）, items: [{productCode, quantity}], 外卖还要 beCode。productCode 用 query-meals 返回的 meals 字典 key。返回 99% 空数组 → 参数不对。',
        'create-order': '调用前必须先 calculate-price 拿到 takeWayCode。堂食（orderType=1）时不需要 beCode。',
        'delivery-query-addresses': 'beType：2=送门到家，6=到店自取。每条返回 {addressId, storeCode, beCode, fullAddress}。',
        'query-nearby-stores': 'searchType：1=定位附近，2=按关键词搜。返回每个 store 有 storeCode + beCode + 距离。',
    };

    const LUCKIN_HINTS = {
        'queryShopList': '查门店。如果用户在瑞幸 APP 填了默认地址（token 绑定的账号有默认地址），可以只传 deptName（可选）或 longitude=0,latitude=0，让 server fallback 到默认地址。如果 server 返回错误说缺经纬度，再问用户要。返回每项含 deptId, name, distance, address。',
        'searchProductForMcp': '2 个字段：deptId（必填, 数字）, query（必填, 商品中文名, 如"生椰拿铁"）。返回每项含 productId + 名字 + 价格。',
        'queryProductDetailInfo': '2 个字段：deptId（数字）, productId（数字）。',
        'previewOrder': '2 个字段：deptId（数字）, productList: [{productId, quantity, skuId?}]。返回最终价 + 优惠明细。',
        'createOrder': '5 个字段：deptId, productList, longitude, latitude, couponCodeList（可选, 字符串数组）。longitude/latitude 没的话用默认地址的（先调 queryShopList 拿到）。返回 orderId。',
    };

    // ====== fetch monkey-patch：拦截 /v1/chat/completions + 处理 tool_calls 循环 ======

    let originalFetch = null;
    let hookInstalled = false;
    let hookProcessingCount = 0;
    let lastPreloadError = { brand: null, message: null, at: 0 };

    function isLLMRequest(url) {
        return typeof url === 'string' && url.indexOf('/v1/chat/completions') >= 0;
    }

    function patchBodyWithTools(body, brand) {
        const obj = (typeof body === 'string') ? safeParseJson(body) : body;
        if (!obj) return body;
        const out = Object.assign({}, obj);
        out.tools = (out.tools || []).concat(buildOpenAITools(brand));
        // 在 system prompt 后追加外卖点单规则
        if (Array.isArray(out.messages)) {
            out.messages = out.messages.map(function (m) {
                if (m.role === 'system' || m.role === 'developer') {
                    const append = brand === 'luckin' ? buildLuckinPrompt() : buildBridgePrompt(brand);
                    return Object.assign({}, m, { content: (m.content || '') + append });
                }
                return m;
            });
            // 如果没有 system message, 加一个
            if (!out.messages.some(function (m) { return m.role === 'system' || m.role === 'developer'; })) {
                const append = brand === 'luckin' ? buildLuckinPrompt() : buildBridgePrompt(brand);
                out.messages.unshift({ role: 'system', content: append.trim() });
            }
        }
        return out;
    }

    function safeParseJson(s) {
        try { return JSON.parse(s); } catch (e) { return null; }
    }

    let toolListCache = { mcd: null, luckin: null };

    function buildOpenAITools(brand) {
        const cache = toolListCache[brand];
        if (cache) return cache;
        const client = brand === 'luckin' ? (global.McpLuckinClient) : (global.McpMcdClient);
        if (!client) return [];
        const hintMap = brand === 'luckin' ? LUCKIN_HINTS : MCD_HINTS;
        // 同步拉一次（初始化 session）
        return client.listTools().then(function (tools) {
            const schema = mcpToolsToOpenAI(tools, hintMap);
            toolListCache[brand] = schema;
            return schema;
        }).catch(function (e) {
            console.warn('[McpBridge] 拉 ' + brand + ' 工具清单失败:', e);
            return [];
        });
    }

    // 工具调用的人类可读摘要（给前端 miniApp 进度区显示用）
    function summarizeToolAction(toolName, args) {
        const n = (toolName || '').toLowerCase();
        if (/query.?nearby.?stores/.test(n)) return '🔍 查附近门店';
        if (/query.?meals/.test(n)) return '📋 拉菜单';
        if (/query.?meal.?detail/.test(n)) return '🔎 查商品详情';
        if (/list.?nutrition.?foods/.test(n)) return '🥗 拉全量营养表';
        if (/calculate.?price/.test(n)) {
            const qty = (args && Array.isArray(args.items)) ? args.items.length : 0;
            return '💰 算价（' + qty + ' 个商品）';
        }
        if (/create.?order/.test(n)) return '🧾 下单中…';
        if (/delivery.?query.?addresses/.test(n)) return '📍 查送货地址';
        if (/query.?order.?detail/.test(n)) return '📦 查订单';
        if (/cancel.?order/.test(n)) return '🚫 取消订单';
        if (/coupon|voucher/.test(n)) return '🎟️ 查优惠券';
        if (n.indexOf('queryshop') >= 0) return '🔍 查附近门店';
        if (n.indexOf('searchproduct') >= 0) return '☕ 找商品';
        if (n.indexOf('queryproductdetail') >= 0) return '🔎 查商品详情';
        if (n.indexOf('previeworder') >= 0) return '💰 预览价格';
        if (n.indexOf('createorder') >= 0) return '🧾 下单中…';
        if (n.indexOf('switchproduct') >= 0) return '🔄 切换规格';
        return '⚙️ ' + toolName;
    }

    function summarizeToolResult(toolName, callResult) {
        const n = (toolName || '').toLowerCase();
        const data = callResult && callResult.data;
        if (!data) return '✓ 完成';
        if (/query.?nearby.?stores/.test(n) || n.indexOf('queryshop') >= 0) {
            const arr = Array.isArray(data) ? data : (data.stores || data.list || data.data || []);
            return '✓ 找到 ' + (Array.isArray(arr) ? arr.length : 0) + ' 家';
        }
        if (/query.?meals/.test(n)) {
            const meals = data.meals || data.data && data.data.meals;
            return '✓ 菜单 ' + (meals ? Object.keys(meals).length : 0) + ' 个';
        }
        if (/list.?nutrition.?foods/.test(n)) {
            const text = typeof data === 'string' ? data : '';
            return '✓ 营养表 ' + (text.length ? Math.round(text.length / 100) / 10 + 'KB' : '收到');
        }
        if (/calculate.?price/.test(n)) {
            const tl = data.takeWayList || (data.data && data.data.takeWayList);
            return '✓ 算价成功';
        }
        if (/create.?order/.test(n) || n.indexOf('createorder') >= 0) {
            const oid = data.orderId || (data.data && data.data.orderId);
            return '✅ 下单成功' + (oid ? ' #' + String(oid).slice(0, 12) : '');
        }
        if (/delivery.?query.?addresses/.test(n)) {
            const list = data.addresses || data.list || data;
            return '✓ ' + (Array.isArray(list) ? list.length : 1) + ' 个地址';
        }
        if (/searchproduct/.test(n)) {
            const list = Array.isArray(data) ? data : (data.list || []);
            return '✓ 找到 ' + list.length + ' 款';
        }
        if (/preview.?order/.test(n)) {
            return '✓ 价格预览完成';
        }
        return '✓ 完成';
    }

    // 工具调用循环：递归调 LLM 直到 finish_reason !== 'tool_calls'
    async function runChatWithToolLoop(url, options, brand, opts) {
        opts = opts || {};
        const client = brand === 'luckin' ? global.McpLuckinClient : global.McpMcdClient;
        if (!client) {
            console.warn('[McpBridge] 客户端没加载');
            return (originalFetch || fetch)(url, options);
        }

        try {
            const tools = await buildOpenAITools(brand);
            const baseBody = safeParseJson(options && options.body) || {};
            baseBody.tools = (baseBody.tools || []).concat(tools);
            // 注入 prompt
            const append = brand === 'luckin' ? buildLuckinPrompt() : buildBridgePrompt(brand);
            if (Array.isArray(baseBody.messages)) {
                baseBody.messages = baseBody.messages.map(function (m) {
                    if (m.role === 'system' || m.role === 'developer') {
                        return Object.assign({}, m, { content: (m.content || '') + append });
                    }
                    return m;
                });
                if (!baseBody.messages.some(function (m) { return m.role === 'system' || m.role === 'developer'; })) {
                    baseBody.messages.unshift({ role: 'system', content: append.trim() });
                }
            }

            const newOpts = Object.assign({}, options, {
                body: JSON.stringify(baseBody),
                headers: Object.assign({}, options.headers || {}, { 'Content-Type': 'application/json' }),
            });

            const maxLoop = 6; // 工具调用循环上限，避免无限循环
            let iteration = 0;
            let conversationMessages = baseBody.messages.slice();
            let lastAssistant = null;

            // 通知 UI：会话开始跑 MCP 工具了
            emitProgress({ brand: brand, phase: 'session_start' });

            while (iteration < maxLoop) {
                iteration++;
                const reqBody = Object.assign({}, baseBody, { messages: conversationMessages });
                const iterOpts = Object.assign({}, newOpts, { body: JSON.stringify(reqBody) });
                // 关键：必须用 originalFetch 而不是 fetch，否则 fetch = wrappedFetch 会无限递归
                const fetchForLLM = originalFetch || fetch;
                const resp = await fetchForLLM(url, iterOpts);
                if (!resp.ok) {
                    emitProgress({ brand: brand, phase: 'session_done', summary: 'LLM 接口返回 ' + resp.status });
                    return resp;
                }
                const data = await resp.json();
                if (!data || !data.choices || !data.choices[0]) {
                    emitProgress({ brand: brand, phase: 'session_done', summary: 'LLM 响应异常' });
                    return wrapAsJsonResp(data, resp);
                }

                const msg = data.choices[0].message;
                lastAssistant = msg;
                const toolCalls = msg.tool_calls || [];

                if (!toolCalls.length) {
                    // 没有 tool_calls，本次结束 —— 返回 assistant 的最终回复
                    emitProgress({ brand: brand, phase: 'session_done', summary: 'AI 已完成整轮点单' });
                    return wrapAsJsonResp(data, resp);
                }

                // 有 tool_calls → 跑工具 + 写卡片消息 + push 工具结果到 messages 再下一轮
                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    const fn = (tc.function && tc.function.name) || '';
                    let args = {};
                    try { args = (tc.function && tc.function.arguments) ? JSON.parse(tc.function.arguments) : {}; } catch (e) { args = {}; }

                    // 通知 UI：开始跑某个工具
                    emitProgress({ brand: brand, phase: 'tool_start', toolName: fn, summary: summarizeToolAction(fn, args) });

                    let callResult;
                    try {
                        callResult = await client.callTool(fn, args);
                    } catch (toolErr) {
                        console.warn('[McpBridge] callTool threw:', toolErr);
                        callResult = { success: false, error: '工具调用异常: ' + (toolErr && toolErr.message || String(toolErr)) };
                    }
                    emitCardMessage(brand, fn, args, callResult);

                    // 通知 UI：工具结果（成功/失败带不同标识）
                    emitProgress({
                        brand: brand,
                        phase: callResult.success ? 'tool_ok' : 'tool_err',
                        toolName: fn,
                        summary: callResult.success ? summarizeToolResult(fn, callResult) : ('失败：' + (callResult.error || '').slice(0, 80)),
                    });

                    // 工具结果 push 到 messages（让 LLM 继续看到工具响应）
                    conversationMessages.push(msg);
                    conversationMessages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: callResult.success ? JSON.stringify(callResult.data).slice(0, 6000) : ('error: ' + callResult.error),
                    });
                }
            }
            // 超过循环上限 → 返回最后一次的 assistant
            emitProgress({ brand: brand, phase: 'session_done', summary: '达到工具循环上限，安全退出' });
            return wrapAsJsonResp({ choices: [{ message: lastAssistant }], usage: {} }, null);

            function wrapAsJsonResp(data, originalResp) {
                // 跟原始 fetch 返回形态一致（带 status / headers / json）
                const status = originalResp ? originalResp.status : 200;
                const headers = originalResp ? originalResp.headers : new Headers();
                return new Response(JSON.stringify(data), {
                    status: status,
                    statusText: originalResp ? originalResp.statusText : 'OK',
                    headers: headers,
                });
            }
        } catch (loopErr) {
            // 任何 throw 都不要让 fetch 链断 → fall back 到原始 fetch + 在诊断行暴露错误
            console.error('[McpBridge] runChatWithToolLoop 完全失败，回退原 fetch:', loopErr);
            lastPreloadError = { brand: brand, message: '工具循环异常: ' + (loopErr && loopErr.message || String(loopErr)), at: Date.now() };
            try {
                emitProgress({ brand: brand, phase: 'session_done', summary: '工具循环异常，回退无工具模式' });
            } catch (e) {}
            // 不带 tools 字段直接发原请求（用 originalFetch 避免递归）
            return (originalFetch || fetch)(url, options);
        }
    }

    // ====== 卡片事件总线（前端 UI 监听这个来渲染聊天卡片） ======

    const cardListeners = [];
    function onCard(fn) { cardListeners.push(fn); }
    function emitCardMessage(brand, toolName, args, result) {
        const card = {
            brand: brand,
            toolName: toolName,
            args: args,
            result: result,
            ts: Date.now(),
        };
        for (const fn of cardListeners) {
            try { fn(card); } catch (e) { console.warn('[McpBridge] card listener err', e); }
        }
        // 把最新一张卡片存到 localStorage，新页面打开或刷新后可恢复
        saveCardToHistory(card);
    }

    // ====== 进度事件总线（前端 miniApp 监听这个来显示实时状态） ======

    const progressListeners = [];
    function onProgress(fn) { progressListeners.push(fn); }
    function emitProgress(progress) {
        // progress: { brand, phase, toolName?, summary?, ts }
        //   phase: 'session_start' | 'tool_start' | 'tool_ok' | 'tool_err' | 'session_done'
        progress.ts = progress.ts || Date.now();
        for (const fn of progressListeners) {
            try { fn(progress); } catch (e) { console.warn('[McpBridge] progress listener err', e); }
        }
    }

    const CARD_HISTORY_KEY = 'ephone.mcp.lastCards';

    function saveCardToHistory(card) {
        try {
            const arr = JSON.parse(localStorage.getItem(CARD_HISTORY_KEY) || '[]');
            arr.push(card);
            // 只保留最近 12 张
            while (arr.length > 12) arr.shift();
            localStorage.setItem(CARD_HISTORY_KEY, JSON.stringify(arr));
        } catch (e) {}
    }
    function getCardHistory() {
        try { return JSON.parse(localStorage.getItem(CARD_HISTORY_KEY) || '[]'); } catch (e) { return []; }
    }
    function clearCardHistory() {
        try { localStorage.removeItem(CARD_HISTORY_KEY); } catch (e) {}
    }

    // ====== fetch 拦截实现 ======

    function installHook() {
        if (hookInstalled) return;
        originalFetch = window.fetch;
        const wrappedFetch = async function (input, init) {
            const url = (typeof input === 'string' ? input : (input && input.url)) || '';
            const method = (init && init.method) || (input && input.method) || 'GET';
            const isJsonBody = init && init.body && typeof init.body === 'string';

            if (method.toUpperCase() === 'POST' && isLLMRequest(url)) {
                const brand = getActiveBrand();
                const toolsCacheReady = toolListCache[brand || 'mcd'] != null;
                pushIntercept({
                    at: 'hook',
                    kind: !brand ? 'no-brand' : (!toolsCacheReady ? 'cache-miss' : 'intercepted'),
                    url: describeUrl(url),
                    brand: brand || null,
                    toolsReady: toolsCacheReady,
                });

                if (brand && !toolsCacheReady) {
                    try {
                        // 拉工具清单给 10s：瑞幸 MCP 首次 initialize + tools/list 网络往返一般 3-5s，偶尔到 8s
                        await Promise.race([
                            preloadTools(brand),
                            new Promise(function (r) { setTimeout(r, 10000); })
                        ]);
                    } catch (e) {
                        console.warn('[McpBridge] cache-miss preload failed:', e);
                    }
                }

                // 不管 cache ready 与否，都跑 runChatWithToolLoop —— 它内部 await buildOpenAITools
                // 完成才注入 tools；这样即使 cache miss 也能让 AI 拿到工具
                if (brand) {
                    try {
                        hookProcessingCount++;
                        const resp = await runChatWithToolLoop(url, init, brand);
                        return resp;
                    } catch (e) {
                        console.warn('[McpBridge] 工具循环出错，回退原 fetch:', e);
                        return originalFetch.apply(this, arguments);
                    } finally {
                        hookProcessingCount--;
                    }
                }
            }
            return originalFetch.apply(this, arguments);
        };
        // 套用糯米机的 install pattern：先试直接赋值，不行再 Object.defineProperty 强改
        let installErr = null;
        try {
            window.fetch = wrappedFetch;
        } catch (e) {
            installErr = e;
            try {
                Object.defineProperty(window, 'fetch', {
                    value: wrappedFetch,
                    writable: true,
                    configurable: true,
                });
            } catch (e2) {
                console.warn('[McpBridge] 装 fetch hook 双 fallback 都失败:', e2);
                lastPreloadError = { brand: null, message: 'fetch hook install failed: ' + (e2 && e2.message || String(e2)), at: Date.now() };
                return;
            }
        }
        hookInstalled = true;
        console.log('[McpBridge] fetch hook 已安装 (mode=' + (installErr ? 'defineProperty' : 'direct') + ')');
    }

    function uninstallHook() {
        if (!hookInstalled) return;
        if (originalFetch) {
            try { window.fetch = originalFetch; }
            catch (e) {
                try { Object.defineProperty(window, 'fetch', { value: originalFetch, writable: true, configurable: true }); }
                catch (e2) { console.warn('[McpBridge] uninstallHook 失败:', e2); }
            }
        }
        hookInstalled = false;
        console.log('[McpBridge] fetch hook 已卸载');
    }

    // ====== 链路诊断（手机端无 console 时用） ======

    // lastInterceptLog 保存最近 5 次 fetch hook 拦截记录，方便排错
    let lastInterceptLog = [];
    function pushIntercept(entry) {
        entry.t = Date.now();
        lastInterceptLog.unshift(entry);
        while (lastInterceptLog.length > 5) lastInterceptLog.pop();
    }

    // 工具调用循环里 emitProgress 时同时 pushIntercept — 这里我直接在 hook 处加记录
    function describeUrl(url) {
        try { return url.replace(/^https?:\/\//, '').split('?')[0]; } catch (e) { return String(url); }
    }

    function getStatus() {
        const brand = getActiveBrand();
        const tools = brand ? (toolListCache[brand] || []) : [];
        const mcdToken = (global.McpMcdClient && global.McpMcdClient.getToken) ? global.McpMcdClient.getToken() : '';
        const luckinToken = (global.McpLuckinClient && global.McpLuckinClient.getToken) ? global.McpLuckinClient.getToken() : '';
        const mcdEnabled = (global.McpMcdClient && global.McpMcdClient.isEnabled) ? global.McpMcdClient.isEnabled() : false;
        const luckinEnabled = (global.McpLuckinClient && global.McpLuckinClient.isEnabled) ? global.McpLuckinClient.isEnabled() : false;
        return {
            bridge: !!global.McpMcdClient && !!global.McpLuckinClient && !!global.McpBridge,
            mcdClient: !!global.McpMcdClient,
            luckinClient: !!global.McpLuckinClient,
            mcdEnabled: mcdEnabled,
            luckinEnabled: luckinEnabled,
            mcdTokenLen: mcdToken.length,
            luckinTokenLen: luckinToken.length,
            mcdTokenHead: mcdToken ? (mcdToken.substring(0, 4) + '***' + mcdToken.substring(Math.max(4, mcdToken.length - 4))) : '',
            luckinTokenHead: luckinToken ? (luckinToken.substring(0, 4) + '***' + luckinToken.substring(Math.max(4, luckinToken.length - 4))) : '',
            mcdConfigured: !!(global.McpMcdClient && global.McpMcdClient.isConfigured && global.McpMcdClient.isConfigured()),
            luckinConfigured: !!(global.McpLuckinClient && global.McpLuckinClient.isConfigured && global.McpLuckinClient.isConfigured()),
            activeBrand: brand,
hookInstalled: hookInstalled,
            toolsCached: !!tools,
            toolsCount: tools.length,
            toolNames: tools.map(function (t) { return t.name; }),
            cardCount: lastInterceptLog.length,
            recentIntercept: lastInterceptLog.slice(0, 5),
            mcpUiInstalled: !!global.McpUI,
            lastPreloadError: lastPreloadError,
            // 客户端内部 cachedTools 数量 — 区分 "client 也没拉到" vs "client 有但 bridge 没同步"
            clientLuckinToolsLen: (global.McpLuckinClient && global.McpLuckinClient.getCachedTools) ? global.McpLuckinClient.getCachedTools().length : -1,
            clientMcdToolsLen: (global.McpMcdClient && global.McpMcdClient.getCachedTools) ? global.McpMcdClient.getCachedTools().length : -1,
            cacheState: {
                luckin: toolListCache.luckin === null ? 'null' : (toolListCache.luckin.length === 0 ? 'empty[]' : 'has' + toolListCache.luckin.length),
                mcd: toolListCache.mcd === null ? 'null' : (toolListCache.mcd.length === 0 ? 'empty[]' : 'has' + toolListCache.mcd.length),
            },
            // 诊断：当前代理 path 是什么、探测过没、是否需要重探测
            proxyUrl: {
                luckin: (global.McpLuckinClient && global.McpLuckinClient.getProxyUrl) ? global.McpLuckinClient.getProxyUrl() : '(no client)',
                mcd: (global.McpMcdClient && global.McpMcdClient.getProxyUrl) ? global.McpMcdClient.getProxyUrl() : '(no client)',
            },
        };
    }

    // 重置一切：从 McpBridge 角度看干净的初始状态
    // 注意：不要碰用户的 enabled 设置（用户在设置面板里点亮的）——只清 session / cache
    function resetAll() {
        try {
            if (window.McpMcdClient) { window.McpMcdClient.resetSession && window.McpMcdClient.resetSession(); }
            if (window.McpLuckinClient) { window.McpLuckinClient.resetSession && window.McpLuckinClient.resetSession(); }
            uninstallHook();
            toolListCache = { mcd: null, luckin: null };
            setActiveBrand(null);
            lastInterceptLog = [];
            // 让 McpUI 刷新设置面板的 toggle UI（按当前 storage 实际值）
            if (global.McpUI && global.McpUI.refreshSettingsToggleUi) {
                try { global.McpUI.refreshSettingsToggleUi(); } catch (e) {}
            }
            console.log('[McpBridge] all reset (enabled 状态保留)');
        } catch (e) {
            console.warn('[McpBridge] reset error:', e);
        }
    }

    function preloadTools(brand) {
        // 提前拉一次工具清单（让工具循环的下一次命中缓存，免去第一次循环里的 init 网络等待）
        if (toolListCache[brand] != null) return Promise.resolve(toolListCache[brand]);
        const client = brand === 'luckin' ? global.McpLuckinClient : global.McpMcdClient;
        if (!client) return Promise.resolve([]);
        return client.listTools().then(function (tools) {
            const hintMap = brand === 'luckin' ? LUCKIN_HINTS : MCD_HINTS;
            if (!tools || !tools.length) {
                // 关键：client 拉到 0 工具要暴露 —— 不是 throw 也得让人看到
                lastPreloadError = {
                    brand: brand,
                    message: 'client.listTools() 返回 0 个工具 — token 可能过期/上游维护/网络问题',
                    at: Date.now(),
                };
                console.warn('[McpBridge] ' + brand + ' listTools 返回空数组');
            } else {
                lastPreloadError = { brand: null, message: null, at: Date.now() };
            }
            const schema = mcpToolsToOpenAI(tools || [], hintMap);
            toolListCache[brand] = schema;
            return schema;
        }).catch(function (e) {
            const msg = (e && e.message) || String(e);
            lastPreloadError = { brand: brand, message: msg, at: Date.now() };
            console.warn('[McpBridge] 预拉 ' + brand + ' 工具失败:', e);
            return [];
        });
    }

    function activate(brand) {
        setActiveBrand(brand);
        // 安装 hook + 预热工具列表
        installHook();
        if (brand) {
            preloadTools(brand).catch(function () {});
        }
    }
    function deactivate() {
        setActiveBrand(null);
        uninstallHook();
    }

    // ====== 触发词处理（供聊天输入处调用） ======

    function processUserInput(userInput) {
        const mcd = findMcdActivation(userInput);
        const lck = findLuckinActivation(userInput);

        if (mcd === 'on' || lck === 'on') {
            const brand = mcd === 'on' ? 'mcd' : 'luckin';
            activate(brand);
            return { activated: brand, deactivate: false };
        }
        if (mcd === 'off' || lck === 'off') {
            deactivate();
            return { activated: null, deactivate: true };
        }
        return { activated: getActiveBrand(), deactivate: false };
    }

    function isMcdConfigured() {
        return global.McpMcdClient && global.McpMcdClient.isConfigured();
    }
    function isLuckinConfigured() {
        return global.McpLuckinClient && global.McpLuckinClient.isConfigured();
    }

    // ====== 暴露 API ======

    global.McpBridge = {
        VERSION: 'v0.1.18',
        activate: activate,
        deactivate: deactivate,
        getActiveBrand: getActiveBrand,

        findMcdActivation: findMcdActivation,
        findLuckinActivation: findLuckinActivation,
        processUserInput: processUserInput,

        isHookInstalled: function () { return hookInstalled; },
        installHook: installHook,
        uninstallHook: uninstallHook,

        onCard: onCard,
        onProgress: onProgress,
        getCardHistory: getCardHistory,
        clearCardHistory: clearCardHistory,

        isMcdConfigured: isMcdConfigured,
        isLuckinConfigured: isLuckinConfigured,

        itemEmoji: itemEmoji,

        // 用于设置面板诊断
        preloadTools: preloadTools,

        // 链路诊断：手机端用（无 console 时也能看出哪段出问题）
        getStatus: getStatus,
        resetAll: resetAll,
        lastInterceptLog: lastInterceptLog,
    };

    // 安装 hook（一次性，等用户首次进入 chat 时自动起）
    // 这里**不**主动安装 - 等用户在工具栏点「点麦当劳」时再起 hook，避免无谓拦截
})(typeof window !== 'undefined' ? window : globalThis);
