// ============================================================
// init-db-schema.js
// 数据库 Schema 定义
// 从 init-and-state.js 拆分
// ============================================================

const db = new Dexie('GeminiChatDB');

// memoryCache, memoryRenderCount, isLoadingMoreMemories 已移至 utils.js 全局作用域
// todoCache, todoRenderCount, isLoadingMoreTodos 已移至 utils.js 全局作用域
db.version(50).stores({
  doubanPosts: '++id, timestamp',
  chats: '&id, isGroup, groupId, isPinned, memos, diary, appUsageLog, lastIntelligentSummaryTimestamp',
  apiConfig: '&id, minimaxGroupId, minimaxApiKey',
  globalSettings: '&id',
  userStickers: '&id, url, name, categoryId',
  stickerVisionCache: '&url, description, timestamp',
  worldBooks: '&id, name, categoryId',
  worldBookCategories: '++id, name',
  musicLibrary: '&id',
  personaPresets: '&id',
  qzoneSettings: '&id',
  qzonePosts: '++id, timestamp, authorId',
  qzoneAlbums: '++id, name, createdAt',
  qzonePhotos: '++id, albumId',
  favorites: '++id, type, timestamp, originalTimestamp',
  qzoneGroups: '++id, name',
  memories: '++id, chatId, timestamp, type, targetDate',
  callRecords: '++id, chatId, timestamp, customName',
  shoppingProducts: '++id, name, description, categoryId',
  shoppingCategories: '++id, name',
  apiPresets: '++id, name',
  soundPresets: '++id, name',
  renderingRules: '++id, name, chatId',
  appearancePresets: '++id, name, type',
  stickerCategories: '++id, name',
  customAvatarFrames: '++id, name',
  presets: '&id, name, categoryId',
  presetCategories: '++id, name',
  readingLibrary: '++id, title, lastOpened, linkedStoryId',
  quickReplies: '++id, text, categoryId', // 修改：增加 categoryId 索引
});

// 快捷回复分类系统 - 新增数据表
db.version(51).stores({
  quickReplyCategories: '++id, name',
  npcs: '++id, name, npcGroupId, enableBackgroundActivity, actionCooldownMinutes, lastActionTimestamp',
  npcGroups: '++id, name',
  naiPresets: '++id, name',
  grAuthors: '++id, name',
  grStories: '++id, title, authorId, lastUpdated',
  userWallet: '&id',
  userTransactions: '++id, timestamp, type, amount, description',
  funds: '&id, code, name, riskLevel, currentNav, lastDayNav, history',
  auctions: '++id, status, itemName, endTime', // 拍卖记录
  inventory: '++id, name, type, acquiredTime',
  emails: '++id, sender, senderType, recipient, subject, content, timestamp, isRead'
}).upgrade(tx => {

  return tx.table('worldBooks').toCollection().modify(book => {

    if (typeof book.content === 'string' && book.content.trim() !== '') {
      book.content = [{
        keys: [],
        comment: '从旧版本迁移的条目',
        content: book.content
      }];
    }
  });
});

// 观影播放列表
db.version(52).stores({
  watchTogetherPlaylist: '++id, name, timestamp'
});

// 月经记录相关表
db.version(53).stores({
  periodRecords: '++id, startDate, endDate, flow, symptoms, mood, notes, painLevel, pmsSymptoms, productChanges, sleepQuality, exerciseDuration, createdAt',
  periodSettings: '++id, characterId, enabled, avgCycleLength, avgPeriodLength',
  periodNotificationSettings: '&id, enabled, upcomingDays, upcomingTime, recordTime, abnormalCycleMin, abnormalCycleMax, delayDays'
});

// 番茄钟相关表
db.version(54).stores({
  focusSessions: '++id, companionId, startTime, endTime, duration, completed, stage',
  focusStats: '&id, todayCount, totalCount, streakDays, lastFocusDate',
  focusMessages: '++id, sessionId, companionId, stage, message, timestamp'
});

// 修复：为 shoppingProducts 补充 categoryId 索引
db.version(55).stores({
  shoppingProducts: '++id, name, description, categoryId'
});

// 聊天设置模板系统
db.version(56).stores({
  chatSettingsPresets: '++id, name, createdAt'
});

// 副API预设系统
db.version(57).stores({
  secondaryApiPresets: '++id, name'
});

// 统一 API 站点预设（Base URL + Key，供各功能位引用）
db.version(58).stores({
  apiEndpointPresets: '++id, name'
});

// TTS 配置结构升级：移除 apiConfig 上旧 Minimax 扁平索引
db.version(59).stores({
  apiConfig: '&id'
});

// 聊天消息拆表：chats 只保留会话元数据，messages 独立保存消息。
// messages 主键使用稳定 id；复合索引用于按 chatId + timestamp 分页读取。
db.version(60).stores({
  chats: '&id, isGroup, groupId, isPinned, memos, diary, appUsageLog, lastIntelligentSummaryTimestamp, lastMessageTimestamp, messageSchemaVersion',
  messages: '&id, chatId, timestamp, [chatId+timestamp], role, type'
}).upgrade(async tx => {
  const chatsTable = tx.table('chats');
  const messagesTable = tx.table('messages');
  const MESSAGE_SCHEMA_VERSION = 2;

  function safeTimestamp(msg) {
    const ts = Number(msg?.timestamp);
    return Number.isFinite(ts) && ts > 0 ? ts : Date.now();
  }

  function createMessageId(chatId, msg, index = 0) {
    if (msg && msg.id) return String(msg.id);
    const role = msg?.role || 'unknown';
    const type = msg?.type || 'text';
    return `${chatId}::${safeTimestamp(msg)}::${role}::${type}::${index}`;
  }

  function buildMessagePreview(msg) {
    if (!msg || msg.isHidden) return '';
    if (msg.type === 'transfer') return '[转账]';
    if (msg.type === 'waimai_request') return '[外卖代付]';
    if (msg.type === 'waimai_order') return '[外卖订单]';
    if (msg.type === 'red_packet') return '[红包]';
    if (msg.type === 'poll') return '[投票]';
    if (msg.type === 'gift') return '[礼物]';
    if (msg.type === 'location_share') return '[位置]';
    if (msg.type === 'voice_message') return '[语音]';
    if (msg.type === 'ai_image' || msg.type === 'user_photo') return '[图片]';
    if (Array.isArray(msg.content)) return '[图片]';
    const text = String(msg.content ?? msg.meaning ?? '').replace(/\s+/g, ' ').trim();
    return text.length > 80 ? `${text.slice(0, 80)}...` : text;
  }

  await chatsTable.toCollection().modify(chat => {
    const history = Array.isArray(chat.history) ? chat.history : [];
    if (history.length > 0) {
      const messages = history
        .map((msg, index) => {
          if (!msg || typeof msg !== 'object') return null;
          if (!msg.timestamp) msg.timestamp = Date.now();
          msg.chatId = msg.chatId || chat.id;
          msg.id = createMessageId(chat.id, msg, index);
          return msg;
        })
        .filter(Boolean);

      if (messages.length > 0) {
        messagesTable.bulkPut(messages);
        const lastVisible = [...messages].reverse().find(m => m && !m.isHidden);
        const lastAny = messages[messages.length - 1];
        chat.lastMessageTimestamp = lastVisible?.timestamp || lastAny?.timestamp || chat.lastMessageTimestamp || 0;
        chat.lastMessagePreview = lastVisible ? buildMessagePreview(lastVisible) : (chat.lastMessagePreview || '');
        chat.lastMessageRole = lastVisible?.role || chat.lastMessageRole || '';
        chat.lastMessageType = lastVisible?.type || chat.lastMessageType || '';
        chat.messageCount = Math.max(Number(chat.messageCount || 0), messages.length);
      }
    }

    chat.messageSchemaVersion = MESSAGE_SCHEMA_VERSION;
    delete chat.history;
  });
});

// 后台保活自定义音频持久化：保存 Blob 本体，globalSettings 仅保存轻量元数据
db.version(61).stores({
  keepAliveAudios: '&id, updatedAt'
});

// AI 定时提醒任务：仅保存提醒计划数据，本阶段不接入后台扫描/触发逻辑
db.version(62).stores({
  aiReminders: '&id, enabled, characterId, nextTriggerAt, repeatType, updatedAt'
});

window.db = db;
