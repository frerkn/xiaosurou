// Live2D 模型选择/管理 Picker (v0.4.6)
// 准备页"管理"按钮的轻量 UI 包装, 复用 5 个 Live2D 核心 API, 不重新实现上传/解压/保存
// 复用 API: Live2DStorage.listModels/getModel/deleteModel/getActiveModelIdForChat/setActiveModelIdForChat
// 复用 API: Live2DUploader.uploadZip/uploadFolder + Live2DStorage.saveModel
// 风格: 跟 #live2d-call-prep-screen 一致 (粉白 iOS 底部 sheet)
// API: window.Live2DModelPicker = { init, open, close }

(function (global) {
  'use strict';

  let modalEl = null;
  let listEl = null;
  let zipInputEl = null;
  let folderInputEl = null;
  let currentChat = null;
  let onCloseCallback = null;

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  async function renderList() {
    if (!listEl || !currentChat || !global.Live2DStorage) return;
    try {
      const models = await global.Live2DStorage.listModels();
      const activeId = await global.Live2DStorage.getActiveModelIdForChat(currentChat.id);
      if (models.length === 0) {
        listEl.innerHTML = '<div class="live2d-model-picker-empty">还没有 Live2D 模型, 上传一个吧</div>';
        return;
      }
      const html = models.map(m => {
        const isActive = m.id === activeId;
        const dateStr = new Date(m.addedAt).toLocaleDateString('zh-CN');
        return '<div class="live2d-model-picker-row ' + (isActive ? 'active' : '') + '" data-model-id="' + escapeHtml(m.id) + '">' +
          '<div class="live2d-model-picker-row-thumb">🎭</div>' +
          '<div class="live2d-model-picker-row-info">' +
            '<div class="live2d-model-picker-row-name">' + escapeHtml(m.name) + '</div>' +
            '<div class="live2d-model-picker-row-meta">' + m.fileCount + ' 个文件 · ' + dateStr + '</div>' +
          '</div>' +
          '<div class="live2d-model-picker-row-actions">' +
            (isActive ? '<span class="live2d-model-picker-row-check">✓</span>' : '') +
            '<button type="button" class="live2d-model-picker-row-del" data-action="delete" title="删除">✕</button>' +
          '</div>' +
        '</div>';
      }).join('');
      listEl.innerHTML = html;
    } catch (e) {
      listEl.innerHTML = '<div class="live2d-model-picker-empty">加载失败: ' + escapeHtml(e.message || String(e)) + '</div>';
    }
  }

  function close() {
    if (modalEl) modalEl.classList.remove('live2d-model-picker-open');
    const cb = onCloseCallback;
    currentChat = null;
    onCloseCallback = null;
    if (typeof cb === 'function') {
      try { cb(); } catch (e) { console.warn('Live2DModelPicker onClose error:', e); }
    }
  }

  async function selectModel(modelId) {
    if (!currentChat || !global.Live2DStorage) return;
    try {
      await global.Live2DStorage.setActiveModelIdForChat(currentChat.id, modelId);
      close();
    } catch (e) {
      console.warn('selectModel error:', e);
      alert('选择失败: ' + (e.message || String(e)));
    }
  }

  async function deleteModel(modelId) {
    if (!currentChat || !global.Live2DStorage) return;
    if (!confirm('确定删除这个模型？')) return;
    try {
      // 如果删的是当前 chat 绑定的, 先解绑避免 stale modelId
      const activeId = await global.Live2DStorage.getActiveModelIdForChat(currentChat.id);
      if (activeId === modelId) {
        await global.Live2DStorage.setActiveModelIdForChat(currentChat.id, '');
      }
      await global.Live2DStorage.deleteModel(modelId);
      await renderList();
    } catch (e) {
      alert('删除失败: ' + (e.message || String(e)));
    }
  }

  // 上传: 复用 uploader + storage, 自己拿 modelId 设 per-chat
  async function uploadZip(file) {
    if (!global.Live2DUploader || !global.Live2DStorage || !currentChat) return;
    try {
      const result = await global.Live2DUploader.uploadZip(file);
      const newId = await global.Live2DStorage.saveModel(result);
      await global.Live2DStorage.setActiveModelIdForChat(currentChat.id, newId);
      close();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      alert('上传失败: ' + msg);
    }
  }

  async function uploadFolder(fileList) {
    if (!global.Live2DUploader || !global.Live2DStorage || !currentChat) return;
    try {
      const result = await global.Live2DUploader.uploadFolder(fileList);
      const newId = await global.Live2DStorage.saveModel(result);
      await global.Live2DStorage.setActiveModelIdForChat(currentChat.id, newId);
      close();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      alert('上传失败: ' + msg);
    }
  }

  function bindInputs() {
    if (!zipInputEl) zipInputEl = document.getElementById('live2d-model-picker-zip-input');
    if (!folderInputEl) folderInputEl = document.getElementById('live2d-model-picker-folder-input');
    if (zipInputEl) {
      zipInputEl.onchange = async function () {
        if (this.files && this.files[0]) await uploadZip(this.files[0]);
        this.value = '';
      };
    }
    if (folderInputEl) {
      folderInputEl.onchange = async function () {
        if (this.files && this.files.length) await uploadFolder(this.files);
        this.value = '';
      };
    }
  }

  function init() {
    modalEl = document.getElementById('live2d-model-picker');
    if (!modalEl) return;
    listEl = document.getElementById('live2d-model-picker-list');
    bindInputs();
    const closeBtn = document.getElementById('live2d-model-picker-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const overlay = modalEl.querySelector('.live2d-model-picker-overlay');
    if (overlay) overlay.addEventListener('click', close);
    const zipBtn = document.getElementById('live2d-model-picker-upload-zip-btn');
    if (zipBtn && zipInputEl) zipBtn.addEventListener('click', () => zipInputEl.click());
    const folderBtn = document.getElementById('live2d-model-picker-upload-folder-btn');
    if (folderBtn && folderInputEl) folderBtn.addEventListener('click', () => folderInputEl.click());
    if (listEl) {
      listEl.addEventListener('click', async function (ev) {
        const row = ev.target.closest('[data-model-id]');
        if (!row) return;
        const modelId = row.getAttribute('data-model-id');
        if (ev.target.getAttribute('data-action') === 'delete') {
          await deleteModel(modelId);
          return;
        }
        await selectModel(modelId);
      });
    }
  }

  function open(chat, onClose) {
    if (!modalEl) init();
    if (!modalEl) return;
    currentChat = chat || null;
    onCloseCallback = onClose || null;
    if (modalEl) modalEl.classList.add('live2d-model-picker-open');
    renderList();
  }

  global.Live2DModelPicker = { init, open, close };
})(typeof window !== 'undefined' ? window : globalThis);
