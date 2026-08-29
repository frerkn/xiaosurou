// Live2D 专区弹窗 — 视频通话前的准备页面 (跟糯米机 CallSetupGuide 一致)
// v0.3.7: 取代 v0.3.2 设置页 Live2D 区块, 改成点视频通话按钮 → 弹本弹窗 → 选模型 + 背景 → 开始通话
// 依赖: window.Live2DStorage / window.Live2DUploader / window.Live2DUI (handleModelUpload/handleBackgroundUpload)
// 入口: window.Live2DHub.open() / window.Live2DHub.close()

(function (global) {
  'use strict';

  // 弹窗容器引用 (init 时拿一次)
  let modalEl = null;
  let listEl = null;
  let bgListEl = null;
  let startBtnEl = null;
  let statusEl = null;
  let onStartCallback = null;  // 用户点"开始通话"后的回调 (video-voice-call.js 注入)

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // 刷新状态提示 + 开始按钮 disable
  async function refreshStatus() {
    if (!statusEl || !startBtnEl) return;
    if (!global.Live2DStorage) {
      statusEl.textContent = 'Live2DStorage 未加载';
      startBtnEl.disabled = true;
      return;
    }
    const models = await global.Live2DStorage.listModels();
    const activeId = await global.Live2DStorage.getActiveModelId();
    if (models.length === 0) {
      statusEl.textContent = '还没有模型, 请先上传 ZIP 或文件夹';
      startBtnEl.disabled = true;
      return;
    }
    if (!activeId) {
      statusEl.textContent = '请在下方选一个模型';
      startBtnEl.disabled = true;
      return;
    }
    const active = models.find(m => m.id === activeId);
    const name = active ? active.name : '未命名';
    statusEl.textContent = `当前: ${name}`;
    startBtnEl.disabled = false;
  }

  // 渲染模型列表 (粉白 iOS 卡片, emoji 占位不渲染 texture PNG — 防止 iOS Safari 崩)
  async function renderModelList() {
    if (!listEl) return;
    if (!global.Live2DStorage) {
      listEl.innerHTML = '<div class="live2d-hub-empty">Live2DStorage 未加载</div>';
      return;
    }
    const models = await global.Live2DStorage.listModels();
    const activeId = await global.Live2DStorage.getActiveModelId();

    if (models.length === 0) {
      listEl.innerHTML = '<div class="live2d-hub-empty">还没有模型, 点下方按钮上传</div>';
      return;
    }

    const html = models.map(m => {
      const isActive = m.id === activeId;
      const activeClass = isActive ? ' live2d-hub-card-active' : '';
      const mark = isActive ? '<span class="live2d-hub-card-mark">✓</span>' : '';
      const dateStr = new Date(m.addedAt).toLocaleDateString('zh-CN');
      return `
        <div class="live2d-hub-card${activeClass}" data-model-id="${m.id}">
          <div class="live2d-hub-card-thumb">🎭</div>
          <div class="live2d-hub-card-info">
            <div class="live2d-hub-card-name">${escapeHtml(m.name)}</div>
            <div class="live2d-hub-card-meta">${m.fileCount} 个文件 · ${dateStr}</div>
          </div>
          ${mark}
          <button class="live2d-hub-card-del" data-action="delete" title="删除">✕</button>
        </div>
      `;
    }).join('');
    listEl.innerHTML = html;
  }

  // 渲染背景列表
  async function renderBackgroundList() {
    if (!bgListEl) return;
    if (!global.db) {
      bgListEl.innerHTML = '<div class="live2d-hub-empty">IDB 未初始化</div>';
      return;
    }
    const all = await global.db.live2d_backgrounds.toArray();
    const activeId = (() => { try { return localStorage.getItem('live2d.activeBackgroundId') || ''; } catch (e) { return ''; } })();
    const sorted = all.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

    if (sorted.length === 0) {
      bgListEl.innerHTML = '<div class="live2d-hub-empty">还没有背景 (可选, 不影响通话)</div>';
      return;
    }

    const html = sorted.map(bg => {
      const isActive = bg.id === activeId;
      const activeClass = isActive ? ' live2d-hub-card-active' : '';
      const mark = isActive ? '<span class="live2d-hub-card-mark">✓</span>' : '';
      return `
        <div class="live2d-hub-card${activeClass}" data-bg-id="${bg.id}">
          <div class="live2d-hub-card-thumb">🖼</div>
          <div class="live2d-hub-card-info">
            <div class="live2d-hub-card-name">${escapeHtml(bg.name)}</div>
          </div>
          ${mark}
          <button class="live2d-hub-card-del" data-action="delete" title="删除">✕</button>
        </div>
      `;
    }).join('');
    bgListEl.innerHTML = html;
  }

  // 渲染所有
  async function renderAll() {
    await Promise.all([renderModelList(), renderBackgroundList(), refreshStatus()]);
  }

  // 初始化 (绑事件, 拿 DOM)
  function init() {
    modalEl = document.getElementById('live2d-hub-modal');
    listEl = document.getElementById('live2d-hub-model-list');
    bgListEl = document.getElementById('live2d-hub-bg-list');
    startBtnEl = document.getElementById('live2d-hub-start-btn');
    statusEl = document.getElementById('live2d-hub-status');
    if (!modalEl) return;

    // 关闭按钮
    const closeBtn = document.getElementById('live2d-hub-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', close);

    // 点遮罩关闭
    modalEl.addEventListener('click', function (ev) {
      if (ev.target === modalEl) close();
    });

    // 上传按钮 → 触发隐藏 input
    const zipBtn = document.getElementById('live2d-hub-upload-zip-btn');
    const zipInput = document.getElementById('live2d-hub-upload-zip-input');
    if (zipBtn && zipInput) zipBtn.addEventListener('click', () => zipInput.click());
    if (zipInput) {
      zipInput.addEventListener('change', async function () {
        if (global.Live2DUI && global.Live2DUI.handleModelUpload) {
          await global.Live2DUI.handleModelUpload(this.files, 'zip', listEl);
        }
        this.value = '';
        await renderAll();
      });
    }
    const folderBtn = document.getElementById('live2d-hub-upload-folder-btn');
    const folderInput = document.getElementById('live2d-hub-upload-folder-input');
    if (folderBtn && folderInput) folderBtn.addEventListener('click', () => folderInput.click());
    if (folderInput) {
      folderInput.addEventListener('change', async function () {
        if (global.Live2DUI && global.Live2DUI.handleModelUpload) {
          await global.Live2DUI.handleModelUpload(this.files, 'folder', listEl);
        }
        this.value = '';
        await renderAll();
      });
    }
    const bgBtn = document.getElementById('live2d-hub-upload-bg-btn');
    const bgInput = document.getElementById('live2d-hub-upload-bg-input');
    if (bgBtn && bgInput) bgBtn.addEventListener('click', () => bgInput.click());
    if (bgInput) {
      bgInput.addEventListener('change', async function () {
        if (global.Live2DUI && global.Live2DUI.handleBackgroundUpload) {
          await global.Live2DUI.handleBackgroundUpload(this.files && this.files[0], bgListEl);
        }
        this.value = '';
        await renderAll();
      });
    }

    // 模型卡片点击 (事件委托)
    if (listEl) {
      listEl.addEventListener('click', async function (ev) {
        const card = ev.target.closest('[data-model-id]');
        if (!card) return;
        const modelId = card.getAttribute('data-model-id');
        if (ev.target.getAttribute('data-action') === 'delete') {
          if (!confirm('确定删除这个模型？')) return;
          await global.Live2DStorage.deleteModel(modelId);
          const cur = await global.Live2DStorage.getActiveModelId();
          if (cur === modelId) await global.Live2DStorage.setActiveModelId('');
          await renderAll();
          return;
        }
        await global.Live2DStorage.setActiveModelId(modelId);
        await renderAll();
      });
    }
    if (bgListEl) {
      bgListEl.addEventListener('click', async function (ev) {
        const card = ev.target.closest('[data-bg-id]');
        if (!card) return;
        const bgId = card.getAttribute('data-bg-id');
        if (ev.target.getAttribute('data-action') === 'delete') {
          if (!confirm('确定删除这个背景？')) return;
          await global.db.live2d_backgrounds.delete(bgId);
          const cur = (() => { try { return localStorage.getItem('live2d.activeBackgroundId') || ''; } catch (e) { return ''; } })();
          if (cur === bgId) {
            try { localStorage.setItem('live2d.activeBackgroundId', ''); } catch (e) {}
            if (global.Live2DUI && global.Live2DUI.applyBackgroundToCallScreen) {
              global.Live2DUI.applyBackgroundToCallScreen('');
            }
          }
          await renderAll();
          return;
        }
        try { localStorage.setItem('live2d.activeBackgroundId', bgId); } catch (e) {}
        await renderAll();
      });
    }

    // 开始通话按钮
    if (startBtnEl) {
      startBtnEl.addEventListener('click', function () {
        if (startBtnEl.disabled) return;
        const cb = onStartCallback;
        close();
        if (typeof cb === 'function') {
          try { cb(); } catch (e) { console.warn('Live2DHub onStart error:', e); }
        }
      });
    }
  }

  // 打开弹窗 (cb = 用户点"开始通话"后回调)
  async function open(cb) {
    if (!modalEl) init();
    if (!modalEl) return;
    onStartCallback = cb || null;
    modalEl.style.display = 'flex';
    await renderAll();
  }

  function close() {
    if (modalEl) modalEl.style.display = 'none';
    onStartCallback = null;
  }

  global.Live2DHub = { init, open, close, renderAll };
})(typeof window !== 'undefined' ? window : globalThis);
