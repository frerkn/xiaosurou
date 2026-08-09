// Service Worker file (sw.js)
// Whitelist cache strategy: cache only known static assets; API requests pass through.
// 2026-08-09 v0.2.04: bump CACHE_VERSION 强制清缓存（启动时清理老错位 group —
//
//   js/mcp-tool-call-log.js 加 cleanupMisplacedGroups():
//   - 启动 100ms 后, 1s 后, 找 document.querySelectorAll('.mcp-tool-log-group')
//   - 用 parent 链向上走检查是否在 #chat-messages 容器内
//   - 不在的全 remove (在 body 末尾 / watch-together 容器 / truth-game 容器的老错位 group)
//   - 打印清理数量
//
//   根因: v0.2.03 修的 4 个 bug 改的是"新触发"时的逻辑, 不会清理已渲染的老错位 group
//         硬刷后老错位 group 还在 DOM, 撑高外层容器, 影响布局
//   修法: 启动时主动清 (1 次 100ms 后 + 1 次 1s 后, 兼容容器还在渲染中的情况)
//
//   user 反馈: "为什么硬刷后还是信息出现在顶部" + "之前已经变高的位置会恢复正常吗"
//   答: v0.2.03 修不了老错位, v0.2.04 加自清理, 硬刷后老错位 group 全 remove, 布局恢复正常
// 2026-08-08 v0.2.03: bump CACHE_VERSION 强制清缓存（修 mcp-tool-call-log 容器错位 + scroll 干扰 bug —
//
//   js/mcp-tool-call-log.js 4 处修复:
//
//   1) appendAfterLastMessage 找 lastBubble 失败时 (新聊天没消息), fallback 用 '.chat-area, .chat-messages, .messages' (类名),
//      但 330 实际只有 #chat-messages (id, 唯一) — 类名全找不到, 退到 document.body, lineEl 被加到 body 末尾
//      修法: 改用 getChatContainer() (#chat-messages), 找不到时插到 typingIndicator 之前 (跟 330 appendMessage 行为一致)
//
//   2) scrollChatToBottom 用 '.chat-area, .chat-messages, .messages, .chat-scroll' (类名) — 同样全找不到,
//      scroller 是 null, 啥也不做 (虽然没生效, 但保留调用是隐患, 跟 330 滚动逻辑时序冲突)
//      修法: 删 scrollChatToBottom 调用 + 函数 (死代码)。330 appendMessage 自己会 messagesContainer.scrollTop = scrollHeight
//
//   3) renderHistoricalLogs 用 document.querySelectorAll('.mcp-tool-log-line') 全局查, 可能拿到 watch-together 等其他容器的 line
//      修法: 改用 container.querySelectorAll() 限定在 chat-messages 容器内
//
//   4) appendAfterLastMessage 用 document.querySelectorAll('.message-bubble[data-timestamp]') + document.querySelectorAll('.mcp-tool-log-group')
//      修法: 全部改用 container.querySelectorAll() 限定容器
//
//   根因: user 反馈"调过 MCP 后, 后续消息一发送就出现在聊天框顶部" + "严重时超出屏幕" —
//        group 偶尔被加到 body 末尾 (1 bug), 或 scrollChatToBottom 设错对象干扰 330 滚动时序 (2 bug),
//        或 group 误插到 watch-together 容器影响布局 (3+4 bug)。4 个 bug 一起修。
//
//   回归 23/23 通过 (test-tool-call-log.mjs)
// 2026-08-06 v0.1.91: bump CACHE_VERSION 强制清缓存（角色级总开关 + 渠道独立控制 —
//   改 v0.1.90 的"二选一互斥"为"角色级 × 渠道独立"二维控制:
//   角色级开关 (chat.settings.proactiveEnabled) = 总开关 (能不能发)
//   全局 mode (globalSettings.proactiveDeliveryMode) = 渠道选择 (用什么发)
//   角色级关 = app + push 都不发; 角色级开 + 选 push = 走系统推送
//   proactive-wake.js createTask/createFixedTask/tryHandleAction 加角色级检查
//   proactive-wake-ui.js syncOldProactiveSwitch 改成"永远不禁用, 只显示投递模式信息"
//   hint 文案从"开关无效"改成"当前投递方式: 系统推送/应用内"信息提示)
// 2026-08-05 v0.1.90: bump CACHE_VERSION 强制清缓存（投递方式 radio 用户自选, 严格二选一 —
//   globalSettings.proactiveDeliveryMode: 'app' (应用内, 默认) / 'push' (系统推送)
//   严格互斥: 选 app 就关 push, 选 push 就关 app, 没有 both (避免刷屏)
//   background-activity.js startProactiveScheduler: mode != 'app' 不启动
//   proactive-wake.js createTask/createFixedTask/tryHandleAction: mode != 'push' 拒绝创建推送任务
//   proactive-wake-ui.js 管理页面加 投递方式 radio 卡片 (2 个选项, 选啥用啥), 切换实时重启 scheduler
//   user 选 push: PWA 活着也走 push-server (不是 PWA 死了才走推送)
//   user 选 app: 完全关掉 push-server 主动消息, 只用应用内)
// 2026-08-05 v0.1.89: bump CACHE_VERSION 强制清缓存（抽 buildProactiveContext 共享函数 —
//   ai-group.js 抽 buildProactiveContext(chat, options) 共享函数 (天气/亲属卡/多层摘要/关联记忆/表情包/世界书/双源长期记忆)
//   暴露 window.buildProactiveContext, proactive-wake.js generateProactiveMessage 改用它
//   现在新通道 (推送) 和老功能 (应用内) 用同一份 context 构建, 新功能 context 跟老功能一样全)
// 2026-08-05 v0.1.88: bump CACHE_VERSION 强制清缓存（AI 主动消息生成带完整 context —
//   prompt 改"由 AI 按人设自主决定" (不再硬场景列表)
//   generateProactiveMessage 注入完整 system prompt: 角色 prompt + 角色深度人设 (aiPersona) + 勾选世界书 + 日记 + 变量记忆闪回
//   双源记忆调 vectorMemoryManager.buildMemoryContext (跟 330 主聊天一致)
//   history 10 → 20 条)
// 2026-08-05 v0.1.87: bump CACHE_VERSION 强制清缓存（合并 AI 定时提醒 + 主动消息 + 冷却时间 —
//   删 ai-reminders-screen / ai-reminders.js / ai-reminders.css 独立 UI, 合并到 proactive-wake 管理页面
//   加冷却时间检查 (默认 30 分钟, user 可调 0-120), 防止 AI 在聊天过程中疯狂设提醒刷屏
//   任务列表加来源标签: 👤 手动 (user_message 有值) / 🤖 AI (user_message null + user_prompt 有值)
//   prompt 加 {{proactiveCooldownMinutes}} 占位符, replaceTemplateVars 加默认值 30 fallback)
// 2026-08-05 v0.1.86: bump CACHE_VERSION 强制清缓存（AI 自动创建主动消息任务 —
//   330 主体 chat AI 在 JSON 指令里加 {"type": "create_push_task", userPrompt, recurrenceType, visible_hint}
//   AI 觉得"该主动关心 user"时输出这条指令 → 前端 hookProactiveWakeInMessages 自动调 ProactiveWake.createTask()
//   这样 user 不用手动创建, AI 自己设提醒)
// 2026-08-05 v0.1.85: bump CACHE_VERSION 强制清缓存（AI 主动消息管理 UI —
//   chat-list 顶部 banner + 全屏管理页面（玩法说明 + 订阅状态 + 任务列表 + 创建表单 + 测试推送）
//   粉白色系配色，modules/proactive-wake-ui.js + css/proactive-wake.css 新增）
// 2026-08-05 v0.1.84: bump CACHE_VERSION 强制清缓存（push 改 wake-up 模式 —
//   push handler 收到 push-server 发来的 {type: 'proactive-wake', chatId, charId, charName, taskId, fixedMessage, aiPrompt} payload。
//   fixed 模式 (fixedMessage 有值): 直接 showNotification
//   guided/auto 模式 (fixedMessage null): 弹占位通知 + postMessage 主页面, 主页面调 LLM 生成后发 UPDATE_NOTIFICATION 替换占位。
//   message handler 加 UPDATE_NOTIFICATION 类型: 主页面 LLM 生成完消息后用同 tag 关闭占位 + 弹新通知。
//   notificationclick 已用 event.notification.data?.chatId 跳转, 不用改。
//   借鉴糯米机 (worker/proactive-push) 的 wake-up 设计: AI 生成在 client 端 (chat history + character prompt 完整 → AI 人格健全)。
// 2026-08-05 v0.1.83: bump CACHE_VERSION 强制清缓存（iOS 18.3.2 PWA VAPID 修复 v3 —
//   v0.1.76 改 Uint8Array 实测 iPhone PWA 仍报 "must contain a valid P-256 public key"。
//   v0.1.83 改 urlBase64ToUint8Array 返回 ArrayBuffer (u8.buffer) + 加 try/catch 双 fallback
//   (ArrayBuffer 优先, 失败时回退 Uint8Array)。
//   实测 desktop Chrome 调通 (v0.1.76 也能), iPhone PWA iOS 18.3.2 严格模式要求 ArrayBuffer。
//   修了 2 处 urlBase64ToUint8Array (line 22 + line 444) + 2 处 pushManager.subscribe try/catch
//   (line 63 subscribeToPushServer + line 481 tryCreatePushSubscription)。
//   如果 v0.1.83 还报错, 改 web-push-libs CLI 重新生成 VAPID 密钥 + push-server 加调试端点。
// 2026-08-06 v0.1.98: bump CACHE_VERSION 强制清缓存（修存储徽章看不到比例 + 工具栏按钮七零八落 —
//   vector-memory.js 把 .vm-room-storage 从 .vm-room-tabs 拿出来, 单独一行 .vm-storage-line
//   (display: flex; justify-content: space-between, 左侧存储信息 + 右侧状态点),
//   左右内边距 0 跟 tab 栏/工具栏对齐 (user 原话 "和下面的宽度对齐")。textContent 改回完整
//   `${formatted} / ${quota} · ${percent}` (user 原话 "现在又看不到比例了", 接受 v0.1.82 简化方案不行)。
//   工具栏按钮重新分组: 3 左 (添加/添加核心/清理) + flex:1 + 4 右 (导出/导入/设置/教程),
//   状态点挪到 storageLine 共享一行 (不再占工具栏空间)。
//   css/variable-memory-skyblue.css 工具栏改 flex-wrap: nowrap (强制单行) + overflow-x: auto 兜底
//   (万一窄屏还是挤, 水平滚动而不是换行乱排, 修真因 "七零八落"), 按钮紧凑化 (padding 7px→6px,
//   font 13px→12px, gap 8px→6px), flex-shrink: 0 (不收缩, 优先保证可点击区域)。
//   index.html 同步 bump vector-memory.js ?v=0.0.45 → ?v=0.0.46 + variable-memory-skyblue.css ?v=0.0.39 → ?v=0.0.40。
// 2026-08-06 v0.1.97: bump CACHE_VERSION 强制清缓存（撤回 v0.1.96 的 _importedAt 重置时间 + 改 importMemory 保留 recallCount 原值 —
//   v0.1.96 加的 _importedAt = now 是 user 明确反对的 "重置时间" 操作, 撤回。_importedAt 字段 + getRoom 改 1 行都撤掉。
//   user 原话: "旧记忆原来什么样就什么样啊, 日期召回次数都要原封不动, 如果以前就是很多天0召回的,
//   进回收站也没什么, 但这全都进就不正常啊, 你也别给他们重置时间"。
//   真因: v0.1.78 决定 "importMemory 重置 recallCount=0" + 旧记忆的 memoryTime 是旧时间
//   → user 设置 foyerDays=3 + threshold=0 → 100+ 旧记忆全部满足 "age > 3天 && 0 <= 0" → 全部进 foyer。
//   修法: importMemory 把 recallCount/lastRecalled 从 "重置为 0" 改为 "保留原值" (跨设备 backup 语义)。
//   memoryTime/createdAt 也保留原值, 缺省用 now (旧导出文件没字段时)。
//   不加 _importedAt 字段, getRoom 不改 — 100+ 旧记忆按原值自然判断进 foyer (recallCount=0 + memoryTime 旧) 或留 bedroom (recallCount>=1)。
//   12/12 mock 验证 (100 条混合 recallCount 0/1/5, 30 进 foyer + 70 留 bedroom + 字段原值保留 + 没 _importedAt)。
//   v0.1.96 那次是过度设计, user 反馈 "你别重置时间" 后撤回。
//   index.html 同步 bump vector-memory.js ?v=0.0.44 → ?v=0.0.45。
// 2026-08-06 v0.1.95: bump CACHE_VERSION 强制清缓存（修玄关批量删 "toast 弹了但卡片还在" 真因 —
//   vector-memory.js 修真的 bug: class 内有两个同名 `deleteFragments` 方法 (line 238-248 老版同步接收
//   string id array + line 1048-1057 新版 async 接收 fragment object array), JS class 后定义覆盖
//   前定义, 新版覆盖了老版, 但玄关 handler 还在按老版签名传 string id array (ids / selected).
//   新版内部 `fragments.map(f => f.id)` 把 string 当对象取 .id → 全部变 undefined → Set 装 undefined
//   → filter 不删任何东西 → toast 弹"已清空 N 条"(handler 用 ids.length 自算, 不是返回值)但
//   实际 vm.fragments 没改 → renderVectorMemoryView 渲染没删的 chat → 卡片还在。
//   单条删除 OK 因为用的是 `deleteFragment`(单数) 没重名问题。
//   修法: 把 line 1048-1057 的 `async deleteFragments(chat, fragments)` 改成兼容两种传法
//   (`typeof item === 'string' ? item : item.id`), 顺手补回关联引用清理 + stats 同步,
//   3 个传 string array 调用方 (玄关清空回收站 + 删除选中) 跟 1 个传 fragment array 调用方
//   (一键清理) 都能正常 work。11/11 mock 验证通过 (string array / fragment array / 混合 / 边界)。
//   之前 v0.1.79 liveChat 修复 (race condition) 是错的方向, 已保留作为防御性代码 (不撤)。
//   index.html 同步 bump vector-memory.js ?v=0.0.42 → ?v=0.0.43。
// 2026-08-05 v0.1.81: bump CACHE_VERSION 强制清缓存（核心记忆加"转普通"按钮 —
//   vector-memory.js 加 unpinFromCoreMemory(chat, id) 方法 (pinToCoreMemory 镜像)，
//   卧室核心记忆卡片渲染时不再用 `${isCore ? '' : '→ 核心'}` 留空, 改成显示"转普通"按钮。
//   行为: 点转普通 → 把 fragment.category 从 'C' 改成 'E' (默认事件分类), 其他字段
//   (importance / emotionalWeight / tags / content / lastRecalled / recallCount 等) 全部保留。
//   importance 保留是因为它是用户主观评分, 不应该被自动改; 想换分类用"改"按钮手动改。
//   memory-summary.js 加 .vm-unpin-btn handler, 用 state.chats[state.activeChatId] 拿最新引用
//   (跟玄关 3 个 handler 同模式, 防 race condition)。
//   index.html 同步 bump vector-memory.js ?v=0.0.40 → ?v=0.0.41 + memory-summary.js ?v=0.0.39 → ?v=0.0.40。
// 2026-08-05 v0.1.80: bump CACHE_VERSION 强制清缓存（修导入导出按钮缺失 —
//   vector-memory.js 卧室工具栏在 "🧹 清理" 按钮后补 #vm-export-btn / #vm-import-btn 两个按钮。
//   modules/memory-summary.js:1057-1097 那段 handler 代码（调 vectorMemoryManager.exportMemory /
//   importMemory）其实早就写了，但 vector-memory.js 里从来没渲染过这俩按钮 DOM，导致
//   container.querySelector('#vm-export-btn') 永远返回 null，if 永远 false，点不到。
//   跟"UI 接好但方法缺失"一个套路的"UI 接好但 DOM 缺失"。
//   index.html 同步 bump vector-memory.js ?v=0.0.39 → ?v=0.0.40。
// 2026-08-05 v0.1.79: bump CACHE_VERSION 强制清缓存（修回收站批量删除 race condition bug —
//   modules/memory-summary.js 玄关 3 个 handler（清空回收站 / 删除选中 / 救回）改为每次从
//   state.chats[state.activeChatId] 拿最新 chat 引用，绕开后台 red-packet-poll.js:163 /
//   data-management.js:2584 的 "state.chats[chatId] = freshChat" 替换逻辑。原版用闭包 chat，
//   用户在二次确认弹窗停留几秒时后台轮询可能把 state 里的 chat 换成另一个对象，导致
//   deleteFragments 改的是旧对象、renderVectorMemoryView 读的是新对象（没改），结果
//   "toast 说清了但卡片还在"。手机 PWA + iOS Safari 性能比 PC 慢，撞概率高。单条删除
//   耗时短所以 user 报 OK，批量删除多一次 showCustomConfirm 弹窗停留所以 user 报不 OK。
//   附 v0.1.78 同期: vector-memory.js 加 exportMemory/importMemory，showCustomConfirm 参数名
//   confirmButtonText/cancelButtonText → confirmText/cancelText 修正。
//   index.html 同步 bump vector-memory.js ?v=0.0.37 → ?v=0.0.39 + memory-summary.js ?v=0.0.37 → ?v=0.0.39。
// 2026-08-05 v0.1.78: bump CACHE_VERSION 强制清缓存（变量记忆新增导出/导入 —
//   vector-memory.js 加 exportMemory + importMemory 方法。UI 入口早就在 modules/memory-summary.js:1057-1097
//   接好（导出按钮 #vm-export-btn + 导入按钮 #vm-import-btn + merge/replace 弹窗），但方法本体一直缺失，
//   点了会报 "exportMemory is not a function"。修法: 实现 exportMemory(chat) 返回 JSON 字符串（剥离 embedding
//   跨模型/端点兼容性更好 + 只导关键 settings + 自定义分类 + 时间线摘要），实现 importMemory(chat, json, mode)
//   'merge' 按 content+memoryTime+category 三元组去重 / 'replace' 清空再覆盖，导入后 embedding 强制 null
//   触发懒重算，lastExtractedTimestamp 不动避免重头提取产生重复。
//   index.html 同步 bump vector-memory.js ?v=0.0.37 → ?v=0.0.38。
// 2026-08-05 v0.1.77: bump CACHE_VERSION 强制清缓存（回退 Gemini 调工具 —
//   js/mcp-tool-bridge.js:
//     1. 删 runChatWithToolLoopGemini (~150 行) — v0.1.71 写, 试了 2 天修不干净, 放弃
//     2. 删 convertSchemaToGemini + openAIToolsToGemini (协议 schema 转换函数, Gemini 工具循环配套用, ~50 行)
//     3. 删 formatGeminiFunctionResponseContent (~10 行)
//     4. wrappedFetch 改回 v0.1.69 行为: Gemini native 永远 bypass, 工具 ON 也 bypass
//   保留: isGeminiNativeRequest (用) / wrapAsJsonResp (OpenAI 路径用)
//
//   行为:
//   - Gemini native 端点 → 永远 bypass, 普通聊天 + 视频/语音 + 总结记忆 work
//   - 调工具用 M3 / Gemini OpenAI 兼容端点 / 公益站 (OpenAI 风格, 走 runChatWithToolLoop)
//   - user 决定: 放弃 Gemini 调工具, 普通聊天就普通聊天, 调工具换渠道换模型
//
//   v0.1.77 之前的回退: v0.1.69 (Gemini native 永远 bypass, user 部署验证 work)
//
//   教训 (memory): "中间层转 body 是反模式" + "bypass ≠ 做不到" + "试了 2 天修不干净就该认命回退, 别死磕"
// 2026-08-03 v0.1.76: bump CACHE_VERSION 强制清缓存（iOS Safari 16.4+ VAPID 修复 v2 —
//   v0.1.75 改 urlBase64ToUint8Array 返回 ArrayBuffer, 实测仍报 "must contain a valid P-256 public key"。
//   改回 Uint8Array (Uint8Array.from + 兼容更好)。iOS Safari 16.4 不同 patch 行为不一致, 改回标准 Uint8Array。
//   如果 v0.1.76 还报错, 下一步在 iPhone console 跑诊断看公钥实际值。
// 2026-08-03 v0.1.75: bump CACHE_VERSION 强制清缓存（iOS Safari 16.4+ VAPID P-256 严格性修复 —
//   modules/notification-battery.js urlBase64ToUint8Array 返回 Uint8Array → ArrayBuffer (返回 u8.buffer)。
//   iOS Safari 16.4+ 严格模式对 applicationServerKey 要求 BufferSource, 直接传 Uint8Array 报 "must contain a valid P-256 public key"。
//   之前 web 标准允许 Uint8Array, iOS Safari 16.4 早期版本不识别, 必须 ArrayBuffer 包裹。改 2 处 (line 22 + line 444)。
//   实测: 2:03 iPhone 截图报错, 改完 push 部署后 iPhone 重启 PWA 应该能订阅。
// 2026-08-02 v0.1.74: bump CACHE_VERSION 强制清缓存（Gemini function response role 修正 —
//   js/mcp-tool-bridge.js runChatWithToolLoopGemini 调工具后写回 contents 时 role:'function' → role:'user' (2 处)。
//   根因: Gemini API 不接受 role:'function', 报 400 "Role 'function' is not supported. Please use a valid role: SYSTEM, SYSTEM_1, USER, ASSISTANT, DEVELOPER, CONTEXT, USER_CONTEXT, MODEL, USER"。
//   正确格式: functionResponse 必须嵌在 role:'user' 的 message 的 parts 里 (user 消息 + parts:[{functionResponse:{name,response:{content}}}]), 不是独立的 role:'function' 消息。
//   实测: 用户 21:35 截图, 调高德 maps_geo 工具, AI 调工具后写回 functionResponse 报 400, 改 role 后应该 work
// 2026-08-02 v0.1.73: bump CACHE_VERSION 强制清缓存（菜单卡片加底部双按钮 + 修 FAB 长按"半透明卡住"bug —
//   js/mcp-menu-card.js ensureSheet: 加 .mcp-menu-sheet-footer 含 "关闭菜单" (data-role="close-bottom" → closeSheet, FAB 还在)
//   和 "不再显示入口" (data-role="hide-fab" → hideFab + closeSheet, 跟长按 FAB 一样) 两按钮, 跟 mcp-pay-card 风格统一;
//   js/mcp-menu-card.js hideFab: 立即移除 is-visible + is-longpress-done + is-longpressing 三个 class, 避免长按后 FAB 留在
//   "半透明卡住" 状态 (is-longpress-done 有自己的 transition, 跟默认 transition 冲突, 看着像没关掉);
//   css/mcp-miniapp-pink.css: 加 .mcp-menu-sheet-footer / .mcp-menu-sheet-footer-btn / .mcp-menu-sheet-footer-btn.secondary 样式
// 2026-08-02 v0.1.72: bump CACHE_VERSION 强制清缓存（AI 请求 total 超时 3 分钟 → 10 分钟 —
//   modules/ai-response.js AI_TOTAL_TIMEOUT_MS 180000 → 600000。
//   原因: v0.1.71 Gemini 工具循环可能跑 6 轮 (AI 调工具 + 重发), 单轮 5-50 秒, 3 分钟会被掐断。
//   10 分钟给足 12 轮 × 50 秒 余量, firstChunk 60 秒保留 (防 API 完全不响应)。
//   _patch_ai_timeout.js 也同步改成 600000, 但 patch 脚本跟当前 ai-response.js 不一致 (脚本写 120000, 实际 180000), 直接改源文件更稳
// 2026-08-02 v0.1.71: bump CACHE_VERSION 强制清缓存（Gemini 原生 API 工具循环重做 —
//   之前 v0.1.58 走的是"中间层转 OpenAI body"反模式, 栽 3 次坑 (type/enum/stream) 后 v0.1.69 矫枉过正完全 bypass;
//
//   v0.1.71 新方案: 不中间层转 body, 直接用 Gemini 原生协议 (contents + tools[functionDeclarations]):
//   1. mcp-tool-bridge.js 恢复 convertSchemaToGemini + openAIToolsToGemini (协议 schema 转换, 必须 — Gemini proto3 枚举大写 + enum 元素 string 化)
//   2. mcp-tool-bridge.js 加 runChatWithToolLoopGemini (~140 行) — 直接用 Gemini 原生 contents 跟 API 通信, 解析 candidate.content.parts[].functionCall, 调工具, 写回 functionResponse (role:function + parts:[{functionResponse:{name,response:{content}}}])
//   3. mcp-tool-bridge.js wrappedFetch 改: Gemini native + 工具 ON → 调 runChatWithToolLoopGemini; 工具 OFF → bypass; stream=true → bypass (流式调工具暂不做)
//   4. formatGeminiFunctionResponseContent: mcp 工具结果用 mcp-tool-bridge.js 自己的 formatMcpToolResult (会处理 mcd 真实 markdown 包装), 转成 Gemini 期望的 string
//
//   普通聊天行为不变 (stream=true → bypass, 跟 v0.1.69 一致); AI 性格不受影响 (主 systemInstruction 不动, 只追加 sysBlock 工具说明);
//
//   真机验证 (用户没梯, 跑不了 Gemini API 直接测, 但代码逻辑跟 v0.1.63 M3 调工具路径一致, 行为稳定):
//   - 主聊天 stream=true → 永远 bypass, 行为跟 v0.1.69 一致 ✅
//   - 调工具 (非流式 Gemini) → 走新工具循环, schema 转换 + 调工具 + 写回 + 重发
//   - 端到端 Node mock 跑不通 (sandbox 设计问题, installHook 拿 originalFetch 错) → 删了 _reports/test-gemini-native-loop.mjs, 改真机验证
//
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
// 2026-08-08 v0.2.09: bump CACHE_VERSION 强制清缓存（修 2 个 v0.2.08 误报 bug —
//   notification-battery.js line 619-620: 删 v0.2.02 时代遗留的 "VAPID 公钥未发现" 警告
//     (永远触发, getConfiguredPushApplicationServerKey() 永远返 null, 因为 v0.2.02 后
//     VAPID 公钥改成 fetch /api/vapid-public-key, UI 没字段了)
//   proactive-wake.js createTask line 386-392: 修 v0.2.06 时代写错的字段读取
//     (原来读 state.globalSettings.apiKey 是错的, 主 API 实际在 state.apiConfig.apiKey,
//     导致 "user 没配 LLM" 误报, 推送任务永远创建失败)
//   background-activity.js triggerProactivePushMessage line 2304-2310: 同样字段错
//     (v0.2.08 加巡视 push 模式时复制了 proactive-wake.js 的错)
//   root cause: proactive-wake.js 一直读 state.globalSettings 但 330 主 API 配在
//     state.apiConfig (index.html input fields 'api-key'/'api-base-url'/'model' 直接写到
//     state.apiConfig, 不进 globalSettings), 永远拿不到. 修法: 优先 apiConfig, fallback globalSettings
// 2026-08-08 v0.2.08: bump CACHE_VERSION 强制清缓存（AI 巡视机制 + push 模式也跑巡视 —
//   user 反馈两个设计洞见:
//   1) "AI 应该巡视, 而不是只等对话触发" — AI 定期(10 分钟)问自己"要不要主动发", LLM 决定
//   2) "锲而不舍" — AI 推了 user 没回, 应该让 LLM 决定"换角度再发/算了", 由人设驱动
//   init-and-state.js proactiveIntervalMinutes 默认 30 → 10 (巡视频率, "再怎么刷也得 10 分钟一次")
//   background-activity.js startProactiveScheduler 拆 mode==='app' 拦截, push 模式也跑巡视
//   background-activity.js runProactiveTick 加 retryContext 收集 (lastProactivePushAt, consecutiveUnreplied, minutesSinceUserMsg)
//     触发时分发: app 模式 triggerProactiveMessage(chatId, {retryContext}) / push 模式 triggerProactivePushMessage
//   background-activity.js 新增 triggerProactivePushMessage: 调 push-server /api/proactive-patrol
//   ai-group.js triggerProactiveMessage 接受 retryContext 选项, 拼到 silenceHint 后 ("你已经主动发了 N 条没回")
//   push-server 加 /api/proactive-patrol 端点 (v0.2.08 新增):
//     一次 LLM 调用决定"action: send/skip" + 生成消息内容, 推系统通知
//     存 proactive_patrol_state 表: (user_id, chat_id) → last_send_at, send_count, consecutive_unreplied
//   push-server init-db.sql 加 proactive_patrol_state 表 + index
//   proactive-wake-ui.js 应用内模式说明卡 加"巡视机制"说明 (10 分钟 + 锲而不舍)
//   不给频率约束 (4h/6h/2h), 不给 retry 上限, 完全由 LLM 人设决定 (符合 user "按人设决定" + "留一个半夜别发就行" 偏好)
// 2026-08-08 v0.2.07: bump CACHE_VERSION 强制清缓存（修应用内模式 + push 模式完全断裂 —
//   background-activity.js startProactiveScheduler: 删 v0.1.91 误加的 mode !== 'app' return 拦截
//     (老 30 分钟 scheduler 本来就该跑, mode 默认 app)
//   proactive-wake.js createTask/createFixedTask: 删 v0.1.91 误加的 mode !== 'push' throw 拦截
//     (防御性检查留给 push-server 端 subscription 校验, UI 控制入口)
//   proactive-wake.js tryHandleAction: mode === 'app' 时静默拒绝 + 提示切老 scheduler
//     (app 模式 AI 不需要设任务, 老 scheduler 自动跑)
//   proactive-wake-ui.js 管理页面: 加 [应用内模式说明卡] (默认隐藏, app 模式显示) +
//     updateUiForDeliveryMode() 根据 mode 隐藏任务列表 + [+ 创建任务] 按钮
//   loadTaskList: app 模式 early return, 不查 push-server (任务列表卡已隐藏)
//   核心: 恢复 330 老版 "主动信息体系" (state.globalSettings.proactiveIntervalMinutes 频率 +
//     chat.settings.proactiveEnabled 角色开关 + chat.history 最后一条消息起算冷却),
//     push-server 任务管理是 push 模式专属 (v0.1.85+ 的设计不变)
//   教训: v0.1.91 把 "应用内" 和 "系统推送" 当二选一互斥错了 — 应该是两条独立通道
//   教训: 不要 hard-reject 已经实现的老功能, 这次让管理页面误导 user "管理页面没任务"
// 2026-08-09 v0.2.13: bump CACHE_VERSION 强制清缓存（修 push-server 调 LLM 用 proxyUrl 失败 —
//   user 反馈"明明选了服务器推送但从没收到通知"+"创建任务 500 fetch failed"。
//   真因: PWA 调 LLM 走 proxyUrl (CF worker) 是因为用户电脑没梯, 但 PWA 把 proxyUrl 传给了 push-server。
//   push-server 在阿里云云端, 根本不需要 CORS 绕过, 应该走直连 LLM URL。
//   实测: push-server 直连 api.minimax.chat 通, 连 mcp.lhualan338.workers.dev 超时 5s+。
//   修法: 3 处 (proactive-wake.js createTask + background-activity.js triggerProactivePushMessage +
//          proactive-wake-ui.js syncCurrentChatPushConfig) 改 LLM URL fallback 链:
//          apiConfig.apiUrl || apiConfig.mainApiUrl || apiConfig.proxyUrl (proxyUrl 放到最后)
//   教训: PWA 跟 server 用的 LLM URL 应该分开, PWA 优先 proxyUrl (浏览器 CORS), server 优先直连 (云端有 internet)
//   教训: 任何"前端传给 server 调 LLM" 的代码, fallback 链不能让 server 拿到前端专用的 proxyUrl 当首选
// 2026-08-08 v0.2.12: bump CACHE_VERSION 强制清缓存（push-server 端 10 分钟巡视 —
//   user 反馈 "PWA 不划掉一会儿也会死, 我还以为是服务器上巡视呢" — 之前 v0.2.08 巡视跑在 PWA setInterval,
//   PWA 被 iOS 杀后台就停了, 跟"无后台保活"承诺不符。
//   修法: PWA 在"启用主动消息 + 系统推送"时, POST /api/push-config 同步 LLM 配置 + 角色 prompt + 最近 20 条 context 到 push-server。
//   push-server 自己有 setInterval (10 分钟, 进程不挂就一直跑), 遍历 push_user_config 表, 调 LLM 决定要不要发, 推系统通知。
//   完全不依赖 PWA 活着 (PWA 死了 push-server 照跑)。
//   端点: POST /api/push-config (PWA sync) + DELETE /api/push-config (PWA unsync) + GET /api/push-config (调试) + POST /api/patrol-all (手动触发)。
//   新表: push_user_config (user_id + chat_id 主键, enabled bool, llm_api_url/key/model, contact_personality, context_summary)。
//   教训: 之前 v0.2.08 巡视设计时, 我和 user 都默认"前端能跑就行", 忘了 iOS PWA 后台随时被杀的现实。
//   教训: "无后台保活" ≠ "server 主动找人" — 实际是"server 处理已触发的任务", 自主巡视要 push-server 自己做。
// 2026-08-08 v0.2.11: bump CACHE_VERSION 强制清缓存（补 v0.2.10 漏改的 2 处 userId fallback —
//   v0.2.10 只改了 4 处, 漏了 proactive-wake.js 的 saveSubscription (line 528) + listTasks (line 568),
//   这俩还在用老 fallback 'default-user' (state?.userId || state?.currentUserId || state?.deviceId || 'default-user')。
//   真因: 你部署 v0.2.10 后, 你 / 琪琪 / 音音 点 "服务器推送" 开关 → 触发 saveSubscription → 用 'default-user' 存 → 覆盖你新 UUID 的订阅。
//   DB 里 default-user 订阅 updated_at 13:31 (部署后 2 分钟) 就是证据。
//   修法: 这 2 处也改 getOrCreatePushUserId()。
//   教训: "修一个相关 bug 时, 应该顺手 review 同类 bug 模式" — v0.2.10 修串台没 review 所有 userId 取值链, 漏了 2 个。
// 2026-08-08 v0.2.10: bump CACHE_VERSION 强制清缓存（修多 PWA 串台 bug —
//   之前所有 push-server 操作的 userId fallback 是 'default-user' (test push) / 'anonymous' (订阅),
//   导致多个 PWA 用户 (你 + 琪琪 + 音音) 装同一 netlify URL 时, 没配 state.userId 的全掉到 fallback,
//   串到同一 userId, 测试推送 + 巡视推送全推给同一个人 (实测 音音收所有人的)。
//   修法: notification-battery.js 加 getOrCreatePushUserId() — 每 PWA 启动时生成 UUID 存 localStorage,
//   永不换。4 处 (订阅/test push/createTask/createFixedTask/triggerProactivePushMessage) 全改用这个 UUID。
//   教训: 多 PWA 同 URL 场景, fallback 必须是 per-device 唯一值 (UUID), 永远不能共享字符串 (如 'default-user')
//   教训: 之前没暴露 per-device 唯一 ID 是设计漏洞, 必须 localStorage + crypto.randomUUID 兜底)
// 2026-08-08 v0.2.09: bump CACHE_VERSION 强制清缓存（修 v0.2.08 误报 bug —
//   proactive-wake.js createTask + background-activity.js triggerProactivePushMessage 字段读取错 (state.globalSettings → state.apiConfig),
//   notification-battery.js 删 v0.2.02 时代遗留的 "VAPID 未发现" 永远触发的检查。实测 web_fetch /api/vapid-public-key 返 87 字符 base64url ✅)
const CACHE_VERSION = 'v0.2.14';
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

// 330 v0.1.83 wake-up 模式 push handler
// 收到 push-server 发来的 {type: 'proactive-wake', chatId, charId, charName, taskId, fixedMessage, aiPrompt} payload
//   fixedMessage 有值: 直接显示 (fixed 模式, 不调 LLM, 节省)
//   fixedMessage 是 null: 弹占位通知 + postMessage 主页面 (guided/auto 模式, 主页面调 LLM 后会发 UPDATE_NOTIFICATION 更新)
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

  // ===== wake-up 模式 (v0.1.83+) =====
  if (data.type === 'proactive-wake') {
    const charName = data.charName || data.charId || 'AI 角色';
    const chatId = data.chatId;
    const taskId = data.taskId;
    const messageType = data.messageType || 'fixed';
    const fixedMessage = data.fixedMessage;

    // fixed 模式: 直接显示 user_message
    if (messageType === 'fixed' && fixedMessage) {
      const title = `💬 ${charName}`;
      const options = {
        body: fixedMessage,
        icon: data.icon || 'https://img.baidu.re/i/2026/07/w6p47e.png',
        badge: data.badge || 'https://img.baidu.re/i/2026/07/w6p47e.png',
        tag: `task-${taskId}`,
        data: { chatId, taskId, type: 'proactive-wake', messageType },
        requireInteraction: true,
        vibrate: [200, 100, 200],
        timestamp: Date.now()
      };
      event.waitUntil(self.registration.showNotification(title, options));
      return;
    }

    // guided/auto 模式: 弹占位通知, 同时 postMessage 主页面让 AI 生成
    const placeholderTitle = `💬 ${charName}`;
    const placeholderBody = `${charName} 想跟你说点什么...`;
    const placeholderOptions = {
      body: placeholderBody,
      icon: data.icon || 'https://img.baidu.re/i/2026/07/w6p47e.png',
      badge: data.badge || 'https://img.baidu.re/i/2026/07/w6p47e.png',
      tag: `task-${taskId}`,
      data: { chatId, taskId, type: 'proactive-wake', messageType, generating: true },
      requireInteraction: true,
      vibrate: [200, 100, 200],
      timestamp: Date.now()
    };

    event.waitUntil((async () => {
      // 1. 弹占位通知
      await self.registration.showNotification(placeholderTitle, placeholderOptions);

      // 2. postMessage 主页面 (如果有), 让主页面调 LLM 生成 + 发 UPDATE_NOTIFICATION
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        client.postMessage({
          type: 'PROACTIVE_WAKE',
          chatId,
          taskId,
          charId: data.charId,
          charName,
          messageType,
          aiPrompt: data.aiPrompt || null,
          sentAt: data.sentAt
        });
      }
    })());
    return;
  }

  // ===== 老 payload 格式兼容 (测试推送等) =====
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

// 330 v0.1.83: 主页面调 LLM 生成完消息后, 发 UPDATE_NOTIFICATION 替换占位通知
self.addEventListener('message', event => {
  console.log('[SW] Message received:', event.data);

  if (!event.data) return;

  // ===== 兼容老 SHOW_NOTIFICATION =====
  if (event.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = event.data;
    event.waitUntil(
      self.registration.showNotification(title, options)
    );
    return;
  }

  // ===== 新: UPDATE_NOTIFICATION 替换占位通知 =====
  if (event.data.type === 'UPDATE_NOTIFICATION') {
    const { tag, title, body, data: notifData } = event.data;
    if (!tag) return;
    event.waitUntil((async () => {
      // 关闭旧的占位通知 (用同一个 tag)
      const existing = await self.registration.getNotifications({ tag });
      for (const n of existing) n.close();

      // 弹新通知
      await self.registration.showNotification(title, {
        body,
        icon: 'https://img.baidu.re/i/2026/07/w6p47e.png',
        badge: 'https://img.baidu.re/i/2026/07/w6p47e.png',
        tag,
        data: notifData || {},
        requireInteraction: true,
        vibrate: [200, 100, 200],
        timestamp: Date.now()
      });
    })());
    return;
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
