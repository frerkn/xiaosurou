// Live2D 背景管理页 (v0.5.0 P11)
// 准备页"通话舞台背景 · 管理"按钮入口, 复用现有 Live2D 背景能力
// 依赖: window.db (live2d_backgrounds store, schema v0.2.31.5+ 已有)
// 依赖: window.Live2DUI.{getActiveBackgroundIdForChat, setActiveBackgroundIdForChat} (per-chat 绑定 + 全局 fallback)
// 依赖: window.Live2DCallPrep.render(chat) - 关闭时回调让准备页刷新
// 职责: 已上传背景的列表 + 缩略图 + 元数据 + 删除 + 当前状态 + 空态 + 错误态
// 不做: 上传 (上传入口在准备页 upload-bg), 通话舞台渲染, 设置页背景选择 (那是 live2d-ui.renderBackgroundList 旧路径)
// DOM 动态注入 (init 时), 不需要预先在 index.html 写
// CSS 走 index.html 静态 link (避免动态注入导致首帧无样式)
// API: window.Live2DBgManager = { init, open, close, uploadBackground }

(function (global) {
  'use strict';

  let screenEl = null;
  let listEl = null;
  let emptyHintEl = null;
  let backBtnEl = null;
  let delModalEl = null;           // v0.5.0 P11.2: 删除确认弹窗 overlay
  let delModalDescEl = null;       // 弹窗描述 (显示 bg 名字)
  let delModalCancelEl = null;     // 取消按钮
  let delModalConfirmEl = null;    // 确定删除按钮
  let currentChat = null;
  let onCloseCallback = null;
  // 缩略图 blob URL 池: 每次 renderList 时 revoke 上轮的, 防止内存泄漏
  let thumbUrls = [];

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function formatBytes(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function ensureScreenDom() {
    // CSS 走 index.html 静态 link, 这里只兜底 (防止忘记在 index.html 加)
    if (!document.querySelector('link[href*="live2d-bg-manager.css"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'css/live2d-bg-manager.css?v=0.0.1';
      document.head.appendChild(link);
    }
    if (screenEl && document.body.contains(screenEl)) return screenEl;
    let existing = document.getElementById('live2d-bg-manager-screen');
    if (existing) {
      screenEl = existing;
    } else {
      const wrap = document.createElement('div');
      wrap.id = 'live2d-bg-manager-screen';
      // 关键: 不要在这里设 inline display:none. 整个 .screen 体系靠 .active 切显隐
      // (.screen 默认 opacity:0+visibility:hidden, .screen.active 反之).
      // 设了 inline display:none 会让 showScreen 加 .active 也没用, 整页空白 (v0.5.0 P0 bug)
      wrap.className = 'screen live2d-bg-manager-screen';
      wrap.innerHTML = [
        '<header class="live2d-bg-manager-header">',
        '  <button type="button" class="live2d-bg-manager-back-btn" data-role="back" aria-label="返回">‹</button>',
        '  <h1 class="live2d-bg-manager-title">通话背景管理</h1>',
        '  <span class="live2d-bg-manager-header-spacer"></span>',
        '</header>',
        '<div class="live2d-bg-manager-body">',
        '  <section class="live2d-bg-manager-section">',
        '    <div class="live2d-bg-manager-section-title">已上传背景</div>',
        '    <div class="live2d-bg-manager-list" data-role="list"></div>',
        '    <div class="live2d-bg-manager-empty" data-role="empty" style="display:none">',
        '      还没有上传过背景，去准备页点「＋ 上传舞台背景」吧',
        '    </div>',
        '  </section>',
        '  <p class="live2d-bg-manager-hint">点列表项可切换「当前 AI 已绑定」背景</p>',
        '</div>',
        // v0.5.0 P11.2: 删除确认弹窗 (绕开 iOS PWA standalone 模式下 window.confirm() 静默返回 false 的 bug)
        // 用户原话"再点是几个意思", 要的是真弹窗. 自建 modal, PWA 下绝对能显示.
        '<div class="live2d-bg-modal-overlay" data-role="del-modal" style="display:none">',
        '  <div class="live2d-bg-modal">',
        '    <div class="live2d-bg-modal-icon">🗑️</div>',
        '    <div class="live2d-bg-modal-title">删除这个背景？</div>',
        '    <div class="live2d-bg-modal-desc" data-role="del-modal-desc">此操作不可撤销</div>',
        '    <div class="live2d-bg-modal-actions">',
        '      <button type="button" class="live2d-bg-modal-btn live2d-bg-modal-btn-cancel" data-role="del-modal-cancel">取消</button>',
        '      <button type="button" class="live2d-bg-modal-btn live2d-bg-modal-btn-confirm" data-role="del-modal-confirm">确定删除</button>',
        '    </div>',
        '  </div>',
        '</div>',
      ].join('\n');
      document.body.appendChild(wrap);
      screenEl = wrap;
    }
    return screenEl;
  }

  function bindRefs() {
    listEl = screenEl.querySelector('[data-role="list"]');
    emptyHintEl = screenEl.querySelector('[data-role="empty"]');
    backBtnEl = screenEl.querySelector('[data-role="back"]');
    // 删除确认弹窗 refs
    delModalEl = screenEl.querySelector('[data-role="del-modal"]');
    delModalDescEl = screenEl.querySelector('[data-role="del-modal-desc"]');
    delModalCancelEl = screenEl.querySelector('[data-role="del-modal-cancel"]');
    delModalConfirmEl = screenEl.querySelector('[data-role="del-modal-confirm"]');
  }

  function getActiveBgIdForCurrentChat() {
    if (!currentChat || !currentChat.id) return '';
    if (global.Live2DUI && typeof global.Live2DUI.getActiveBackgroundIdForChat === 'function') {
      try { return global.Live2DUI.getActiveBackgroundIdForChat(currentChat.id) || ''; }
      catch (e) { console.warn('[Live2DBgManager] getActive failed:', e); return ''; }
    }
    // 兜底: 直接读 localStorage
    try {
      return localStorage.getItem('live2d.activeBackgroundId.' + currentChat.id)
        || localStorage.getItem('live2d.activeBackgroundId')
        || '';
    } catch (e) { return ''; }
  }

  function setActiveBgIdForCurrentChat(bgId) {
    if (!currentChat || !currentChat.id) return;
    if (global.Live2DUI && typeof global.Live2DUI.setActiveBackgroundIdForChat === 'function') {
      try { global.Live2DUI.setActiveBackgroundIdForChat(currentChat.id, bgId); return; }
      catch (e) { console.warn('[Live2DBgManager] setActive via Live2DUI failed:', e); }
    }
    try { localStorage.setItem('live2d.activeBackgroundId.' + currentChat.id, bgId || ''); }
    catch (e) { console.warn('[Live2DBgManager] setActive ls fallback failed:', e); }
  }

  // v0.5.0 P11.2: 删除确认弹窗 (自建 modal, 绕开 iOS PWA standalone 模式下 window.confirm() 静默返回 false)
  // v0.5.0 P11.1 试过 inline 二次确认 (按钮变红 + 文字"再点"), 功能 work 但 UX 不直观,
  // user 原话"再点是几个意思". 改成显眼的弹窗: 半透明遮罩 + 中间白卡 + 取消/确定按钮.
  let pendingDelBgId = '';   // 当前弹窗等待删除的 bgId

  function showDeleteConfirm(bgId, bgName) {
    if (!delModalEl) return;
    pendingDelBgId = bgId || '';
    if (delModalDescEl) {
      delModalDescEl.textContent = '确定要删除「' + (bgName || '这个背景') + '」吗？此操作不可撤销';
    }
    delModalEl.style.display = 'flex';
    console.log('[Live2DBgManager] 弹出删除确认, bgId=', bgId);
  }

  function hideDeleteConfirm() {
    if (delModalEl) delModalEl.style.display = 'none';
    pendingDelBgId = '';
  }

  async function doDeleteBg(bgId) {
    if (!bgId) return;
    try {
      if (!global.db) throw new Error('IDB 未初始化');
      await global.db.live2d_backgrounds.delete(bgId);
      console.log('[Live2DBgManager] IDB 已删除背景', bgId);
      // 清理 per-chat / global active id (如果指向被删的 bg)
      try {
        const glob = localStorage.getItem('live2d.activeBackgroundId');
        if (glob === bgId) localStorage.setItem('live2d.activeBackgroundId', '');
        if (currentChat && currentChat.id) {
          const per = localStorage.getItem('live2d.activeBackgroundId.' + currentChat.id);
          if (per === bgId) setActiveBgIdForCurrentChat('');
        }
      } catch (e) { console.warn('[Live2DBgManager] clean active id after delete:', e); }
      console.log('[Live2DBgManager] 已删除背景', bgId);
      await renderList();
    } catch (e) {
      console.error('[Live2DBgManager] 删除失败:', e, 'bgId=', bgId);
      // 不用 alert (PWA 也可能屏蔽), 直接 console 抛错, 朋友能截图给我
    }
  }

  function bindEvents() {
    if (backBtnEl) backBtnEl.onclick = close;
    if (listEl) {
      listEl.onclick = function (ev) {
        const card = ev.target.closest('[data-bg-id]');
        if (!card) return;
        const bgId = card.getAttribute('data-bg-id');
        if (!bgId) return;
        // v0.5.0 P11.3: 用 closest('.live2d-bg-card-del') 兜底 (ev.target 可能是 button 也可能是 button 内 text node, 都命中)
        // 之前 ev.target.getAttribute('data-action') === 'delete' 在按钮缩放 + hit area 偏小时算不到 data-action, 走"绑定 chat"分支
        if (ev.target.closest('.live2d-bg-card-del')) {
          // ✕ → 弹模态确认弹窗 (替代 window.confirm, PWA 兼容)
          const bgName = card.querySelector('.live2d-bg-card-name')?.textContent || '';
          showDeleteConfirm(bgId, bgName);
          return;
        }
        // 点卡片本体 (不在 ✕ 按钮上) → 绑定当前 chat 为该 bg (跟准备页 upload-bg 行为一致)
        if (currentChat && currentChat.id) {
          try {
            setActiveBgIdForCurrentChat(bgId);
            console.log('[Live2DBgManager] 已绑定 chat ' + currentChat.id + ' → bg ' + bgId);
            updateCardHighlight();
          } catch (e) {
            console.error('[Live2DBgManager] 绑定失败:', e);
          }
        }
      };
    }
    // modal 按钮: 取消 / 确定
    if (delModalCancelEl) {
      delModalCancelEl.onclick = function () {
        console.log('[Live2DBgManager] 取消删除');
        hideDeleteConfirm();
      };
    }
    if (delModalConfirmEl) {
      delModalConfirmEl.onclick = async function () {
        const bgId = pendingDelBgId;
        hideDeleteConfirm();
        if (bgId) await doDeleteBg(bgId);
      };
    }
    // 点遮罩 (modal 卡片外的区域) → 取消
    if (delModalEl) {
      delModalEl.onclick = function (ev) {
        if (ev.target === delModalEl) {
          console.log('[Live2DBgManager] 点遮罩取消');
          hideDeleteConfirm();
        }
      };
    }
  }

  function revokeThumbUrls() {
    thumbUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
    thumbUrls = [];
  }

  async function renderList() {
    revokeThumbUrls();
    // 重新渲染时清掉可能挂着的 modal
    hideDeleteConfirm();
    if (!listEl) return;
    let all = [];
    try {
      if (!global.db) throw new Error('IDB 未初始化');
      all = await global.db.live2d_backgrounds.toArray();
    } catch (e) {
      console.error('[Live2DBgManager] 加载背景列表失败:', e);
      listEl.innerHTML = '<div class="live2d-bg-manager-list-error">加载背景列表失败: ' + escapeHtml(e.message || String(e)) + '</div>';
      if (emptyHintEl) emptyHintEl.style.display = 'none';
      return;
    }
    const sorted = all.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    if (emptyHintEl) emptyHintEl.style.display = sorted.length === 0 ? 'block' : 'none';
    if (sorted.length === 0) {
      listEl.innerHTML = '';
      return;
    }
    const activeId = getActiveBgIdForCurrentChat();
    listEl.innerHTML = sorted.map(bg => {
      // 缩略图: blob URL (不 resize, 4K 照片由 CSS 64x64 + object-fit:cover 浏览器自然 downscale)
      // Live2D 模型纹理崩过 (v0.3.5), 但背景是普通照片, iOS Safari blob URL img 加载大照片通常 OK.
      // 万一崩会降级到 emoji placeholder.
      let thumb = '<div class="live2d-bg-card-thumb live2d-bg-card-thumb-placeholder">🖼</div>';
      try {
        if (bg.blob) {
          const url = URL.createObjectURL(bg.blob);
          thumbUrls.push(url);
          thumb = '<div class="live2d-bg-card-thumb"><img src="' + url + '" alt="" loading="lazy"></div>';
        }
      } catch (e) { /* fallback placeholder */ }
      const isActive = bg.id === activeId;
      const activeClass = isActive ? ' live2d-bg-card-active' : '';
      const activeMark = isActive ? '<span class="live2d-bg-card-mark">✓ 当前</span>' : '';
      const dateStr = new Date(bg.addedAt || 0).toLocaleDateString('zh-CN');
      const sizeStr = formatBytes(bg.blob && bg.blob.size);
      return [
        '<div class="live2d-bg-card' + activeClass + '" data-bg-id="' + escapeHtml(bg.id) + '">',
        '  ' + thumb,
        '  <div class="live2d-bg-card-info">',
        '    <div class="live2d-bg-card-name">' + escapeHtml(bg.name) + '</div>',
        '    <div class="live2d-bg-card-meta">',
        '      <span>' + sizeStr + '</span>',
        '      <span>·</span>',
        '      <span>' + dateStr + '</span>',
        '    </div>',
        '  </div>',
        '  ' + activeMark,
        '  <button type="button" class="live2d-bg-card-del" data-action="delete" title="删除">✕</button>',
        '</div>',
      ].join('');
    }).join('');
  }

  function updateCardHighlight() {
    if (!listEl || !currentChat || !currentChat.id) return;
    const activeId = getActiveBgIdForCurrentChat();
    listEl.querySelectorAll('[data-bg-id]').forEach(el => {
      const id = el.getAttribute('data-bg-id');
      el.classList.toggle('live2d-bg-card-active', id === activeId);
      // 同步 ✓ 标记 (DOM 重写 vs 局部更新: 重写更省心, 但会丢失可能存在的滚动位置; 列表短可以重写)
      let mark = el.querySelector('.live2d-bg-card-mark');
      if (id === activeId) {
        if (!mark) {
          mark = document.createElement('span');
          mark.className = 'live2d-bg-card-mark';
          mark.textContent = '✓ 当前';
          // 插在 info 后面, del 前面
          const info = el.querySelector('.live2d-bg-card-info');
          const del = el.querySelector('.live2d-bg-card-del');
          if (del) el.insertBefore(mark, del);
          else if (info && info.nextSibling) el.insertBefore(mark, info.nextSibling);
          else el.appendChild(mark);
        }
      } else if (mark) {
        mark.remove();
      }
    });
  }

  function init() {
    ensureScreenDom();
    bindRefs();
    bindEvents();
  }

  function open(chat, onClose) {
    init();
    currentChat = chat || null;
    onCloseCallback = onClose || null;
    // 防御性: 清掉 close() 留下的 inline display, 防止任何残留的 display:none 覆盖 .screen.active
    if (screenEl) screenEl.style.display = '';
    if (global.showScreen) {
      global.showScreen('live2d-bg-manager-screen');
    } else if (screenEl) {
      screenEl.style.display = 'block';
    }
    renderList();
  }

  function close() {
    // 完整 dispose, 不残留 blob URL / modal 状态
    revokeThumbUrls();
    hideDeleteConfirm();
    // 返回准备页
    if (global.showScreen) {
      global.showScreen('live2d-call-prep-screen');
    }
    if (screenEl) screenEl.style.display = 'none';
    const cb = onCloseCallback;
    currentChat = null;
    onCloseCallback = null;
    if (typeof cb === 'function') {
      try { cb(); } catch (e) { console.warn('[Live2DBgManager] onClose error:', e); }
    }
  }

  // 给准备页"上传舞台背景"按钮用: 上传后自动绑定当前 chat (per-chat active bg id)
  // 跟旧 live2d-ui.handleBackgroundUpload 不一样: 这个会同时绑 chat, 旧那个只 put IDB
  async function uploadBackground(file, chatId) {
    if (!file) return null;
    if (!/^image\//i.test(file.type)) {
      console.warn('[Live2DBgManager] 非图片文件, 跳过:', file.type);
      alert('请选择图片文件');
      return null;
    }
    try {
      if (!global.db) throw new Error('IDB 未初始化');
      const id = (global.crypto && global.crypto.randomUUID)
        ? global.crypto.randomUUID()
        : 'bg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
      await global.db.live2d_backgrounds.put({
        id,
        name: file.name.replace(/\.[^.]+$/, '') || '背景',
        addedAt: Date.now(),
        blob: file,
      });
      if (chatId && global.Live2DUI && typeof global.Live2DUI.setActiveBackgroundIdForChat === 'function') {
        global.Live2DUI.setActiveBackgroundIdForChat(chatId, id);
        console.log('[Live2DBgManager] 上传后自动绑定 chat ' + chatId + ' → bg ' + id);
      } else if (chatId) {
        try { localStorage.setItem('live2d.activeBackgroundId.' + chatId, id); } catch (e) {}
      }
      return id;
    } catch (e) {
      console.error('[Live2DBgManager] 上传失败:', e);
      alert('上传失败: ' + (e.message || String(e)));
      return null;
    }
  }

  global.Live2DBgManager = { init, open, close, uploadBackground };
})(typeof window !== 'undefined' ? window : globalThis);
