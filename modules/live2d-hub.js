// Live2D 专区弹窗 — 底部 iOS sheet 风格 (跟糯米机 CallSetupGuide 一致)
// v0.3.8: 步骤化 UI (01 对方形象 → 02 通话背景 → 按这个方案接通), 浅色主题, 浅粉主色
// 依赖: window.Live2DStorage / window.Live2DUploader / window.Live2DUI (handleModelUpload/handleBackgroundUpload)
// 入口: window.Live2DHub.open() / window.Live2DHub.close()

(function (global) {
  'use strict';

  let modalEl = null;
  let bodyEl = null;
  let primaryBtnEl = null;
  let secondaryBtnEl = null;
  let closeBtnEl = null;
  let overlayBtnEl = null;
  let onStartCallback = null;
  let currentStep = 'model';  // 'model' | 'background'

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // 渲染 step = 'model' 内容
  async function renderModelStep() {
    if (!bodyEl) return;
    if (!global.Live2DStorage) {
      bodyEl.innerHTML = '<div class="live2d-hub-empty">Live2DStorage 未加载</div>';
      return;
    }
    const models = await global.Live2DStorage.listModels();
    const activeId = await global.Live2DStorage.getActiveModelId();
    const active = models.find(m => m.id === activeId);

    const html = [];

    // 当前状态
    html.push('<p class="live2d-hub-section-title">CURRENT CAST</p>');
    html.push('<div class="live2d-hub-current">');
    html.push('<div class="live2d-hub-current-icon">🎭</div>');
    html.push('<div class="live2d-hub-current-text">');
    html.push(`<div class="live2d-hub-current-name">${escapeHtml(active ? active.name : '尚未绑定动态模型')}</div>`);
    html.push('<div class="live2d-hub-current-meta">Live2D · 可校准构图、动作与衣橱</div>');
    html.push('</div>');
    if (active) html.push('<div class="live2d-hub-current-check">✓</div>');
    html.push('</div>');

    // 上传按钮 (iOS 列表风格)
    html.push('<div class="live2d-hub-list">');
    html.push('<button type="button" class="live2d-hub-row-action" id="live2d-hub-action-zip">');
    html.push('<span class="live2d-hub-row-action-icon">📦</span>');
    html.push('<span class="live2d-hub-row-action-text">');
    html.push('<span class="live2d-hub-row-action-name">模型文件</span>');
    html.push('<span class="live2d-hub-row-action-meta">Live2D ZIP, .moc3 + 纹理全打包</span>');
    html.push('</span>');
    html.push('<span class="live2d-hub-row-action-arrow">›</span>');
    html.push('</button>');

    html.push('<button type="button" class="live2d-hub-row-action" id="live2d-hub-action-folder">');
    html.push('<span class="live2d-hub-row-action-icon">📁</span>');
    html.push('<span class="live2d-hub-row-action-text">');
    html.push('<span class="live2d-hub-row-action-name">Live2D 完整文件夹</span>');
    html.push('<span class="live2d-hub-row-action-meta">选择包含 model3.json 的整个目录</span>');
    html.push('</span>');
    html.push('<span class="live2d-hub-row-action-arrow">›</span>');
    html.push('</button>');
    html.push('</div>');

    // 已有模型列表 (如果有)
    if (models.length > 0) {
      html.push('<p class="live2d-hub-section-title">已上传的模型</p>');
      html.push('<div class="live2d-hub-list">');
      for (const m of models) {
        const isActive = m.id === activeId;
        const dateStr = new Date(m.addedAt).toLocaleDateString('zh-CN');
        html.push(`<div class="live2d-hub-row" data-model-id="${m.id}">`);
        html.push('<div class="live2d-hub-row-thumb">🎭</div>');
        html.push('<div class="live2d-hub-row-text">');
        html.push(`<div class="live2d-hub-row-name">${escapeHtml(m.name)}</div>`);
        html.push(`<div class="live2d-hub-row-meta">${m.fileCount} 个文件 · ${dateStr}</div>`);
        html.push('</div>');
        html.push('<div class="live2d-hub-row-actions">');
        if (isActive) html.push('<span class="live2d-hub-row-check">✓</span>');
        html.push(`<button type="button" class="live2d-hub-row-del" data-action="delete" title="删除">✕</button>`);
        html.push('</div>');
        html.push('</div>');
      }
      html.push('</div>');
    }

    bodyEl.innerHTML = html.join('');

    // 绑事件
    bindUploadTriggers();
    bindModelRowEvents();
  }

  // 渲染 step = 'background' 内容
  async function renderBackgroundStep() {
    if (!bodyEl) return;
    if (!global.db) {
      bodyEl.innerHTML = '<div class="live2d-hub-empty">IDB 未初始化</div>';
      return;
    }
    const all = await global.db.live2d_backgrounds.toArray();
    const activeId = (() => { try { return localStorage.getItem('live2d.activeBackgroundId') || ''; } catch (e) { return ''; } })();
    const sorted = all.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const active = sorted.find(b => b.id === activeId);

    const html = [];

    // 当前状态
    html.push('<p class="live2d-hub-section-title">CURRENT BACKDROP</p>');
    html.push('<div class="live2d-hub-current">');
    html.push('<div class="live2d-hub-current-icon">🖼</div>');
    html.push('<div class="live2d-hub-current-text">');
    html.push(`<div class="live2d-hub-current-name">${escapeHtml(active ? active.name : '未设置 (用原视频画面)')}</div>`);
    html.push('<div class="live2d-hub-current-meta">通话时显示在角色背后</div>');
    html.push('</div>');
    if (active) html.push('<div class="live2d-hub-current-check">✓</div>');
    html.push('</div>');

    // 上传按钮
    html.push('<div class="live2d-hub-list">');
    html.push('<button type="button" class="live2d-hub-row-action" id="live2d-hub-action-bg">');
    html.push('<span class="live2d-hub-row-action-icon">🖼</span>');
    html.push('<span class="live2d-hub-row-action-text">');
    html.push('<span class="live2d-hub-row-action-name">上传背景图片</span>');
    html.push('<span class="live2d-hub-row-action-meta">JPG / PNG, 通话时全屏铺满</span>');
    html.push('</span>');
    html.push('<span class="live2d-hub-row-action-arrow">›</span>');
    html.push('</button>');
    html.push('</div>');

    // 已有背景列表
    if (sorted.length > 0) {
      html.push('<p class="live2d-hub-section-title">已上传的背景</p>');
      html.push('<div class="live2d-hub-list">');
      for (const bg of sorted) {
        const isActive = bg.id === activeId;
        html.push(`<div class="live2d-hub-row" data-bg-id="${bg.id}">`);
        html.push('<div class="live2d-hub-row-thumb">🖼</div>');
        html.push('<div class="live2d-hub-row-text">');
        html.push(`<div class="live2d-hub-row-name">${escapeHtml(bg.name)}</div>`);
        html.push('</div>');
        html.push('<div class="live2d-hub-row-actions">');
        if (isActive) html.push('<span class="live2d-hub-row-check">✓</span>');
        html.push(`<button type="button" class="live2d-hub-row-del" data-action="delete" title="删除">✕</button>`);
        html.push('</div>');
        html.push('</div>');
      }
      html.push('</div>');
    }

    bodyEl.innerHTML = html.join('');

    // 绑事件
    bindBackgroundRowEvents();
  }

  // 切换 step + 更新 footer 按钮文案
  async function setStep(step) {
    currentStep = step;
    document.querySelectorAll('#live2d-hub-modal .live2d-hub-step').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-step') === step);
    });
    if (step === 'model') {
      await renderModelStep();
      primaryBtnEl.textContent = '下一步: 选择背景 →';
      primaryBtnEl.disabled = !await hasActiveModel();
    } else {
      await renderBackgroundStep();
      primaryBtnEl.textContent = '按这个方案接通 →';
      primaryBtnEl.disabled = !await hasActiveModel();
    }
  }

  async function hasActiveModel() {
    if (!global.Live2DStorage) return false;
    const id = await global.Live2DStorage.getActiveModelId();
    return !!id;
  }

  // 绑上传按钮 → 触发隐藏 input
  function bindUploadTriggers() {
    const zipInput = document.getElementById('live2d-hub-upload-zip-input');
    const folderInput = document.getElementById('live2d-hub-upload-folder-input');
    const bgInput = document.getElementById('live2d-hub-upload-bg-input');
    // 创建一次 input (放 body 末尾)
    function ensureInput(id, attrs) {
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('input');
        el.type = 'file';
        el.id = id;
        el.hidden = true;
        for (const k in attrs) el.setAttribute(k, attrs[k]);
        document.body.appendChild(el);
      }
      return el;
    }
    const zIn = ensureInput('live2d-hub-upload-zip-input', { accept: '.zip' });
    const fIn = ensureInput('live2d-hub-upload-folder-input', { webkitdirectory: '', directory: '', multiple: '' });
    const bIn = ensureInput('live2d-hub-upload-bg-input', { accept: 'image/*' });

    const zipBtn = document.getElementById('live2d-hub-action-zip');
    const folderBtn = document.getElementById('live2d-hub-action-folder');
    const bgBtn = document.getElementById('live2d-hub-action-bg');
    if (zipBtn) zipBtn.onclick = () => zIn.click();
    if (folderBtn) folderBtn.onclick = () => fIn.click();
    if (bgBtn) bgBtn.onclick = () => bIn.click();

    zIn.onchange = async function () {
      if (this.files && this.files[0] && global.Live2DUI && global.Live2DUI.handleModelUpload) {
        await global.Live2DUI.handleModelUpload(this.files, 'zip', null);
      }
      this.value = '';
      await setStep(currentStep);
    };
    fIn.onchange = async function () {
      if (this.files && this.files.length && global.Live2DUI && global.Live2DUI.handleModelUpload) {
        await global.Live2DUI.handleModelUpload(this.files, 'folder', null);
      }
      this.value = '';
      await setStep(currentStep);
    };
    bIn.onchange = async function () {
      if (this.files && this.files[0] && global.Live2DUI && global.Live2DUI.handleBackgroundUpload) {
        await global.Live2DUI.handleBackgroundUpload(this.files[0], null);
      }
      this.value = '';
      await setStep(currentStep);
    };
  }

  // 绑模型行事件
  function bindModelRowEvents() {
    if (!bodyEl) return;
    bodyEl.onclick = async function (ev) {
      const row = ev.target.closest('[data-model-id]');
      if (!row) return;
      const modelId = row.getAttribute('data-model-id');
      if (ev.target.getAttribute('data-action') === 'delete') {
        if (!confirm('确定删除这个模型？')) return;
        await global.Live2DStorage.deleteModel(modelId);
        const cur = await global.Live2DStorage.getActiveModelId();
        if (cur === modelId) await global.Live2DStorage.setActiveModelId('');
        await setStep('model');
        return;
      }
      await global.Live2DStorage.setActiveModelId(modelId);
      await setStep('model');
    };
  }

  // 绑背景行事件
  function bindBackgroundRowEvents() {
    if (!bodyEl) return;
    bodyEl.onclick = async function (ev) {
      const row = ev.target.closest('[data-bg-id]');
      if (!row) return;
      const bgId = row.getAttribute('data-bg-id');
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
        await setStep('background');
        return;
      }
      try { localStorage.setItem('live2d.activeBackgroundId', bgId); } catch (e) {}
      await setStep('background');
    };
  }

  // 初始化 (拿 DOM, 绑事件)
  function init() {
    modalEl = document.getElementById('live2d-hub-modal');
    bodyEl = document.getElementById('live2d-hub-body');
    primaryBtnEl = document.getElementById('live2d-hub-btn-primary');
    secondaryBtnEl = document.getElementById('live2d-hub-btn-secondary');
    closeBtnEl = document.getElementById('live2d-hub-close-btn');
    overlayBtnEl = document.getElementById('live2d-hub-overlay-btn');
    if (!modalEl) return;

    if (closeBtnEl) closeBtnEl.addEventListener('click', close);
    if (overlayBtnEl) overlayBtnEl.addEventListener('click', close);
    if (secondaryBtnEl) secondaryBtnEl.addEventListener('click', close);

    // 步骤切换
    document.querySelectorAll('#live2d-hub-modal .live2d-hub-step').forEach(el => {
      el.addEventListener('click', () => setStep(el.getAttribute('data-step')));
    });

    // 主按钮: 步骤 0 → 切到 background; 步骤 1 → onStart
    if (primaryBtnEl) {
      primaryBtnEl.addEventListener('click', async function () {
        if (primaryBtnEl.disabled) return;
        if (currentStep === 'model') {
          await setStep('background');
        } else {
          const cb = onStartCallback;
          close();
          if (typeof cb === 'function') {
            try { cb(); } catch (e) { console.warn('Live2DHub onStart error:', e); }
          }
        }
      });
    }
  }

  async function open(cb) {
    if (!modalEl) init();
    if (!modalEl) return;
    onStartCallback = cb || null;
    modalEl.classList.add('live2d-hub-open');
    await setStep('model');
  }

  function close() {
    if (modalEl) modalEl.classList.remove('live2d-hub-open');
    onStartCallback = null;
  }

  global.Live2DHub = { init, open, close, setStep };
})(typeof window !== 'undefined' ? window : globalThis);
