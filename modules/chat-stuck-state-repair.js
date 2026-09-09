// ============================================================
// chat-stuck-state-repair.js
// 修复聊天窗口永久卡死状态
// ============================================================

(function () {
  const STALE_STATUSES = new Set(['generating', 'pending', 'streaming', 'loading']);
  const STALE_CUTOFF_MS = 5 * 60 * 1000; // 5分钟

  /**
   * 修复单个聊天的僵尸状态
   */
  async function repairStuckChatState(chatId) {
    if (!chatId || !window.db || !window.state) return;

    window.runtimeDiag?.log?.('CHAT_STUCK_STATE_SCAN_START', { chatId });

    const chat = window.state.chats?.[chatId];
    if (!chat) return;

    let hasStuckState = false;
    const now = Date.now();

    // 1. 扫描消息表中的异常状态
    const messages = window.messageStore 
      ? await window.messageStore.getRecentMessages(chatId, 100).catch(() => [])
      : (chat.history || []);

    for (const msg of messages) {
      if (!msg || msg.role !== 'assistant') continue;
      
      const status = msg.status || (msg.isStreaming ? 'streaming' : '');
      if (!STALE_STATUSES.has(status)) continue;

      const ts = Number(msg.timestamp || 0);
      if (ts && (now - ts) > STALE_CUTOFF_MS) {
        hasStuckState = true;
        window.runtimeDiag?.log?.('CHAT_STUCK_STATE_FOUND', {
          chatId,
          messageTimestamp: msg.timestamp,
          status
        });

        msg.status = 'failed';
        msg.error = msg.error || '上次生成异常中断';
        msg.isStreaming = false;
        msg.isTemporary = false;

        try {
          if (window.messageStore) {
            await window.messageStore.updateMessage(chatId, msg.timestamp, msg);
          }
          window.runtimeDiag?.log?.('CHAT_PENDING_MESSAGE_REPAIRED', {
            chatId,
            messageTimestamp: msg.timestamp
          });
        } catch (error) {
          window.runtimeDiag?.log?.('MESSAGE_STORAGE_ERROR_NON_BLOCKING', {
            chatId,
            messageTimestamp: msg.timestamp,
            error: error?.message || String(error)
          });
        }
      }
    }

    // 2. 清理聊天级别的锁定状态
    if (chat.isGenerating || chat.isResponding || chat.locked) {
      hasStuckState = true;
      window.runtimeDiag?.log?.('CHAT_STUCK_STATE_FOUND', {
        chatId,
        isGenerating: chat.isGenerating,
        isResponding: chat.isResponding,
        locked: chat.locked
      });

      delete chat.isGenerating;
      delete chat.isResponding;
      delete chat.locked;
    }

    // 3. 保存修复后的聊天状态
    if (hasStuckState) {
      try {
        await window.db.chats.put(chat);
        window.runtimeDiag?.log?.('CHAT_STUCK_STATE_REPAIRED', { chatId });
      } catch (error) {
        window.runtimeDiag?.log?.('MESSAGE_STORAGE_ERROR_NON_BLOCKING', {
          chatId,
          operation: 'repair_chat_state',
          error: error?.message || String(error)
        });
      }
    }

    return hasStuckState;
  }

  /**
   * 扫描并修复所有聊天的僵尸状态
   */
  async function scanAndRepairAllChats() {
    if (!window.state?.chats) return;

    const chatIds = Object.keys(window.state.chats);
    let repairedCount = 0;

    for (const chatId of chatIds) {
      const repaired = await repairStuckChatState(chatId).catch(() => false);
      if (repaired) repairedCount++;
    }

    if (repairedCount > 0) {
      console.log(`[僵尸状态修复] 已修复 ${repairedCount} 个聊天窗口`);
    }
  }

  /**
   * 强制解锁AI请求状态
   */
  function forceUnlockAiRequestState() {
    if (!window.state) return;

    const unlocked = {
      isGenerating: !!window.state.isGenerating,
      currentAbortController: !!window.state.currentAbortController,
      currentReader: !!window.state.currentReader
    };

    window.state.isGenerating = false;
    window.state.currentAbortController = null;
    window.state.currentReader = null;

    // 解锁发送按钮
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = '发送';
    }

    // 隐藏输入提示
    const typingIndicator = document.getElementById('typing-indicator');
    if (typingIndicator) {
      typingIndicator.style.display = 'none';
    }

    if (unlocked.isGenerating || unlocked.currentAbortController || unlocked.currentReader) {
      window.runtimeDiag?.log?.('AI_REQUEST_STATE_UNLOCKED', unlocked);
    }
  }

  /**
   * 页面启动时自动修复
   */
  async function initStuckStateRepair() {
    await window.dbReadyPromise;
    await scanAndRepairAllChats();
    forceUnlockAiRequestState();
  }

  /**
   * 发送前检查并修复当前聊天
   */
  async function ensureCurrentChatNotStuck() {
    if (!window.state?.activeChatId) return true;

    await repairStuckChatState(window.state.activeChatId);
    forceUnlockAiRequestState();

    // 检查是否还有活跃请求
    if (window.state.isGenerating && !window.state.currentAbortController && !window.state.currentReader) {
      window.runtimeDiag?.log?.('AI_REQUEST_STATE_UNLOCKED', {
        reason: 'no_active_controller_or_reader'
      });
      window.state.isGenerating = false;
      return true;
    }

    return !window.state.isGenerating;
  }

  // 暴露到全局
  window.chatStuckStateRepair = {
    repairStuckChatState,
    scanAndRepairAllChats,
    forceUnlockAiRequestState,
    ensureCurrentChatNotStuck
  };

  // 页面启动时自动执行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStuckStateRepair);
  } else {
    initStuckStateRepair();
  }
})();
