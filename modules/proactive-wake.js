// ============================================================
// proactive-wake.js — 主动消息 wake-up 处理
// 借鉴糯米机 (worker/proactive-push) 设计: push-server 只发唤醒信号
// AI 生成放前端 (chat history + character prompt 完整 → AI 人格健全)
//
// 流程:
//   1. Service Worker 收推送 → postMessage 主页面 {type:'PROACTIVE_WAKE', chatId, taskId, ...}
//   2. 主页面 listener 触发 → 找 chat → 检查睡眠时间 → 调 LLM 生成内容
//   3. 拿到 AI 回复 → 插入 chat history → 发 UPDATE_NOTIFICATION 给 SW 替换占位通知
//   4. 渲染到 UI (如果当前正在显示这个 chat)
//
// v0.1.84+ 引入, 2026-08-05
// ============================================================

(function() {
  'use strict';

  // ===== 睡眠时间检查 (user 当地时区) =====
  // 默认 23:00 - 08:00 不推送 (避免打扰 user 睡觉)
  // user 早上看 chat 时能看到 AI 想发但没发的消息 (自己决定是否回应)
  const SLEEP_START_HOUR = 23;
  const SLEEP_END_HOUR = 8;

  function isSleepTime() {
    try {
      const now = new Date();
      const hour = now.getHours();
      return hour >= SLEEP_START_HOUR || hour < SLEEP_END_HOUR;
    } catch (e) {
      return false;
    }
  }

  function formatTime(date = new Date()) {
    const hour = date.getHours();
    const minute = date.getMinutes().toString().padStart(2, '0');
    return `${hour}:${minute}`;
  }

  // ===== 调 LLM 生成 AI 主动消息 =====
  // v0.1.89+ 复用 ai-group.js 的 buildProactiveContext (跟老的应用内主动消息用同一份 context 构建)
  // 包含: 角色 prompt + 角色深度人设 + 勾选世界书 + 关联记忆 + 长期记忆双源 + 多层摘要 + 表情包 + 天气 + 亲属卡 + 短期历史
  async function generateProactiveMessage(chat, aiPromptHint) {
    const state = window.state;
    if (!state) {
      throw new Error('window.state 不可用');
    }

    // 1. 复用老功能的 context 构建 (跟老应用内主动消息一致)
    let ctx;
    if (typeof window.buildProactiveContext === 'function') {
      try {
        ctx = await window.buildProactiveContext(chat, { queryText: aiPromptHint || '主动消息生成' });
      } catch (e) {
        console.warn('[proactive-wake] buildProactiveContext 失败, 用 fallback:', e.message);
      }
    }
    if (!ctx) {
      throw new Error('buildProactiveContext 不可用 (ai-group.js 可能没加载)');
    }

    // 2. 拼 user prompt (覆盖老功能的, 因为新通道有 aiPromptHint)
    const userPrompt = aiPromptHint
      ? `【系统提示：主动消息触发 - 你主动找用户】\n\n你想表达的核心内容/话题: ${aiPromptHint}\n\n请用你自己的角色口吻发一条短消息 (微信聊天风格, 1-3 段, 末尾有语气词)。\n\n【输出格式】\n你的回复【必须】是一个 JSON 对象: {"type": "text", "content": "你想对用户说的话"}\n只输出 JSON, 不要其他内容。`
      : `【系统提示：主动消息触发 - 你主动找用户】\n\n请用你自己的角色口吻发一条短消息 (微信聊天风格, 1-3 段, 末尾有语气词)。\n\n【输出格式】\n你的回复【必须】是一个 JSON 对象: {"type": "text", "content": "你想对用户说的话"}\n只输出 JSON, 不要其他内容。`;

    // 3. 拼 chat history + 当前 user 提示
    const messagesForApi = (ctx.history || []).map(m => ({
      role: m.role,
      content: String(m.content)
    }));
    messagesForApi.push({ role: 'user', content: userPrompt });

    // 4. 调 LLM (跟老功能一致, 用主 API)
    const isGemini = String(ctx.proxyUrl || '').includes('generativelanguage.googleapis.com');
    const useMainApiProxy = !isGemini
      && typeof window.fetchViaOpenAICompatibleProxy === 'function'
      && typeof window.isMainApiProxyEnabled === 'function'
      && window.isMainApiProxyEnabled();
    const chatCompletionsUrl = `${String(ctx.proxyUrl).replace(/\/+$/, '')}/chat/completions`;

    const proactivePayload = {
      model: ctx.model,
      messages: [
        { role: 'system', content: ctx.systemPrompt },
        ...messagesForApi
      ],
      temperature: state.globalSettings.apiTemperature || 0.9
    };

    let response;
    if (isGemini) {
      // Gemini 走原函数 (跟老功能一致)
      const toGeminiFn = window.toGeminiRequestData;
      if (typeof toGeminiFn === 'function') {
        const geminiConfig = toGeminiFn(ctx.model, ctx.apiKey, ctx.systemPrompt, messagesForApi);
        response = await fetch(geminiConfig.url, geminiConfig.data);
      } else {
        // fallback
        response = await fetch(`${ctx.proxyUrl.replace(/\/+$/, '')}/v1beta/models/${ctx.model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: messagesForApi })
        });
      }
    } else if (useMainApiProxy) {
      response = await window.fetchViaOpenAICompatibleProxy({
        baseUrl: ctx.proxyUrl,
        targetPath: '/chat/completions',
        apiKey: ctx.apiKey,
        payload: proactivePayload,
        method: 'POST'
      });
    } else {
      response = await fetch(chatCompletionsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.apiKey}` },
        body: JSON.stringify(proactivePayload)
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`LLM API 失败: ${response.status} ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    // Gemini 响应解析
    let rawContent;
    if (isGemini) {
      const getGeminiFn = window.getGeminiResponseText;
      rawContent = typeof getGeminiFn === 'function' ? getGeminiFn(data) : (data?.candidates?.[0]?.content?.parts?.[0]?.text || '');
    } else {
      rawContent = data.choices?.[0]?.message?.content;
    }

    if (!rawContent || !rawContent.trim()) {
      throw new Error('LLM 返回空消息');
    }

    // 解析 JSON text action (跟老功能一致)
    const stripCodeFence = (text) => String(text || '')
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    const parseProactiveTextAction = (rawText) => {
      const cleaned = stripCodeFence(rawText);
      const candidates = [cleaned];
      const fencedMatch = String(rawText || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fencedMatch) candidates.push(fencedMatch[1].trim());
      const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
      if (arrayMatch) candidates.push(arrayMatch[0]);
      const objectMatch = cleaned.match(/\{[\s\S]*\}/);
      if (objectMatch) candidates.push(objectMatch[0]);

      for (const candidate of candidates) {
        try {
          const parsed = JSON.parse(stripCodeFence(candidate));
          if (Array.isArray(parsed)) {
            const textAction = parsed.find(item => item?.type === 'text' && item.content);
            if (textAction) return textAction;
          } else if (parsed?.type === 'text' && parsed.content) {
            return parsed;
          }
        } catch (e) {}
      }
      // 兜底: 直接返回 cleaned 字符串 (不是 JSON 也行)
      return { type: 'text', content: cleaned };
    };

    const action = parseProactiveTextAction(rawContent);
    return action.content || rawContent;
  }

  // ===== 插入 chat history =====
  function insertAiMessageToHistory(chat, message) {
    if (!chat.history) chat.history = [];
    chat.history.push({
      role: 'assistant',
      content: message,
      timestamp: Date.now(),
      // 标记: 这是 AI 主动消息, 不是 user 触发的
      proactive: true,
      taskId: chat._proactiveTaskId
    });
  }

  // ===== 持久化到 IndexedDB =====
  async function persistChat(chat) {
    try {
      if (window.db?.chats?.put) {
        await window.db.chats.put(chat);
      }
    } catch (e) {
      console.warn('[proactive-wake] 持久化 chat 失败:', e.message);
    }
  }

  // ===== 发 UPDATE_NOTIFICATION 给 SW =====
  function sendUpdateNotification(tag, title, body, notifData) {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'UPDATE_NOTIFICATION',
        tag,
        title,
        body,
        data: notifData
      });
    }
  }

  // ===== 渲染到 UI (如果当前正在显示这个 chat) =====
  function renderToUIIfActive(chatId) {
    try {
      if (window.state?.activeChatId === chatId && typeof window.renderChatMessages === 'function') {
        window.renderChatMessages();
      }
    } catch (e) {
      console.warn('[proactive-wake] 渲染 UI 失败:', e.message);
    }
  }

  // ===== 主入口: 处理一条 PROACTIVE_WAKE =====
  async function handleProactiveWake(payload) {
    const { chatId, taskId, charId, charName, messageType, aiPrompt, sentAt } = payload;
    console.log('[proactive-wake] 收到唤醒信号:', { chatId, taskId, messageType, charName });

    const state = window.state;
    if (!state) {
      console.warn('[proactive-wake] window.state 不可用, 跳过');
      return;
    }

    // 1. 找 chat
    const chat = state.chats?.[chatId];
    if (!chat) {
      console.warn('[proactive-wake] 找不到 chat:', chatId, '可能已被删除');
      return;
    }

    // 2. 标记 taskId 给 history 用
    chat._proactiveTaskId = taskId;

    // 3. 睡眠时间硬约束 (避免深夜打扰 user)
    if (isSleepTime()) {
      // 插历史 (user 早上看 chat 能看到 AI 想发但没发)
      const note = `（${formatTime()} 想发消息但怕吵醒你，忍住没说）`;
      insertAiMessageToHistory(chat, note);
      await persistChat(chat);
      renderToUIIfActive(chatId);
      console.log('[proactive-wake] 睡眠时间, 只插历史, 不推送');
      return;
    }

    // 4. 调 LLM 生成内容
    let aiMessage;
    try {
      aiMessage = await generateProactiveMessage(chat, aiPrompt);
    } catch (e) {
      console.error('[proactive-wake] LLM 生成失败:', e.message);
      // fallback: 插历史, 不弹通知
      insertAiMessageToHistory(chat, `(系统消息: AI 主动消息生成失败 - ${e.message})`);
      await persistChat(chat);
      renderToUIIfActive(chatId);
      return;
    }

    // 5. 插入 chat history
    insertAiMessageToHistory(chat, aiMessage);
    await persistChat(chat);

    // 6. 发 UPDATE_NOTIFICATION 给 SW 替换占位通知
    const tag = `task-${taskId}`;
    sendUpdateNotification(tag, `💬 ${charName || chat.name || 'AI'}`, aiMessage, {
      chatId,
      taskId,
      type: 'proactive-wake',
      messageType
    });

    // 7. 渲染到 UI
    renderToUIIfActive(chatId);

    console.log(`[proactive-wake] ✅ 完成: ${charName} → "${aiMessage.substring(0, 30)}..."`);
  }

  // ===== 监听 SW message =====
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data;
      if (!data) return;

      if (data.type === 'PROACTIVE_WAKE') {
        // 异步处理, 不阻塞 SW message handler
        handleProactiveWake(data).catch(err => {
          console.error('[proactive-wake] 处理失败:', err);
        });
      }
    });
    console.log('[proactive-wake] ✅ 已注册 PROACTIVE_WAKE listener');
  }

  // ===== 冷却时间检查 (v0.1.87+) =====
  // 防止 AI 在聊天过程中疯狂设主动消息, 刷屏 user
  // 默认 30 分钟 (user 可调 0=不限流)
  // 按 chat 角色算: chat.history 最后一条 assistant 消息时间 + cooldown < now → 拒绝
  function getCooldownMinutes() {
    const mins = window.state?.globalSettings?.proactiveCooldownMinutes;
    return (typeof mins === 'number' && mins >= 0) ? mins : 30;
  }

  function isCooldownActive(chat) {
    const cooldown = getCooldownMinutes();
    if (cooldown === 0) return false;  // 0 = 不限流
    if (!chat || !Array.isArray(chat.history) || chat.history.length === 0) return false;

    // 找最后一条 assistant 消息
    for (let i = chat.history.length - 1; i >= 0; i--) {
      const m = chat.history[i];
      if (m && (m.role === 'assistant' || m.senderName !== undefined)) {
        const lastTime = m.timestamp || 0;
        const elapsedMs = Date.now() - lastTime;
        return elapsedMs < cooldown * 60 * 1000;
      }
    }
    return false;
  }

  function getCooldownRemainingMinutes(chat) {
    const cooldown = getCooldownMinutes();
    if (cooldown === 0 || !chat || !Array.isArray(chat.history)) return 0;
    for (let i = chat.history.length - 1; i >= 0; i--) {
      const m = chat.history[i];
      if (m && (m.role === 'assistant' || m.senderName !== undefined)) {
        const lastTime = m.timestamp || 0;
        const elapsedMs = Date.now() - lastTime;
        const remainingMs = cooldown * 60 * 1000 - elapsedMs;
        return Math.max(0, Math.ceil(remainingMs / 60000));
      }
    }
    return 0;
  }

  // ===== 暴露 API 供调试 / 手动创建任务 =====
  // user 在桌面 console 调: await ProactiveWake.createTask({ userPrompt: '跟 user 聊今天吃了啥', recurrenceType: 'ai-decided' })
  async function createTask(options = {}) {
    const {
      userPrompt = '跟 user 聊聊天',
      recurrenceType = 'ai-decided',
      contactName = null,
      chatId = null
    } = options;

    const state = window.state;
    if (!state) throw new Error('window.state 不可用');

    // v0.2.07+: 移除 v0.1.91 误加的 mode !== 'push' throw 拦截
    // 设计: createTask 只服务 push 模式, 但拦截由管理页面 UI 控制 (app 模式时隐藏 [+ 创建任务] 按钮)
    // 这里不再 hard reject — 防御性检查留给 push-server 端 (subscription 检查)
    // (角色级总开关 chat.settings.proactiveEnabled 在下面单独检查, 这里只管渠道)

    // 1. 拿当前 chat (优先 activeChatId)
    const activeChatId = chatId || state.activeChatId;
    const chat = activeChatId ? state.chats?.[activeChatId] : null;
    const finalContactName = contactName || chat?.name || 'AI 角色';
    const finalChatId = chatId || activeChatId;

    if (!finalChatId) throw new Error('没指定 chatId 且当前不在 chat 中');
    if (!chat && !contactName) throw new Error('没 chat 上下文, 请传 contactName');

    // v0.1.91+ 角色级总开关: 关掉的话两个渠道都不发 (app 和 push 都跳过)
    // 设计: 角色级开关 = "能不能发" (总开关) + 全局 mode = "用什么发" (渠道), 两个独立维度
    if (chat && chat.settings?.proactiveEnabled !== true) {
      throw new Error(`角色 "${chat.name}" 未启用主动消息, 不能创建推送任务. 请在角色设置 → 启用主动消息 打开开关`);
    }

    // 冷却检查 (v0.1.87+)
    if (chat && isCooldownActive(chat)) {
      const remaining = getCooldownRemainingMinutes(chat);
      throw new Error(`冷却中: 同一角色聊天结束后 ${getCooldownMinutes()} 分钟内不能创建新任务, 还剩 ${remaining} 分钟`);
    }

    // 2. 拿 user LLM 配置 (push-server 内部 LLM 用)
    // v0.2.09 修: 之前 v0.2.06 读 globalSettings.apiUrl 是错的, 主 API 实际在 state.apiConfig
    // (user 截图 "user 没配 LLM" 误报 → 实际 user 在 API 设置配了, 字段读错)
    // v0.2.12 修: 优先直连 URL, 不传 proxyUrl (push-server 在云端, 不需要 CORS 绕过)
    const apiConfig = state.apiConfig || {};
    const settings = state.globalSettings || {};
    const aiApiUrl = apiConfig.apiUrl || apiConfig.mainApiUrl || apiConfig.proxyUrl || settings.apiUrl || settings.mainApiUrl;
    const aiApiKey = apiConfig.apiKey || apiConfig.mainApiKey || settings.apiKey || settings.mainApiKey;
    const aiModel = apiConfig.model || apiConfig.mainModel || settings.model || settings.mainModel || 'MiniMax/M3';
    if (!aiApiUrl || !aiApiKey) {
      throw new Error('user 没配 LLM (state.apiConfig.apiUrl/apiKey)');
    }

    // 3. 拿 push server URL
    const pushConfig = settings.systemNotification?.pushServer || {};
    const serverUrl = (pushConfig.serverUrl || '').replace(/\/$/, '');
    if (!serverUrl) throw new Error('push serverUrl 没配');

    // 4. 拿 push subscription (从 indexedDB 重新查)
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) throw new Error('还没订阅推送, 请先在通知推送栏启用');

    // 5. 拿 userId (v0.2.10+: 每 PWA 唯一 UUID, 防止串台)
    const userId = getOrCreatePushUserId();
    if (!userId) throw new Error('userId 找不到');

    // 6. 拿 user 当地当前时间
    const now = new Date();
    const localTime = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // 7. 提取最近 20 条聊天历史作为 context (v0.2.05: 让 LLM 决定下次时间时能接上话)
    let contextSummary = '';
    if (chat && Array.isArray(chat.history) && chat.history.length > 0) {
      const recent = chat.history.slice(-20);
      contextSummary = recent.map(m => {
        if (!m) return '';
        const role = m.role === 'user' ? 'user' : (m.role === 'assistant' ? 'AI' : (m.role || '?'));
        let text = '';
        if (typeof m.content === 'string') text = m.content;
        else if (Array.isArray(m.content)) text = m.content.filter(c => c && c.type === 'text').map(c => c.text || '').join('');
        return text ? `${role}: ${text.substring(0, 200)}` : '';
      }).filter(Boolean).join('\n');
    }

    // 8. 调 push-server /api/schedule-ai-task
    const response = await fetch(`${serverUrl}/api/schedule-ai-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        chatId: finalChatId,
        pushSubscription: subscription.toJSON(),
        contactName: finalContactName,
        contactPersonality: chat?.settings?.characterPersonality || null,
        userPrompt,
        contextSummary,  // v0.2.05: 最近 20 条对话上下文
        recurrenceType,
        aiApiUrl,
        aiApiKey,
        aiModel,
        currentLocalTime: localTime,
        userTimezone
      })
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`push-server 失败: ${response.status} ${errText.substring(0, 300)}`);
    }

    const data = await response.json();
    console.log('[ProactiveWake.createTask] ✅', data);
    return data;
  }

  // ===== 查订阅状态 =====
  async function getSubscriptionStatus() {
    try {
      if (!('serviceWorker' in navigator)) {
        return { supported: false, reason: '浏览器不支持 Service Worker' };
      }
      if (!('PushManager' in window)) {
        return { supported: false, reason: '浏览器不支持 Push API' };
      }
      const registration = await navigator.serviceWorker.ready.catch(() => null);
      if (!registration) {
        return { supported: true, subscribed: false, reason: 'Service Worker 未注册' };
      }
      const subscription = await registration.pushManager.getSubscription();
      return {
        supported: true,
        subscribed: !!subscription,
        subscription: subscription ? subscription.toJSON() : null,
        permission: Notification.permission
      };
    } catch (e) {
      return { supported: false, reason: e.message };
    }
  }

  // ===== 订阅推送 =====
  async function subscribe() {
    if (!('serviceWorker' in navigator)) {
      throw new Error('浏览器不支持 Service Worker');
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error('通知权限未授予（iPhone 还需要在 iOS 设置 → Safari → 高级 → 网站通知 启用）');
    }
    const registration = await navigator.serviceWorker.ready;
    if (!registration.pushManager) {
      throw new Error('当前环境不支持 Push API（iPhone 需要先把 PWA 加到主屏幕）');
    }

    // 拿 VAPID 公钥
    const settings = window.state?.globalSettings || {};
    const pushConfig = settings.systemNotification?.pushServer || {};
    const serverUrl = (pushConfig.serverUrl || '').replace(/\/$/, '');
    if (!serverUrl) {
      throw new Error('推送服务器地址没配（设置 → 通知 → 推送服务器地址）');
    }

    const vapidRes = await fetch(`${serverUrl}/api/vapid-public-key`);
    if (!vapidRes.ok) throw new Error('拿 VAPID 公钥失败');
    const { publicKey } = await vapidRes.json();

    // iOS 18.x PWA 双 fallback (ArrayBuffer 优先, Uint8Array 兜底)
    const abKey = urlBase64ToUint8Array(publicKey);
    let subscription;
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: abKey
      });
    } catch (abErr) {
      console.warn('[ProactiveWake.subscribe] ArrayBuffer 失败, 试 Uint8Array:', abErr.message);
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: new Uint8Array(abKey)
      });
    }

    // 保存到 push-server (v0.2.10+: 用每 PWA 唯一 UUID, 不再掉到 'default-user' fallback)
    const state = window.state;
    const userId = getOrCreatePushUserId();
    const saveRes = await fetch(`${serverUrl}/api/save-subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, subscription: subscription.toJSON() })
    });
    if (!saveRes.ok) {
      const err = await saveRes.text();
      throw new Error(`保存订阅失败: ${err.substring(0, 200)}`);
    }

    console.log('[ProactiveWake.subscribe] ✅ 订阅成功');
    return subscription;
  }

  // ===== 取消订阅 =====
  async function unsubscribe() {
    if (!('serviceWorker' in navigator)) return false;
    const registration = await navigator.serviceWorker.ready.catch(() => null);
    if (!registration) return false;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return true;
    return await subscription.unsubscribe();
  }

  // ===== urlBase64ToUint8Array (v0.2.02 改回 v0.1.84 跑通的版本: 返回 ArrayBuffer) =====
  // ★ v0.2.00 改返回 Uint8Array —— iOS 18.3.2 严格 PWA 拒, 报 "valid P-256 public key"
  // ★ v0.1.84 跑通的版本: 用 Uint8Array.from() 转换 + return u8.buffer (ArrayBuffer)
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    // iOS 18.3.2 PWA 严格模式: 返回 ArrayBuffer (u8.buffer) —— 这是 v0.1.84 跑通的格式
    const u8 = Uint8Array.from(rawData, c => c.charCodeAt(0));
    return u8.buffer;
  }

  // ===== 查任务列表 =====
  async function listTasks(userId = null) {
    const state = window.state;
    // v0.2.10+: 查任务列表也用每 PWA 唯一 UUID
    const finalUserId = userId || getOrCreatePushUserId();
    const settings = state?.globalSettings || {};
    const pushConfig = settings.systemNotification?.pushServer || {};
    const serverUrl = (pushConfig.serverUrl || '').replace(/\/$/, '');
    if (!serverUrl) throw new Error('推送服务器地址没配');

    const res = await fetch(`${serverUrl}/api/tasks?userId=${encodeURIComponent(finalUserId)}`);
    if (!res.ok) throw new Error(`查任务失败: ${res.status}`);
    const data = await res.json();
    return data.tasks || [];
  }

  // ===== 删任务 =====
  async function deleteTask(taskId) {
    const settings = window.state?.globalSettings || {};
    const pushConfig = settings.systemNotification?.pushServer || {};
    const serverUrl = (pushConfig.serverUrl || '').replace(/\/$/, '');
    if (!serverUrl) throw new Error('推送服务器地址没配');

    const res = await fetch(`${serverUrl}/api/tasks/${taskId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`删任务失败: ${res.status}`);
    return true;
  }

  // ===== 发测试推送 (fixed 模式 - 立即测试推送链路) =====
  async function sendTestPush(options = {}) {
    const state = window.state;
    // v0.2.10+: 用每 PWA 唯一 UUID, 不用 state.userId/currentUserId/deviceId + 'default-user' fallback
    //   老逻辑会导致多 PWA 串台: user 1 没配 userId 掉到 'default-user', user 2 也一样 → 全推给同一个订阅
    const userId = getOrCreatePushUserId();
    const settings = state?.globalSettings || {};
    const pushConfig = settings.systemNotification?.pushServer || {};
    const serverUrl = (pushConfig.serverUrl || '').replace(/\/$/, '');
    if (!serverUrl) throw new Error('推送服务器地址没配');

    const { title = '🧪 330 推送测试', body = '如果你看到这条, 推送链路通了! 🎉' } = options;

    const res = await fetch(`${serverUrl}/api/test-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, title, body })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`测试推送失败: ${res.status} ${err.substring(0, 200)}`);
    }
    return await res.json();
  }

  // ===== 创建 fixed 模式任务 (user 填消息内容) =====
  async function createFixedTask(options = {}) {
    const {
      userMessage,
      userPrompt = null,
      contactName = null,
      chatId = null,
      firstSendTime = null,  // ISO 字符串, null = 1 分钟后
      recurrenceType = 'none'
    } = options;

    if (!userMessage) throw new Error('userMessage 必填');

    const state = window.state;
    if (!state) throw new Error('window.state 不可用');

    // v0.2.07+: 移除 v0.1.91 误加的 mode !== 'push' throw 拦截 (同 createTask, 由 UI 控制)
    // (角色级总开关 chat.settings.proactiveEnabled 在下面单独检查, 这里只管渠道)

    const activeChatId = chatId || state.activeChatId;
    const chat = activeChatId ? state.chats?.[activeChatId] : null;
    const finalContactName = contactName || chat?.name || 'AI 角色';

    if (!finalContactName) throw new Error('没指定 contactName 且当前不在 chat 中');

    // v0.1.91+ 角色级总开关: 关掉的话两个渠道都不发 (app 和 push 都跳过)
    if (chat && chat.settings?.proactiveEnabled !== true) {
      throw new Error(`角色 "${chat.name}" 未启用主动消息, 不能创建推送任务. 请在角色设置 → 启用主动消息 打开开关`);
    }

    const settings = state.globalSettings || {};
    const pushConfig = settings.systemNotification?.pushServer || {};
    const serverUrl = (pushConfig.serverUrl || '').replace(/\/$/, '');
    if (!serverUrl) throw new Error('推送服务器地址没配');

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) throw new Error('还没订阅推送, 请先订阅');

    const userId = getOrCreatePushUserId(); // v0.2.10+: 每 PWA 唯一 UUID, 防止串台

    // 默认 1 分钟后发
    const finalFirstSendTime = firstSendTime || new Date(Date.now() + 60 * 1000).toISOString();

    const res = await fetch(`${serverUrl}/api/schedule-notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        chatId: activeChatId,
        pushSubscription: subscription.toJSON(),
        contactName: finalContactName,
        contactPersonality: chat?.settings?.characterPersonality || null,
        messageType: 'fixed',
        userMessage,
        userPrompt,
        firstSendTime: finalFirstSendTime,
        recurrenceType
      })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`创建任务失败: ${res.status} ${err.substring(0, 300)}`);
    }
    return await res.json();
  }

  // ===== AI JSON 指令处理 (function calling 入口) =====
  // 330 主体 chat AI 在回复里输出 {"type": "create_push_task", ...} 指令 → 调这个
  // chat 是 window.state.chats[chatId] 或群聊里的某个角色 chat (function calling 自动判断)
  async function tryHandleAction(msgData, chat) {
    if (!msgData || msgData.type !== 'create_push_task') return false;

    const logPrefix = '[ProactiveWake.tryHandleAction]';
    try {
      const userPrompt = (msgData.userPrompt || '').trim();
      if (!userPrompt) {
        console.warn(`${logPrefix} userPrompt 空, 跳过`);
        return true;  // 已处理, 不让 LLM 重试
      }

      // 决定 chat 上下文
      const targetChat = chat || (() => {
        const activeId = window.state?.activeChatId;
        return activeId ? window.state.chats?.[activeId] : null;
      })();

      // v0.2.07+: 应用内模式 (默认) 静默拒绝 — 应用内不需要 AI 设任务, 老 scheduler 会自动跑
      // 老 scheduler 路径: background-activity.js startProactiveScheduler (按 chat.history 最后一条消息 + interval 自动发)
      // 要 push 模式 AI 才能创建任务 (走 push-server)
      const mode = window.state?.globalSettings?.proactiveDeliveryMode || 'app';
      if (mode === 'app') {
        console.log(`${logPrefix} 应用内模式不需要 AI 设任务, 老 scheduler 会按 [启用主动消息] 的角色自动发 (要 AI 设任务, 切到 [🔔 系统推送])`);
        return true;  // 已处理 (拒绝也是处理), 不让 LLM 报错
      }

      // v0.1.91+ 角色级总开关: 关掉的话两个渠道都不发
      if (targetChat && targetChat.settings?.proactiveEnabled !== true) {
        console.log(`${logPrefix} 角色 "${targetChat.name}" 未启用主动消息, AI 不能创建推送任务 (在角色设置里打开 [启用主动消息])`);
        return true;  // 已处理 (拒绝也是处理), 不让 LLM 报错
      }

      // 冷却检查 (v0.1.87+) — AI 调工具也限流
      if (targetChat && isCooldownActive(targetChat)) {
        const remaining = getCooldownRemainingMinutes(targetChat);
        console.log(`${logPrefix} ⏸ 冷却中, 还剩 ${remaining} 分钟, AI 调用被忽略`);
        return true;  // 已处理 (拒绝也是处理), 不让 LLM 报错
      }

      // 决定 contactName: 优先用 chat, 群聊场景 LLM 输出的 name 字段作为角色
      const contactName = (msgData.contactName || msgData.name || targetChat?.name || 'AI 角色').trim();

      console.log(`${logPrefix} AI 想设主动消息:`, {
        contactName,
        userPrompt: userPrompt.substring(0, 60),
        recurrenceType: msgData.recurrenceType || 'ai-decided',
        chatId: targetChat?.id
      });

      // 调 createTask (走 push-server, AI-decided 模式 LLM 决定时间)
      const result = await createTask({
        userPrompt,
        contactName,
        chatId: targetChat?.id,
        recurrenceType: msgData.recurrenceType || 'ai-decided'
      });

      console.log(`${logPrefix} ✅ 任务已创建:`, result?.task?.id);
      return true;
    } catch (e) {
      console.error(`${logPrefix} 创建任务失败:`, e.message);
      return true;  // 已处理 (失败也是处理), 不让 LLM 重试
    }
  }

  // ===== 暴露 API =====
  window.ProactiveWake = {
    handleProactiveWake,
    createTask,           // AI-decided (调 LLM 决定时间)
    createFixedTask,      // fixed 模式 (user 填消息)
    listTasks,
    deleteTask,
    getSubscriptionStatus,
    subscribe,
    unsubscribe,
    sendTestPush,
    tryHandleAction,      // ★ AI JSON 指令入口 (function calling 风格)
    isSleepTime,
    formatTime,
    // 冷却相关
    getCooldownMinutes,
    isCooldownActive,
    getCooldownRemainingMinutes
  };

  console.log('[proactive-wake] 模块加载完成');
})();
