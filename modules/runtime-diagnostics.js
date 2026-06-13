(function () {
  'use strict';

  const STORAGE_KEY = 'runtimeDiagnosticsLogs';
  const MAX_LOGS = 500;
  const MAX_STRING = 300;
  const SENSITIVE_KEY_RE = /(api[-_]?key|authorization|token|password|passwd|secret|bearer|cookie|set-cookie)/i;
  const PENDING_STATUSES = new Set(['generating', 'pending', 'streaming', 'loading']);
  const stateMarks = new Map();
  let logs = [];
  let panelEl = null;
  let lastState = null;

  function nowIso() {
    return new Date().toISOString();
  }

  function safeJsonParse(text, fallback) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return fallback;
    }
  }

  function loadLogs() {
    const stored = safeJsonParse(localStorage.getItem(STORAGE_KEY) || '[]', []);
    logs = Array.isArray(stored) ? stored.slice(-MAX_LOGS) : [];
  }

  function persistLogs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(logs.slice(-MAX_LOGS)));
    } catch (_) {
      // 诊断日志写入失败不影响业务。
    }
  }

  function sanitizeString(value) {
    const str = String(value);
    if (/^data:image\//i.test(str) || /base64[,;]/i.test(str)) return '[base64 omitted]';
    if (/Bearer\s+[A-Za-z0-9._~+/=-]+/i.test(str)) return '[REDACTED]';
    return str.length > MAX_STRING ? `${str.slice(0, MAX_STRING)}...` : str;
  }

  function summarizePayload(value, depth = 0, seen = new WeakSet()) {
    if (value == null) return value;
    if (typeof value === 'string') return sanitizeString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'function') return '[function]';
    if (value instanceof Error) {
      return {
        name: sanitizeString(value.name || 'Error'),
        message: sanitizeString(value.message || ''),
        stack: value.stack ? sanitizeString(value.stack) : undefined
      };
    }
    if (value instanceof Blob) return `[Blob ${value.type || 'unknown'} ${value.size || 0} bytes]`;
    if (value instanceof File) return `[File ${sanitizeString(value.name)} ${value.size || 0} bytes]`;
    if (typeof value !== 'object') return sanitizeString(value);

    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (depth >= 3) {
      if (Array.isArray(value)) return `[Array(${value.length})]`;
      return '[Object]';
    }

    if (Array.isArray(value)) {
      return value.slice(0, 20).map(item => summarizePayload(item, depth + 1, seen));
    }

    const out = {};
    Object.keys(value).slice(0, 40).forEach(key => {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = '[REDACTED]';
        return;
      }
      if (/^(content|text|message|body|prompt|image|imageUrl|url)$/i.test(key)) {
        const raw = value[key];
        if (typeof raw === 'string') {
          out[key] = sanitizeString(raw);
        } else if (Array.isArray(raw)) {
          out[key] = `[Array(${raw.length})]`;
        } else if (raw && typeof raw === 'object') {
          out[key] = '[Object omitted]';
        } else {
          out[key] = raw;
        }
        return;
      }
      out[key] = summarizePayload(value[key], depth + 1, seen);
    });
    return out;
  }

  function log(event, payload = {}, durationMs) {
    const entry = {
      time: nowIso(),
      event: sanitizeString(event || 'UNKNOWN_EVENT'),
      payload: summarizePayload(payload),
      durationMs: typeof durationMs === 'number' ? Math.round(durationMs) : undefined
    };
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
    persistLogs();
    return entry;
  }

  function markStart(key, payload = {}) {
    stateMarks.set(key, { start: performance.now(), payload: summarizePayload(payload) });
    log(`${key}_START`, payload);
  }

  function markEnd(key, event, payload = {}) {
    const mark = stateMarks.get(key);
    const durationMs = mark ? performance.now() - mark.start : undefined;
    stateMarks.delete(key);
    return log(event || `${key}_DONE`, payload, durationMs);
  }

  function getVisibleScreenId() {
    return document.querySelector('.screen.active')?.id ||
      document.querySelector('.char-screen.active')?.id ||
      document.querySelector('[id$="-screen"].active')?.id ||
      'unknown';
  }

  function estimateLocalStorageSize() {
    let bytes = 0;
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i) || '';
        const value = localStorage.getItem(key) || '';
        bytes += (key.length + value.length) * 2;
      }
    } catch (_) {
      return { bytes: null, label: 'unknown' };
    }
    return { bytes, label: `${(bytes / 1024).toFixed(1)} KB` };
  }

  async function getCacheStorageState() {
    if (!('caches' in window)) return { supported: false, names: [], count: 0 };
    try {
      const names = await caches.keys();
      return { supported: true, names, count: names.length };
    } catch (error) {
      return { supported: true, names: [], count: 0, error: sanitizeString(error.message) };
    }
  }

  async function getServiceWorkerState() {
    if (!('serviceWorker' in navigator)) {
      return { supported: false, controller: 'unsupported', registration: 'unsupported' };
    }
    const controller = navigator.serviceWorker.controller ? (navigator.serviceWorker.controller.state || 'controlled') : 'none';
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      return {
        supported: true,
        controller,
        registration: registration ? {
          scope: registration.scope,
          active: registration.active?.state || null,
          waiting: registration.waiting?.state || null,
          installing: registration.installing?.state || null
        } : 'none'
      };
    } catch (error) {
      return { supported: true, controller, registration: 'error', error: sanitizeString(error.message) };
    }
  }

  function findLastDuration(events) {
    const hit = logs.slice().reverse().find(item => events.includes(item.event) && typeof item.durationMs === 'number');
    return hit ? `${hit.durationMs} ms` : 'unknown';
  }

  async function getPendingMessagesLight() {
    const result = { status: 'unknown', count: 'unknown', items: [] };
    try {
      const rows = [];
      const addLight = (msg, chatIdFallback) => {
        if (!msg || !PENDING_STATUSES.has(String(msg.status || '').toLowerCase())) return;
        rows.push({
          id: msg.id || null,
          chatId: msg.chatId || chatIdFallback || null,
          role: msg.role || null,
          status: msg.status || null,
          timestamp: msg.timestamp || msg.createdAt || null,
          error: msg.error ? sanitizeString(msg.error) : null
        });
      };

      if (window.db?.messages?.each) {
        await window.db.messages.each(msg => addLight(msg));
      } else if (window.state?.chats) {
        Object.values(window.state.chats).forEach(chat => {
          (chat?.history || []).forEach(msg => addLight(msg, chat.id));
        });
      } else {
        return result;
      }

      result.status = 'ok';
      result.count = rows.length;
      result.items = rows.slice(0, 30);
      return result;
    } catch (error) {
      return { status: 'unknown', count: 'unknown', items: [], error: sanitizeString(error.message) };
    }
  }

  async function getState() {
    const localStorageSize = estimateLocalStorageSize();
    const [serviceWorker, cacheStorage, pendingMessages] = await Promise.all([
      getServiceWorkerState(),
      getCacheStorageState(),
      getPendingMessagesLight()
    ]);

    lastState = {
      time: nowIso(),
      screenId: getVisibleScreenId(),
      url: location.href,
      domNodeCount: document.getElementsByTagName('*').length,
      localStorageSize,
      serviceWorker,
      cacheStorage,
      durations: {
        lastAiRequest: findLastDuration(['AI_REQUEST_DONE', 'AI_REQUEST_ERROR', 'AI_REQUEST_FINALLY']),
        lastMessageSave: findLastDuration(['MESSAGE_SAVE_DONE', 'MESSAGE_SAVE_ERROR']),
        lastChatRender: findLastDuration(['RENDER_CHAT_DONE', 'RENDER_CHAT_ERROR']),
        lastDbReadWrite: findLastDuration(['DB_WRITE_DONE', 'DB_WRITE_ERROR', 'DB_READ_DONE', 'DB_READ_ERROR'])
      },
      pendingMessages,
      logs: logs.slice(-50)
    };
    return lastState;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportLogs() {
    const payload = {
      exportedAt: nowIso(),
      logs: logs.slice()
    };
    downloadText(`runtime-diagnostics-${Date.now()}.json`, JSON.stringify(payload, null, 2));
    return payload;
  }

  function clearLogs() {
    logs = [];
    stateMarks.clear();
    persistLogs();
    log('DIAGNOSTIC_LOGS_CLEARED', {});
    renderPanel();
  }

  async function failPendingMessages() {
    const errorText = '已在运行诊断中终止挂起生成';
    let changed = 0;
    try {
      if (window.db?.messages?.each && window.db.messages.update) {
        const updates = [];
        await window.db.messages.each(msg => {
          const status = String(msg?.status || '').toLowerCase();
          if (PENDING_STATUSES.has(status)) {
            updates.push(window.db.messages.update(msg.id, { status: 'failed', error: errorText }));
          }
        });
        const results = await Promise.all(updates);
        changed += results.filter(Boolean).length;
      }

      if (window.state?.chats) {
        Object.values(window.state.chats).forEach(chat => {
          (chat?.history || []).forEach(msg => {
            const status = String(msg?.status || '').toLowerCase();
            if (PENDING_STATUSES.has(status)) {
              msg.status = 'failed';
              msg.error = errorText;
              changed += 1;
            }
          });
        });
      }

      log('DIAGNOSTIC_MARK_PENDING_FAILED', { changed });
      await renderPanel();
      alert(`已标记 ${changed} 条挂起生成消息为失败。`);
    } catch (error) {
      log('DIAGNOSTIC_MARK_PENDING_FAILED_ERROR', { error });
      alert(`标记失败：${error.message}`);
    }
  }

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.id = 'runtime-diagnostics-panel';
    panelEl.innerHTML = `
      <style>
        #runtime-diagnostics-panel {
          position: fixed;
          inset: 0;
          z-index: 999999;
          background: rgba(0, 0, 0, 0.45);
          color: #111;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        #runtime-diagnostics-panel .runtime-diag-sheet {
          position: absolute;
          inset: 18px;
          max-width: 920px;
          margin: 0 auto;
          background: #f7f7f9;
          border-radius: 18px;
          box-shadow: 0 18px 50px rgba(0,0,0,.28);
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        #runtime-diagnostics-panel .runtime-diag-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 12px 14px;
          background: #fff;
          border-bottom: 1px solid #e5e5ea;
          font-weight: 700;
        }
        #runtime-diagnostics-panel .runtime-diag-body {
          overflow: auto;
          padding: 12px;
          -webkit-overflow-scrolling: touch;
        }
        #runtime-diagnostics-panel button {
          border: 0;
          border-radius: 10px;
          padding: 8px 10px;
          background: #007aff;
          color: #fff;
          font-size: 13px;
        }
        #runtime-diagnostics-panel button.secondary { background: #8e8e93; }
        #runtime-diagnostics-panel button.danger { background: #ff3b30; }
        #runtime-diagnostics-panel .runtime-diag-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin: 8px 0 12px;
        }
        #runtime-diagnostics-panel .runtime-diag-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 8px;
        }
        #runtime-diagnostics-panel .runtime-diag-card {
          background: #fff;
          border-radius: 12px;
          padding: 10px;
          border: 1px solid #e5e5ea;
        }
        #runtime-diagnostics-panel .runtime-diag-label {
          color: #6b7280;
          font-size: 12px;
          margin-bottom: 4px;
        }
        #runtime-diagnostics-panel pre {
          white-space: pre-wrap;
          word-break: break-word;
          margin: 0;
          background: #111827;
          color: #d1d5db;
          border-radius: 10px;
          padding: 10px;
          font-size: 12px;
          line-height: 1.45;
        }
      </style>
      <div class="runtime-diag-sheet">
        <div class="runtime-diag-header">
          <button class="secondary" data-action="back">返回外观设置</button>
          <span>运行诊断面板 V1</span>
          <button class="secondary" data-action="close">关闭</button>
        </div>
        <div class="runtime-diag-body">
          <div class="runtime-diag-actions">
            <button data-action="refresh">刷新状态</button>
            <button data-action="export">导出日志 JSON</button>
            <button class="danger" data-action="clear">清空日志</button>
            <button class="danger" data-action="fail-pending">标记生成中消息为失败</button>
          </div>
          <div data-role="content">加载中...</div>
        </div>
      </div>
    `;
    panelEl.addEventListener('click', event => {
      const action = event.target?.dataset?.action;
      if (!action) return;
      if (action === 'back' || action === 'close') closePanel();
      if (action === 'refresh') renderPanel();
      if (action === 'export') exportLogs();
      if (action === 'clear') clearLogs();
      if (action === 'fail-pending') failPendingMessages();
    });
    return panelEl;
  }

  function stateToHtml(state) {
    const cards = [
      ['当前可见页面/screen id', state.screenId],
      ['当前 URL', state.url],
      ['DOM 节点数量', state.domNodeCount],
      ['localStorage 估算大小', state.localStorageSize.label],
      ['Service Worker controller', state.serviceWorker.controller],
      ['Service Worker registration', JSON.stringify(state.serviceWorker.registration)],
      ['Cache Storage 缓存数量', state.cacheStorage.count],
      ['Cache Storage 缓存名', state.cacheStorage.names.join(', ') || 'none'],
      ['最近一次 AI 请求耗时', state.durations.lastAiRequest],
      ['最近一次消息保存耗时', state.durations.lastMessageSave],
      ['最近一次聊天渲染耗时', state.durations.lastChatRender],
      ['最近一次 DB 读写耗时', state.durations.lastDbReadWrite],
      ['pending/generating 轻量检查', `${state.pendingMessages.count}`]
    ];

    return `
      <div class="runtime-diag-grid">
        ${cards.map(([label, value]) => `
          <div class="runtime-diag-card">
            <div class="runtime-diag-label">${escapeHtml(label)}</div>
            <div>${escapeHtml(value ?? 'unknown')}</div>
          </div>
        `).join('')}
      </div>
      <h4>pending/generating 消息轻量列表</h4>
      <pre>${escapeHtml(JSON.stringify(state.pendingMessages.items, null, 2))}</pre>
      <h4>最近 50 条诊断日志</h4>
      <pre>${escapeHtml(JSON.stringify(state.logs, null, 2))}</pre>
    `;
  }

  async function renderPanel() {
    const panel = ensurePanel();
    const content = panel.querySelector('[data-role="content"]');
    if (content) content.textContent = '刷新中...';
    const snapshot = await getState();
    if (content) content.innerHTML = stateToHtml(snapshot);
  }

  function openPanel() {
    const panel = ensurePanel();
    if (!panel.parentNode) document.body.appendChild(panel);
    panel.style.display = 'block';
    log('DIAGNOSTIC_PANEL_OPEN', { screenId: getVisibleScreenId() });
    renderPanel();
  }

  function closePanel() {
    if (panelEl) panelEl.style.display = 'none';
    log('DIAGNOSTIC_PANEL_CLOSE', { screenId: getVisibleScreenId() });
    if (typeof window.showScreen === 'function') {
      window.showScreen('wallpaper-screen');
    }
  }

  loadLogs();

  window.runtimeDiag = {
    log,
    markStart,
    markEnd,
    getState,
    exportLogs,
    clearLogs,
    openPanel,
    closePanel
  };
})();
