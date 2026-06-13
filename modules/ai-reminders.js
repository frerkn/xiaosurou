// ============================================================
// ai-reminders.js
// AI 定时提醒任务管理：仅负责本地数据管理和界面展示。
// 本阶段不接入后台扫描、不触发 AI、不发送通知、不插入聊天、不播放声音。
// ============================================================

(function () {
  const REPEAT_LABELS = {
    none: '不重复',
    daily: '每天',
    weekly: '每周'
  };

  let editingReminderId = null;

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
  }

  function createReminderId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `air_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function formatDateTime(timestamp) {
    const time = Number(timestamp);
    if (!Number.isFinite(time) || time <= 0) return '未设置';
    const date = new Date(time);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function readAIReminderDebugLogs() {
    if (typeof window.getAIReminderDebugLogs === 'function') {
      return window.getAIReminderDebugLogs();
    }

    try {
      const parsed = JSON.parse(localStorage.getItem('aiReminderDebugLogs') || '[]');
      return Array.isArray(parsed) ? parsed.slice(-100) : [];
    } catch (_) {
      return [];
    }
  }

  function renderAIReminderDebugLogs() {
    const container = document.getElementById('ai-reminder-debug-logs-list');
    if (!container) return;

    const logs = readAIReminderDebugLogs().slice(-100).reverse();
    if (logs.length === 0) {
      container.innerHTML = '<div class="ai-reminder-debug-empty">暂无提醒调试日志</div>';
      return;
    }

    container.innerHTML = logs.map(log => `
      <div class="ai-reminder-debug-log">
        <div class="ai-reminder-debug-log-head">
          <span>${escapeHtml(log.event || 'UNKNOWN')}</span>
          <time>${escapeHtml(formatDateTime(Date.parse(log.time)))}</time>
        </div>
        <div class="ai-reminder-debug-log-meta">
          ${escapeHtml(log.reminderName || '')}${log.reminderId ? ` · ${escapeHtml(log.reminderId)}` : ''}
        </div>
        <pre>${escapeHtml(typeof log.detail === 'string' ? log.detail : JSON.stringify(log.detail || ''))}</pre>
      </div>
    `).join('');
  }

  function ensureAIReminderDebugPanel() {
    const list = document.getElementById('ai-reminders-list');
    if (!list || document.getElementById('ai-reminder-debug-panel')) return;

    const panel = document.createElement('section');
    panel.id = 'ai-reminder-debug-panel';
    panel.className = 'ai-reminder-debug-panel';
    panel.innerHTML = `
      <div class="ai-reminder-debug-title">提醒调试日志</div>
      <div class="ai-reminder-debug-actions">
        <button type="button" id="ai-reminder-debug-refresh">刷新日志</button>
        <button type="button" id="ai-reminder-debug-clear">清空日志</button>
        <button type="button" id="ai-reminder-debug-scan">立即扫描提醒</button>
      </div>
      <div id="ai-reminder-debug-logs-list" class="ai-reminder-debug-logs-list"></div>
    `;
    list.insertAdjacentElement('afterend', panel);

    document.getElementById('ai-reminder-debug-refresh')?.addEventListener('click', renderAIReminderDebugLogs);
    document.getElementById('ai-reminder-debug-clear')?.addEventListener('click', () => {
      if (typeof window.clearAIReminderDebugLogs === 'function') {
        window.clearAIReminderDebugLogs();
      } else {
        localStorage.setItem('aiReminderDebugLogs', '[]');
      }
      renderAIReminderDebugLogs();
    });
    document.getElementById('ai-reminder-debug-scan')?.addEventListener('click', async () => {
      const button = document.getElementById('ai-reminder-debug-scan');
      if (button) button.disabled = true;
      try {
        if (typeof window.runAIReminderImmediateScan === 'function') {
          await window.runAIReminderImmediateScan('debug_button');
        }
      } finally {
        renderAIReminderDebugLogs();
        if (button) button.disabled = false;
      }
    });
  }

  function toDateTimeLocalValue(timestamp) {
    const time = Number(timestamp);
    if (!Number.isFinite(time) || time <= 0) return '';
    const date = new Date(time);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function computeNextTriggerAt(remindAt, repeatType) {
    let next = Number(remindAt);
    if (!Number.isFinite(next) || next <= 0) return null;

    const now = Date.now();
    if (repeatType === 'daily') {
      const oneDay = 24 * 60 * 60 * 1000;
      while (next < now) next += oneDay;
    } else if (repeatType === 'weekly') {
      const oneWeek = 7 * 24 * 60 * 60 * 1000;
      while (next < now) next += oneWeek;
    }

    return next;
  }

  async function getLightweightCharacters() {
    const fromState = Object.values(window.state?.chats || {})
      .filter(chat => chat && chat.id && !chat.isOnlineFriend)
      .map(chat => ({
        id: chat.id,
        name: chat.name || chat.originalName || '未命名聊天',
        avatar: chat.isGroup ? chat.settings?.groupAvatar : chat.settings?.aiAvatar,
        isGroup: !!chat.isGroup
      }));

    if (fromState.length > 0) return fromState;

    if (!window.db?.chats) return [];

    const chats = await db.chats.toArray();
    return chats
      .filter(chat => chat && chat.id && !chat.isOnlineFriend)
      .map(chat => ({
        id: chat.id,
        name: chat.name || chat.originalName || '未命名聊天',
        avatar: chat.isGroup ? chat.settings?.groupAvatar : chat.settings?.aiAvatar,
        isGroup: !!chat.isGroup
      }));
  }

  async function populateCharacterSelect(selectedId = '') {
    const select = document.getElementById('ai-reminder-character-select');
    if (!select) return;

    const characters = await getLightweightCharacters();
    select.innerHTML = '<option value="">请选择角色/聊天对象</option>' + characters.map(character => `
      <option value="${escapeHtml(character.id)}" data-name="${escapeHtml(character.name)}"${character.id === selectedId ? ' selected' : ''}>
        ${escapeHtml(character.name)}${character.isGroup ? '（群聊）' : ''}
      </option>
    `).join('');
  }

  function getFormElements() {
    return {
      title: document.getElementById('ai-reminder-title-input'),
      character: document.getElementById('ai-reminder-character-select'),
      remindAt: document.getElementById('ai-reminder-time-input'),
      repeatType: document.getElementById('ai-reminder-repeat-select'),
      content: document.getElementById('ai-reminder-content-input'),
      enabled: document.getElementById('ai-reminder-enabled-switch'),
      useAI: document.getElementById('ai-reminder-use-ai-switch'),
      insertIntoChat: document.getElementById('ai-reminder-insert-chat-switch'),
      sendSystemNotification: document.getElementById('ai-reminder-system-notification-switch'),
      playSound: document.getElementById('ai-reminder-play-sound-switch')
    };
  }

  function resetReminderForm() {
    const els = getFormElements();
    editingReminderId = null;
    document.getElementById('ai-reminder-editor-title').textContent = '新建提醒';
    els.title.value = '';
    els.remindAt.value = '';
    els.repeatType.value = 'none';
    els.content.value = '';
    els.enabled.checked = true;
    els.useAI.checked = false;
    els.insertIntoChat.checked = false;
    els.sendSystemNotification.checked = false;
    els.playSound.checked = false;
  }

  async function openAIReminderEditor(reminderId = null) {
    resetReminderForm();
    await populateCharacterSelect('');

    if (reminderId) {
      const reminder = await db.aiReminders.get(reminderId);
      if (!reminder) return;

      editingReminderId = reminder.id;
      document.getElementById('ai-reminder-editor-title').textContent = '编辑提醒';

      const els = getFormElements();
      els.title.value = reminder.title || '';
      await populateCharacterSelect(reminder.characterId || '');
      els.remindAt.value = toDateTimeLocalValue(reminder.remindAt || reminder.nextTriggerAt);
      els.repeatType.value = reminder.repeatType || 'none';
      els.content.value = reminder.content || '';
      els.enabled.checked = reminder.enabled !== false;
      els.useAI.checked = !!reminder.useAI;
      els.insertIntoChat.checked = !!reminder.insertIntoChat;
      els.sendSystemNotification.checked = !!reminder.sendSystemNotification;
      els.playSound.checked = !!reminder.playSound;
    }

    showScreen('ai-reminder-editor-screen');
  }

  async function saveAIReminderFromForm() {
    const els = getFormElements();
    const title = els.title.value.trim();
    const characterId = els.character.value;
    const selectedOption = els.character.options[els.character.selectedIndex];
    const characterName = selectedOption?.dataset?.name || selectedOption?.textContent?.replace('（群聊）', '').trim() || '';
    const remindAt = els.remindAt.value ? new Date(els.remindAt.value).getTime() : null;
    const repeatType = els.repeatType.value || 'none';
    const content = els.content.value.trim();

    if (!title) {
      alert('请填写提醒名称');
      return;
    }
    if (!characterId) {
      alert('请选择角色/聊天对象');
      return;
    }
    if (!Number.isFinite(remindAt) || remindAt <= 0) {
      alert('请设置有效的提醒时间');
      return;
    }

    const now = Date.now();
    const existing = editingReminderId ? await db.aiReminders.get(editingReminderId) : null;
    const reminder = {
      id: existing?.id || createReminderId(),
      title,
      enabled: !!els.enabled.checked,
      characterId,
      characterName,
      remindAt,
      repeatType,
      content,
      useAI: !!els.useAI.checked,
      insertIntoChat: !!els.insertIntoChat.checked,
      sendSystemNotification: !!els.sendSystemNotification.checked,
      playSound: !!els.playSound.checked,
      lastTriggeredAt: existing?.lastTriggeredAt || null,
      nextTriggerAt: computeNextTriggerAt(remindAt, repeatType),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    await db.aiReminders.put(reminder);
    showScreen('ai-reminders-screen');
    await renderAIReminders();
  }

  async function toggleAIReminder(reminderId) {
    const reminder = await db.aiReminders.get(reminderId);
    if (!reminder) return;
    reminder.enabled = !reminder.enabled;
    reminder.updatedAt = Date.now();
    if (reminder.enabled) {
      reminder.nextTriggerAt = computeNextTriggerAt(reminder.remindAt, reminder.repeatType);
    }
    await db.aiReminders.put(reminder);
    await renderAIReminders();
  }

  async function deleteAIReminder(reminderId) {
    const reminder = await db.aiReminders.get(reminderId);
    if (!reminder) return;

    let confirmed = false;
    if (typeof showCustomConfirm === 'function') {
      confirmed = await showCustomConfirm('删除提醒', `确定要删除“${reminder.title || '未命名提醒'}”吗？此操作不可撤销。`, {
        confirmButtonClass: 'btn-danger'
      });
    } else {
      confirmed = window.confirm(`确定要删除“${reminder.title || '未命名提醒'}”吗？`);
    }

    if (!confirmed) return;
    await db.aiReminders.delete(reminderId);
    await renderAIReminders();
  }

  async function renderAIReminders() {
    const list = document.getElementById('ai-reminders-list');
    if (!list || !window.db?.aiReminders) return;

    const reminders = await db.aiReminders.orderBy('nextTriggerAt').toArray();

    if (reminders.length === 0) {
      list.innerHTML = `
        <div class="ai-reminder-empty">
          <div class="ai-reminder-empty-icon">⏰</div>
          <div>暂无 AI 定时提醒</div>
          <p>点击右上角“+”创建提醒计划。到点后会由提醒调度器自动扫描触发。</p>
        </div>
      `;
      ensureAIReminderDebugPanel();
      renderAIReminderDebugLogs();
      return;
    }

    list.innerHTML = reminders.map(reminder => `
      <div class="ai-reminder-card" data-reminder-id="${escapeHtml(reminder.id)}">
        <div class="ai-reminder-main" data-action="edit">
          <div class="ai-reminder-title-row">
            <span class="ai-reminder-title">${escapeHtml(reminder.title || '未命名提醒')}</span>
            <span class="ai-reminder-status ${reminder.enabled ? 'enabled' : 'paused'}">${reminder.enabled ? '启用' : '暂停'}</span>
          </div>
          <div class="ai-reminder-meta">角色：${escapeHtml(reminder.characterName || reminder.characterId || '未选择')}</div>
          <div class="ai-reminder-meta">下次提醒：${escapeHtml(formatDateTime(reminder.nextTriggerAt))}</div>
          <div class="ai-reminder-meta">重复规则：${escapeHtml(REPEAT_LABELS[reminder.repeatType] || reminder.repeatType || '不重复')}</div>
        </div>
        <div class="ai-reminder-actions">
          <button type="button" class="ai-reminder-action-btn" data-action="toggle">${reminder.enabled ? '暂停' : '启用'}</button>
          <button type="button" class="ai-reminder-action-btn danger" data-action="delete">删除</button>
        </div>
      </div>
    `).join('');

    ensureAIReminderDebugPanel();
    renderAIReminderDebugLogs();
  }

  function bindAIReminderEvents() {
    const addBtn = document.getElementById('add-ai-reminder-btn');
    const saveBtn = document.getElementById('save-ai-reminder-btn');
    const list = document.getElementById('ai-reminders-list');

    ensureAIReminderDebugPanel();

    if (addBtn && !addBtn.dataset.bound) {
      addBtn.dataset.bound = 'true';
      addBtn.addEventListener('click', () => openAIReminderEditor());
    }

    if (saveBtn && !saveBtn.dataset.bound) {
      saveBtn.dataset.bound = 'true';
      saveBtn.addEventListener('click', saveAIReminderFromForm);
    }

    if (list && !list.dataset.bound) {
      list.dataset.bound = 'true';
      list.addEventListener('click', event => {
        const card = event.target.closest('.ai-reminder-card');
        if (!card) return;
        const reminderId = card.dataset.reminderId;
        const action = event.target.closest('[data-action]')?.dataset?.action;
        if (action === 'toggle') {
          event.stopPropagation();
          toggleAIReminder(reminderId);
        } else if (action === 'delete') {
          event.stopPropagation();
          deleteAIReminder(reminderId);
        } else {
          openAIReminderEditor(reminderId);
        }
      });
    }
  }

  function openAIRemindersScreen() {
    showScreen('ai-reminders-screen');
    bindAIReminderEvents();
    renderAIReminders();
  }

  document.addEventListener('DOMContentLoaded', bindAIReminderEvents);

  window.openAIRemindersScreen = openAIRemindersScreen;
  window.renderAIReminders = renderAIReminders;
  window.openAIReminderEditor = openAIReminderEditor;
})();
