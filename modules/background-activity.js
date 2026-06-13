// ========== 后台活动模块 ==========
// 来源：script.js 第 21043~21384, 37449~37788, 47205~47250 行
// 功能：后台模拟活动、NPC行动生成、后台保活、页面可见性处理
// 包含：startBackgroundSimulation, stopBackgroundSimulation, runBackgroundSimulationTick,
//       generateNpcActions, simulateBackgroundActivity, initializeBackgroundKeepAlive,
//       startBackgroundKeepAlive, stopBackgroundKeepAlive, handleVisibilityChange,
//       bindBackgroundKeepAliveEvents, loadBackgroundKeepAliveSettings

  function startBackgroundSimulation() {
    if (simulationIntervalId) return;
    const intervalSeconds = state.globalSettings.backgroundActivityInterval || 60;

    simulationIntervalId = setInterval(runBackgroundSimulationTick, intervalSeconds * 1000);
    playSilentAudio();
  }

  function stopBackgroundSimulation() {
    if (simulationIntervalId) {
      clearInterval(simulationIntervalId);
      simulationIntervalId = null;
    }
    stopSilentAudio();
  }




  const aiReminderTriggerLocks = new Set();
  let aiReminderSchedulerIntervalId = null;
  let aiReminderSchedulerEventsBound = false;
  let aiReminderScanInProgress = false;

  const AI_REMINDER_SCHEDULER_INTERVAL_MS = 30000;
  const AI_REMINDER_DEBUG_STORAGE_KEY = 'aiReminderDebugLogs';
  const AI_REMINDER_DEBUG_MAX_LOGS = 100;
  const AI_REMINDER_DEBUG_DETAIL_MAX_LENGTH = 300;
  const AI_REMINDER_RECENT_MESSAGE_LIMIT = 50;
  const AI_REMINDER_MAX_TEXT_LENGTH = 200;
  const AI_REMINDER_API_TIMEOUT_MS = 60000;

  function sanitizeAiReminderDebugDetail(detail) {
    const sensitiveKeyRe = /(api[-_]?key|authorization|token|password|passwd|secret|bearer|cookie|set-cookie)/i;

    function sanitize(value, depth = 0, seen = new WeakSet()) {
      if (value == null) return value;
      if (typeof value === 'string') {
        let text = value
          .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g, '[image/base64 omitted]')
          .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
          .replace(/[A-Za-z0-9+/]{800,}={0,2}/g, '[base64 omitted]');
        if (text.length > AI_REMINDER_DEBUG_DETAIL_MAX_LENGTH) {
          text = `${text.slice(0, AI_REMINDER_DEBUG_DETAIL_MAX_LENGTH)}...`;
        }
        return text;
      }
      if (typeof value === 'number' || typeof value === 'boolean') return value;
      if (value instanceof Error) return sanitize(value.message || value.name || 'Error');
      if (typeof value !== 'object') return sanitize(String(value));
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      if (depth >= 2) return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]';

      const out = {};
      Object.keys(value).slice(0, 20).forEach(key => {
        if (sensitiveKeyRe.test(key)) {
          out[key] = '[REDACTED]';
        } else if (/^(content|text|message|body|prompt|image|imageUrl|url)$/i.test(key)) {
          const raw = value[key];
          if (typeof raw === 'string') out[key] = sanitize(raw);
          else if (Array.isArray(raw)) out[key] = `[Array(${raw.length})]`;
          else if (raw && typeof raw === 'object') out[key] = '[Object omitted]';
          else out[key] = raw;
        } else {
          out[key] = sanitize(value[key], depth + 1, seen);
        }
      });
      return out;
    }

    const sanitized = sanitize(detail);
    const text = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
    return text.length > AI_REMINDER_DEBUG_DETAIL_MAX_LENGTH
      ? `${text.slice(0, AI_REMINDER_DEBUG_DETAIL_MAX_LENGTH)}...`
      : text;
  }

  function readAiReminderDebugLogs() {
    try {
      const parsed = JSON.parse(localStorage.getItem(AI_REMINDER_DEBUG_STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.slice(-AI_REMINDER_DEBUG_MAX_LOGS) : [];
    } catch (_) {
      return [];
    }
  }

  function writeAiReminderDebugLogs(logs) {
    try {
      localStorage.setItem(AI_REMINDER_DEBUG_STORAGE_KEY, JSON.stringify(logs.slice(-AI_REMINDER_DEBUG_MAX_LOGS)));
    } catch (_) {
      // 调试日志写入失败不影响提醒业务。
    }
  }

  function logAiReminderDebug(event, reminder, detail = {}) {
    const entry = {
      time: new Date().toISOString(),
      event: String(event || 'AI_REMINDER_UNKNOWN'),
      reminderId: reminder?.id || detail?.reminderId || null,
      reminderName: reminder?.title || reminder?.name || detail?.reminderName || '',
      detail: sanitizeAiReminderDebugDetail(detail)
    };

    const logs = readAiReminderDebugLogs();
    logs.push(entry);
    writeAiReminderDebugLogs(logs);

    if (window.runtimeDiag && typeof window.runtimeDiag.log === 'function') {
      try {
        window.runtimeDiag.log(event, {
          reminderId: entry.reminderId,
          reminderName: entry.reminderName,
          detail: entry.detail
        });
      } catch (_) {}
    }

    return entry;
  }

  function getFixedAiReminderText(reminder) {
    return String(reminder?.content || '').trim();
  }

  function truncateAiReminderText(text, maxLength = AI_REMINDER_MAX_TEXT_LENGTH) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    if (source.length <= maxLength) return source;
    const sliced = source.slice(0, maxLength);
    const lastPunctuation = Math.max(
      sliced.lastIndexOf('。'),
      sliced.lastIndexOf('！'),
      sliced.lastIndexOf('？'),
      sliced.lastIndexOf('!'),
      sliced.lastIndexOf('?')
    );
    return (lastPunctuation >= 60 ? sliced.slice(0, lastPunctuation + 1) : sliced).trim();
  }

  function getAiReminderValueType(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (value instanceof Date) return 'Date';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  function summarizeAiReminderNextTriggerAt(value) {
    const type = getAiReminderValueType(value);
    if (value instanceof Date) {
      return {
        type,
        value: Number.isFinite(value.getTime()) ? value.toISOString() : 'Invalid Date'
      };
    }
    if (typeof value === 'number') {
      return {
        type,
        value: Number.isFinite(value) ? value : String(value)
      };
    }
    if (typeof value === 'string') {
      return {
        type,
        value: value.length > 80 ? `${value.slice(0, 80)}...` : value
      };
    }
    if (value == null) {
      return {
        type,
        value: value === null ? null : 'undefined'
      };
    }
    return {
      type,
      value: '[unsupported]'
    };
  }

  function normalizeAiReminderNextTriggerAt(value) {
    const summary = summarizeAiReminderNextTriggerAt(value);

    if (typeof value === 'number') {
      if (Number.isFinite(value)) {
        return {
          ok: true,
          time: value,
          ...summary
        };
      }
      return {
        ok: false,
        time: null,
        reason: 'number_not_finite',
        ...summary
      };
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return {
          ok: false,
          time: null,
          reason: 'empty_string',
          ...summary
        };
      }

      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed)) {
        return {
          ok: true,
          time: parsed,
          ...summary
        };
      }

      return {
        ok: false,
        time: null,
        reason: 'string_parse_failed',
        ...summary
      };
    }

    if (value instanceof Date) {
      const time = value.getTime();
      if (Number.isFinite(time)) {
        return {
          ok: true,
          time,
          ...summary
        };
      }

      return {
        ok: false,
        time: null,
        reason: 'invalid_date',
        ...summary
      };
    }

    return {
      ok: false,
      time: null,
      reason: value == null ? 'missing_nextTriggerAt' : 'unsupported_type',
      ...summary
    };
  }

  function cleanAiReminderGeneratedText(rawText) {
    let text = String(rawText || '').trim();
    if (!text) return '';

    text = text
      .replace(/^```(?:json|markdown|md|text)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    text = text
      .replace(/^(?:提醒语|提醒文案|以下是(?:提醒语|提醒文案)?|生成结果|回复内容)\s*[:：]\s*/i, '')
      .replace(/^["“”'‘’]+|["“”'‘’]+$/g, '')
      .trim();

    return truncateAiReminderText(text);
  }

  function extractAiReminderTextFromResponse(rawContent, chat, proxyUrl, latestUserMessage) {
    const raw = String(rawContent || '').trim();
    if (!raw) return '';

    const isOfficialMinimax = String(proxyUrl || '').toLowerCase().includes('api.minimaxi.com');
    const parsedActions = isOfficialMinimax && typeof normalizeOfficialMinimaxOutput === 'function'
      ? normalizeOfficialMinimaxOutput(raw, latestUserMessage || '')
      : (typeof parseAiResponse === 'function' ? parseAiResponse(raw) : null);

    if (Array.isArray(parsedActions)) {
      for (const action of parsedActions) {
        if (!action || typeof action !== 'object') continue;
        if (action.type === 'thought_chain' || action.type === 'internal_state' || action.type === 'character_thoughts') continue;

        const candidate = action.content || action.message || action.text || action.dialogue || action.description;
        const cleaned = cleanAiReminderGeneratedText(candidate);
        if (cleaned) return cleaned;
      }
    }

    return cleanAiReminderGeneratedText(raw);
  }

  function sanitizeAiReminderPromptText(value, maxLength = 1200) {
    let text = String(value || '');
    text = text.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g, '[图片数据已省略]');
    text = text.replace(/[A-Za-z0-9+/]{800,}={0,2}/g, '[疑似base64内容已省略]');
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  }

  async function getRecentAiReminderMessages(chat) {
    if (!chat?.id) return [];

    if (window.messageStore?.getRecentContextMessages) {
      return window.messageStore.getRecentContextMessages(chat.id, {
        limit: AI_REMINDER_RECENT_MESSAGE_LIMIT,
        excludeHidden: false,
        excludeExcluded: true
      });
    }

    if (window.db?.messages) {
      const rows = await db.messages
        .where('[chatId+timestamp]')
        .between([chat.id, Dexie.minKey], [chat.id, Dexie.maxKey])
        .reverse()
        .limit(AI_REMINDER_RECENT_MESSAGE_LIMIT * 2)
        .toArray();

      return rows
        .reverse()
        .filter(msg => !msg.isExcluded)
        .slice(-AI_REMINDER_RECENT_MESSAGE_LIMIT);
    }

    throw new Error('messages 表或安全消息读取函数不可用');
  }

  function buildAiReminderWorldBookContext(chat) {
    let worldBookContent = '';
    const worldBooks = Array.isArray(state.worldBooks) ? state.worldBooks : [];
    const allWorldBookIds = [...(chat?.settings?.linkedWorldBookIds || [])];

    worldBooks.forEach(wb => {
      if (wb.isGlobal && !allWorldBookIds.includes(wb.id)) {
        allWorldBookIds.push(wb.id);
      }
    });

    if (allWorldBookIds.length > 0) {
      const linkedContents = allWorldBookIds.map(bookId => {
        const worldBook = worldBooks.find(wb => wb.id === bookId);
        if (!worldBook || !Array.isArray(worldBook.content)) return '';

        const formattedEntries = worldBook.content
          .filter(entry => entry.enabled !== false)
          .map(entry => {
            let entryString = `\n### 条目: ${entry.comment || '无备注'}\n`;
            entryString += `**内容:**\n${entry.content}`;
            return entryString;
          })
          .join('');

        return formattedEntries ? `\n\n## 世界书: ${worldBook.name}\n${formattedEntries}` : '';
      }).filter(Boolean).join('');

      if (linkedContents) {
        worldBookContent = `# --- 世界书 (World Book) ---
# 【最高优先级指令：绝对真理】
# 以下内容是你所在世界的“物理法则”和“基础常识”。
# 无论用户是否提及，你都【必须】时刻主动应用这些设定来指导你的思考和描写。
# 它们是无条件生效的，不需要触发词。
${linkedContents}
# --- 世界书设定结束 ---
`;
      }
    }

    return worldBookContent;
  }

  async function buildAiReminderLongTermMemoryContext(chat, recentMessages) {
    const queryTextForVector = (recentMessages || [])
      .slice(-5)
      .map(msg => typeof msg.content === 'string' ? msg.content : '')
      .join(' ');

    if (chat?.isGroup) {
      let longTermMemoryContext = '# 长期记忆 (最高优先级，这是群内已经确立的事实，所有角色必须严格遵守)\n';
      let collectedMemories = false;

      for (const member of chat.members || []) {
        const memberChat = state.chats?.[member.id] || await db.chats.get(member.id).catch(() => null);
        if (!memberChat) continue;

        const memMode = memberChat.settings?.memoryMode || (memberChat.settings?.enableStructuredMemory ? 'structured' : 'diary');
        let memberMemContent = '';

        if (memMode === 'vector' && window.vectorMemoryManager) {
          memberMemContent = await window.vectorMemoryManager.serializeForPrompt(memberChat, queryTextForVector);
        } else if (memMode === 'structured' && window.structuredMemoryManager) {
          memberMemContent = window.structuredMemoryManager.serializeForPrompt(memberChat);
        } else if (memberChat.longTermMemory && memberChat.longTermMemory.length > 0) {
          memberMemContent = memberChat.longTermMemory.map(mem => `- (记录于 ${typeof formatTimeAgo === 'function' ? formatTimeAgo(mem.timestamp) : mem.timestamp}) ${mem.content}`).join('\n');
        }

        if (memberMemContent && memberMemContent.trim()) {
          longTermMemoryContext += `\n## --- 关于“${member.groupNickname || member.originalName}”的记忆 ---\n${memberMemContent}\n`;
          collectedMemories = true;
        }
      }

      return collectedMemories ? longTermMemoryContext : `${longTermMemoryContext}- (暂无)`;
    }

    const memMode = chat?.settings?.memoryMode || (chat?.settings?.enableStructuredMemory ? 'structured' : 'diary');
    if (memMode === 'vector' && window.vectorMemoryManager) {
      return await window.vectorMemoryManager.serializeForPrompt(chat, queryTextForVector);
    }
    if (memMode === 'structured' && window.structuredMemoryManager) {
      return window.structuredMemoryManager.serializeForPrompt(chat);
    }
    if (typeof getMemoryContextForPrompt === 'function') {
      return getMemoryContextForPrompt(chat);
    }
    return chat?.longTermMemory && chat.longTermMemory.length > 0
      ? chat.longTermMemory.map(mem => `- ${mem.content}`).join('\n')
      : '- (暂无)';
  }

  function formatAiReminderMessageForPrompt(chat, msg) {
    if (!msg || typeof msg !== 'object') return null;
    if (msg.isExcluded) return null;
    if (msg.isHidden && typeof msg.content === 'string' && msg.content.includes('[这是你上一轮的内部思考]')) return null;

    const timestamp = msg.timestamp ? `(Timestamp: ${msg.timestamp}) ` : '';
    const sender = msg.role === 'user'
      ? (chat?.settings?.myNickname || '我')
      : (chat?.isGroup && typeof getDisplayNameInGroup === 'function'
        ? getDisplayNameInGroup(chat, msg.senderName)
        : (msg.senderName || chat?.name || 'AI'));

    if (msg.role === 'system') {
      if (msg.type === 'narration') return { role: 'user', content: `${timestamp}[旁白] ${sanitizeAiReminderPromptText(msg.content)}` };
      if (msg.isHidden) return { role: 'user', content: sanitizeAiReminderPromptText(msg.content) };
      return { role: 'user', content: `${timestamp}[系统] ${sanitizeAiReminderPromptText(msg.content)}` };
    }

    let content = '';
    if (Array.isArray(msg.content)) {
      content = '[用户发送了一张图片，图片原始数据已省略。]';
    } else if (msg.type === 'user_photo' || msg.type === 'ai_image') {
      content = `[图片消息，描述：${sanitizeAiReminderPromptText(msg.content || msg.description || msg.prompt)}]`;
    } else if (msg.type === 'voice_message') {
      content = `[语音消息：${sanitizeAiReminderPromptText(msg.content)}]`;
    } else if (msg.type === 'sticker') {
      content = `[表情：${sanitizeAiReminderPromptText(msg.meaning || msg.content || 'sticker')}]`;
    } else if (msg.type === 'transfer') {
      content = `[转账：${sanitizeAiReminderPromptText(msg.amount)}${msg.currency || '元'}，备注：${sanitizeAiReminderPromptText(msg.note)}]`;
    } else {
      content = sanitizeAiReminderPromptText(msg.content);
    }

    if (!content) return null;

    if (msg.role === 'assistant') {
      return {
        role: 'assistant',
        content: `${timestamp}${JSON.stringify([{ type: msg.type || 'text', content }])}`
      };
    }

    return {
      role: 'user',
      content: `${timestamp}${sender}: ${content}`
    };
  }

  function getAiReminderCurrentTimeContext(chat) {
    const now = new Date();
    const customTimeInfo = typeof window.getCustomTime === 'function' ? window.getCustomTime() : null;

    if (customTimeInfo && customTimeInfo.enabled) {
      const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
      const weekDay = weekDays[customTimeInfo.date.getDay()];
      return `${customTimeInfo.year}年${customTimeInfo.month}月${customTimeInfo.day}日${weekDay} ${String(customTimeInfo.hour).padStart(2, '0')}:${String(customTimeInfo.minute).padStart(2, '0')}`;
    }

    const selectedTimeZone = chat?.settings?.timeZone || 'Asia/Shanghai';
    return now.toLocaleString('zh-CN', {
      timeZone: selectedTimeZone,
      dateStyle: 'full',
      timeStyle: 'short'
    });
  }

  function buildAiReminderTaskInstruction(reminder, chat) {
    const triggerAtInfo = normalizeAiReminderNextTriggerAt(reminder?.nextTriggerAt ?? reminder?.remindAt);
    const triggerTimeText = triggerAtInfo.ok && triggerAtInfo.time > 0
      ? new Date(triggerAtInfo.time).toLocaleString('zh-CN', { hour12: false })
      : '(未设置)';
    const characterName = reminder?.characterName || chat?.name || chat?.originalName || '角色';

    return `# 【定时提醒任务】
这是一次到点触发的定时提醒，请在完整遵守你的人设、关系、世界书、长期记忆和最近聊天语境的前提下，像正式主动聊天一样自然开口提醒用户。

- reminder.title: ${sanitizeAiReminderPromptText(reminder?.title || '定时提醒')}
- reminder.content: ${sanitizeAiReminderPromptText(reminder?.content || '')}
- reminder.remindAt / nextTriggerAt: ${triggerTimeText}
- characterName: ${sanitizeAiReminderPromptText(characterName)}

要求：
1. 必须以“${sanitizeAiReminderPromptText(characterName)}”自己的口吻自然主动提醒用户。
2. 要体现角色身份感、关系感和当前聊天语境。
3. 不要解释任务。
4. 不要说自己是系统、闹钟或程序。
5. 不要输出多段长文。
6. 尽量控制在 200 字以内。
7. 只输出最终要发送给用户的一条提醒语；如果按原聊天格式输出 JSON，也只能包含一条 text/offline_text 内容。`;
  }

  async function buildAiReminderFormalChatContext(reminder, chat) {
    const recentMessages = await getRecentAiReminderMessages(chat);
    const filteredRecentMessages = typeof filterHistoryWithDoNotSendRules === 'function'
      ? await filterHistoryWithDoNotSendRules(recentMessages, chat.id)
      : recentMessages;

    const worldBookContent = buildAiReminderWorldBookContext(chat);
    const longTermMemoryContext = await buildAiReminderLongTermMemoryContext(chat, filteredRecentMessages);
    const currentTime = getAiReminderCurrentTimeContext(chat);
    const timeOfDayGreeting = typeof getTimeOfDayGreeting === 'function' ? getTimeOfDayGreeting(new Date()) : '';
    const myNickname = chat?.settings?.myNickname || '我';
    const userName = state.qzoneSettings?.nickname || '用户';
    const aiAgeContext = typeof getDynamicAgeContext === 'function' ? getDynamicAgeContext(chat) : '';
    const currencyExchangeContext = chat?.settings?.enableDynamicCurrency && typeof getCurrencyExchangeContext === 'function' ? getCurrencyExchangeContext() : '';
    const stickerContext = chat?.isGroup
      ? (typeof getGroupStickerContextForPrompt === 'function' ? getGroupStickerContextForPrompt(chat) : '')
      : (typeof getStickerContextForPrompt === 'function' ? getStickerContextForPrompt(chat) : '');

    const promptType = chat?.isGroup ? 'group' : 'single';
    const systemPromptTemplate = window.getActiveChatPrompt ? window.getActiveChatPrompt(promptType) : '';

    let contextMap;
    if (chat?.isGroup) {
      const memberNames = (chat.members || []).map(m => m.originalName);
      const membersWithContacts = (chat.members || []).map(member => `- **${member.groupNickname}** (本名: ${member.originalName}): ${member.persona}`).join('\n');
      contextMap = {
        aiAgeContext,
        currencyExchangeContext,
        char_avatar: chat.settings?.groupAvatar || '',
        user_avatar: chat.settings?.myAvatar || state.qzoneSettings?.avatar || '',
        char_name: chat.originalName || chat.name,
        char_remark: chat.name,
        user_name: userName,
        user_nickname: myNickname,
        memberNames: memberNames.join('、 '),
        myNickname,
        myOriginalName: userName,
        groupTimePerceptionInstruction: chat.settings?.enableTimePerception ? `**情景感知**: 当前时间 ${currentTime} ${timeOfDayGreeting}。` : '',
        readingContextStr: '按当前聊天阅读状态处理。',
        groupCrossChatInstruction: '',
        'chat.name': chat.name,
        groupTimeContextText: chat.settings?.enableTimePerception ? `- **当前时间**: ${currentTime} (${timeOfDayGreeting})` : '',
        groupLongTimeNoSeeContext: '',
        membersWithContacts,
        myPersona: chat.settings?.myPersona || '普通用户',
        userStatus: chat.settings?.userStatus ? chat.settings.userStatus.text : '在线',
        worldBookContent,
        longTermMemoryContext,
        memoryModeContext: longTermMemoryContext,
        multiLayeredSummaryContext_group: '',
        linkedMemoryContext: '',
        musicContext: '',
        sharedContext: '',
        groupAvatarLibraryContext: '',
        stickerContext,
        forbiddenNamesContext: '',
        callTranscriptContext: '',
        synthMusicInstruction: '',
        narratorInstruction: '',
        novelAiImageGroupContext: '',
        googleImagenGroupContext: '',
        bilingualAlertVoice: ''
      };
    } else {
      contextMap = {
        aiAgeContext,
        currencyExchangeContext,
        char_avatar: chat.settings?.aiAvatar || '',
        user_avatar: chat.settings?.myAvatar || state.qzoneSettings?.avatar || '',
        char_name: chat.originalName || chat.name,
        char_remark: chat.name,
        user_name: userName,
        user_nickname: myNickname,
        'chat.originalName': chat.originalName || chat.name,
        aiPersona: chat.settings?.aiPersona || '',
        latestThoughtContext: chat.settings?.injectLatestThought && chat.heartfeltVoice ? `# 你的内心独白\n- 心声: ${chat.heartfeltVoice}\n- 散记: ${chat.randomJottings || ''}` : '',
        worldBookContent: worldBookContent || '(当前无特殊世界观设定，以现实逻辑为准)',
        memoryContextForPrompt: longTermMemoryContext,
        multiLayeredSummaryContext: '',
        todoListContext: '',
        periodSummaryContext: '',
        'chat.name': chat.name,
        myNickname,
        myPersona: chat.settings?.myPersona || '普通用户',
        userStatus: chat.settings?.userStatus ? chat.settings.userStatus.text : '在线',
        userProfileContext: `- 用户的QZone昵称是 "${userName}"。`,
        nameHistoryContext: chat.nameHistory?.length ? `\n- **你的曾用名**: [${chat.nameHistory.join(', ')}]。` : '',
        timePerceptionContext: chat.settings?.enableTimePerception ? `- **当前时间**: ${currentTime} (${timeOfDayGreeting})` : '',
        weatherContext: typeof getWeatherContextForPrompt === 'function' ? await getWeatherContextForPrompt(chat) : '',
        timeContext: '',
        musicContextStr: '按当前聊天音乐状态处理。',
        readingContextStr: '按当前聊天阅读状态处理。',
        contactsList: '',
        postsContext: '',
        groupContext: '',
        sharedContext: '',
        callTranscriptContext: '',
        synthMusicInstruction: '',
        narratorInstruction: '',
        kinshipContext: '',
        coupleSpaceContext: '',
        bilingualModeContext: chat.settings?.enableBilingualMode ? '必须使用已启用的双语格式。' : '',
        thoughtsPrompt: '',
        bilingualAlertText: chat.settings?.enableBilingualMode ? ' ⚠️ 必须使用双语格式：外语〖中文〗' : '',
        bilingualAlertVoice: chat.settings?.enableBilingualMode ? ' ⚠️ 必须使用双语格式：外语〖中文〗' : '',
        novelAiImageContext: '',
        googleImagenContext: '',
        qzoneActionsPrompt: '',
        viewMyPhonePrompt: '',
        crossChatInstruction: '',
        todoInstruction: '',
        stickerContext,
        aiAvatarLibrary: chat.settings?.aiAvatarLibrary?.length ? chat.settings.aiAvatarLibrary.map(avatar => `- ${avatar.name}`).join('\n') : '- (空)',
        myAvatarLibrary: chat.settings?.myAvatarLibrary?.length ? chat.settings.myAvatarLibrary.map(avatar => `- ${avatar.name}`).join('\n') : '- (空)'
      };
    }

    let systemPrompt = typeof replaceTemplateVars === 'function'
      ? replaceTemplateVars(systemPromptTemplate, contextMap)
      : systemPromptTemplate;

    if (typeof processPromptWithSettings === 'function') {
      systemPrompt = processPromptWithSettings(systemPrompt, promptType);
    }

    const messagesPayload = filteredRecentMessages
      .slice(-AI_REMINDER_RECENT_MESSAGE_LIMIT)
      .map(msg => formatAiReminderMessageForPrompt(chat, msg))
      .filter(Boolean);

    const taskInstruction = buildAiReminderTaskInstruction(reminder, chat);
    messagesPayload.push({
      role: 'user',
      content: taskInstruction
    });

    return {
      systemPrompt,
      messagesPayload,
      latestUserMessage: taskInstruction
    };
  }

  async function requestAiReminderCompletion(chat, systemPrompt, messagesPayload) {
    const mainApiConfig = typeof resolveApiSlotConfig === 'function'
      ? await resolveApiSlotConfig('main')
      : state.apiConfig;
    let apiConfig = mainApiConfig;
    if (chat?.apiOverride?.enabled) {
      apiConfig = {
        proxyUrl: chat.apiOverride.proxyUrl || mainApiConfig.proxyUrl,
        apiKey: chat.apiOverride.apiKey || mainApiConfig.apiKey,
        model: chat.apiOverride.model || mainApiConfig.model
      };
    }

    const { proxyUrl, apiKey, model } = apiConfig || {};
    if (!proxyUrl || !apiKey || !model) {
      throw new Error('API未配置');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AI_REMINDER_API_TIMEOUT_MS);

    try {
      const isGemini = String(proxyUrl).includes('generativelanguage');
      if (isGemini) {
        const geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesPayload);
        const response = await fetch(geminiConfig.url, {
          ...geminiConfig.data,
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
        const data = await response.json();
        return {
          rawContent: getGeminiResponseText(data),
          proxyUrl
        };
      }

      const response = await fetch(`${proxyUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt }, ...messagesPayload],
          temperature: state.globalSettings.apiTemperature || 0.8,
          top_p: state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0,
          presence_penalty: state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0,
          frequency_penalty: state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0,
          stream: false
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        let errorMessage = `${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          errorMessage = errorData?.error?.message || errorData?.message || errorMessage;
        } catch (e) {}
        throw new Error(`API请求失败: ${errorMessage}`);
      }

      const data = await response.json();
      return {
        rawContent: getGeminiResponseText(data),
        proxyUrl
      };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('AI生成超时');
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function generateAiReminderText(reminder, chat) {
    const fallbackText = getFixedAiReminderText(reminder);
    const now = Date.now();

    try {
      const context = await buildAiReminderFormalChatContext(reminder, chat);
      logAiReminderDebug('AI_REMINDER_API_START', reminder, {
        chatId: chat?.id || reminder?.characterId || '',
        model: chat?.apiOverride?.enabled ? (chat.apiOverride.model || state.apiConfig?.model || '') : (state.apiConfig?.model || '')
      });
      const completion = await requestAiReminderCompletion(chat, context.systemPrompt, context.messagesPayload);
      const text = extractAiReminderTextFromResponse(completion.rawContent, chat, completion.proxyUrl, context.latestUserMessage);

      if (!text) {
        throw new Error('AI返回空内容');
      }

      logAiReminderDebug('AI_REMINDER_API_DONE', reminder, {
        chatId: chat?.id || reminder?.characterId || '',
        generatedLength: text.length
      });

      return {
        text,
        ok: true,
        result: 'success',
        error: '',
        aiFields: {
          lastAiGenerateAt: now,
          lastAiGenerateResult: 'success',
          lastAiGenerateError: ''
        }
      };
    } catch (error) {
      const message = error?.message || String(error);
      logAiReminderDebug('AI_REMINDER_API_ERROR', reminder, {
        error: message
      });
      console.warn('[AI定时提醒] AI生成失败，回退固定文案:', reminder?.id, error);
      return {
        text: fallbackText,
        ok: false,
        result: 'fallback',
        error: message.slice(0, 160),
        aiFields: {
          lastAiGenerateAt: now,
          lastAiGenerateResult: 'fallback',
          lastAiGenerateError: message.slice(0, 160)
        }
      };
    }
  }

  function getNextAiReminderTriggerAt(reminder, now) {
    const repeatType = reminder?.repeatType || 'none';
    const normalizedNext = normalizeAiReminderNextTriggerAt(reminder?.nextTriggerAt ?? reminder?.remindAt);
    let next = normalizedNext.ok ? normalizedNext.time : null;
    if (!Number.isFinite(next) || next <= 0) return null;

    const interval = repeatType === 'weekly'
      ? 7 * 24 * 60 * 60 * 1000
      : repeatType === 'daily'
        ? 24 * 60 * 60 * 1000
        : 0;

    if (!interval) return null;
    while (next <= now) next += interval;
    return next;
  }

  function buildAiReminderUpdate(reminder, now, result) {
    const repeatType = reminder?.repeatType || 'none';
    const update = {
      lastTriggeredAt: now,
      updatedAt: now,
      lastTriggerResult: result.triggerResult || (result.ok ? 'success' : 'failed'),
      lastTriggerError: result.error || '',
      lastTriggerMessagePreview: String(result.messagePreview || '').slice(0, 100)
    };

    if (result.aiFields && typeof result.aiFields === 'object') {
      Object.assign(update, result.aiFields);
    }

    if (repeatType === 'none') {
      update.enabled = false;
      update.nextTriggerAt = null;
    } else {
      update.nextTriggerAt = getNextAiReminderTriggerAt(reminder, now);
      if (!update.nextTriggerAt || update.nextTriggerAt <= now) {
        update.enabled = false;
        update.lastTriggerResult = 'failed';
        update.lastTriggerError = [update.lastTriggerError, '无法计算下一次提醒时间'].filter(Boolean).join('；');
        update.nextTriggerAt = null;
      }
    }

    return update;
  }

  async function insertAiReminderIntoChat(reminder, text, now) {
    const chatId = reminder?.characterId;
    if (!chatId) throw new Error('缺少 characterId');

    const chat = state.chats?.[chatId] || await db.chats.get(chatId);
    if (!chat) throw new Error(`找不到聊天 ${chatId}`);

    if (state.chats && !state.chats[chatId]) {
      state.chats[chatId] = chat;
    }

    const message = {
      role: 'assistant',
      senderName: reminder.characterName || chat.originalName || chat.name,
      type: 'text',
      content: text,
      timestamp: now,
      source: 'aiReminder',
      reminderId: reminder.id
    };

    if (window.messageStore?.addMessageToChat) {
      await window.messageStore.addMessageToChat(chat, message);
    } else if (db.messages?.put) {
      const messageId = `${chatId}::${now}::assistant::text::aiReminder::${reminder.id}`;
      await db.messages.put({
        ...message,
        id: messageId,
        chatId
      });
    } else {
      throw new Error('messageStore 与 db.messages 均不可用，无法写入提醒消息');
    }

    if (state.activeChatId === chatId && typeof renderChatInterface === 'function') {
      await renderChatInterface(chatId);
    }
    if (typeof renderChatList === 'function') {
      renderChatList();
    }

    return true;
  }

  async function sendAiReminderSystemNotification(reminder, text) {
    const chatId = reminder?.characterId;
    if (!chatId) throw new Error('缺少 characterId');

    const config = state.globalSettings?.systemNotification;
    if (!config?.enabled) throw new Error('系统通知未启用');
    if (typeof Notification === 'undefined') throw new Error('当前浏览器不支持系统通知');
    if (Notification.permission !== 'granted') throw new Error('通知权限未授权');

    if (typeof showSystemNotification === 'function') {
      await showSystemNotification(chatId, text, {
        title: reminder.title || '定时提醒'
      });
      return true;
    }

    if (typeof handleSystemNotification === 'function') {
      await handleSystemNotification(chatId, text);
      return true;
    }

    throw new Error('系统通知发送函数不可用');
  }

  async function playAiReminderSound() {
    if (typeof playNotificationSound === 'function') {
      playNotificationSound();
      return true;
    }

    if (typeof playSystemNotificationSound === 'function') {
      playSystemNotificationSound();
      return true;
    }

    throw new Error('未找到独立轻量提示音能力');
  }

  async function triggerDueAiReminder(reminder, now) {
    logAiReminderDebug('AI_REMINDER_TRIGGER_START', reminder, {
      nextTriggerAt: reminder?.nextTriggerAt || null,
      useAI: !!reminder?.useAI,
      insertIntoChat: !!reminder?.insertIntoChat,
      sendSystemNotification: !!reminder?.sendSystemNotification
    });

    const fixedText = getFixedAiReminderText(reminder);
    if (!reminder?.useAI && !fixedText) {
      logAiReminderDebug('AI_REMINDER_TRIGGER_SKIPPED', reminder, {
        reason: 'no_content_and_ai_disabled'
      });
      const skippedResult = {
        ok: false,
        triggerResult: 'skipped',
        error: 'no_content_and_ai_disabled',
        messagePreview: ''
      };
      await db.aiReminders.update(reminder.id, buildAiReminderUpdate(reminder, now, skippedResult));
      return skippedResult;
    }

    const chatId = reminder?.characterId;
    const chat = chatId ? (state.chats?.[chatId] || await db.chats.get(chatId)) : null;
    const aiTextResult = reminder.useAI
      ? await generateAiReminderText(reminder, chat)
      : {
          text: fixedText,
          ok: true,
          result: 'success',
          error: '',
          aiFields: {}
        };
    const text = aiTextResult.text || getFixedAiReminderText(reminder);
    const result = {
      ok: false,
      triggerResult: aiTextResult.result || 'success',
      error: aiTextResult.error ? `AI生成失败：${aiTextResult.error}` : '',
      messagePreview: text,
      aiFields: aiTextResult.aiFields || {}
    };
    const errors = [];
    let delivered = false;

    if (result.error) {
      errors.push(result.error);
    }

    if (reminder.insertIntoChat) {
      try {
        logAiReminderDebug('AI_REMINDER_INSERT_CHAT_START', reminder, {
          chatId: reminder.characterId
        });
        await insertAiReminderIntoChat(reminder, text, now);
        logAiReminderDebug('AI_REMINDER_INSERT_CHAT_DONE', reminder, {
          chatId: reminder.characterId
        });
        delivered = true;
      } catch (error) {
        const message = error?.message || String(error);
        logAiReminderDebug('AI_REMINDER_INSERT_CHAT_ERROR', reminder, {
          chatId: reminder.characterId,
          error: message
        });
        errors.push(`插入聊天失败：${message}`);
        console.warn('[AI定时提醒] 插入聊天失败:', reminder.id, error);
      }
    }

    if (reminder.sendSystemNotification) {
      try {
        await sendAiReminderSystemNotification(reminder, text);
        logAiReminderDebug('AI_REMINDER_NOTIFICATION_SENT', reminder, {
          chatId: reminder.characterId
        });
        delivered = true;
      } catch (error) {
        const message = error?.message || String(error);
        logAiReminderDebug('AI_REMINDER_NOTIFICATION_ERROR', reminder, {
          chatId: reminder.characterId,
          error: message
        });
        errors.push(`系统通知失败：${message}`);
        console.warn('[AI定时提醒] 系统通知失败:', reminder.id, error);
      }
    }

    if (reminder.playSound) {
      try {
        await playAiReminderSound();
        delivered = true;
      } catch (error) {
        const message = error?.message || String(error);
        errors.push(`提示音失败：${message}`);
        console.warn('[AI定时提醒] 提示音未实现或播放失败:', reminder.id, error);
      }
    }

    if (!reminder.insertIntoChat && !reminder.sendSystemNotification && !reminder.playSound) {
      errors.push('提醒没有启用任何触达方式');
    }

    const deliveryErrors = errors.filter(error => !String(error).startsWith('AI生成失败：'));
    result.ok = delivered && deliveryErrors.length === 0;
    result.error = errors.join('；');
    if (deliveryErrors.length > 0 && result.triggerResult !== 'fallback') {
      result.triggerResult = 'failed';
    }
    const update = buildAiReminderUpdate(reminder, now, result);
    await db.aiReminders.update(reminder.id, update);

    if (update.enabled === false && update.nextTriggerAt == null) {
      logAiReminderDebug('AI_REMINDER_COMPLETED', reminder, {
        repeatType: reminder.repeatType || 'none',
        triggerResult: result.triggerResult,
        error: result.error || ''
      });
    } else if (update.nextTriggerAt) {
      logAiReminderDebug('AI_REMINDER_NEXT_SCHEDULED', reminder, {
        repeatType: reminder.repeatType || 'none',
        nextTriggerAt: update.nextTriggerAt
      });
    }

    return result;
  }

  async function scanDueAiReminders(reason = 'manual') {
    if (!window.db?.aiReminders) return;

    if (aiReminderScanInProgress) {
      logAiReminderDebug('AI_REMINDER_SCAN_START', null, {
        reason,
        skipped: true,
        skipReason: 'scan_in_progress'
      });
      return;
    }

    aiReminderScanInProgress = true;
    const now = Date.now();
    let scannedCount = 0;
    let dueCount = 0;
    let invalidCount = 0;
    let dueReminders = [];

    logAiReminderDebug('AI_REMINDER_SCAN_START', null, {
      reason,
      now
    });

    try {
      const allReminders = await db.aiReminders.toArray();
      const enabledReminders = allReminders.filter(reminder => reminder?.enabled === true);
      scannedCount = enabledReminders.length;

      for (const reminder of enabledReminders) {
        try {
          const normalized = normalizeAiReminderNextTriggerAt(reminder?.nextTriggerAt);

          if (!normalized.ok) {
            invalidCount += 1;
            logAiReminderDebug('AI_REMINDER_INVALID_NEXT_TRIGGER', reminder, {
              reason: normalized.reason,
              nextTriggerAtType: normalized.type,
              nextTriggerAtValue: normalized.value
            });
            continue;
          }

          if (typeof reminder.nextTriggerAt === 'string' && normalized.time !== reminder.nextTriggerAt) {
            try {
              await db.aiReminders.update(reminder.id, {
                nextTriggerAt: normalized.time,
                updatedAt: Date.now()
              });
            } catch (normalizeSaveError) {
              logAiReminderDebug('AI_REMINDER_SCAN_ERROR', reminder, {
                reason: 'normalize_save_failed',
                nextTriggerAtType: normalized.type,
                nextTriggerAtValue: normalized.value,
                error: normalizeSaveError?.message || String(normalizeSaveError)
              });
            }
          }

          if (normalized.time <= now) {
            dueReminders.push({
              ...reminder,
              nextTriggerAt: normalized.time
            });
          }
        } catch (reminderScanError) {
          invalidCount += 1;
          logAiReminderDebug('AI_REMINDER_INVALID_NEXT_TRIGGER', reminder, {
            reason: 'per_reminder_scan_exception',
            ...summarizeAiReminderNextTriggerAt(reminder?.nextTriggerAt),
            error: reminderScanError?.message || String(reminderScanError)
          });
        }
      }

      dueCount = dueReminders.length;
      dueReminders = dueReminders.slice(0, 20);

      for (const reminder of dueReminders) {
        if (!reminder?.id || aiReminderTriggerLocks.has(reminder.id)) continue;

        logAiReminderDebug('AI_REMINDER_DUE_FOUND', reminder, {
          nextTriggerAt: reminder.nextTriggerAt,
          now
        });
        aiReminderTriggerLocks.add(reminder.id);
        try {
          const latest = await db.aiReminders.get(reminder.id);
          const latestNextTriggerAt = normalizeAiReminderNextTriggerAt(latest?.nextTriggerAt);
          if (!latest || latest.enabled !== true) {
            continue;
          }

          if (!latestNextTriggerAt.ok) {
            invalidCount += 1;
            logAiReminderDebug('AI_REMINDER_INVALID_NEXT_TRIGGER', latest, {
              reason: latestNextTriggerAt.reason,
              nextTriggerAtType: latestNextTriggerAt.type,
              nextTriggerAtValue: latestNextTriggerAt.value
            });
            continue;
          }

          if (latestNextTriggerAt.time > Date.now()) {
            continue;
          }

          await triggerDueAiReminder({
            ...latest,
            nextTriggerAt: latestNextTriggerAt.time
          }, Date.now());
        } catch (error) {
          const errorMessage = error?.message || String(error);
          logAiReminderDebug('AI_REMINDER_TRIGGER_SKIPPED', reminder, {
            reason: 'trigger_exception',
            error: errorMessage
          });
          console.error('[AI定时提醒] 触发提醒失败:', reminder.id, error);
          try {
            const latest = await db.aiReminders.get(reminder.id);
            if (latest) {
              await db.aiReminders.update(reminder.id, buildAiReminderUpdate(latest, Date.now(), {
                ok: false,
                error: `触发异常：${errorMessage}`,
                messagePreview: getFixedAiReminderText(latest)
              }));
            }
          } catch (updateError) {
            console.warn('[AI定时提醒] 写入失败状态失败:', reminder.id, updateError);
          }
        } finally {
          aiReminderTriggerLocks.delete(reminder.id);
        }
      }

      logAiReminderDebug('AI_REMINDER_SCAN_DONE', null, {
        reason,
        now,
        scannedCount,
        dueCount,
        invalidCount,
        processedCount: dueReminders.length
      });
    } catch (error) {
      logAiReminderDebug('AI_REMINDER_SCAN_ERROR', null, {
        reason,
        now,
        scannedCount,
        dueCount,
        invalidCount,
        error: error?.message || String(error)
      });
      console.warn('[AI定时提醒] 扫描到点提醒失败:', error);
    } finally {
      aiReminderScanInProgress = false;
    }
  }

  function runAIReminderImmediateScan(reason = 'manual') {
    return scanDueAiReminders(reason);
  }

  function bindAIReminderSchedulerEvents() {
    if (aiReminderSchedulerEventsBound) return;
    aiReminderSchedulerEventsBound = true;

    window.addEventListener('pageshow', () => {
      runAIReminderImmediateScan('pageshow');
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        runAIReminderImmediateScan('visibility_visible');
      }
    });
  }

  function startAIReminderScheduler() {
    if (aiReminderSchedulerIntervalId) return;

    bindAIReminderSchedulerEvents();
    logAiReminderDebug('AI_REMINDER_SCHEDULER_START', null, {
      intervalMs: AI_REMINDER_SCHEDULER_INTERVAL_MS
    });
    runAIReminderImmediateScan('scheduler_start');
    aiReminderSchedulerIntervalId = setInterval(() => {
      runAIReminderImmediateScan('interval');
    }, AI_REMINDER_SCHEDULER_INTERVAL_MS);
  }

  function stopAIReminderScheduler() {
    if (!aiReminderSchedulerIntervalId) return;
    clearInterval(aiReminderSchedulerIntervalId);
    aiReminderSchedulerIntervalId = null;
  }

  async function runBackgroundSimulationTick() {
    console.log("模拟器心跳 Tick...");
    if (!state.globalSettings.enableBackgroundActivity) {
      stopBackgroundSimulation();
      return;
    }

    await scanDueAiReminders();


    const allSingleChats = Object.values(state.chats).filter(chat => !chat.isGroup);
    allSingleChats.forEach(chat => {
      if (chat.relationship?.status === 'blocked_by_user') {
        const blockedTimestamp = chat.relationship.blockedTimestamp;
        if (!blockedTimestamp) return;
        const blockedDuration = Date.now() - blockedTimestamp;
        const cooldownMilliseconds = (state.globalSettings.blockCooldownHours || 1) * 60 * 60 * 1000;
        if (blockedDuration > cooldownMilliseconds) {
          chat.relationship.status = 'pending_system_reflection';
          triggerAiFriendApplication(chat.id);
        }
      } else if (chat.relationship?.status === 'friend' && chat.id !== state.activeChatId) {
        if (chat.settings.enableBackgroundActivity === false) {
          console.log(`角色 "${chat.name}" 的独立后台活动开关已关闭，本次跳过。`);
          return;
        }
        if (Math.random() < 0.20) {
          console.log(`角色 "${chat.name}" 被唤醒，准备独立行动...`);
          triggerInactiveAiAction(chat.id);
        }
        // 检查是否可以帮助用户清空购物车
        checkAndClearShoppingCart(chat.id);
        // 情侣空间 AI 自主决定模式 - 后台触发
        if (typeof triggerCoupleSpaceAiDecide === 'function') {
          try { triggerCoupleSpaceAiDecide(chat.id, 'background'); } catch(e) {}
        }
      }
    });


    const allGroupChats = Object.values(state.chats).filter(chat => chat.isGroup);
    allGroupChats.forEach(chat => {
      if (chat.settings.enableBackgroundActivity === false) {
        console.log(`群聊 "${chat.name}" 的后台活动开关已关闭，本次跳过。`);
        return;
      }
      if (chat.id !== state.activeChatId && Math.random() < 0.10) {
        console.log(`群聊 "${chat.name}" 被唤醒，准备独立行动...`);
        triggerGroupAiAction(chat.id);
      }
    });



    try {
      const allNpcs = await db.npcs.toArray();
      if (allNpcs.length === 0) return;

      const allRecentPosts = await db.qzonePosts.orderBy('timestamp').reverse().limit(10).toArray();

      for (const npc of allNpcs) {
        if (npc.enableBackgroundActivity === false) continue;
        const cooldownMinutes = npc.actionCooldownMinutes || 15;
        if (npc.lastActionTimestamp) {
          const minutesSinceLastAction = (Date.now() - npc.lastActionTimestamp) / (1000 * 60);
          if (minutesSinceLastAction < cooldownMinutes) {
            continue;
          }
        }
        if (Math.random() > 0.3) continue;


        const tasks = [];
        for (const post of allRecentPosts) {

          if (post.authorId === `npc_${npc.id}`) continue;


          const isRepliedTo = post.comments?.some(c => c.replyTo === npc.name);


          const lastCommenter = post.comments?.slice(-1)[0]?.commenterName;
          if (lastCommenter === npc.name) continue;

          let isVisible = false;


          if (post.authorId === 'user' || post.authorId.startsWith('chat_')) {
            if (npc.associatedWith.includes(post.authorId)) {
              isVisible = true;
            }
          } else if (post.authorId.startsWith('npc_')) {
            const authorNpcId = parseInt(post.authorId.replace('npc_', ''));
            const authorNpc = await db.npcs.get(authorNpcId);


            if (authorNpc) {
              const npc1_group = npc.npcGroupId;
              const npc2_group = authorNpc.npcGroupId;


              if (npc1_group && npc2_group && npc1_group === npc2_group) {
                isVisible = true;
              }
            }
          }

          if (isVisible || isRepliedTo) {
            tasks.push(post);
          }
        }



        if (tasks.length > 0 || Math.random() < 0.2) {
          console.log(`NPC "${npc.name}" 触发行动决策...`);
          const generatedActions = await generateNpcActions(npc, tasks);

          if (generatedActions && generatedActions.length > 0) {
            for (const action of generatedActions) {
              if (action.type === 'qzone_comment') {

                const post = await db.qzonePosts.get(action.postId);
                if (post) {
                  if (!post.comments) post.comments = [];
                  post.comments.push({
                    commenterName: npc.name,
                    text: action.commentText,
                    replyTo: action.replyTo || null,
                    timestamp: Date.now() + Math.random()
                  });
                  await db.qzonePosts.update(action.postId, {
                    comments: post.comments
                  });
                  updateUnreadIndicator(unreadPostsCount + 1);
                }
              } else if (action.type === 'qzone_post') {

                const newPost = {
                  type: action.postType || 'shuoshuo',
                  content: action.content,
                  timestamp: Date.now(),
                  authorId: `npc_${npc.id}`,
                  authorOriginalName: npc.name,
                  visibleTo: npc.associatedWith,
                  likes: [],
                  comments: [],
                  isDeleted: false
                };
                await db.qzonePosts.add(newPost);
                console.log(`NPC "${npc.name}" 成功发布了一条新动态。`);
                updateUnreadIndicator(unreadPostsCount + 1);
              }
            }
            await db.npcs.update(npc.id, {
              lastActionTimestamp: Date.now()
            });
            if (document.getElementById('qzone-screen').classList.contains('active')) {
              await renderQzonePosts();
            }
          }
        }
      }
    } catch (error) {
      console.error("处理NPC后台活动时出错:", error);
    }
  }

  async function generateNpcActions(npc, tasks) {
    // 优先使用后台 API；地址/密钥实时引用 API 预设库，未配置则沿用主 API
    const apiConfig = typeof resolveApiSlotConfig === 'function'
      ? await resolveApiSlotConfig('background')
      : (state.apiConfig.backgroundProxyUrl && state.apiConfig.backgroundApiKey && state.apiConfig.backgroundModel
        ? {
            proxyUrl: state.apiConfig.backgroundProxyUrl,
            apiKey: state.apiConfig.backgroundApiKey,
            model: state.apiConfig.backgroundModel
          }
        : state.apiConfig);
    const {
      proxyUrl,
      apiKey,
      model
    } = apiConfig;

    if (!proxyUrl || !apiKey || !model) {
      console.error("NPC行动失败：API未配置。");
      return null;
    }


    let charactersContext = "# 你的互动对象 (用户和其他角色)\n";
    const userNickname = state.qzoneSettings.nickname || '我';
    const userPersona = state.chats[Object.keys(state.chats)[0]]?.settings.myPersona || '(未设置)';
    charactersContext += `- **${userNickname} (用户)**: ${userPersona}\n`;
    if (npc.associatedWith && npc.associatedWith.length > 0) {
      npc.associatedWith.forEach(charId => {
        const char = state.chats[charId];
        if (char && !char.isGroup) {
          charactersContext += `- **${char.name} (本名: ${char.originalName})**: ${char.settings.aiPersona}\n`;
        }
      });
    }

    const tasksString = (await Promise.all(tasks.map(async post => {
      let authorDisplayName = '未知作者';
      if (post.authorId === 'user') {
        authorDisplayName = state.qzoneSettings.nickname || '用户';
      } else if (post.authorId.startsWith('chat_')) {
        authorDisplayName = getDisplayNameByOriginalName(post.authorOriginalName || post.authorId);
      } else if (post.authorId.startsWith('npc_')) {
        const authorNpcId = parseInt(post.authorId.replace('npc_', ''));
        const authorNpc = await db.npcs.get(authorNpcId);
        if (authorNpc) {
          authorDisplayName = authorNpc.name;
        }
      }

      const commentsString = (post.comments || [])
        .map(c => {
          if (typeof c === 'object' && c.commenterName) {
            const commenterDisplayName = getDisplayNameByOriginalName(c.commenterName);
            return `- **${commenterDisplayName}**: ${c.text}`;
          }
          return `- ${c}`;
        }).join('\n');
      return `
---
### 帖子ID: ${post.id}
- **作者**: ${authorDisplayName}
- **内容摘要**: ${(post.content || post.publicText || '').substring(0, 150)}...
- **已有评论**:
${commentsString || '(暂无评论)'}
---
`;
    }))).join('\n');





    const npcAuthorId = `npc_${npc.id}`;
    const twelveHoursAgo = Date.now() - (12 * 60 * 60 * 1000);
    const recentNpcPosts = await db.qzonePosts
      .where('authorId').equals(npcAuthorId)
      .and(post => post.timestamp > twelveHoursAgo)
      .toArray();


    let postingCooldownInstruction = '';
    if (recentNpcPosts.length > 0) {
      postingCooldownInstruction = `
# 【行为倾向指令 (高优先级)】
**你最近已经发布过动态了。** 为了让社区互动更自然，你本次行动的【唯一任务】就是**评论**或**回复**下面"待处理的帖子列表"中的内容。
你【绝对禁止】再次发布新动态，除非你收到了直接的指令或有一个对剧情发展至关重要的、紧急的新想法。
`;
    }


    const systemPrompt = `
# 你的任务
你是一个虚拟社区的AI。你的核心任务是扮演角色"${npc.name}"，并根据其人设，通过【发布新动态】或【评论/回复帖子】来参与社区互动。

${postingCooldownInstruction}

# 核心规则
1.  **【角色扮演】**: 你的所有行为都【必须】严格符合你的角色设定。
2.  **【互动逻辑】**: 你的首要任务是检查"待处理的帖子列表"。如果列表中有你可以回应的帖子（特别是那些有新评论或提到你的），你【必须】优先进行评论或回复，而不是发布新动态。
3.  **【格式铁律 (最高优先级)】**: 
    -   你的回复【必须且只能】是一个JSON数组格式的字符串。
    -   数组中可以包含【一个或多个】行动对象。
    -   每个行动对象的格式【必须】是以下两种之一：
      -   **发布新动态**: \`{"type": "qzone_post", "postType": "shuoshuo", "content": "你的新动态内容。"}\`
      -   **发表评论**: \`{"type": "qzone_comment", "postId": 123, "commentText": "你的新评论内容。"}\` 或 \`{"type": "qzone_comment", "postId": 123, "replyTo": "被回复者的【本名】", "commentText": "你的回复内容。"}\`
4.  **【行为组合指南】**:
    -   你可以自由组合不同的行动，例如，先发布一条自己的动态，再去评论别人的动态。
    -   为了模拟真实行为，你本次生成的行动数量建议在【1到3个】之间。

# 你的角色设定
- **昵称**: ${npc.name}
- **人设**: ${npc.persona}

${charactersContext} 

# 待处理的帖子列表 (如果你选择评论)
${tasksString}

现在，请严格遵守所有规则，选择并执行你的行动。`;


    try {
      const messagesForApi = [{
        role: 'user',
        content: "请根据你的设定，开始你的行动。"
      }];
      let isGemini = proxyUrl.includes('generativelanguage');
      let geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesForApi);

      const response = isGemini ?
        await fetch(geminiConfig.url, geminiConfig.data) :
        await fetch(`${proxyUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: model,
            messages: [{
              role: 'system',
              content: systemPrompt
            }, ...messagesForApi],
            temperature: state.globalSettings.apiTemperature || 0.9,
            top_p: state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0,
            presence_penalty: state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0,
            frequency_penalty: state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0
          })
        });

      if (!response.ok) throw new Error(`API 错误: ${response.statusText}`);

      const data = await response.json();
      const aiResponseContent = getGeminiResponseText(data);
      const jsonMatch = aiResponseContent.match(/(\[[\s\S]*\])/);
      if (!jsonMatch) throw new Error("AI返回的行动中未找到有效的JSON数组。");

      return JSON.parse(jsonMatch[0]);

    } catch (error) {
      console.error(`为NPC "${npc.name}" 生成行动失败:`, error);
      return null;
    }
  }



  // ========== 后台保活功能开始 ==========

  let keepAliveInterval = null;
  let keepAliveAudio = null;
  let wakeLock = null;
  let keepAliveWorker = null;
  let keepAliveSharedWorker = null;
  let keepAliveBroadcast = null;
  let keepAliveAnimationFrame = null;
  let keepAliveAudioContext = null;
  let keepAliveMultiTimers = [];
  let keepAliveWebRTC = null;
  let keepAliveAudioPlayer = null; // 用于显示的音频播放器
  let keepAliveAudioObjectUrl = null;
  const KEEP_ALIVE_CUSTOM_AUDIO_ID = 'background-keep-alive-custom-audio';

  function getKeepAliveConfig() {
    if (!state.globalSettings.backgroundKeepAlive) {
      state.globalSettings.backgroundKeepAlive = {
        enabled: false
      };
    }
    return state.globalSettings.backgroundKeepAlive;
  }

  async function saveKeepAliveConfig() {
    await db.globalSettings.put(state.globalSettings);
  }

  function getKeepAliveAudioPlayer() {
    const audioPlayer = document.getElementById('keep-alive-audio-player');
    if (audioPlayer) {
      audioPlayer.loop = true;
      audioPlayer.playsInline = true;
      audioPlayer.setAttribute('playsinline', '');
      audioPlayer.preload = 'auto';
    }
    return audioPlayer;
  }

  function revokeKeepAliveObjectUrl() {
    if (keepAliveAudioObjectUrl) {
      URL.revokeObjectURL(keepAliveAudioObjectUrl);
      keepAliveAudioObjectUrl = null;
    }
  }

  function getDefaultKeepAliveAudioSource() {
    const silentPlayer = document.getElementById('silent-audio-player');
    const source = silentPlayer?.querySelector('source');
    const src = source?.getAttribute('src') || silentPlayer?.getAttribute('src') || '';
    if (!src) return null;
    return {
      src,
      fileName: '内置静默音频',
      mimeType: source?.getAttribute('type') || 'audio/mpeg',
      size: 0
    };
  }

  function formatKeepAliveError(error) {
    if (!error) return '';
    if (error.name === 'NotAllowedError') return '需要用户点击启动';
    if (error.name === 'NotSupportedError') return '音频格式不支持';
    return error.message || String(error);
  }

  function updateKeepAliveStatus(statusText, detailText = '') {
    const statusElement = document.getElementById('keep-alive-status-text');
    const detailElement = document.getElementById('keep-alive-audio-status-detail');

    if (statusElement) {
      statusElement.textContent = detailText ? `${statusText}：${detailText}` : statusText;

      if (statusText.includes('运行中')) {
        statusElement.style.color = '#4CAF50';
      } else if (statusText.includes('失败') || statusText.includes('需要')) {
        statusElement.style.color = '#f44336';
      } else if (statusText.includes('暂停')) {
        statusElement.style.color = '#ff9800';
      } else if (statusText.includes('已配置')) {
        statusElement.style.color = '#2196F3';
      } else {
        statusElement.style.color = '#999';
      }
    }

    if (detailElement) {
      detailElement.textContent = detailText ? `${statusText} · ${detailText}` : statusText;
    }
  }

  function updateConfiguredKeepAliveStatus() {
    const config = getKeepAliveConfig();
    if (config.enabled && keepAliveAudioPlayer && !keepAliveAudioPlayer.paused) {
      updateKeepAliveStatus('运行中', config.audioFileName || '保活音频循环播放中');
    } else if (config.audioSource === 'custom' && config.audioId) {
      updateKeepAliveStatus('已配置未启动', config.audioFileName || '自定义音频');
    } else if (config.audioSource === 'default') {
      updateKeepAliveStatus('已配置未启动', config.audioFileName || '默认音频');
    } else {
      updateKeepAliveStatus(config.enabled ? '未配置' : '未启用');
    }
  }

  function bindKeepAliveAudioStateEvents(audioPlayer) {
    if (!audioPlayer || audioPlayer.dataset.keepAliveStateBound === 'true') return;
    audioPlayer.dataset.keepAliveStateBound = 'true';

    audioPlayer.addEventListener('playing', () => {
      keepAliveAudioPlayer = audioPlayer;
      updateKeepAliveStatus('运行中', getKeepAliveConfig().audioFileName || '循环播放中');
    });

    audioPlayer.addEventListener('pause', () => {
      if (getKeepAliveConfig().enabled || getKeepAliveConfig().audioId || getKeepAliveConfig().audioSource) {
        updateKeepAliveStatus('已暂停', getKeepAliveConfig().audioFileName || '保活音频');
      }
    });

    audioPlayer.addEventListener('error', () => {
      const mediaError = audioPlayer.error;
      const message = mediaError ? `媒体错误 ${mediaError.code}` : '未知错误';
      updateKeepAliveStatus('播放失败', message);
      console.warn('[后台保活] 音频播放失败:', message);
    });
  }

  async function loadCustomKeepAliveAudioIntoPlayer() {
    const config = getKeepAliveConfig();
    const audioPlayer = getKeepAliveAudioPlayer();
    if (!audioPlayer || !config.audioId) return false;

    const record = await db.keepAliveAudios.get(config.audioId);
    if (!record?.blob) {
      updateKeepAliveStatus('播放失败', '未找到已保存的音频文件');
      return false;
    }

    revokeKeepAliveObjectUrl();
    keepAliveAudioObjectUrl = URL.createObjectURL(record.blob);
    audioPlayer.pause();
    audioPlayer.src = keepAliveAudioObjectUrl;
    audioPlayer.type = record.mimeType || config.audioMimeType || record.blob.type || '';
    bindKeepAliveAudioStateEvents(audioPlayer);
    keepAliveAudioPlayer = audioPlayer;
    updateKeepAliveStatus('已配置未启动', record.fileName || config.audioFileName || '自定义音频');
    return true;
  }

  function loadDefaultKeepAliveAudioIntoPlayer() {
    const defaultAudio = getDefaultKeepAliveAudioSource();
    const audioPlayer = getKeepAliveAudioPlayer();
    if (!defaultAudio || !audioPlayer) {
      updateKeepAliveStatus('未配置', '没有可用的默认音频');
      return false;
    }

    revokeKeepAliveObjectUrl();
    audioPlayer.pause();
    audioPlayer.src = defaultAudio.src;
    audioPlayer.type = defaultAudio.mimeType;
    bindKeepAliveAudioStateEvents(audioPlayer);
    keepAliveAudioPlayer = audioPlayer;
    updateKeepAliveStatus('已配置未启动', defaultAudio.fileName);
    return true;
  }

  async function restoreConfiguredKeepAliveAudio() {
    const config = getKeepAliveConfig();

    if (config.audioUrl && String(config.audioUrl).startsWith('blob:')) {
      delete config.audioUrl;
      await saveKeepAliveConfig();
      updateKeepAliveStatus('未配置', '旧的临时 blob 地址已忽略');
    }

    if (config.audioSource === 'custom' && config.audioId) {
      return loadCustomKeepAliveAudioIntoPlayer();
    }

    if (config.audioSource === 'default') {
      return loadDefaultKeepAliveAudioIntoPlayer();
    }

    updateConfiguredKeepAliveStatus();
    return false;
  }

  async function playKeepAliveAudio(reason = 'auto') {
    const audioPlayer = getKeepAliveAudioPlayer();
    if (!audioPlayer) return false;

    if (!audioPlayer.src) {
      const restored = await restoreConfiguredKeepAliveAudio();
      if (!restored) return false;
    }

    try {
      bindKeepAliveAudioStateEvents(audioPlayer);
      await audioPlayer.play();
      keepAliveAudioPlayer = audioPlayer;
      updateKeepAliveStatus('运行中', reason === 'test' ? '测试播放成功' : (getKeepAliveConfig().audioFileName || '循环播放中'));
      return true;
    } catch (error) {
      const message = formatKeepAliveError(error);
      updateKeepAliveStatus(message === '需要用户点击启动' ? '需要用户点击启动' : '播放失败', message);
      console.warn('[后台保活] 音频播放失败:', error);
      return false;
    }
  }

  async function saveCustomKeepAliveAudio(file) {
    const allowedAudioTypes = [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/x-wav',
      'audio/wave',
      'audio/mp4',
      'audio/aac',
      'audio/ogg',
      'audio/webm'
    ];
    const allowedAudioExtensions = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'webm'];
    const fileType = (file.type || '').toLowerCase();
    const fileExtension = (file.name.split('.').pop() || '').toLowerCase();
    const isAllowedAudioType = fileType && allowedAudioTypes.includes(fileType);
    const isAllowedAudioExtension = allowedAudioExtensions.includes(fileExtension);

    if (!isAllowedAudioType && !isAllowedAudioExtension) {
      throw new Error(`不支持的保活音频文件：${file.name}`);
    }

    const updatedAt = Date.now();
    const mimeType = file.type || (fileExtension ? `audio/${fileExtension === 'mp3' ? 'mpeg' : fileExtension}` : 'audio/mpeg');
    const blob = file.slice(0, file.size, mimeType);

    await db.keepAliveAudios.put({
      id: KEEP_ALIVE_CUSTOM_AUDIO_ID,
      blob,
      fileName: file.name,
      mimeType,
      size: file.size,
      updatedAt
    });

    const config = getKeepAliveConfig();
    config.audioSource = 'custom';
    config.audioId = KEEP_ALIVE_CUSTOM_AUDIO_ID;
    config.audioFileName = file.name;
    config.audioMimeType = mimeType;
    config.audioSize = file.size;
    config.audioUpdatedAt = updatedAt;
    delete config.audioUrl;
    await saveKeepAliveConfig();

    await loadCustomKeepAliveAudioIntoPlayer();
  }

  async function clearCustomKeepAliveAudio() {
    await db.keepAliveAudios.delete(KEEP_ALIVE_CUSTOM_AUDIO_ID);

    const config = getKeepAliveConfig();
    const wasUsingCustom = config.audioSource === 'custom' || config.audioId === KEEP_ALIVE_CUSTOM_AUDIO_ID;

    if (wasUsingCustom) {
      delete config.audioSource;
      delete config.audioId;
      delete config.audioFileName;
      delete config.audioMimeType;
      delete config.audioSize;
      delete config.audioUpdatedAt;
      delete config.audioUrl;
      await saveKeepAliveConfig();

      const audioPlayer = getKeepAliveAudioPlayer();
      if (audioPlayer) {
        audioPlayer.pause();
        audioPlayer.removeAttribute('src');
        audioPlayer.load();
        keepAliveAudioPlayer = null;
      }
      revokeKeepAliveObjectUrl();
      updateKeepAliveStatus('未配置', '已清除自定义音频');
      return;
    }

    updateConfiguredKeepAliveStatus();
  }

  async function restoreDefaultKeepAliveAudio() {
    const defaultAudio = getDefaultKeepAliveAudioSource();
    if (!defaultAudio) {
      updateKeepAliveStatus('未配置', '没有内置默认音频');
      return false;
    }

    const config = getKeepAliveConfig();
    config.audioSource = 'default';
    config.audioFileName = defaultAudio.fileName;
    config.audioMimeType = defaultAudio.mimeType;
    config.audioSize = defaultAudio.size;
    config.audioUpdatedAt = Date.now();
    delete config.audioId;
    delete config.audioUrl;
    await saveKeepAliveConfig();

    loadDefaultKeepAliveAudioIntoPlayer();
    return true;
  }

  // 初始化后台保活
  async function initializeBackgroundKeepAlive() {
    const config = getKeepAliveConfig();
    if (config.audioUrl && String(config.audioUrl).startsWith('blob:')) {
      delete config.audioUrl;
      await saveKeepAliveConfig();
    }
  }

  // 启动后台保活
  async function startBackgroundKeepAlive() {
    console.log('[后台保活] 启动后台保活（音频播放器模式）...');

    const audioBtnContainer = document.getElementById('keep-alive-audio-btn-container');
    if (audioBtnContainer) {
      audioBtnContainer.style.display = 'flex';
    }

    document.removeEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const restored = await restoreConfiguredKeepAliveAudio();
    if (restored) {
      await playKeepAliveAudio('auto');
    } else {
      updateKeepAliveStatus('未配置');
    }

    console.log('[后台保活] ✅ 后台保活已启动');
  }

  // 停止后台保活
  function stopBackgroundKeepAlive() {
    console.log('[后台保活] 停止后台保活...');

    const audioBtnContainer = document.getElementById('keep-alive-audio-btn-container');
    const audioPlayer = getKeepAliveAudioPlayer();
    const audioModal = document.getElementById('keep-alive-audio-modal');

    if (audioPlayer) {
      try {
        audioPlayer.pause();
        audioPlayer.removeAttribute('src');
        audioPlayer.load();
        revokeKeepAliveObjectUrl();
        keepAliveAudioPlayer = null;
        console.log('[后台保活] 保活音频已暂停并释放临时URL');
      } catch (error) {
        console.warn('[后台保活] 停止保活音频失败:', error);
      }
    }

    if (audioBtnContainer) {
      audioBtnContainer.style.display = 'none';
    }

    if (audioModal) {
      audioModal.style.display = 'none';
    }

    document.removeEventListener('visibilitychange', handleVisibilityChange);
    updateKeepAliveStatus('未启用');
    console.log('[后台保活] ✅ 后台保活已停止');
  }

  async function handleVisibilityChange() {
    if (document.hidden) {
      console.log('[后台保活] 🔄 页面进入后台');
    } else {
      console.log('[后台保活] ✅ 页面返回前台');

      if (getKeepAliveConfig().enabled) {
        await playKeepAliveAudio('auto');
      }
      runAIReminderImmediateScan('keep_alive_visibility_restore');
    }
  }

  function handleStorageChange(event) {}
  function handlePageFreeze() {}
  function handlePageResume() {}

  function bindBackgroundKeepAliveEvents() {
    const keepAliveSwitch = document.getElementById('background-keep-alive-switch');
    const statusDiv = document.getElementById('keep-alive-status');
    const audioBtnContainer = document.getElementById('keep-alive-audio-btn-container');
    const audioBtn = document.getElementById('keep-alive-audio-btn');
    const audioModal = document.getElementById('keep-alive-audio-modal');
    const audioMinimize = document.getElementById('keep-alive-audio-minimize');
    const audioClose = document.getElementById('keep-alive-audio-close');
    const audioFile = document.getElementById('keep-alive-audio-file');
    const audioUrl = document.getElementById('keep-alive-audio-url');
    const audioLoadUrl = document.getElementById('keep-alive-audio-load-url');
    const audioPlayer = getKeepAliveAudioPlayer();
    const audioTest = document.getElementById('keep-alive-audio-test');
    const audioClear = document.getElementById('keep-alive-audio-clear');
    const audioRestoreDefault = document.getElementById('keep-alive-audio-restore-default');

    if (audioPlayer) bindKeepAliveAudioStateEvents(audioPlayer);

    if (keepAliveSwitch && keepAliveSwitch.dataset.keepAliveBound !== 'true') {
      keepAliveSwitch.dataset.keepAliveBound = 'true';
      keepAliveSwitch.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        const config = getKeepAliveConfig();
        config.enabled = enabled;
        await saveKeepAliveConfig();

        if (statusDiv) {
          statusDiv.style.display = enabled ? 'flex' : 'none';
        }

        if (enabled) {
          await startBackgroundKeepAlive();
        } else {
          stopBackgroundKeepAlive();
        }
      });
    }

    if (audioBtn && audioModal && audioBtn.dataset.keepAliveBound !== 'true') {
      audioBtn.dataset.keepAliveBound = 'true';
      audioBtn.addEventListener('click', async () => {
        audioModal.style.display = 'flex';
        await restoreConfiguredKeepAliveAudio();
      });
    }

    if (audioMinimize && audioModal && audioMinimize.dataset.keepAliveBound !== 'true') {
      audioMinimize.dataset.keepAliveBound = 'true';
      audioMinimize.addEventListener('click', () => {
        audioModal.style.display = 'none';
        console.log('[后台保活] 播放器已最小化，音频继续播放');
      });
    }

    if (audioClose && audioModal && audioClose.dataset.keepAliveBound !== 'true') {
      audioClose.dataset.keepAliveBound = 'true';
      audioClose.addEventListener('click', () => {
        audioModal.style.display = 'none';
      });
    }

    if (audioModal && audioModal.dataset.keepAliveBound !== 'true') {
      audioModal.dataset.keepAliveBound = 'true';
      audioModal.addEventListener('click', (e) => {
        if (e.target === audioModal) {
          audioModal.style.display = 'none';
          console.log('[后台保活] 播放器已最小化，音频继续播放');
        }
      });
    }

    if (audioFile && audioFile.dataset.keepAliveBound !== 'true') {
      audioFile.dataset.keepAliveBound = 'true';
      audioFile.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
          await saveCustomKeepAliveAudio(file);
          updateKeepAliveStatus('已配置未启动', file.name);
          await playKeepAliveAudio('upload');
          console.log('[后台保活] 自定义音频已持久化保存并加载');
        } catch (error) {
          console.error('[后台保活] 保存本地音频失败:', error);
          updateKeepAliveStatus('播放失败', formatKeepAliveError(error));
          alert(`保存保活音频失败：${formatKeepAliveError(error)}`);
        } finally {
          audioFile.value = '';
        }
      });
    }

    if (audioLoadUrl && audioUrl && audioPlayer && audioLoadUrl.dataset.keepAliveBound !== 'true') {
      audioLoadUrl.dataset.keepAliveBound = 'true';
      audioLoadUrl.addEventListener('click', async () => {
        const url = audioUrl.value.trim();
        if (!url) {
          alert('请输入音频URL');
          return;
        }

        try {
          if (url.startsWith('blob:')) {
            throw new Error('blob: 临时地址不能作为永久保活音频保存');
          }

          revokeKeepAliveObjectUrl();
          audioPlayer.pause();
          audioPlayer.src = url;
          bindKeepAliveAudioStateEvents(audioPlayer);
          await audioPlayer.play();
          keepAliveAudioPlayer = audioPlayer;
          updateKeepAliveStatus('运行中', 'URL临时播放（不会保存为永久配置）');
          console.log('[后台保活] URL音频已临时加载并播放');
        } catch (error) {
          console.warn('[后台保活] URL音频播放失败:', error);
          updateKeepAliveStatus('播放失败', formatKeepAliveError(error));
          alert(`音频播放失败：${formatKeepAliveError(error)}`);
        }
      });
    }

    if (audioTest && audioTest.dataset.keepAliveBound !== 'true') {
      audioTest.dataset.keepAliveBound = 'true';
      audioTest.addEventListener('click', async () => {
        await playKeepAliveAudio('test');
      });
    }

    if (audioClear && audioClear.dataset.keepAliveBound !== 'true') {
      audioClear.dataset.keepAliveBound = 'true';
      audioClear.addEventListener('click', async () => {
        try {
          await clearCustomKeepAliveAudio();
          console.log('[后台保活] 自定义音频已清除');
        } catch (error) {
          console.warn('[后台保活] 清除自定义音频失败:', error);
          updateKeepAliveStatus('播放失败', formatKeepAliveError(error));
        }
      });
    }

    if (audioRestoreDefault && audioRestoreDefault.dataset.keepAliveBound !== 'true') {
      audioRestoreDefault.dataset.keepAliveBound = 'true';
      audioRestoreDefault.addEventListener('click', async () => {
        const restored = await restoreDefaultKeepAliveAudio();
        if (restored) {
          await playKeepAliveAudio('default');
        }
      });
    }
  }

  // 加载后台保活设置到UI
  async function loadBackgroundKeepAliveSettings() {
    const config = getKeepAliveConfig();

    const keepAliveSwitch = document.getElementById('background-keep-alive-switch');
    const statusDiv = document.getElementById('keep-alive-status');
    const audioBtnContainer = document.getElementById('keep-alive-audio-btn-container');

    if (keepAliveSwitch) {
      keepAliveSwitch.checked = config.enabled || false;

      if (statusDiv) {
        statusDiv.style.display = config.enabled ? 'flex' : 'none';
      }

      if (config.enabled) {
        await startBackgroundKeepAlive();
      } else {
        if (audioBtnContainer) {
          audioBtnContainer.style.display = 'none';
        }
        await restoreConfiguredKeepAliveAudio();
      }
    }
  }

  // ========== 后台保活功能结束 ==========


  async function simulateBackgroundActivity(minutesOffline) {
    console.log(`检测到应用离线了 ${minutesOffline.toFixed(1)} 分钟，开始模拟后台活动...`);


    const activeCharacters = Object.values(state.chats).filter(chat =>
      !chat.isGroup &&
      chat.settings.enableBackgroundActivity &&
      chat.relationship?.status === 'friend'
    );

    if (activeCharacters.length === 0) {
      console.log("没有配置为后台活跃的角色，跳过模拟。");
      return;
    }


    for (const char of activeCharacters) {

      const cooldownMinutes = char.settings.actionCooldownMinutes || 15;
      const timeSinceLastAction = char.lastActionTimestamp ?
        (Date.now() - char.lastActionTimestamp) / (1000 * 60) :
        Infinity;


      if (minutesOffline > cooldownMinutes && timeSinceLastAction > cooldownMinutes) {



        if (Math.random() < 0.3) {
          console.log(`角色 "${char.name}" 触发了后台行动！`);


          if (Math.random() < 0.7) {

            await triggerInactiveAiAction(char.id);
          } else {

            console.log(`角色 "${char.name}" 决定去发一条动态... (此处为模拟)`);
          }
        }
      }
    }
  }

  // ========== 全局暴露 ==========
  window.generateAiReminderText = generateAiReminderText;
  window.scanDueAiReminders = scanDueAiReminders;
  window.startAIReminderScheduler = startAIReminderScheduler;
  window.stopAIReminderScheduler = stopAIReminderScheduler;
  window.runAIReminderImmediateScan = runAIReminderImmediateScan;
  window.getAIReminderDebugLogs = readAiReminderDebugLogs;
  window.clearAIReminderDebugLogs = function clearAIReminderDebugLogs() {
    writeAiReminderDebugLogs([]);
  };
  window.logAiReminderDebug = logAiReminderDebug;
  window.simulateBackgroundActivity = simulateBackgroundActivity;
  window.startBackgroundSimulation = startBackgroundSimulation;
  window.stopBackgroundSimulation = stopBackgroundSimulation;
  window.initializeBackgroundKeepAlive = initializeBackgroundKeepAlive;
  window.bindBackgroundKeepAliveEvents = bindBackgroundKeepAliveEvents;
  window.loadBackgroundKeepAliveSettings = loadBackgroundKeepAliveSettings;
