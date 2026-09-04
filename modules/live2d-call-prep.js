// Live2D 视频通话准备页 (新)
// 旧 #live2d-hub-screen / live2d-hub.js 已废弃删除, 这是唯一的"视频通话准备页"
// 第一阶段: 基础结构, 不接 Live2D, 不接模型上传/背景上传/角色选择/管理
// v0.4.3: 动态数据渲染 (per-chat 模型/背景绑定, 动态 AI 名字/头像/状态)
// v0.5.0 P3-1: 新增"我的画面"卡片 (从聊天设置页"视频通话优化"板块搬来)
//              复用 video-optimization.js 的 init/load/save (传 prefix='prep-')
//              camera 运行函数 0 改动, 准备页只配置不启动 camera
// API: window.Live2DCallPrep = { init, open, close }

(function (global) {
  'use strict';

  let screenEl = null;
  let callBtnEl = null;
  let onStartCallback = null;
  let currentChat = null;

  // v0.5.0 P3-1: 准备页"我的画面"自动持久化 (复用 video-optimization.js saveVideoOptimizationSettings)
  // 事件委托: change/click/input 落到 prep-* 元素时, 把当前 DOM 状态写回 chat.videoOptimization 并 db.chats.put
  // input 事件 debounce 300ms (URL 打字时合并写), change/click 立即写
  function persistPrepVideoSettings() {
    if (!currentChat) return;
    try {
      if (typeof saveVideoOptimizationSettings === 'function') {
        saveVideoOptimizationSettings(currentChat, 'prep-');
      } else if (global.saveVideoOptimizationSettings) {
        global.saveVideoOptimizationSettings(currentChat, 'prep-');
      }
      if (global.db && global.db.chats) {
        global.db.chats.put(currentChat).catch(function (e) {
          console.warn('[Live2DCallPrep] save videoOptimization failed:', e);
        });
      }
    } catch (e) {
      console.warn('[Live2DCallPrep] persistPrepVideoSettings failed:', e);
    }
  }

  function bindPrepVideoAutoSave() {
    if (!screenEl) return;
    if (screenEl._prepVideoAutoSaveBound) return;
    screenEl._prepVideoAutoSaveBound = true;

    let inputTimer = null;
    function flush() {
      if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
      persistPrepVideoSettings();
    }
    function debounced() {
      if (inputTimer) clearTimeout(inputTimer);
      inputTimer = setTimeout(flush, 300);
    }

    // change 覆盖: switch/checkbox (note: file input 单独处理, 见 prepLocalInput 专属 handler)
    //   —— P4 排查: file input 的 change 会冒泡到这里, 但 FileReader 是异步的,
    //      此刻 preview.src 还没被新图更新, 直接 flush 会把 localVideoUrl 写成空值.
    //      → 所以对 #prep-local-video-input 跳过, 交给专属 defer handler 在 onload 后处理.
    screenEl.addEventListener('change', function (e) {
      const t = e.target;
      if (!t || !t.id || !t.id.startsWith('prep-')) return;
      if (t.id === 'prep-local-video-input') return;
      flush();
    });
    // click 覆盖: 按钮 (本地上传按钮是 onclick 间接 click file input, 不会触发 button click;
    //   这里只关心 prep-local-video-url-btn / prep-local-video-reset-btn / prep-enable-rear-camera-switch 标签等)
    screenEl.addEventListener('click', function (e) {
      const t = e.target;
      if (!t) return;
      const btn = t.closest && t.closest('button');
      if (!btn || !btn.id || !btn.id.startsWith('prep-')) return;
      flush();
    });
    // input 覆盖: 文本框实时打字 (debounce)
    screenEl.addEventListener('input', function (e) {
      const t = e.target;
      if (!t || !t.id || !t.id.startsWith('prep-')) return;
      debounced();
    });
  }

  // v0.5.0 P3-1.1: "我的画面"卡片 — 获取当前用户头像 (作为 chat.videoOptimization.localVideoUrl 为空时的视觉兜底)
  // 读取模式跟项目 ai-response.js / couple-space.js / background-activity.js 等保持一致:
  //   chat.settings.myAvatar (per-chat 存) → state.qzoneSettings.avatar (全局) → defaultAvatar ('' 字符串, utils.js:663)
  // 绝对不能读 chat.settings.aiAvatar (那是 AI 对方头像, 不是 user 自己的)
  // 不存, 不创建新字段, 不复制图片; 只读现有数据源
  function getUserAvatarUrl(chat) {
    if (!chat || !chat.settings) return '';
    try {
      const fromChat = chat.settings.myAvatar;
      if (fromChat) return fromChat;
      const qs = (typeof state !== 'undefined' && state && state.qzoneSettings && state.qzoneSettings.avatar) || '';
      if (qs) return qs;
      // defaultAvatar 是 utils.js:663 顶层 const (值 ''), 这里走 typeof 守卫, 万一未加载也返 ''
      return (typeof defaultAvatar !== 'undefined' ? defaultAvatar : '') || '';
    } catch (e) {
      return '';
    }
  }

  // v0.5.0 P3-1.1: "我的画面"卡片 — user 头像兜底层显示控制
  // 设计: 三个元素互斥显示 (localVideoUrl 有值 → custom 预览; 否则 → user 头像兜底; 都没有 → 隐藏预览区)
  // 真实摄像头状态完全独立, 不作为兜底, 仅在用户主动开启时由 applyVideoOptimizationToCall 走原逻辑启动
  function refreshPrepLocalFallback() {
    if (!screenEl) return;
    const userAvatarEl = document.getElementById('prep-local-video-user-avatar');
    const previewEl = document.getElementById('prep-local-video-preview');
    const placeholderEl = document.getElementById('prep-local-video-placeholder');
    const hasCustom = !!(currentChat && currentChat.videoOptimization && currentChat.videoOptimization.localVideoUrl);
    if (hasCustom) {
      // user 上传/URL 给了 custom 图 → 显示 preview, 隐藏 user 头像兜底
      if (userAvatarEl) userAvatarEl.style.display = 'none';
      if (placeholderEl) placeholderEl.style.display = 'none';
      // preview 由 loadVideoOptimizationSettings 设的 display 保持
    } else {
      // 没有 custom → 显示 user 头像兜底 (user 头像为空时隐藏)
      const ua = getUserAvatarUrl(currentChat);
      if (userAvatarEl) {
        if (ua) {
          userAvatarEl.src = ua;
          userAvatarEl.style.display = 'block';
        } else {
          userAvatarEl.removeAttribute('src');
          userAvatarEl.style.display = 'none';
        }
      }
      if (previewEl) previewEl.style.display = 'none';
      if (placeholderEl) placeholderEl.style.display = 'none';
    }
  }

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

    // v0.5.0 P3-1: 准备页"我的画面"卡片事件绑定 + 自动持久化
    // 调 video-optimization.js 的 initVideoOptimization('prep-') 复用旧的 handler 逻辑
    //   (FileReader / URL / 重置 / 真实摄像头开关显隐 / 后置摄像头通话中切换守卫)
    // 注: 旧聊天设置页 initVideoOptimization('') 由 video-optimization.js 自身的 DOMContentLoaded 触发
    if (typeof initVideoOptimization === 'function') {
      try { initVideoOptimization('prep-'); } catch (e) { console.warn('[Live2DCallPrep] initVideoOptimization failed:', e); }
    } else if (global.initVideoOptimization) {
      try { global.initVideoOptimization('prep-'); } catch (e) { console.warn('[Live2DCallPrep] initVideoOptimization failed:', e); }
    }
    // 事件委托自动持久化: prep-* 元素 change/click/input 触发时调 saveVideoOptimizationSettings(chat, 'prep-') + db.chats.put
    bindPrepVideoAutoSave();

    // v0.5.0 P3-1.1: "我的画面"卡片 — reset / upload / URL 后的视觉兜底控制
    // 这些 handler 故意在 initVideoOptimization('prep-') 绑的旧 handler 之后 addEventListener, 后注册先跑后跑顺序
    // 目的: user 上传/URL 后隐藏 user 头像兜底; reset 后恢复 user 头像兜底
    // 不动 video-optimization.js 的 reset handler 内部 (旧 handler 仍按原逻辑清空 preview.src + 显示 placeholder)
    //   新 handler 在旧 handler 之后跑, 把 placeholder 重新隐藏, 把 user 头像兜底显示出来
    const prepLocalResetBtn = document.getElementById('prep-local-video-reset-btn');
    if (prepLocalResetBtn) {
      prepLocalResetBtn.addEventListener('click', function () {
        // 旧 reset handler 已清空 preview.src + 显示 placeholder, 这里把 user 头像兜底重新显示出来
        // 延迟一帧让旧 handler 跑完, 再修正 display 状态
        setTimeout(refreshPrepLocalFallback, 0);
      });
    }
    const prepLocalInput = document.getElementById('prep-local-video-input');
    if (prepLocalInput) {
      prepLocalInput.addEventListener('change', function () {
        // P4 重新排查: FileReader 异步, onload 之后 preview.src 才更新. 等 100ms 让 onload 跑完.
        //   (此前 bug: 事件委托 change 在此前同步 save 把 localVideoUrl 写空 + 顺序 refresh 先跑
        //    → 把 onload 刚显示的新图藏回 display:none ⇒ "从来没出现过预览")
        //   正确顺序:
        //   1) 先 persistPrepVideoSettings() —— onload 已跑完, 读 preview.src 新值 → localVideoUrl 写正确
        //   2) 再 refreshPrepLocalFallback() —— 读 localVideoUrl 有值 → hasCustom=true → 显示 preview, 藏 user-avatar
        setTimeout(function () {
          persistPrepVideoSettings();
          refreshPrepLocalFallback();
        }, 100);
      });
    }
    const prepLocalUrlBtn = document.getElementById('prep-local-video-url-btn');
    if (prepLocalUrlBtn) {
      prepLocalUrlBtn.addEventListener('click', function () {
        setTimeout(refreshPrepLocalFallback, 0);
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

    // 4.5 v0.5.0 P2.4: "已设默认形象" 轻量 badge — 读 getVideoCallAppearance(chat.id) 决定显示
    //     形象调试台用户点"使用此形象进入视频通话"后, 这里的 appearance 有数据 → 显示"✅ 已设默认形象 (来自调试台)"
    //     appearance 跟 activeModelId 解耦: 哪怕 activeModelId 是旧的 (用户没改), 只要有 appearance
    //     就表示"用户曾经在调试台确认过当前模型是默认形象"。
    const appearanceBadgeEl = screenEl.querySelector('[data-role="appearance-badge"]');
    if (appearanceBadgeEl) {
      let appearance = null;
      try {
        if (global.Live2DStorage && typeof global.Live2DStorage.getVideoCallAppearance === 'function' && chat.id) {
          appearance = await global.Live2DStorage.getVideoCallAppearance(chat.id);
        }
      } catch (e) { /* fallback 不显示 */ }
      if (appearance && appearance.modelId) {
        let badgeText = '✅ 已设默认形象 (来自调试台)';
        // 给出 defaultExpression 提示, 让用户知道"AI 进入通话时是按这个 expression 起的"
        if (appearance.defaultExpression) {
          badgeText += ' · 起始表情: ' + appearance.defaultExpression;
        } else {
          badgeText += ' · 起始表情: 默认';
        }
        appearanceBadgeEl.textContent = badgeText;
        appearanceBadgeEl.style.display = 'block';
      } else {
        appearanceBadgeEl.textContent = '';
        appearanceBadgeEl.style.display = 'none';
      }
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

    // 8. v0.5.0 P3-1: 加载当前 chat 的"我的画面"配置 (localVideoUrl / enableRealCamera / cameraInterval / useRearCamera)
    //   按 chatId 隔离: 沈清越 → 沈清越自己的配置; 换角色 → 另一个角色的配置
    if (global.loadVideoOptimizationSettings && typeof global.loadVideoOptimizationSettings === 'function') {
      try {
        global.loadVideoOptimizationSettings(chat, 'prep-');
      } catch (e) {
        console.warn('[Live2DCallPrep] loadVideoOptimizationSettings failed:', e);
      }
    }

    // 8.1 v0.5.0 P3-1.1: 修正"我的画面"卡片的 user 头像兜底显示 (localVideoUrl 空时显示当前用户头像)
    //   localVideoUrl 有值 → 隐藏 user 头像, 显示 preview (loadVideoOptimizationSettings 已设)
    //   localVideoUrl 空 → 隐藏 preview/placeholder, 显示 user 头像兜底层
    refreshPrepLocalFallback();
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
