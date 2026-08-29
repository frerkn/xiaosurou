// Live2D 专区全屏页面 — 跟糯米机 CallApp 主页一致
// v0.3.9: 全屏 page 模式 (不是弹窗), 粉白 + 装饰元素, 视频通话前的准备页
// 入口: window.Live2DHub.open() / window.Live2DHub.close()
// 显示: 调用 showScreen('live2d-hub-screen') 进入

(function (global) {
  'use strict';

  let screenEl = null;
  let titleEl = null;
  let subEl = null;
  let avatarEl = null;
  let charNameEl = null;
  let charDescEl = null;
  let callBtnNameEl = null;
  let callBtnEl = null;
  let closeBtnEl = null;
  let manageModelBtnEl = null;
  let manageBgBtnEl = null;
  let currentModelEl = null;
  let currentBgEl = null;
  let previewEl = null;
  let onStartCallback = null;
  let currentChat = null;

  // 状态: 'main' (主页面) | 'manage-model' (模型管理) | 'manage-bg' (背景管理)
  let currentView = 'main';

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // 渲染主页面 (角色 + 模型 + 背景 + 视频接通)
  async function renderMain() {
    if (!screenEl) return;
    currentView = 'main';
    // 恢复 markup (从 manage 模式回 main)
    if (!document.getElementById('live2d-hub-call-btn')) {
      location.hash = '';  // 强制重渲染 — 简化, 实际用 innerHTML 重建
    }

    // 角色信息
    if (currentChat) {
      if (charNameEl) charNameEl.textContent = currentChat.name || '当前角色';
      if (charDescEl) charDescEl.textContent = (currentChat.isGroup ? '群' : '一对一') + ' · 视频通话准备';
      if (callBtnNameEl) callBtnNameEl.textContent = currentChat.name || 'TA';
      if (avatarEl) {
        const avatar = (currentChat.settings && currentChat.settings.aiAvatar) || (currentChat.isGroup ? 'group' : 'default');
        avatarEl.src = avatar;
        avatarEl.onerror = function () { this.src = 'assets/avatars/default.png'; };
      }
    }

    // 模型
    let hasActiveModel = false;
    if (global.Live2DStorage) {
      const models = await global.Live2DStorage.listModels();
      const activeId = await global.Live2DStorage.getActiveModelId();
      const active = models.find(m => m.id === activeId);
      hasActiveModel = !!active;
      if (currentModelEl) {
        if (active) {
          currentModelEl.innerHTML = `
            <div class="live2d-hub-block-current-thumb">🎭</div>
            <div class="live2d-hub-block-current-text">${escapeHtml(active.name)}</div>
            <div class="live2d-hub-block-current-check">✓</div>
          `;
        } else {
          currentModelEl.innerHTML = `
            <div class="live2d-hub-block-current-thumb">🎭</div>
            <div class="live2d-hub-block-current-text">尚未绑定动态模型</div>
          `;
        }
      }
    }

    // 背景
    let activeBgName = '';
    if (global.db) {
      const all = await global.db.live2d_backgrounds.toArray();
      const activeId = (() => { try { return localStorage.getItem('live2d.activeBackgroundId') || ''; } catch (e) { return ''; } })();
      const active = all.find(b => b.id === activeId);
      activeBgName = active ? active.name : '';
      if (currentBgEl) {
        if (active) {
          currentBgEl.innerHTML = `
            <div class="live2d-hub-block-current-thumb">🖼</div>
            <div class="live2d-hub-block-current-text">${escapeHtml(active.name)}</div>
            <div class="live2d-hub-block-current-check">✓</div>
          `;
        } else {
          currentBgEl.innerHTML = `
            <div class="live2d-hub-block-current-thumb">🖼</div>
            <div class="live2d-hub-block-current-text">未设置 (用原视频画面)</div>
          `;
        }
      }
    }

    // 视频接通按钮
    if (callBtnEl) callBtnEl.disabled = !hasActiveModel;

    // 显示主页面, 隐藏 manage 页面
    showMainPanel();
  }

  // 渲染模型管理 (子页面)
  async function renderManageModel() {
    if (!screenEl || !global.Live2DStorage) return;
    currentView = 'manage-model';
    const models = await global.Live2DStorage.listModels();
    const activeId = await global.Live2DStorage.getActiveModelId();

    const body = document.createElement('div');
    body.className = 'live2d-hub-manage';
    body.style.cssText = 'padding: 20px;';

    let html = `
      <button type="button" class="live2d-hub-bottom-btn" id="live2d-hub-back-btn" style="margin-bottom: 16px;">
        <span class="live2d-hub-bottom-icon">←</span>
        <span>返回</span>
      </button>
      <p class="live2d-hub-eyebrow" style="margin: 0 0 12px;">MANAGE / MODELS</p>
      <h2 style="margin: 0 0 16px; font-size: 22px; font-weight: 600; color: #3a2a30;">选择 Live2D 模型</h2>
      <div style="display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap;">
        <button type="button" id="live2d-hub-m-zip-btn" class="live2d-hub-block-link" style="padding: 10px 16px; background: linear-gradient(135deg, #ff8eb3 0%, #ffb6c1 100%); color: #fff; font-weight: 600; box-shadow: 0 4px 12px rgba(255, 142, 179, 0.3);">📦 上传 ZIP</button>
        <button type="button" id="live2d-hub-m-folder-btn" class="live2d-hub-block-link" style="padding: 10px 16px; background: linear-gradient(135deg, #ff8eb3 0%, #ffb6c1 100%); color: #fff; font-weight: 600; box-shadow: 0 4px 12px rgba(255, 142, 179, 0.3);">📁 上传文件夹</button>
      </div>
    `;

    if (models.length === 0) {
      html += '<div class="live2d-hub-block" style="text-align: center; color: #b58a9a; padding: 24px;">还没有模型, 点上方按钮上传</div>';
    } else {
      html += '<div style="display: flex; flex-direction: column; gap: 8px;">';
      for (const m of models) {
        const isActive = m.id === activeId;
        const dateStr = new Date(m.addedAt).toLocaleDateString('zh-CN');
        const activeStyle = isActive ? 'background: linear-gradient(135deg, #fff0f5 0%, #ffffff 100%); border: 1.5px solid #ff8eb3; box-shadow: 0 4px 12px rgba(255, 142, 179, 0.2);' : 'background: #ffffff; border: 1.5px solid transparent;';
        html += `
          <div class="live2d-hub-manage-row" data-model-id="${m.id}" style="display: flex; align-items: center; gap: 10px; padding: 12px; border-radius: 12px; cursor: pointer; ${activeStyle}">
            <div style="width: 40px; height: 40px; border-radius: 10px; background: #ffe0eb; display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0;">🎭</div>
            <div style="flex: 1; min-width: 0;">
              <div style="font-size: 14px; font-weight: 500; color: #3a2a30; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(m.name)}</div>
              <div style="font-size: 11px; color: #b58a9a; margin-top: 2px;">${m.fileCount} 个文件 · ${dateStr}</div>
            </div>
            ${isActive ? '<span style="color: #ff5c8d; font-size: 18px; font-weight: bold;">✓</span>' : ''}
            <button type="button" data-action="delete" style="width: 24px; height: 24px; border-radius: 50%; border: none; background: rgba(42, 35, 48, 0.06); color: #b58a9a; font-size: 12px; cursor: pointer;">✕</button>
          </div>
        `;
      }
      html += '</div>';
    }

    body.innerHTML = html;

    // 替换 main content
    const mainContent = document.querySelector('#live2d-hub-screen .live2d-hub-content');
    if (mainContent) {
      mainContent.style.display = 'none';
      mainContent.parentNode.appendChild(body);
    }

    // 绑事件
    const backBtn = document.getElementById('live2d-hub-back-btn');
    if (backBtn) backBtn.addEventListener('click', () => {
      body.remove();
      renderMain();
    });

    const zipBtn = document.getElementById('live2d-hub-m-zip-btn');
    const folderBtn = document.getElementById('live2d-hub-m-folder-btn');
    const zipInput = document.getElementById('live2d-hub-upload-zip-input');
    const folderInput = document.getElementById('live2d-hub-upload-folder-input');
    if (zipBtn && zipInput) zipBtn.addEventListener('click', () => zipInput.click());
    if (folderBtn && folderInput) folderBtn.addEventListener('click', () => folderInput.click());
    if (zipInput) zipInput.onchange = async function () {
      if (this.files && this.files[0] && global.Live2DUI && global.Live2DUI.handleModelUpload) {
        await global.Live2DUI.handleModelUpload(this.files, 'zip', null);
      }
      this.value = '';
      body.remove();
      renderManageModel();
    };
    if (folderInput) folderInput.onchange = async function () {
      if (this.files && this.files.length && global.Live2DUI && global.Live2DUI.handleModelUpload) {
        await global.Live2DUI.handleModelUpload(this.files, 'folder', null);
      }
      this.value = '';
      body.remove();
      renderManageModel();
    };

    body.addEventListener('click', async function (ev) {
      const row = ev.target.closest('[data-model-id]');
      if (!row) return;
      const modelId = row.getAttribute('data-model-id');
      if (ev.target.getAttribute('data-action') === 'delete') {
        if (!confirm('确定删除这个模型？')) return;
        await global.Live2DStorage.deleteModel(modelId);
        const cur = await global.Live2DStorage.getActiveModelId();
        if (cur === modelId) await global.Live2DStorage.setActiveModelId('');
        body.remove();
        renderManageModel();
        return;
      }
      await global.Live2DStorage.setActiveModelId(modelId);
      body.remove();
      renderManageModel();
    });
  }

  // 渲染背景管理 (子页面)
  async function renderManageBg() {
    if (!screenEl || !global.db) return;
    currentView = 'manage-bg';
    const all = await global.db.live2d_backgrounds.toArray();
    const activeId = (() => { try { return localStorage.getItem('live2d.activeBackgroundId') || ''; } catch (e) { return ''; } })();
    const sorted = all.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

    const body = document.createElement('div');
    body.className = 'live2d-hub-manage';
    body.style.cssText = 'padding: 20px;';

    let html = `
      <button type="button" class="live2d-hub-bottom-btn" id="live2d-hub-back-btn" style="margin-bottom: 16px;">
        <span class="live2d-hub-bottom-icon">←</span>
        <span>返回</span>
      </button>
      <p class="live2d-hub-eyebrow" style="margin: 0 0 12px;">MANAGE / BACKGROUNDS</p>
      <h2 style="margin: 0 0 16px; font-size: 22px; font-weight: 600; color: #3a2a30;">选择通话背景</h2>
      <div style="display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap;">
        <button type="button" id="live2d-hub-m-bg-btn" class="live2d-hub-block-link" style="padding: 10px 16px; background: linear-gradient(135deg, #ff8eb3 0%, #ffb6c1 100%); color: #fff; font-weight: 600; box-shadow: 0 4px 12px rgba(255, 142, 179, 0.3);">🖼 上传背景</button>
      </div>
    `;

    if (sorted.length === 0) {
      html += '<div class="live2d-hub-block" style="text-align: center; color: #b58a9a; padding: 24px;">还没有背景, 点上方按钮上传</div>';
    } else {
      html += '<div style="display: flex; flex-direction: column; gap: 8px;">';
      for (const bg of sorted) {
        const isActive = bg.id === activeId;
        const activeStyle = isActive ? 'background: linear-gradient(135deg, #fff0f5 0%, #ffffff 100%); border: 1.5px solid #ff8eb3; box-shadow: 0 4px 12px rgba(255, 142, 179, 0.2);' : 'background: #ffffff; border: 1.5px solid transparent;';
        html += `
          <div class="live2d-hub-manage-row" data-bg-id="${bg.id}" style="display: flex; align-items: center; gap: 10px; padding: 12px; border-radius: 12px; cursor: pointer; ${activeStyle}">
            <div style="width: 40px; height: 40px; border-radius: 10px; background: #ffe0eb; display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0;">🖼</div>
            <div style="flex: 1; min-width: 0;">
              <div style="font-size: 14px; font-weight: 500; color: #3a2a30; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(bg.name)}</div>
            </div>
            ${isActive ? '<span style="color: #ff5c8d; font-size: 18px; font-weight: bold;">✓</span>' : ''}
            <button type="button" data-action="delete" style="width: 24px; height: 24px; border-radius: 50%; border: none; background: rgba(42, 35, 48, 0.06); color: #b58a9a; font-size: 12px; cursor: pointer;">✕</button>
          </div>
        `;
      }
      html += '</div>';
    }

    body.innerHTML = html;

    const mainContent = document.querySelector('#live2d-hub-screen .live2d-hub-content');
    if (mainContent) {
      mainContent.style.display = 'none';
      mainContent.parentNode.appendChild(body);
    }

    const backBtn = document.getElementById('live2d-hub-back-btn');
    if (backBtn) backBtn.addEventListener('click', () => {
      body.remove();
      renderMain();
    });

    const bgBtn = document.getElementById('live2d-hub-m-bg-btn');
    const bgInput = document.getElementById('live2d-hub-upload-bg-input');
    if (bgBtn && bgInput) bgBtn.addEventListener('click', () => bgInput.click());
    if (bgInput) bgInput.onchange = async function () {
      if (this.files && this.files[0] && global.Live2DUI && global.Live2DUI.handleBackgroundUpload) {
        await global.Live2DUI.handleBackgroundUpload(this.files[0], null);
      }
      this.value = '';
      body.remove();
      renderManageBg();
    };

    body.addEventListener('click', async function (ev) {
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
        body.remove();
        renderManageBg();
        return;
      }
      try { localStorage.setItem('live2d.activeBackgroundId', bgId); } catch (e) {}
      body.remove();
      renderManageBg();
    });
  }

  function showMainPanel() {
    const mainContent = document.querySelector('#live2d-hub-screen .live2d-hub-content');
    if (mainContent) mainContent.style.display = 'block';
    const managePanels = document.querySelectorAll('#live2d-hub-screen .live2d-hub-manage');
    managePanels.forEach(p => p.remove());
  }

  // 初始化 (拿 DOM, 绑主页面事件)
  function init() {
    screenEl = document.getElementById('live2d-hub-screen');
    if (!screenEl) return;
    titleEl = document.getElementById('live2d-hub-title');
    subEl = null; // 已写死
    avatarEl = document.getElementById('live2d-hub-avatar');
    charNameEl = document.getElementById('live2d-hub-character-name');
    charDescEl = document.getElementById('live2d-hub-character-desc');
    callBtnNameEl = document.getElementById('live2d-hub-call-btn-name');
    callBtnEl = document.getElementById('live2d-hub-call-btn');
    closeBtnEl = document.getElementById('live2d-hub-close-btn');
    manageModelBtnEl = document.getElementById('live2d-hub-manage-model-btn');
    manageBgBtnEl = document.getElementById('live2d-hub-manage-bg-btn');
    currentModelEl = document.getElementById('live2d-hub-current-model');
    currentBgEl = document.getElementById('live2d-hub-current-bg');
    previewEl = document.getElementById('live2d-hub-preview');

    if (closeBtnEl) closeBtnEl.addEventListener('click', close);
    // v0.3.10: 浮动 fixed 关闭按钮 (CSS sw 缓存时也能用)
    const closeBtnFixed = document.getElementById('live2d-hub-close-btn-fixed');
    if (closeBtnFixed) closeBtnFixed.addEventListener('click', close);
    if (callBtnEl) callBtnEl.addEventListener('click', function () {
      if (callBtnEl.disabled) return;
      const cb = onStartCallback;
      close();
      if (typeof cb === 'function') {
        try { cb(); } catch (e) { console.warn('Live2DHub onStart error:', e); }
      }
    });
    if (manageModelBtnEl) manageModelBtnEl.addEventListener('click', renderManageModel);
    if (manageBgBtnEl) manageBgBtnEl.addEventListener('click', renderManageBg);
  }

  // open(chat, onStart) — chat 是 chat 对象, onStart 是用户点"视频接通"后的回调
  function open(chat, cb) {
    if (!screenEl) init();
    if (!screenEl) return;
    currentChat = chat || null;
    onStartCallback = cb || null;
    if (global.showScreen) {
      global.showScreen('live2d-hub-screen');
    } else {
      screenEl.style.display = 'block';
    }
    renderMain();
  }

  function close() {
    if (screenEl) screenEl.style.display = 'none';
    onStartCallback = null;
  }

  global.Live2DHub = { init, open, close, renderMain, renderManageModel, renderManageBg };
})(typeof window !== 'undefined' ? window : globalThis);
