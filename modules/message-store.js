// ============================================================
// message-store.js
// 聊天拆表数据访问层：db.chats 只存会话元数据，db.messages 单独存消息。
// 目标：主聊天链路按窗口分页读取消息，不再依赖 chat.history 全量常驻。
// ============================================================

(function () {
  const DEFAULT_WINDOW_SIZE = 50;
  const MESSAGE_SCHEMA_VERSION = 2;

  function getDb() {
    return window.db;
  }

  function getState() {
    return window.state;
  }

  function getRenderWindow(limit) {
    const state = getState();
    const configured = Number(
      limit ||
      state?.globalSettings?.chatRenderWindow ||
      DEFAULT_WINDOW_SIZE
    );
    return Number.isFinite(configured) && configured > 0
      ? Math.min(Math.max(Math.floor(configured), 10), 200)
      : DEFAULT_WINDOW_SIZE;
  }

  function safeTimestamp(msg) {
    const ts = Number(msg?.timestamp);
    return Number.isFinite(ts) && ts > 0 ? ts : Date.now();
  }

  function createMessageId(chatId, msg, index = 0) {
    if (msg && msg.id) return String(msg.id);
    const timestamp = safeTimestamp(msg);
    const role = msg?.role || 'unknown';
    const type = msg?.type || 'text';
    return `${chatId}::${timestamp}::${role}::${type}::${index}`;
  }

  function normalizeMessage(chatId, msg, index = 0) {
    if (!msg || typeof msg !== 'object') return null;
    if (!msg.timestamp) msg.timestamp = Date.now();
    msg.chatId = msg.chatId || chatId;
    msg.id = createMessageId(chatId, msg, index);
    return msg;
  }

  function stripChatHistory(chat, historyForMeta = null) {
    if (!chat || typeof chat !== 'object') return chat;

    const cleanChat = { ...chat };
    const history = Array.isArray(historyForMeta)
      ? historyForMeta
      : Array.isArray(chat.history)
        ? chat.history
        : null;

    if (history && history.length > 0) {
      const lastVisible = [...history].reverse().find(m => m && !m.isHidden);
      const lastAny = history[history.length - 1];

      cleanChat.lastMessageTimestamp =
        lastVisible?.timestamp ||
        lastAny?.timestamp ||
        cleanChat.lastMessageTimestamp ||
        0;

      if (lastVisible) {
        cleanChat.lastMessagePreview = buildMessagePreview(lastVisible);
        cleanChat.lastMessageRole = lastVisible.role || '';
        cleanChat.lastMessageType = lastVisible.type || '';
      }
      cleanChat.messageCount = Math.max(
        Number(cleanChat.messageCount || 0),
        history.length
      );
    }

    cleanChat.messageSchemaVersion = MESSAGE_SCHEMA_VERSION;
    delete cleanChat.history;
    return cleanChat;
  }

  function buildMessagePreview(msg) {
    if (!msg) return '';
    if (msg.isHidden) return '';
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

  async function persistMessages(chatId, messages) {
    const db = getDb();
    if (!db?.messages || !Array.isArray(messages) || messages.length === 0) return [];
    const normalized = messages
      .map((msg, index) => normalizeMessage(chatId, msg, index))
      .filter(Boolean);
    if (normalized.length === 0) return [];
    try {
      await db.messages.bulkPut(normalized);
    } catch (error) {
      window.runtimeDiag?.log?.('MESSAGE_STORAGE_ERROR_NON_BLOCKING', {
        chatId,
        error: error?.message || String(error)
      });
      // 不抛出错误，允许内存中的消息继续流转
    }
    return normalized;
  }

  async function persistChatMeta(chat, historyForMeta = null) {
    const db = getDb();
    if (!db?.chats || !chat) return;
    const cleanChat = stripChatHistory(chat, historyForMeta);
    try {
      await db.chats.put(cleanChat);
    } catch (error) {
      window.runtimeDiag?.log?.('MESSAGE_STORAGE_ERROR_NON_BLOCKING', {
        chatId: cleanChat.id,
        operation: 'persistChatMeta',
        error: error?.message || String(error)
      });
    }
    const state = getState();
    if (state?.chats?.[cleanChat.id]) {
      Object.assign(state.chats[cleanChat.id], cleanChat);
    }
  }

  function ensureMessageState() {
    const state = getState();
    if (!state) return null;
    if (!state.messageWindows) state.messageWindows = {};
    return state.messageWindows;
  }

  function attachWindowHistory(chatId, messages) {
    const arr = Array.isArray(messages) ? messages : [];
    if (arr.__messageStoreAttached) return arr;

    Object.defineProperty(arr, '__messageStoreAttached', {
      value: true,
      enumerable: false,
      configurable: true
    });

    Object.defineProperty(arr, 'push', {
      value: function (...items) {
        const oldPush = Array.prototype.push;
        const normalized = items
          .map((item, index) => normalizeMessage(chatId, item, this.length + index))
          .filter(Boolean);
        const result = oldPush.apply(this, normalized);

        const state = getState();
        const chat = state?.chats?.[chatId];
        if (chat) {
          const lastVisible = [...normalized].reverse().find(m => !m.isHidden);
          if (lastVisible) {
            chat.lastMessageTimestamp = lastVisible.timestamp;
            chat.lastMessagePreview = buildMessagePreview(lastVisible);
            chat.lastMessageRole = lastVisible.role || '';
            chat.lastMessageType = lastVisible.type || '';
          }
          chat.messageCount = Math.max(Number(chat.messageCount || 0), this.length);
        }

        // 兼容旧代码：旧模块仍然 chat.history.push(...) 后 db.chats.put(chat)。
        // push 先尽快写 messages 表；后续 put 会被包装器剥离 history 并补写窗口内消息。
        persistMessages(chatId, normalized)
          .then(() => chat && persistChatMeta(chat, this))
          .catch(err => console.error('[message-store] history.push 持久化失败:', err));

        return result;
      },
      enumerable: false,
      configurable: true,
      writable: true
    });

    return arr;
  }

  function setWindow(chatId, messages, options = {}) {
    const windows = ensureMessageState();
    if (!windows) return attachWindowHistory(chatId, messages);

    const sorted = (messages || []).slice().sort((a, b) => safeTimestamp(a) - safeTimestamp(b));
    const attached = attachWindowHistory(chatId, sorted);

    windows[chatId] = {
      messages: attached,
      oldestTimestamp: attached.length ? safeTimestamp(attached[0]) : null,
      newestTimestamp: attached.length ? safeTimestamp(attached[attached.length - 1]) : null,
      hasMore: options.hasMore !== false,
      loadedCount: attached.length
    };

    const state = getState();
    if (state?.chats?.[chatId]) {
      state.chats[chatId].history = attached; // 仅当前/近期窗口缓存，不再代表完整历史。
    }

    return attached;
  }

  function getWindowMessages(chatId) {
    const state = getState();
    return state?.messageWindows?.[chatId]?.messages || state?.chats?.[chatId]?.history || [];
  }

  async function countMessages(chatId) {
    const db = getDb();
    if (!db?.messages) return getWindowMessages(chatId).length;
    return db.messages.where('chatId').equals(chatId).count();
  }

  async function loadRecentMessages(chatId, limit) {
    const db = getDb();
    const state = getState();
    const chat = state?.chats?.[chatId];
    const pageSize = getRenderWindow(limit);

    if (!db?.messages) {
      return setWindow(chatId, Array.isArray(chat?.history) ? chat.history.slice(-pageSize) : [], { hasMore: false });
    }

    const rows = await db.messages
      .where('[chatId+timestamp]')
      .between([chatId, Dexie.minKey], [chatId, Dexie.maxKey])
      .reverse()
      .limit(pageSize)
      .toArray();

    const messages = rows.reverse();
    const total = await countMessages(chatId);
    return setWindow(chatId, messages, { hasMore: total > messages.length });
  }

  async function loadMessagesBefore(chatId, beforeTimestamp, limit) {
    const db = getDb();
    const state = getState();
    const chat = state?.chats?.[chatId];
    const pageSize = getRenderWindow(limit);

    if (!db?.messages) {
      const current = Array.isArray(chat?.history) ? chat.history : [];
      const end = beforeTimestamp
        ? current.findIndex(m => safeTimestamp(m) >= beforeTimestamp)
        : current.length;
      const sliceEnd = end < 0 ? current.length : end;
      const sliceStart = Math.max(0, sliceEnd - pageSize);
      return current.slice(sliceStart, sliceEnd);
    }

    const upper = Number(beforeTimestamp) || Dexie.maxKey;
    const rows = await db.messages
      .where('[chatId+timestamp]')
      .between([chatId, Dexie.minKey], [chatId, upper], false, true)
      .reverse()
      .limit(pageSize)
      .toArray();

    const older = rows.reverse();
    const windows = ensureMessageState();
    const win = windows?.[chatId];
    const hasMore = older.length >= pageSize;

    if (win) {
      if (older.length > 0) {
        const existingIds = new Set(win.messages.map(m => m.id));
        const merged = older.filter(m => !existingIds.has(m.id)).concat(win.messages);
        setWindow(chatId, merged, { hasMore });
      } else {
        win.hasMore = false;
      }
    }

    return older;
  }

  async function getMessageByTimestamp(chatId, timestamp) {
    const ts = Number(timestamp);
    const inWindow = getWindowMessages(chatId).find(m => Number(m.timestamp) === ts);
    if (inWindow) return inWindow;

    const db = getDb();
    if (!db?.messages) return null;
    return db.messages
      .where('[chatId+timestamp]')
      .equals([chatId, ts])
      .first();
  }

  async function getMessagesByTimestamps(chatId, timestamps) {
    const set = new Set((timestamps || []).map(Number));
    if (set.size === 0) return [];

    const found = [];
    const foundTs = new Set();
    for (const msg of getWindowMessages(chatId)) {
      const ts = Number(msg.timestamp);
      if (set.has(ts)) {
        found.push(msg);
        foundTs.add(ts);
      }
    }

    const db = getDb();
    if (!db?.messages || foundTs.size === set.size) {
      return found.sort((a, b) => safeTimestamp(a) - safeTimestamp(b));
    }

    const rows = await db.messages.where('chatId').equals(chatId).filter(m => set.has(Number(m.timestamp))).toArray();
    const byTs = new Map();
    [...found, ...rows].forEach(m => byTs.set(Number(m.timestamp), m));
    return [...byTs.values()].sort((a, b) => safeTimestamp(a) - safeTimestamp(b));
  }

  async function getRecentContextMessages(chatId, options = {}) {
    const {
      limit = 30,
      excludeHidden = true,
      excludeExcluded = true
    } = options || {};

    const safeLimit = Math.max(1, Number(limit) || 30);
    const fetchLimit = Math.max(safeLimit * 3, safeLimit);
    const db = getDb();

    let messages = [];
    if (db?.messages) {
      messages = await db.messages
        .where('[chatId+timestamp]')
        .between([chatId, Dexie.minKey], [chatId, Dexie.maxKey])
        .reverse()
        .limit(fetchLimit)
        .toArray();
      messages = messages.reverse();
    } else {
      messages = getWindowMessages(chatId).slice(-fetchLimit);
    }

    if (excludeHidden) {
      messages = messages.filter(m => !m.isHidden);
    }

    if (excludeExcluded) {
      messages = messages.filter(m => !m.isExcluded);
    }

    return messages.slice(-safeLimit);
  }

  async function getRecentMessages(chatId, limit, predicate = null) {
    const pageSize = getRenderWindow(limit);
    const rows = await getRecentContextMessages(chatId, {
      limit: pageSize,
      excludeHidden: false,
      excludeExcluded: false
    });

    const filtered = typeof predicate === 'function' ? rows.filter(predicate) : rows;
    return filtered.slice(-pageSize);
  }

  async function getLastVisibleMessage(chatId) {
    const recent = await getRecentMessages(chatId, 20, m => !m.isHidden);
    return recent[recent.length - 1] || null;
  }

  async function getPreviousVisibleMessage(chatId, timestamp) {
    const ts = Number(timestamp) || Date.now();
    const inWindow = getWindowMessages(chatId)
      .filter(m => !m.isHidden && Number(m.timestamp) < ts)
      .slice(-1)[0];
    if (inWindow) return inWindow;

    const db = getDb();
    if (!db?.messages) return null;
    const rows = await db.messages
      .where('[chatId+timestamp]')
      .between([chatId, Dexie.minKey], [chatId, ts], false, true)
      .reverse()
      .filter(m => !m.isHidden)
      .limit(1)
      .toArray();
    return rows[0] || null;
  }

  async function addMessageToChat(chatOrChatId, msg, options = {}) {
    const state = getState();
    const chatId = typeof chatOrChatId === 'string' ? chatOrChatId : chatOrChatId?.id;
    const chat = typeof chatOrChatId === 'string' ? state?.chats?.[chatOrChatId] : chatOrChatId;
    if (!chatId || !msg) return null;

    window.runtimeDiag?.markStart('MESSAGE_SAVE', {
      chatId,
      role: msg.role,
      type: msg.type || 'text',
      status: msg.status || null
    });

    let normalized = null;
    try {
      normalized = normalizeMessage(chatId, msg, options.index || 0);
      await persistMessages(chatId, [normalized]);

    const win = ensureMessageState()?.[chatId];
    if (win?.messages && !options.skipWindow) {
      if (!win.messages.some(m => m.id === normalized.id)) {
        Array.prototype.push.call(win.messages, normalized);
        win.loadedCount = win.messages.length;
        win.newestTimestamp = normalized.timestamp;
      }
    } else if (chat && Array.isArray(chat.history) && !chat.history.some(m => m.id === normalized.id) && !options.skipWindow) {
      Array.prototype.push.call(chat.history, normalized);
    }

    if (chat) {
      if (!normalized.isHidden) {
        chat.lastMessageTimestamp = normalized.timestamp;
        chat.lastMessagePreview = buildMessagePreview(normalized);
        chat.lastMessageRole = normalized.role || '';
        chat.lastMessageType = normalized.type || '';
      }
      chat.messageCount = Number(chat.messageCount || 0) + 1;
      await persistChatMeta(chat);
    }

      window.runtimeDiag?.markEnd('MESSAGE_SAVE', 'MESSAGE_SAVE_DONE', {
        chatId,
        id: normalized.id,
        role: normalized.role,
        type: normalized.type || 'text',
        status: normalized.status || null
      });
      window.runtimeDiag?.markEnd('DB_WRITE', 'DB_WRITE_DONE', { table: 'messages', chatId });
      return normalized;
    } catch (error) {
      // 将存储错误降级为非阻塞日志，返回内存中的消息继续工作
      window.runtimeDiag?.markEnd('MESSAGE_SAVE', 'MESSAGE_SAVE_ERROR', {
        chatId,
        error: error?.message || String(error)
      });
      window.runtimeDiag?.markEnd('DB_WRITE', 'DB_WRITE_ERROR', {
        table: 'messages',
        chatId,
        error: error?.message || String(error)
      });
      window.runtimeDiag?.log?.('MESSAGE_STORAGE_ERROR_NON_BLOCKING', {
        chatId,
        error: error?.message || String(error)
      });
      return normalized;
    }
  }

  async function updateMessage(chatId, timestamp, patchOrUpdater) {
    const existing = await getMessageByTimestamp(chatId, timestamp);
    if (!existing) return null;

    const updated =
      typeof patchOrUpdater === 'function'
        ? patchOrUpdater(existing) || existing
        : Object.assign(existing, patchOrUpdater || {});

    normalizeMessage(chatId, updated);
    await persistMessages(chatId, [updated]);

    const windowMsg = getWindowMessages(chatId).find(m => Number(m.timestamp) === Number(timestamp));
    if (windowMsg && windowMsg !== updated) {
      Object.assign(windowMsg, updated);
    }

    // 【修复重复识图】同步 state.chats[chatId].history
    // 之前只同步了 window 和 db，导致 ensureChatImagesVisionReady（基于 chat.history）
    // 读到的是 stale 的 status='pending'，误触发新一轮 ensureVisionPromise
    // → 看起来"识好图又重新识图"
    const state = getState();
    const chat = state?.chats?.[chatId];
    if (chat && Array.isArray(chat.history)) {
      const histMsg = chat.history.find(m => Number(m.timestamp) === Number(timestamp));
      if (histMsg && histMsg !== updated) {
        Object.assign(histMsg, updated);
      }
    }
    if (chat) await persistChatMeta(chat, getWindowMessages(chatId));
    return updated;
  }

  async function refreshChatMeta(chatId) {
    const db = getDb();
    const state = getState();
    const chat = state?.chats?.[chatId];
    if (!chat) return null;

    let total = 0;
    let lastVisible = null;

    if (db?.messages) {
      total = await db.messages.where('chatId').equals(chatId).count();
      const recent = await db.messages
        .where('[chatId+timestamp]')
        .between([chatId, Dexie.minKey], [chatId, Dexie.maxKey])
        .reverse()
        .limit(50)
        .toArray();
      lastVisible = recent.find(m => m && !m.isHidden) || null;
    } else {
      const windowMessages = getWindowMessages(chatId);
      total = windowMessages.length;
      lastVisible = [...windowMessages].reverse().find(m => m && !m.isHidden) || null;
    }

    chat.messageCount = total;
    chat.lastMessageTimestamp = lastVisible?.timestamp || 0;
    chat.lastMessagePreview = lastVisible ? buildMessagePreview(lastVisible) : '';
    chat.lastMessageRole = lastVisible?.role || '';
    chat.lastMessageType = lastVisible?.type || '';
    chat.updatedAt = Date.now();

    await persistChatMeta(chat);
    return chat;
  }

  async function deleteMessage(chatId, message) {
    const db = getDb();
    if (!chatId || !message) return false;

    const state = getState();
    console.log('[删除] chatId:', chatId);
    console.log('[删除] message:', message);
    console.log('[删除] message.id:', message?.id);
    console.log('[删除] currentMessages删除前:', state?.currentMessages?.length);
    console.trace('[删除] 调用来源');

    let deletedCount = 0;

    if (db?.messages) {
      if (message.id) {
        const existed = await db.messages.get(message.id);
        if (existed) {
          await db.messages.delete(message.id);
          deletedCount = 1;
        }
      }

      if (!deletedCount && message.timestamp != null) {
        const ts = Number(message.timestamp);
        const rows = await db.messages.where('chatId').equals(chatId).filter(m => Number(m.timestamp) === ts).limit(5).toArray();
        if (rows.length > 0) {
          await db.messages.bulkDelete(rows.map(m => m.id));
          deletedCount = rows.length;
        }
      }

      if (!deletedCount && message.createdAt != null) {
        const createdAt = Number(message.createdAt);
        const rows = await db.messages.where('chatId').equals(chatId).filter(m => Number(m.createdAt) === createdAt).limit(5).toArray();
        if (rows.length > 0) {
          await db.messages.bulkDelete(rows.map(m => m.id));
          deletedCount = rows.length;
        }
      }
    } else {
      const win = ensureMessageState()?.[chatId];
      const before = getWindowMessages(chatId).length;
      const filtered = getWindowMessages(chatId).filter(m => {
        if (message.id && m.id === message.id) return false;
        if (message.timestamp != null && Number(m.timestamp) === Number(message.timestamp)) return false;
        if (message.createdAt != null && Number(m.createdAt) === Number(message.createdAt)) return false;
        return true;
      });
      deletedCount = before - filtered.length;
      if (win) {
        setWindow(chatId, filtered, { hasMore: !!win.hasMore });
      }
    }

    if (!deletedCount) {
      console.warn('[删除消息] 缺少可定位字段或未找到消息', message);
      return false;
    }

    const win = ensureMessageState()?.[chatId];
    if (win?.messages) {
      win.messages = attachWindowHistory(chatId, win.messages.filter(m => {
        if (message.id && m.id === message.id) return false;
        if (message.timestamp != null && Number(m.timestamp) === Number(message.timestamp)) return false;
        if (message.createdAt != null && Number(m.createdAt) === Number(message.createdAt)) return false;
        return true;
      }));
      win.loadedCount = win.messages.length;
      win.oldestTimestamp = win.messages.length ? safeTimestamp(win.messages[0]) : null;
      win.newestTimestamp = win.messages.length ? safeTimestamp(win.messages[win.messages.length - 1]) : null;
      if (state?.chats?.[chatId]) state.chats[chatId].history = win.messages;
    }

    await refreshChatMeta(chatId);
    return true;
  }

  async function clearChatMessages(chatId, keepCount = 0) {
    const db = getDb();
    const state = getState();
    if (!chatId) return 0;

    const n = Math.max(0, Number(keepCount) || 0);
    let deletedCount = 0;
    let remainingMessages = [];

    if (db?.messages) {
      console.log('[清空聊天] chatId:', chatId);
      console.log('[清空聊天] keepCount:', keepCount);
      console.log('[清空聊天] 删除前总数:', await db.messages.where('chatId').equals(chatId).count());

      if (n <= 0) {
        deletedCount = await db.messages.where('chatId').equals(chatId).delete();
      } else {
        const keepMessagesDesc = await db.messages
          .where('[chatId+timestamp]')
          .between([chatId, Dexie.minKey], [chatId, Dexie.maxKey])
          .reverse()
          .limit(n)
          .toArray();

        const keepMessagesAsc = keepMessagesDesc.slice().reverse();
        const keepKeySet = new Set(
          keepMessagesAsc.map(m => (
            m?.id
              ? `id:${m.id}`
              : m?.timestamp != null
                ? `timestamp:${Number(m.timestamp)}`
                : m?.createdAt != null
                  ? `createdAt:${Number(m.createdAt)}`
                  : null
          )).filter(Boolean)
        );

        const allMessages = await db.messages.where('chatId').equals(chatId).toArray();
        const deleteIds = allMessages
          .filter(m => {
            const key = m?.id
              ? `id:${m.id}`
              : m?.timestamp != null
                ? `timestamp:${Number(m.timestamp)}`
                : m?.createdAt != null
                  ? `createdAt:${Number(m.createdAt)}`
                  : null;
            return key && !keepKeySet.has(key);
          })
          .map(m => m.id)
          .filter(Boolean);

        if (deleteIds.length > 0) {
          await db.messages.bulkDelete(deleteIds);
          deletedCount = deleteIds.length;
        }

        remainingMessages = keepMessagesAsc;
      }
    } else {
      const currentMessages = getWindowMessages(chatId);
      if (n <= 0) {
        deletedCount = currentMessages.length;
      } else {
        remainingMessages = currentMessages.slice(-n);
        deletedCount = Math.max(0, currentMessages.length - remainingMessages.length);
      }
    }

    const windows = ensureMessageState();
    if (windows) {
      const nextMessages = attachWindowHistory(chatId, remainingMessages);
      windows[chatId] = {
        messages: nextMessages,
        oldestTimestamp: nextMessages.length ? safeTimestamp(nextMessages[0]) : null,
        newestTimestamp: nextMessages.length ? safeTimestamp(nextMessages[nextMessages.length - 1]) : null,
        oldestCursor: null,
        newestCursor: null,
        hasMore: false,
        loadedCount: nextMessages.length
      };
    }

    if (state?.chats?.[chatId]) {
      const nextMessages = windows?.[chatId]?.messages || attachWindowHistory(chatId, remainingMessages);
      state.chats[chatId].history = nextMessages;
      state.chats[chatId].updatedAt = Date.now();
      await refreshChatMeta(chatId);
    }

    if (state) {
      if (state.activeChatId === chatId) {
        state.currentMessages = (windows?.[chatId]?.messages || []).slice();
      }
      if (state.messageWindows?.[chatId] && windows?.[chatId]) {
        state.messageWindows[chatId] = windows[chatId];
      }
    }

    return deletedCount;
  }

  async function deleteMessages(chatId, timestamps) {
    const set = new Set((timestamps || []).map(Number));
    if (set.size === 0) return 0;

    let count = 0;
    const list = await getMessagesByTimestamps(chatId, [...set]);
    for (const message of list) {
      const ok = await deleteMessage(chatId, message);
      if (ok) count++;
    }
    return count;
  }

  async function searchMessages(chatId, keyword, options = {}) {
    const db = getDb();
    const term = String(keyword || '').trim().toLowerCase();
    const limit = Number(options.limit || 200);
    if (!term) return [];

    const matcher = msg => {
      if (msg.isHidden && !options.includeHidden) return false;
      const text = [
        msg.content,
        msg.meaning,
        msg.note,
        msg.productInfo,
        msg.senderName,
        msg.receiverName
      ].map(v => (typeof v === 'string' ? v : JSON.stringify(v || ''))).join(' ').toLowerCase();
      return text.includes(term);
    };

    if (!db?.messages) return getWindowMessages(chatId).filter(matcher).slice(0, limit);
    return db.messages.where('chatId').equals(chatId).filter(matcher).limit(limit).toArray();
  }

  function prepareLoadedChats(chatsMap) {
    if (!chatsMap) return;
    Object.values(chatsMap).forEach(chat => {
      if (!chat) return;
      const windowHistory = Array.isArray(chat.history) ? chat.history.slice(-getRenderWindow()) : [];
      chat.history = attachWindowHistory(chat.id, windowHistory);
      chat.messageSchemaVersion = MESSAGE_SCHEMA_VERSION;
    });
  }

  async function migrateResidualHistories() {
    const db = getDb();
    if (!db?.chats || !db?.messages) return;
    const chats = await db.chats.toArray();
    for (const chat of chats) {
      if (Array.isArray(chat.history) && chat.history.length > 0) {
        await persistMessages(chat.id, chat.history);
        await persistChatMeta(chat, chat.history);
      }
    }
  }

  function wrapChatsTablePut() {
    const db = getDb();
    if (!db?.chats || db.chats.__messageStoreWrapped) return;

    const originalPut = db.chats.put.bind(db.chats);
    const originalAdd = db.chats.add.bind(db.chats);
    const originalBulkPut = db.chats.bulkPut.bind(db.chats);

    db.chats.put = async function (chat, key) {
      if (chat && Array.isArray(chat.history) && chat.history.length > 0) {
        await persistMessages(chat.id, chat.history);
      }
      return originalPut(stripChatHistory(chat), key);
    };

    db.chats.add = async function (chat, key) {
      if (chat && Array.isArray(chat.history) && chat.history.length > 0) {
        await persistMessages(chat.id, chat.history);
      }
      return originalAdd(stripChatHistory(chat), key);
    };

    db.chats.bulkPut = async function (chats, keys) {
      const list = Array.isArray(chats) ? chats : [];
      for (const chat of list) {
        if (chat && Array.isArray(chat.history) && chat.history.length > 0) {
          await persistMessages(chat.id, chat.history);
        }
      }
      return originalBulkPut(list.map(chat => stripChatHistory(chat)), keys);
    };

    Object.defineProperty(db.chats, '__messageStoreWrapped', {
      value: true,
      enumerable: false
    });
  }

  window.messageStore = {
    MESSAGE_SCHEMA_VERSION,
    normalizeMessage,
    stripChatHistory,
    buildMessagePreview,
    persistMessages,
    persistChatMeta,
    prepareLoadedChats,
    migrateResidualHistories,
    wrapChatsTablePut,
    loadRecentMessages,
    loadMessagesBefore,
    getWindowMessages,
    getMessageByTimestamp,
    getMessagesByTimestamps,
    getRecentContextMessages,
    getRecentMessages,
    getLastVisibleMessage,
    getPreviousVisibleMessage,
    addMessageToChat,
    updateMessage,
    deleteMessage,
    deleteMessages,
    clearChatMessages,
    refreshChatMeta,
    searchMessages,
    countMessages,
    setWindow
  };
})();
