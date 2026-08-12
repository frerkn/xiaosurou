// ============================================================
// in-app-proactive-patrol.js — 应用内模式 PWA 前端巡视任务
// v0.2.17 引入, 2026-08-10
//
// 跟 push 模式 (server 端巡视 + web-push 推送) 完全独立:
//   - PWA 前端 setInterval 巡视
//   - 调 LLM 决策 send / skip (假装活人感)
//   - send: 调 LLM 生成消息 + 浏览器 Notification API 弹通知 + 插历史
//   - skip: 跳过 (用户看不到任何东西, 像没事发生)
//   - PWA 死了 (iOS 强杀 setInterval) 就不巡视
//   - 用户自己靠 iPhone 外放无声音频保活 PWA 在线 (1 小时左右)
//
// 跟旧"固定时间必然发"区别:
//   旧: setInterval 触发 → 必然发 (死板)
//   新: setInterval 触发 → 问 AI 要不要发 → 真人感 (70% skip / 30% send)
//
// 配置 (window.state.globalSettings):
//   inAppProactiveEnabled    bool, 默认 true (启用应用内模式巡视)
//   inAppProactiveIntervalMin number, 默认 30 (间隔分钟)
//   inAppProactiveMinIdleMin  number, 默认 5 (距最后一条消息最小 idle 分钟)
//
// 触发条件 (全满足才巡视):
//   1. inAppProactiveEnabled === true
//   2. 当前不在睡眠时间 (23:00 - 08:00)
//   3. active chat 存在 + chat.settings.proactiveEnabled === true
//   4. 距最后一条消息 >= inAppProactiveMinIdleMin 分钟
// ============================================================

(function() {
  'use strict';

  const DEFAULT_INTERVAL_MIN = 20;
  const DEFAULT_MIN_IDLE_MIN = 5;
  // v0.2.18+: 睡眠时间改读 globalSettings (UI 在 proactive-wake-ui.js)
  const DEFAULT_SLEEP_START_HOUR = 23;
  const DEFAULT_SLEEP_END_HOUR = 8;

  let inAppProactiveIntervalId = null;

  // ===== 配置读取 =====
  function getInAppProactiveConfig() {
    const settings = window.state?.globalSettings || {};
    return {
      enabled: settings.inAppProactiveEnabled !== false,  // 默认 true
      intervalMin: (typeof settings.inAppProactiveIntervalMin === 'number' && settings.inAppProactiveIntervalMin > 0)
        ? settings.inAppProactiveIntervalMin
        : DEFAULT_INTERVAL_MIN,
      minIdleMin: (typeof settings.inAppProactiveMinIdleMin === 'number' && settings.inAppProactiveMinIdleMin >= 0)
        ? settings.inAppProactiveMinIdleMin
        : DEFAULT_MIN_IDLE_MIN
    };
  }

  // v0.2.18+: 改读 globalSettings, 支持跨午夜 (23-8, 1-6 等) + 关闭开关全天巡视
  function isSleepTime() {
    const settings = window.state?.globalSettings;
    if (!settings) return false;
    // 关闭睡眠跳过 = 24小时都巡视
    if (settings.inAppProactiveSleepEnabled === false) return false;

    // 读小时, 缺省值与 UI 默认一致
    const start = (typeof settings.inAppProactiveSleepStartHour === 'number'
      && settings.inAppProactiveSleepStartHour >= 0
      && settings.inAppProactiveSleepStartHour <= 23)
      ? settings.inAppProactiveSleepStartHour : DEFAULT_SLEEP_START_HOUR;
    const end = (typeof settings.inAppProactiveSleepEndHour === 'number'
      && settings.inAppProactiveSleepEndHour >= 0
      && settings.inAppProactiveSleepEndHour <= 23)
      ? settings.inAppProactiveSleepEndHour : DEFAULT_SLEEP_END_HOUR;

    const hour = new Date().getHours();
    if (start === end) return false;  // 起止相同 = 不跳过 (全天巡视)
    if (start < end) return hour >= start && hour < end;     // 不跨午夜 (1-6)
    return hour >= start || hour < end;                       // 跨午夜 (23-8)
  }

  function getLastMessageTime(chat) {
    if (!chat?.history || chat.history.length === 0) return 0;
    const last = chat.history[chat.history.length - 1];
    return last?.timestamp || 0;
  }

  function getMinutesSinceLastMessage(chat) {
    const last = getLastMessageTime(chat);
    if (!last) return Infinity;
    return (Date.now() - last) / 60000;
  }

  // v0.2.17+: 移植自 v0.2.08 老巡视 retry context — 算"连续 AI 主动消息 user 没接"次数
  // 给 LLM 信息 ("你发了 N 条没回"), 不强制约束, 让 LLM 自己想
  function getConsecutiveUnreplied(chat) {
    if (!chat?.history || chat.history.length === 0) return 0;
    let count = 0;
    for (let i = chat.history.length - 1; i >= 0; i--) {
      const m = chat.history[i];
      if (!m) break;
      if (m.role === 'user') break;  // user 接了一条, 计数停
      if (m.role === 'assistant' && m.proactive) {
        count++;
      } else if (m.role === 'assistant' && !m.proactive) {
        break;  // 正常对话 AI 消息, 停
      }
    }
    return count;
  }

  // ===== 调 LLM 决策 send/skip =====
  async function decideProactiveMessage(chat) {
    if (typeof window.buildProactiveContext !== 'function') {
      throw new Error('buildProactiveContext 不可用 (ai-group.js 可能没加载)');
    }

    // v0.2.17+: retry context — 告诉 LLM 你发了 N 条 user 没回, 让 LLM 自己想
    const consecutiveUnreplied = getConsecutiveUnreplied(chat);

    const ctx = await window.buildProactiveContext(chat, { queryText: '主动消息巡视决策' });

    const decisionPrompt = `【系统提示：主动消息巡视】

你正在"假装活人"地决定要不要主动发消息给用户。

请考虑以下因素:
- 当前时间 (user 当地时间)
- 你和 user 上次聊了什么 (最近聊天记录在历史里)
- 你的人设 / 性格 / 当前心情 / 跟 user 的关系
- 距离上次发主动消息多久了 (冷却时间)
- user 最近有没有回复你 (如果没回, 不要再刷屏)
- 是不是深夜 / user 在忙

请像真人一样判断, 完全根据你的人设、记忆、上下文决定要不要发. 你刚才已经发了 ${consecutiveUnreplied} 条 user 没回, 你自己想想, 50% 的概率应该 skip, 50% 概率 send.

只输出严格 JSON: {"action": "send" | "skip", "reason": "你的判断理由"}`;

    const messages = [
      { role: 'system', content: ctx.systemPrompt },
      ...(ctx.history || []).map(m => ({ role: m.role, content: String(m.content) })),
      { role: 'user', content: decisionPrompt }
    ];

    // 调 LLM (复用 proactive-wake.js generateProactiveMessage 的 fetch 逻辑)
    const isGemini = String(ctx.proxyUrl || '').includes('generativelanguage.googleapis.com');
    const useMainApiProxy = !isGemini
      && typeof window.fetchViaOpenAICompatibleProxy === 'function'
      && typeof window.isMainApiProxyEnabled === 'function'
      && window.isMainApiProxyEnabled();
    const chatCompletionsUrl = `${String(ctx.proxyUrl).replace(/\/+$/, '')}/chat/completions`;

    const payload = {
      model: ctx.model,
      messages,
      temperature: 0.7
    };

    let response;
    if (isGemini) {
      const toGeminiFn = window.toGeminiRequestData;
      if (typeof toGeminiFn === 'function') {
        const geminiConfig = toGeminiFn(ctx.model, ctx.apiKey, ctx.systemPrompt, messages.slice(1));
        response = await fetch(geminiConfig.url, geminiConfig.data);
      } else {
        response = await fetch(`${ctx.proxyUrl.replace(/\/+$/, '')}/v1beta/models/${ctx.model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: messages.slice(1) })
        });
      }
    } else if (useMainApiProxy) {
      response = await window.fetchViaOpenAICompatibleProxy({
        baseUrl: ctx.proxyUrl,
        targetPath: '/chat/completions',
        apiKey: ctx.apiKey,
        payload,
        method: 'POST'
      });
    } else {
      response = await fetch(chatCompletionsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.apiKey}` },
        body: JSON.stringify(payload)
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`LLM 决策 API 失败: ${response.status} ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    let rawContent;
    if (isGemini) {
      const getGeminiFn = window.getGeminiResponseText;
      rawContent = typeof getGeminiFn === 'function' ? getGeminiFn(data) : (data?.candidates?.[0]?.content?.parts?.[0]?.text || '');
    } else {
      rawContent = data.choices?.[0]?.message?.content;
    }

    if (!rawContent || !rawContent.trim()) {
      throw new Error('LLM 决策返回空');
    }

    const cleaned = String(rawContent)
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    try {
      const parsed = JSON.parse(cleaned);
      return {
        action: parsed.action === 'send' ? 'send' : 'skip',
        reason: parsed.reason || '(无原因)'
      };
    } catch (e) {
      // 兜底: 默认 skip (避免刷屏)
      console.warn('[in-app-proactive] 决策 JSON 解析失败, 默认 skip:', cleaned.substring(0, 100));
      return { action: 'skip', reason: '决策 JSON 解析失败' };
    }
  }

  // ===== 浏览器通知 =====
  function showInAppNotification(chat, message) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') {
      console.warn('[in-app-proactive] 通知权限未授权, 跳过弹通知');
      return;
    }
    // v0.2.18+: 听 systemNotification 总开关 (v0.2.17 之前绕过, 关总开关照样弹)
    if (!window.state?.globalSettings?.systemNotification?.enabled) {
      console.log('[in-app-proactive] 系统通知总开关关闭, 跳过弹通知 (消息仍写入历史)');
      return;
    }
    try {
      const n = new Notification(`💬 ${chat.name || 'AI'}`, {
        body: message.substring(0, 100),
        tag: `in-app-proactive-${chat.id}-${Date.now()}`,
        requireInteraction: false
      });
      n.onclick = () => {
        window.focus();
        if (typeof window.openChat === 'function') window.openChat(chat.id);
        n.close();
      };
    } catch (e) {
      console.warn('[in-app-proactive] 通知弹失败:', e.message);
    }
  }

  // ===== 插历史 + 持久化 =====
  async function persistProactiveMessage(chat, message) {
    if (!chat.history) chat.history = [];
    chat.history.push({
      role: 'assistant',
      content: message,
      timestamp: Date.now(),
      proactive: true,
      source: 'in-app-proactive-patrol'
    });
    try {
      if (window.db?.chats?.put) await window.db.chats.put(chat);
    } catch (e) {
      console.warn('[in-app-proactive] 持久化失败:', e.message);
    }
  }

  // ===== 渲染 UI (如果当前显示这个 chat) =====
  function renderToUIIfActive(chatId) {
    try {
      if (window.state?.activeChatId === chatId && typeof window.renderChatMessages === 'function') {
        window.renderChatMessages();
      }
    } catch (e) {}
  }

  // ===== 单次巡视 =====
  async function runInAppProactiveTick(options = {}) {
    // v0.2.17+: mode='push' 时 v0.2.17 跳过, 让 push-server 接管
    const mode = window.state?.globalSettings?.proactiveDeliveryMode || 'app';
    if (mode === 'push') {
      console.log('[in-app-proactive] mode=push, 跳过 v0.2.17 (推送任务由 push-server 接管)');
      return;
    }
    try {
      console.log('[in-app-proactive] 巡视 tick...');

      const state = window.state;
      if (!state) return;

      if (isSleepTime()) {
        console.log('[in-app-proactive] 睡眠时间, 跳过');
        return;
      }

      const chatId = state.activeChatId;
      const chat = chatId ? state.chats?.[chatId] : null;
      if (!chat) {
        console.log('[in-app-proactive] 没 active chat, 跳过');
        return;
      }

      if (chat.settings?.proactiveEnabled !== true) {
        console.log('[in-app-proactive] chat 未启用主动消息, 跳过');
        return;
      }

      // idle 检查 (启动后第一次 tick 用 skipIdleCheck=true 跳过, 让 user 能立刻看到效果)
      if (!options.skipIdleCheck) {
        const config = getInAppProactiveConfig();
        const idleMin = getMinutesSinceLastMessage(chat);
        if (idleMin < config.minIdleMin) {
          console.log(`[in-app-proactive] idle ${idleMin.toFixed(1)} 分钟 < ${config.minIdleMin}, 跳过`);
          return;
        }
      } else {
        console.log('[in-app-proactive] 跳过 idle 检查 (启动后第一次 tick)');
      }

      // 调 LLM 决策
      const decision = await decideProactiveMessage(chat);
      console.log(`[in-app-proactive] LLM 决策: ${decision.action} (${decision.reason})`);
      if (decision.action !== 'send') return;

      // 调 LLM 生成消息 (复用 proactive-wake.js 的 generateProactiveMessage)
      if (typeof window.ProactiveWake?.generateProactiveMessage !== 'function') {
        throw new Error('ProactiveWake.generateProactiveMessage 不可用 (proactive-wake.js 可能没加载)');
      }
      const message = await window.ProactiveWake.generateProactiveMessage(chat, null);
      if (!message) {
        console.warn('[in-app-proactive] 消息生成空, 跳过');
        return;
      }

      // 插历史 + 持久化
      await persistProactiveMessage(chat, message);

      // 浏览器通知
      showInAppNotification(chat, message);

      // 渲染 UI
      renderToUIIfActive(chatId);

      console.log(`[in-app-proactive] ✅ 已发: "${message.substring(0, 30)}..."`);
    } catch (e) {
      console.error('[in-app-proactive] 巡视失败:', e.message);
    }
  }

  // ===== 启停 =====
  function startInAppProactivePatrol() {
    if (inAppProactiveIntervalId) return;
    const config = getInAppProactiveConfig();
    if (!config.enabled) {
      console.log('[in-app-proactive] 未启用, 不启动');
      return;
    }
    const intervalMs = config.intervalMin * 60 * 1000;
    inAppProactiveIntervalId = setInterval(runInAppProactiveTick, intervalMs);
    // 启动 5s 后先跑一次 (跳过 idle 检查), 让 user 测的时候能立刻看到效果, 不等 30 分钟
    setTimeout(() => runInAppProactiveTick({ skipIdleCheck: true }), 5000);
    console.log(`[in-app-proactive] ✅ 启动, 间隔 ${config.intervalMin} 分钟, 最小 idle ${config.minIdleMin} 分钟, 5s 后先跑一次 tick (跳过 idle)`);
    console.log('[in-app-proactive] 注: PWA 死了 iOS 强杀 setInterval = 不巡视, 用户靠 iPhone 外放无声音频保活');
  }

  function stopInAppProactivePatrol() {
    if (inAppProactiveIntervalId) {
      clearInterval(inAppProactiveIntervalId);
      inAppProactiveIntervalId = null;
    }
    console.log('[in-app-proactive] 停止');
  }

  // ===== 暴露 API =====
  window.InAppProactive = {
    start: startInAppProactivePatrol,
    stop: stopInAppProactivePatrol,
    tick: runInAppProactiveTick,
    isRunning: () => !!inAppProactiveIntervalId,
    showInAppNotification,
    decideProactiveMessage
  };

  // ===== 页面加载时自动启动 =====
  // 等 5s 让 PWA 初始化完 (state / db / buildProactiveContext / globalSettings 都加载好)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(startInAppProactivePatrol, 5000);
    });
  } else {
    setTimeout(startInAppProactivePatrol, 5000);
  }

  console.log('[in-app-proactive] ✅ 模块加载完成');
})();
