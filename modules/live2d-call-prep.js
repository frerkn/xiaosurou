// Live2D 视频通话准备页 (新)
// 旧 #live2d-hub-screen / live2d-hub.js 已废弃删除, 这是唯一的"视频通话准备页"
// 第一阶段: 基础结构, 不接 Live2D, 不接模型上传/背景上传/角色选择/管理
// v0.4.3: 动态数据渲染 (per-chat 模型/背景绑定, 动态 AI 名字/头像/状态)
// API: window.Live2DCallPrep = { init, open, close }

(function (global) {
  'use strict';

  let screenEl = null;
  let callBtnEl = null;
  let onStartCallback = null;
  let currentChat = null;

  function init() {
    screenEl = document.getElementById('live2d-call-prep-screen');
    if (!screenEl) return;
    callBtnEl = screenEl.querySelector('[data-role="call"]');
    // v0.5.0 P1.7: 返回按钮绑 close (user 反馈"准备页没有退出键")
    const backBtn = screenEl.querySelector('[data-role="back"]');
    if (backBtn) backBtn.onclick = close;
    if (callBtnEl) {
      callBtnEl.addEventListener('click', function () {
        if (callBtnEl.disabled) return;
        const cb = onStartCallback;
        close();
        if (typeof cb === 'function') {
          try { cb(); } catch (e) { console.warn('Live2DCallPrep onStart error:', e); }
        }
      });
    }
    // v0.4.7: "＋ 上传 / 选择 Live2D" 按钮 → 打开 Live2DModelPicker
    // v0.5.0 P0: "管理" 按钮 (data-role="manage-model") → 打开 Live2DManager (v0.4.7 决策被覆写)
    const uploadSelectModelBtn = screenEl.querySelector('[data-role="upload-select-model"]');
    if (uploadSelectModelBtn) {
      uploadSelectModelBtn.addEventListener('click', function () {
        if (!currentChat) return;
        if (global.Live2DModelPicker && typeof global.Live2DModelPicker.open === 'function') {
          global.Live2DModelPicker.open(currentChat, function () { render(currentChat); });
        }
      });
    }
    const manageModelBtn = screenEl.querySelector('[data-role="manage-model"]');
    if (manageModelBtn) {
      manageModelBtn.addEventListener('click', function () {
        if (!currentChat) return;
        if (global.Live2DManager && typeof global.Live2DManager.open === 'function') {
          global.Live2DManager.open(currentChat, function () { render(currentChat); });
        }
      });
    }
    // v0.5.0 P11: "＋ 上传舞台背景" 按钮 → 调 Live2DBgManager.uploadBackground, 上传后自动绑当前 chat
    const uploadBgBtn = screenEl.querySelector('[data-role="upload-bg"]');
    const uploadBgInput = document.getElementById('live2d-bg-upload-input');
    if (uploadBgBtn && uploadBgInput) {
      uploadBgBtn.addEventListener('click', function () {
        if (!currentChat) return;
        uploadBgInput.value = '';  // 允许重复选同一文件
        uploadBgInput.click();
      });
      uploadBgInput.addEventListener('change', async function () {
        if (!currentChat || !this.files || !this.files[0]) return;
        const file = this.files[0];
        if (global.Live2DBgManager && typeof global.Live2DBgManager.uploadBackground === 'function') {
          const newId = await global.Live2DBgManager.uploadBackground(file, currentChat.id);
          if (newId) {
            console.log('[Live2DCallPrep] 背景上传成功, 绑 chat ' + currentChat.id + ' → bg ' + newId);
            render(currentChat);
          }
        } else {
          console.warn('[Live2DCallPrep] Live2DBgManager 未加载, 无法上传背景');
          alert('背景管理模块未加载, 请刷新页面重试');
        }
        this.value = '';
      });
    }
    // v0.5.0 P11: "管理" 按钮 (data-role="manage-bg") → 打开 Live2DBgManager
    const manageBgBtn = screenEl.querySelector('[data-role="manage-bg"]');
    if (manageBgBtn) {
      manageBgBtn.addEventListener('click', function () {
        if (!currentChat) return;
        if (global.Live2DBgManager && typeof global.Live2DBgManager.open === 'function') {
          global.Live2DBgManager.open(currentChat, function () { render(currentChat); });
        } else {
          console.warn('[Live2DCallPrep] Live2DBgManager 未加载, 无法打开背景管理');
        }
      });
    }
  }

  // v0.4.3: 根据当前 chat 动态渲染准备页
  async function render(chat) {
    if (!chat || !screenEl) return;

    // 1. AI 名字 → [data-role="character-name"]
    const charNameEl = screenEl.querySelector('[data-role="character-name"]');
    if (charNameEl) charNameEl.textContent = chat.name || '当前角色';

    // 2. AI 头像 → [data-role="avatar"] (chat.settings.aiAvatar 动态插入 img, 缺则 emoji 占位)
    const avatarEl = screenEl.querySelector('[data-role="avatar"]');
    if (avatarEl) {
      const avatar = (chat.settings && chat.settings.aiAvatar) || '';
      avatarEl.innerHTML = '';
      if (avatar) {
        const img = document.createElement('img');
        img.src = avatar;
        img.alt = '';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;';
        img.onerror = function () {
          avatarEl.innerHTML = '<span class="live2d-call-prep-avatar-placeholder">🎭</span>';
        };
        avatarEl.appendChild(img);
      } else {
        avatarEl.innerHTML = '<span class="live2d-call-prep-avatar-placeholder">🎭</span>';
      }
    }

    // 3. 单聊/群聊描述 → .live2d-call-prep-character-desc
    const charDescEl = screenEl.querySelector('.live2d-call-prep-character-desc');
    if (charDescEl) {
      charDescEl.textContent = (chat.isGroup ? '群聊' : '一对一') + ' · 视频通话准备';
    }

    // 4. Live2D 模型状态 → [data-role="model-preview"] (从原 model-status 合并过来, 准备页大卡片直接显示模型名)
    const modelPreviewEl = screenEl.querySelector('[data-role="model-preview"]');
    if (modelPreviewEl) {
      let modelText = '尚未绑定动态模型';
      try {
        if (global.Live2DStorage && chat.id) {
          const modelId = await global.Live2DStorage.getActiveModelIdForChat(chat.id);
          if (modelId) {
            const m = await global.Live2DStorage.getModel(modelId);
            modelText = m ? '已绑定 · ' + m.name : '已绑定 · 模型';
          }
        }
      } catch (e) { /* fallback 默认文字 */ }
      // 保留占位 span, 只改文字 (复用 .live2d-call-prep-preview-placeholder 样式)
      const textSpan = modelPreviewEl.querySelector('.live2d-call-prep-preview-placeholder') || modelPreviewEl;
      textSpan.textContent = modelText;
    }

    // 5. 通话背景预览缩略图 → [data-role="bg-preview"] (v0.5.0 P11: 用当前 chat 绑定的 bg blob URL, re-render 时 revoke)
    const bgPreviewEl = screenEl.querySelector('[data-role="bg-preview"]');
    if (bgPreviewEl) {
      // 回收上一次的 URL (避免重复打开准备页时 blob URL 累积)
      if (bgPreviewEl._live2dBgUrl) {
        try { URL.revokeObjectURL(bgPreviewEl._live2dBgUrl); } catch (e) {}
        bgPreviewEl._live2dBgUrl = '';
      }
      bgPreviewEl.innerHTML = '';
      let shown = false;
      try {
        if (chat.id && global.db && global.Live2DUI && typeof global.Live2DUI.getActiveBackgroundIdForChat === 'function') {
          const bgId = global.Live2DUI.getActiveBackgroundIdForChat(chat.id);
          if (bgId) {
            const bg = await global.db.live2d_backgrounds.get(bgId);
            if (bg && bg.blob) {
              const url = URL.createObjectURL(bg.blob);
              bgPreviewEl._live2dBgUrl = url;
              const img = document.createElement('img');
              img.src = url;
              img.alt = '';
              img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
              bgPreviewEl.appendChild(img);
              shown = true;
            }
          }
        }
      } catch (e) { console.warn('[Live2DCallPrep] bg-preview render failed:', e); }
      if (!shown) {
        const ph = document.createElement('span');
        ph.className = 'live2d-call-prep-preview-placeholder';
        ph.textContent = '背景预览';
        bgPreviewEl.appendChild(ph);
      }
    }

    // 6. 通话背景状态 → [data-role="bg-status"] (只读 IDB 显示名字, 不应用到 #live2d-call-prep-screen)
    const bgStatusEl = screenEl.querySelector('[data-role="bg-status"]');
    if (bgStatusEl) {
      let bgText = '尚未设置通话背景';
      try {
        if (chat.id && global.Live2DUI && global.Live2DUI.getActiveBackgroundIdForChat) {
          const bgId = global.Live2DUI.getActiveBackgroundIdForChat(chat.id);
          if (bgId && global.db) {
            const bg = await global.db.live2d_backgrounds.get(bgId);
            bgText = bg ? '已设置 · ' + bg.name : '已设置 · 背景';
          }
        }
      } catch (e) { /* fallback 默认文字 */ }
      bgStatusEl.textContent = bgText;
    }

    // 7. 接通按钮名字 → [data-role="call-btn-name"]
    const callBtnNameEl = screenEl.querySelector('[data-role="call-btn-name"]');
    if (callBtnNameEl) callBtnNameEl.textContent = chat.name || 'TA';
  }

  function open(chat, onStart) {
    if (!screenEl) init();
    if (!screenEl) return;
    currentChat = chat || null;
    onStartCallback = onStart || null;
    // v0.5.0: 清掉 close() 留下的 inline display:none. .screen 靠 opacity+visibility+.active 显隐,
    // 但 inline display:none 会覆盖 .screen 的 display:flex, 导致第二次 open() 一片空白.
    // (管理页 Live2DManager.open() 已同样处理, 见 live2d-manager.js)
    if (screenEl) screenEl.style.display = '';
    if (global.showScreen) {
      global.showScreen('live2d-call-prep-screen');
    } else {
      screenEl.style.display = 'block';
    }
    // 动态渲染 (fire-and-forget, 异步填充模型/背景名字)
    try { render(chat); } catch (e) { console.warn('Live2DCallPrep render error:', e); }
  }

  function close() {
    if (screenEl) screenEl.style.display = 'none';
    onStartCallback = null;
    // v0.5.0 P2.3: 退回当前聊天框 (user 反馈 P1.7 退到 chat-detail/chat-list 不对, 应该是 chat-interface)
    // 兜底: 没 active chat 时退 chat-list; showScreen 不存在就保持 display:none
    try {
      if (global.showScreen) {
        const hasActive = state && state.activeChatId && document.getElementById('chat-interface-screen');
        if (hasActive) {
          global.showScreen('chat-interface-screen');
        } else if (document.getElementById('chat-list-screen')) {
          global.showScreen('chat-list-screen');
        } else if (document.getElementById('chat-interface-screen')) {
          global.showScreen('chat-interface-screen');
        }
      }
    } catch (e) { console.warn('[Live2DCallPrep] close showScreen failed:', e); }
  }

  global.Live2DCallPrep = { init, open, close, render };
})(typeof window !== 'undefined' ? window : globalThis);
