// Service Worker file (sw.js)
// Whitelist cache strategy: cache only known static assets; API requests pass through.
// 2026-08-02 v0.1.70: bump CACHE_VERSION 强制清缓存（MCP 工具调用日志持久化 + v0.1.58 死代码彻底清理 —
//   (1) js/mcp-tool-call-log.js: 实时 onCard 时 push 到 chat.mcpToolLogs (新字段, chat 对象下独立数组) + db.chats.put(chat) 写 IndexedDB;
//       持久化 entry = { ts, afterMsgTs, toolName, aiName, summary, success } (afterMsgTs = 当时最近一条 assistant 消息 timestamp 作锚点);
//       MutationObserver 监控 #chat-messages 容器 childList 变化, debounce 100ms 后调 renderHistoricalLogs(activeChatId)
//       把当前聊天 mcpToolLogs 重新按 afterMsgTs 锚点插入 DOM (按 data-ts 跳过已渲染, 幂等);
//       找不到精确锚点气泡时兜底找 ts 之前最近一条, 仍找不到就插到 chat-messages 容器末尾;
//       老聊天 (没 mcpToolLogs 字段) 兼容不报错 (test case 14 验证);
//   (2) js/mcp-tool-bridge.js: 删除 v0.1.58 死代码 ~200 行 (convertSchemaToGemini / openAIToolsToGemini / geminiBodyToOpenAI /
//       openAIMessagesToGeminiContents / openAIResponseToGemini / runChatWithToolLoopGemini), 保留 isGeminiNativeRequest (v0.1.69 wrappedFetch 用)
//       和 wrapAsJsonResp (runChatWithToolLoop 用);
//       v0.1.69 行为完全保留 (test-stream-bypass.mjs 8/8 仍然通过);
//   端到端验证 23/23 通过 (实时渲染 9 + 多调用堆叠 2 + 持久化写入 4 + 切聊天恢复 4 + 幂等 1 + 兜底 1 + 老聊天兼容 1 + 实时 summary 2);
//   modules/data-management.js type='chat' 分支已联动: 群聊 + 单聊清空 history 时同步 chat.mcpToolLogs = [], 避免锚点孤立;
//   charId==='user' 分支不动 mcpToolLogs (那个分支是过滤 user 消息保留 assistant 消息, afterMsgTs 锚点指向 assistant 不受影响)
// 2026-08-02 v0.1.69: bump CACHE_VERSION 强制清缓存（Gemini 直连普通聊天全断 v3 — v0.1.58 写的 wrappedFetch + runChatWithToolLoopGemini 拦截所有 Gemini 请求, 强制 non-stream + 注入 tools + systemInstruction, 破坏 330 主聊天/总结记忆的原生行为。v0.1.67 试图加 stream bypass 但只对 body.stream === true 有效, Gemini native 端点 body 不带 stream 字段所以 bypass 不生效。v0.1.69 根本性修复: wrappedFetch 简化 — Gemini native 端点 (generativelanguage.googleapis.com/v1beta/models/.../generateContent) 永远 bypass 走 originalFetch (普通聊天 + 总结记忆 work), 想用 Gemini 调工具改用 OpenAI 兼容端点 (generativelanguage.googleapis.com/v1beta/openai) 走工具循环 (已验证 work)。v0.1.65 + v0.1.68 仍然有效 (调 mcd 工具 work)。端到端 8/8 通过 (Gemini native bypass + Gemini OpenAI 兼容进工具循环 + M3 进工具循环 + 非 LLM bypass + GET bypass + 公益站 Gemini 两种模式都 work)）
// 2026-08-02 v0.1.68: bump CACHE_VERSION 强制清缓存（Gemini enum 元素 number → string + 类型回转 — mcd 工具真实 inputSchema 里 enum 是 number 数组 (e.g. beType: enum=[1,5] type=integer), Gemini API 期望 enum 是 repeated string 不接受 number, 报 400 Invalid value at 'enum[0]'。修法: (1) mcp-tool-bridge.js convertSchemaToGemini 转换时把 enum 元素全部 toString, (2) mcp-generic-client.js normalizeValueBySchema 加 enum 类型回转 — AI 输出 string "1" → mcd.cn 端点期望 number 1, 自动转回。端到端 12/12 通过 (含 mcd query-nearby-stores 真实 beType=[1,5]/searchType=[1,2] number enum 转换 + 类型回转测试)）
// 2026-08-02 v0.1.65: bump CACHE_VERSION 强制清缓存（Gemini 原生 API type 大写 bug 修复 — openAIToolsToGemini 加 convertSchemaToGemini() 递归转换 OpenAPI Schema 小写 (string/number/integer/boolean/object/array) 为 Gemini proto3 枚举大写 (STRING/NUMBER/INTEGER/BOOLEAN/OBJECT/ARRAY)。修前: Gemini 直连调工具报 400 Invalid value at 'tools[0].function_declarations[1].parameters.properties.X.type' (TYPE_STRING)。修后端到端 11/11 通过 (mcd 真实参数 + 嵌套 object/array + enum + description/required 保留)）
// 2026-08-02 v0.1.63: bump CACHE_VERSION 强制清缓存（MCP 工具调用日志 — 新建 js/mcp-tool-call-log.js 监听所有 onCard, 覆盖所有通用 MCP 工具 (不限 mcd/luckin/amap), inline 渲染简洁文字行紧跟最后一条 AI 消息: "[emoji] [toolName] · [摘要]"。跟 mcp-menu-card / mcp-pay-card 共存互补 — 菜单/支付是大卡片, 日志是文字证据, 用户看日志就知道 AI 真调了工具不是瞎编。摘要逻辑通用: 优先看 pois/stores/meals/items 等数组长度 → 数字字段 (count/amount/distance) → 订单号 → 兜底字段数。css/mcp-miniapp-pink.css 加 .mcp-tool-log-group / .mcp-tool-log-line / .mcp-tool-log-ok/err 样式）
// 2026-08-02 v0.1.62: bump CACHE_VERSION 强制清缓存（inline 支付卡片 — 新建 js/mcp-pay-card.js + css/mcp-miniapp-pink.css 加 .mcp-pay-card 系列样式 + index.html 加载 + 麦当劳/瑞幸教程加"系统自动 inline 渲染支付卡片, AI 自由发挥不重复"提示。监听 create-order/createOrder/mall-create-order, 提取 payUrl/payOrderUrl/payOrderQrCodeUrl, 紧跟最后一条 AI 消息气泡后面渲染。设计原则: 不弹全屏 (破坏"AI 帮你下单"代入感), 只 inline 渲染支付信息让用户能扫/点。不规定 AI 说话, AI 用人设自由发挥）
// 2026-08-02 v0.1.61: bump CACHE_VERSION 强制清缓存（备份模块漏掉悬浮球/生图/MCP 修复 — modules/backup-import-export.js 抽 EXTRA_LOCALSTORAGE_PREFIXES 列表统一管理 8 类 localStorage key（couple/floating-ball/novelai-/google-imagen-/pollinations-/openaiCompatImage/ephone.mcp./aphone.mcp.），重构 exportExtraLocalStorage / clearExtraLocalStorage / restoreExtraLocalStorage 三个函数。import 路径全部更新（importStreamedBackup/importLegacyBackup/handleSelectiveImport 3 处），旧名 exportCoupleSpaceLocalStorage 等保留做兼容转发。_reports/test-extra-localstorage.mjs 端到端验证 94/94 通过）
// 2026-08-02 v0.1.60: bump CACHE_VERSION 强制清缓存（麦当劳教程按官方文档 https://open.mcd.cn/mcp/guide.md 重写 — 21 个工具全覆盖：到店流程 5 步 / 外送流程 5 步 / 优惠券 4 工具 / 订单管理 2 工具 / 辅助 7 工具。修之前"🚫 官方没做查订单工具"的错误（实际有 query-order），加协议版本兼容说明 + 限流 600/分 提示 + 数据依赖链 storeCode/mealCode/订单ID）
// 2026-08-02 v0.1.59: bump CACHE_VERSION 强制清缓存（高德 3 个端点 REST 兜底: maps_text_search / maps_around_search / maps_weather — mcp-generic-client.js 新增 amapTextSearchRestFallback / amapAroundSearchRestFallback / amapWeatherRestFallback + tryAmapRestFallback 集中分发 + amapMcpDataIsEmpty 空数据检测 + isAmapBugTool 判断，callTool 在 isError / 空数据两种分支都触发 REST 兜底。AI 完全无感，端到端验证 4/4 通过：成都搜麦当劳 20 个 POI / 周边 2km 7 个 POI / 成都实况小雨 22°C / 洛阳路 3 个候选）
// 2026-07-09 v0.1.18: 改用 Vercel 默认 bodyParser:true —— req.body 直接是解析后的对象，不用 rawBody 兜底
// 2026-07-09 v0.1.12: 修致命 bug — runChatWithToolLoop 内部 fetch(url) = window.fetch = wrappedFetch → 无限递归 → OOM 闪退。改用 originalFetch 绕过自己。
// 2026-07-09 v0.1.11: 修 refreshToolbarActive 闭包 bug — 把 refreshToolbarActive 提升到 IIFE module-scope 让 ensureMiniAppDom 闭包也能访问
// 2026-07-29 v1.0.0: 通用 MCP 工具服务器 — 删 mcd/luckin 硬编码, 改用 McpGenericClient + 通用 UI 列表
// 2026-07-09 v0.1.6: 诊断行暴露 preload 错误信息；重连后强制重激活当前 brand + 同步 UI；toggle click 后刷 diag
// 2026-07-09 v0.1.5: 干净设计 — 去掉"强制开启"按钮；UI 永远服从 storage；toggle 提示文案区分 token 没填/开关没开
// 2026-07-09 v0.1.4: 修 resetAll() 错误地 setEnabled(false) 残留 bug；UI 加 🔧 强制开启 / 🔄 刷UI 按钮兜底恢复
// 2026-07-09 v0.1.3: 修 MCP token 输入框 change→input 事件 + toggle click 兜底 setToken（解决"看着填了但 storage 没存"bug）
// 2026-07-15 v0.1.25: bump CACHE_VERSION 强制清缓存（hotNews + vector memory + isGenerating 残留 3 处修复 — modules/hot-news.js + modules/ai-response.js + modules/vector-memory.js）
// 2026-07-15 v0.1.24: bump CACHE_VERSION 强制清缓存（歌词解析 parseLRC 兼容无毫秒时间戳 — modules/music-player.js 改 1 处 parseLRC + index.html bump ?v=0.0.44）
// 2026-07-14 v0.1.22: bump CACHE_VERSION 强制清缓存（一起读书加 URL 抓取 + 粉白美化，index.html/main-ui.css/reading-room.js 都改了）
// 2026-07-14 v0.1.21: getProxyUrl 加 hostname 优先判断 — 双平台切换永远正确不靠缓存
// 2026-07-21 v0.1.29: bump CACHE_VERSION — 新增 js/ai-songs-store.js（AI 原创曲 IndexedDB 持久化层）
// 2026-07-24 v0.1.44: bump CACHE_VERSION 强制清缓存（Live2D 硬开关 — state.globalSettings.live2dEnabled !== true 时 mountLive2DForCall 直接 return, UI 输入框也隐藏；之前卖家模型不兼容 doDrawModel undefined '0'，保留所有 Live2D 代码和数据以备以后换兼容模型）
// 2026-07-21 v0.1.30: bump CACHE_VERSION — 视频通话 Live2D 接入（cubism core + pixi.js + pixi-live2d-display + lib/live2dcubismcore.min.js + modules/live2d-loader.js + assets/live2d/）

// 2026-07-24 v0.1.45: bump CACHE_VERSION 强制清缓存（音色样本时长上限 60s → 180s / 3 分钟 — js/role-voice-sample-ui.js MAX_DURATION 60→180、MAX_SIZE 10MB→20MB、文案跟着变。MiniMax Cover 输出音频长度受参考音频长度限制，60s 唱不完整一首歌，3 分钟够用；3 分钟 wav 25-35MB 仍超 20MB，但 mp3 5-8MB 够用，主推 mp3）
// 2026-07-23 v0.1.38: bump CACHE_VERSION 强制清缓存（"角色有音色样本时自动用 Cover" 开关 — index.html 加 #auto-cover-when-has-sample-switch 开关；settings-presets.js 加载默认 true；init-event-bindingsA.js 保存到 globalSettings.autoCoverWhenHasSample；ai-music.js 强制 cover 逻辑改成读这个开关，false 时即使有样本也用用户在设置里选的普通模型）
// 2026-07-23 v0.1.37: bump CACHE_VERSION 强制清缓存（灵动岛点击打不开播放器 — modules/init-event-bindingsA.js setupMusicIslandWidget openPlayer 原来只判 musicState.isActive，AI 自动唱歌的路径不调 startListenTogetherSession 一直是 false，加 playlist+isPlaying 兜底判断）
// 2026-07-23 v0.1.36: bump CACHE_VERSION 强制清缓存（AI 歌 caller 漏传 lyrics — ai-response.js:6739 + ai-group.js:1092 + ai-group.js:1567 三处 addAiSongToPlaylist 没传 lyrics 字段，buildLrcFromLyrics 拿不到词 → 播放器 lrcContent 一直是空，歌词不显示）
// 2026-07-23 v0.1.35: bump CACHE_VERSION 强制清缓存（Cover 模式歌词覆盖 bug — modules/ai-music.js generateCover 删掉 preprocess 返回的 formatted_lyrics 覆盖逻辑，之前是 server 从参考音频 ASR 出来的旧歌词覆盖了用户给的新词，导致 Cover 唱的还是上传内容）
// 2026-07-22 v0.1.34: bump CACHE_VERSION 强制清缓存（音色样本 file input accept 加扩展名兜底 — js/role-voice-sample-ui.js accept 改为 ".mp3,.wav,.m4a,..." 列表避免 audio/* 在 Windows Chrome/PWA 过滤掉 mp3；hidden 改 display:none 保险；js/music-voice-sample.js setVoiceSample 强制 blob mime=audio/mpeg 避免 IDB 丢 mime）
// 2026-07-22 v0.1.33: bump CACHE_VERSION 强制清缓存（悬浮球"AI 原创曲管理"入口 — modules/floating-ball.js 加 data-action="manage-ai-songs" + handleQuickManageAiSongs() mini modal 列出 IndexedDB 所有 AI 歌，每首 ▶/⤓/🗑，底部一键清空；js/ai-songs-store.js 加 listAllSongs API）
// 2026-07-22 v0.1.32: bump CACHE_VERSION 强制清缓存（AI 歌 blob 强制 mime=audio/mpeg — IDB 反序列化常丢 mime type，导致 data URI 前缀变 data:;base64, 没 mime，<audio> 拒播。修法：modules/music-player.js addAiSongToPlaylist 入口 + js/ai-songs-store.js persistSong 写库时都强制 new Blob([blob], { type: 'audio/mpeg' })）
// 2026-07-22 v0.1.31: bump CACHE_VERSION 强制清缓存（AI 原创曲按 songId 去重 — modules/music-player.js addAiSongToPlaylist 加 songId pre-dedup 块，绕过 getMusicTrackKey 不认 songId 的 bug）
// 2026-07-21 v0.1.30: bump CACHE_VERSION — 视频通话 Live2D 接入（cubism core + pixi.js + pixi-live2d-display + lib/live2dcubismcore.min.js + modules/live2d-loader.js + assets/live2d/）
// 2026-07-21 v0.1.29: bump CACHE_VERSION — 新增 js/ai-songs-store.js（AI 原创曲 IndexedDB 持久化层）
// 2026-07-24 v0.1.42: bump CACHE_VERSION 强制清缓存（SW install 改宽容：cache.addAll → Promise.allSettled，单个 URL 失败不再让整个 install 失败 — 修复"一键修复通知 SW 注册不上"根因）
// 2026-07-24 v0.1.41: bump CACHE_VERSION 强制清缓存（一键修复通知卡死修复：navigator.serviceWorker.ready 加 5s timeout + 全流程 console.log 进度 + 按钮 disabled 状态 — modules/notification-battery.js + index.html bump ?v=0.0.38）
// 2026-07-25 v0.1.46: bump CACHE_VERSION 强制清缓存（语音/视频通话 Gemini 直连修复 — video-voice-call.js 两处 isGemini 兜底：resolveApiSlotConfig 不返回 isGemini, 用 proxyUrl.includes('generativelanguage') 兜底判定）
// 2026-07-24 v0.1.40: bump CACHE_VERSION 强制清缓存（"无声智能保活"settings-item 改用标准结构 label + .settings-desc，跟其他设置项对齐 — index.html line 3173-3183）
// 2026-07-24 v0.1.39: bump CACHE_VERSION 强制清缓存（系统设置首页"数据与存储"卡片跳转目标从 sec-cloud-storage 改到 sec-data-management — modules/system-settings-home.js + index.html bump ?v=0.0.37）
// 2026-08-01 v0.1.56: MCP 菜单卡片 parse bug 修复 + 教程简化
//   1) mcp-generic-client.js callTool: safeParseJson 失败时改用 extractJsonFromMcpText
//      brace-match 抽 mcd.cn / 其他 MCP 端点 text 里嵌的 JSON (前面 markdown 描述导致 JSON.parse 整体炸)
//   2) mcp-menu-card.js parseMcpResult: McpGenericClient 包成 {success,data,rawText} 时
//      改成 return result.data (而不是 return result), 剥外层包装
//   3) mcp-menu-card.js onCard: 加诊断 log, 列出 result shape + 没解析出菜单数据时打 rawText 前 200 字符
//   4) mcp-ui-list.js 教程简化: 删 30 行 WORKER_CODE + 删"5 分钟部署教程"块 + 删"通用流程"块 + 删
//      "遇到问题"块 + 删 "copy-worker-code" 事件块 (~200 行 → 75 行), 弹窗顶部改成
//      "代理已部署好, URL 填 https://mcp.lhualan338.workers.dev/" + 2 个服务各 3 步接入
// 验证: _reports/test-extract-only.mjs 端到端跑通 — 14 分类 116 餐品, 跟用户截图"蘸酱炸鸡五选一 11.9元"对上
// 2026-08-01 v0.1.56: 修绿江章节删除按钮不响应 - checkbox 点击时同步 selectedChapters
// 2026-08-01 v0.1.57: 修绿江 AI 续写不接剧情 - prompt 拼接多章 summary + 硬性接续要求 + summary 缺失 fallback
// 2026-08-01 (合并到 v0.1.58) MCP 端点使用教程注入: mcp-tool-bridge.js buildMcpSystemBlock
//   按 server.url 识别, 注入对应端点的踩坑使用教程 (麦当劳: reservationDate/营业时段, 瑞幸:
//   keyword 写法/菜单只有 2-3 个是真没货). 解决 Gemini 漏参数 / Deepseek 流程不对 / M3 较稳
//   的模型差异大问题. 不再 bump 版本号, 跟 v0.1.58 一起发, 避免 SW 缓存反复失效
// 2026-08-01 (合并到 v0.1.58) 瑞幸菜单卡片: mcp-menu-card.js
//   1) MENU_TOOL_PATTERNS 加 searchProductForMcp / queryProductDetailInfo (实际工具名, 不是猜的 searchProduct)
//   2) 加 parseLuckinMenu 函数, 解析瑞幸的扁平商品数组 (data[].productId/productName/pictureUrl/initialPrice/estimatePrice/productAttrs)
//   3) 商品卡片加 .mcp-menu-item-attrs 渲染杯型/温度/糖度等属性折叠文字
//   4) 端到端验证: _reports/test-luckin-parse.mjs 跑通, 拿到 2 个生椰拿铁商品
//   5) 教程改: 瑞幸 searchProductForMcp(deptId+query) / queryShopList(longitude+latitude) / previewOrder 不是 calculate-price
// 2026-08-01 (合并到 v0.1.58) 瑞幸教程按官方文档完整重写: 8 步骤全流程
//   1) 查门店 (经纬度) / 2) 搜商品 (关键词) / 3) 切属性 (operation=3) / 4) 查详情
//   5) 算价 (返 couponCodeList) / 6) 下单 (⚠️ longitude/latitude 必填 + couponCodeList 从 ⑤ 拿, 返 payOrderUrl 给用户扫)
//   7) 查订单 (orderStatus 10-100) / 8) 取消 (待付/下单才能取消)
//   数据依赖链: deptId (①→所有) / productId+skuCode (②→⑤⑥) / couponCodeList (⑤→⑥)
// 2026-08-01 (合并到 v0.1.58) Gemini 直连 MCP 工具修复: mcp-tool-bridge.js isLLMRequest
//   原版只匹配 /v1/chat/completions (OpenAI 风格), Gemini 走 generativelanguage.googleapis.com
//   完全不匹配, hook 跳过 → AI 看不到 tools → 拉不到菜单. 修法: 新增 OR 匹配
//   /v1beta/openai/chat/completions (Gemini OpenAI 兼容) + generativelanguage.googleapis.com (Gemini 原生)
//   老匹配 /v1/chat/completions 完全保留, M3/MiniMax/Deepseek 不受影响. 安全性: 新加字符串都是 Google
//   域名专属, 不会误匹配其他 LLM. 可回退: 把 if 那几行删了恢复原版
// 2026-08-01 (合并到 v0.1.58) Gemini 原生 API 工具循环: mcp-tool-bridge.js runChatWithToolLoopGemini
//   原计划: Gemini body 转 OpenAI body → 复用 OpenAI 内部逻辑 (错! Gemini API 收到 OpenAI 风格 body
//   返 400, 两种协议完全不兼容). 现: 直接用 Gemini 风格 body + contents + systemInstruction
//   跟 Gemini API 通信, 自己解析 Gemini 风格响应 (candidates[0].content.parts[].functionCall).
//   工具结果存 role:function + parts:[{functionResponse:{name, response:{content}}}]
//   wrappedFetch 根据 isGeminiNativeRequest 分发到 runChatWithToolLoopGemini 或 runChatWithToolLoop
//   新增: openAIToolsToGemini (OpenAI tools → functionDeclarations), isGeminiNativeRequest (URL 识别)
//   ⚠️ 端到端测试需用户拿真实 Gemini API 调一次验证 (我电脑没梯连不上 generativelanguage.googleapis.com)
// 2026-08-01 (合并到 v0.1.58) 高德 MCP 教程: mcp-tool-bridge.js SERVER_USAGE_GUIDES
//   实测 15 个工具, 部分端点 bug: maps_text_search/around_search/weather 都返空或 null (两 key 都复现)
//   教程避开 bug 端点, 让 AI 引导用户走 REST API 兜底
//   WORK: maps_distance/maps_geo(偶发失败)/maps_regeocode/路径规划 4 个/maps_ip_location
//   关键依赖: 经纬度 (lng,lat) 字符串格式, 几乎所有工具都需要
//   瑞幸教程 (deptId 经纬度搜索) 现在引用高德 geocode 拿经纬度
// 2026-08-01 (合并到 v0.1.58) 高德 maps_geo REST 兜底: mcp-generic-client.js
//   mcp.amap.com/mcp 的 maps_geo 端点坏 (返 ENGINE_RESPONSE_DATA_ERROR),
//   在 callTool 检测到 maps_geo + result.isError 时自动 fallback 到
//   https://restapi.amap.com/v3/geocode/geo?address=...&key=server.bearerToken
//   把 REST 的 {geocodes: [...]} 转成 MCP 风格 {results: [...]}, AI 完全无感
//   其他 bug 端点 (text_search/around_search/weather) 暂不兜底, 走教程引导 REST 路径
const CACHE_VERSION = 'v0.1.70';
const CACHE_NAME = `ephone-cache-${CACHE_VERSION}`;

const URLS_TO_CACHE = [
  './index.html',
  './style.css',
  './online-app.css',
  './script.js',
  './modules/hot-news.js',
  './modules/runtime-diagnostics.js',
  // v0.1.28 新增：AI 唱歌（3 个新模块）
  './modules/ai-music.js',
  './js/music-voice-sample.js',
  './js/role-voice-sample-ui.js',
  // v0.1.29 新增：AI 原创曲 IndexedDB 持久化层
  './js/ai-songs-store.js',
  './js/netease-music.js',
  // v1.0.0 改造: 通用 MCP 工具（删 mcd/luckin 硬编码, 删旧 mcp-ui-init + 3 个 css, 加 generic-client + ui-list）
  './js/mcp-generic-client.js',
  './js/mcp-tool-bridge.js',
  './js/mcp-ui-list.js',
  // v0.1.55 新增: MCP 菜单卡片渲染（粉白色系浮动按钮 + 全屏 sheet）
  './js/mcp-menu-card.js',
  './css/mcp-miniapp-pink.css',
  // v0.1.30 新增：Live2D 视频通话（cubism 引擎 + loader + 视频通话主文件）
  './lib/live2dcubismcore.min.js',
  './modules/live2d-loader.js',
  './modules/video-voice-call.js',
  'https://unpkg.com/dexie/dist/dexie.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://phoebeboo.github.io/mewoooo/pp.js',
  'https://cdn.jsdelivr.net/npm/streamsaver@2.0.6/StreamSaver.min.js',
  'https://img.baidu.re/i/2026/07/w6p47e.png'
];

self.addEventListener('install', event => {
  console.log('[SW] Installing service worker...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Cache opened, caching core files...');
        // 2026-07-24 修复：cache.addAll 改 allSettled 单独缓存每个文件
        // 原因：URLS_TO_CACHE 里有 25 个文件（含 5 个外部 CDN），任何一个 fetch
        // 失败（CDN 抽风 / CORS / 404）整个 addAll 就会 reject，导致 SW install
        // 永远卡 installing 状态 → navigator.serviceWorker.register() 抛错 →
        // "一键修复通知" alert 里看不到"已重新注册"的成功提示。
        // 改宽容后：单个失败只 warn 跳过，整体 install 必成功。
        return Promise.allSettled(
          URLS_TO_CACHE.map(url =>
            cache.add(url).catch(err => {
              console.warn('[SW] 缓存失败（已跳过）:', url, err.message || err);
              return null;
            })
          )
        ).then(results => {
          const ok = results.filter(r => r.status === 'fulfilled').length;
          const fail = results.length - ok;
          console.log(`[SW] Core files cached: ${ok} ok, ${fail} failed.`);
        });
      })
      .then(() => {
        console.log('[SW] skipWaiting()');
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', event => {
  console.log('[SW] Activating service worker...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[SW] Service worker activated.');
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  const isLocalAsset = url.startsWith(self.location.origin) &&
    (url.includes('/index.html') ||
     url.includes('/style.css') ||
     url.includes('/online-app.css') ||
     url.includes('/script.js') ||
     url.includes('/modules/hot-news.js') ||
     url.includes('/modules/runtime-diagnostics.js') ||
     // v0.1.28 新增：AI 唱歌模块
     url.includes('/modules/ai-music.js') ||
     url.includes('/js/music-voice-sample.js') ||
     url.includes('/js/role-voice-sample-ui.js') ||
     // v0.1.29 新增：AI 原创曲存储层
     url.includes('/js/ai-songs-store.js') ||
     // v1.0.0 改造: 通用 MCP 文件命中拦截, 走缓存（请求带回 ?v= 时也走 fetch）
     url.includes('/js/mcp-generic-client.js') ||
     url.includes('/js/mcp-tool-bridge.js') ||
     url.includes('/js/mcp-ui-list.js') ||
     // v0.1.30 新增：Live2D 视频通话（引擎 + loader + 模型目录）
     url.includes('/lib/live2dcubismcore.min.js') ||
     url.includes('/modules/live2d-loader.js') ||
     url.includes('/modules/video-voice-call.js') ||
     url.includes('/assets/live2d/'));

  const isKnownCDN =
    url.includes('unpkg.com/dexie') ||
    url.includes('cdnjs.cloudflare.com/ajax/libs/html2canvas') ||
    url.includes('cdn.jsdelivr.net/npm/streamsaver') ||
    url.includes('phoebeboo.github.io/mewoooo/pp.js') ||
    url.includes('i.postimg.cc/') ||
    url.includes('img.baidu.re/') ||
    // v0.1.30 新增：Live2D 引擎 (UMD prebuilt, 完全不用 esm.sh)
    url.includes('cdn.jsdelivr.net/npm/pixi.js') ||
    url.includes('cdn.jsdelivr.net/npm/pixi-live2d-display') ||
    url.includes('cdn.jsdelivr.net/gh/dylanNew/live2d');

  if (isLocalAsset || isKnownCDN) {
    const isVersioned = url.includes('?v=');
    if (isVersioned) {
      event.respondWith(
        fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            const noQueryUrl = url.split('?')[0];
            caches.open(CACHE_NAME).then(cache => cache.put(noQueryUrl, clone));
          }
          return response;
        }).catch(() => caches.match(url.split('?')[0]))
      );
      return;
    }

    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        const fetchPromise = fetch(event.request).then(response => {
          if (response && response.status === 200) {
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, response.clone());
            });
          }
          return response;
        }).catch(() => null);

        return cachedResponse || fetchPromise;
      })
    );
  }
});

self.addEventListener('push', event => {
  console.log('[SW] Push received:', event);

  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { body: event.data.text() };
    }
  }

  const title = data.title || 'EPhone';
  const options = {
    body: data.body || 'You have a new message',
    icon: data.icon || 'https://img.baidu.re/i/2026/07/w6p47e.png',
    badge: data.badge || 'https://img.baidu.re/i/2026/07/w6p47e.png',
    tag: data.tag || 'default',
    data: data.data || {},
    requireInteraction: true,
    vibrate: [200, 100, 200],
    timestamp: Date.now()
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('message', event => {
  console.log('[SW] Message received:', event.data);

  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = event.data;
    event.waitUntil(
      self.registration.showNotification(title, options)
    );
  }
});

self.addEventListener('notificationclick', event => {
  console.log('[SW] Notification clicked:', event);

  event.notification.close();

  const chatId = event.notification.data?.chatId;
  const urlToOpen = chatId ? `/?openChat=${chatId}` : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (let client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            return client.focus().then(client => {
              if (chatId) {
                client.postMessage({ type: 'OPEN_CHAT', chatId });
              }
              return client;
            });
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});
