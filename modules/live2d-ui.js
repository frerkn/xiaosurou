// Live2D 模型管理 UI — 粉白 iOS 卡片列表
// P1.5 第四步: 视频通话设置页加模型/背景管理面板
// 依赖: window.Live2DUploader / window.Live2DStorage / window.Live2DConfig / window.Live2DLoader
// 输入: <input type="file" webkitdirectory> + <input type="file" accept=".zip">

(function (global) {
  'use strict';

  // 工具: 错误/成功 toast (用现有 330 toast, 没有就 alert 兜底)
  function showToast(msg, type) {
    type = type || 'info';
    if (global.showToast && typeof global.showToast === 'function') {
      global.showToast(msg, type);
      return;
    }
    if (global.Toast && global.Toast.show) { global.Toast.show(msg, type); return; }
    if (type === 'error') alert('❌ ' + msg);
    else if (type === 'success') alert('✅ ' + msg);
    else alert(msg);
  }

  // 工具: 从 model3.json 的第一张 texture 生成缩略图 blob URL
  async function makeModelThumbnail(files, modelPath) {
    try {
      const modelJson = JSON.parse(await files.get(modelPath).text());
      const refs = (modelJson.FileReferences || modelJson.fileReferences) || {};
      const baseDir = modelPath.substring(0, modelPath.lastIndexOf('/') + 1);
      const textures = Array.isArray(refs.Textures) ? refs.Textures : [];
      if (textures.length === 0) return null;
      const firstTex = baseDir + textures[0];
      const blob = files.get(firstTex);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      return url;  // 生命周期由调用方 revoke
    } catch (e) {
      return null;
    }
  }

  // 工具: 缩放图片到指定最大边 (用于背景缩略图)
  async function makeImageThumbnail(file, maxSize) {
    maxSize = maxSize || 128;
    return new Promise((resolve) => {
      try {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = function () {
          const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1);
          const w = Math.max(1, Math.round(img.width * ratio));
          const h = Math.max(1, Math.round(img.height * ratio));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            if (blob) resolve(URL.createObjectURL(blob));
            else resolve(null);
          }, 'image/png', 0.8);
        };
        img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
      } catch (e) { resolve(null); }
    });
  }

  // 同步 activeModelId → chat.settings.live2dModelPath (保持兼容, P1.5-7 改 video-voice-call.js 用 IDB 后这条可删)
  async function syncActiveModelToChat(modelId) {
    if (!modelId) {
      if (global.state && global.state.globalSettings) global.state.globalSettings.live2dModelPath = '';
      return;
    }
    try {
      const modelData = await global.Live2DStorage.getModel(modelId);
      if (!modelData) return;
      const path = modelData.modelPath;
      if (global.state && global.state.globalSettings) {
        global.state.globalSettings.live2dModelPath = path;
      }
      const inputEl = document.getElementById('ai-live2d-model-input');
      if (inputEl) inputEl.value = path;
    } catch (e) {}
  }

  // 渲染模型卡片列表
  async function renderModelList(containerEl) {
    if (!containerEl) return;
    if (!global.Live2DStorage) {
      containerEl.innerHTML = '<div class="live2d-empty">未加载 Live2DStorage 模块</div>';
      return;
    }
    const models = await global.Live2DStorage.listModels();
    const activeId = await global.Live2DStorage.getActiveModelId();

    if (models.length === 0) {
      containerEl.innerHTML = '<div class="live2d-empty">还没有模型 · 点下方按钮上传 ZIP 或文件夹</div>';
      return;
    }

    // 收集当前轮要 revoke 的 blob URL
    const toRevoke = containerEl._live2dUrls || [];
    containerEl._live2dUrls = [];

    const html = [];
    for (const m of models) {
      // v0.3.5: 设置页不再读 model3.json + texture 转 blob URL 渲染缩略图 (2048x2048 PNG 在 iOS Safari 渲染崩 tab)
      // 用 emoji 占位 🎭, 实际纹理由 PIXI 在视频通话画面里渲染 (那才是 Live2D 该出现的地方)
      const thumb = '<div class="live2d-card-thumb live2d-card-thumb-placeholder">🎭</div>';

      const isActive = m.id === activeId;
      const activeClass = isActive ? ' live2d-card-active' : '';
      const activeMark = isActive ? '<span class="live2d-card-mark">✓</span>' : '';
      const dateStr = new Date(m.addedAt).toLocaleDateString('zh-CN');

      html.push(`
        <div class="live2d-card${activeClass}" data-model-id="${m.id}">
          ${thumb}
          <div class="live2d-card-info">
            <div class="live2d-card-name">${escapeHtml(m.name)}</div>
            <div class="live2d-card-meta">${m.fileCount} 个文件 · ${dateStr}</div>
          </div>
          ${activeMark}
          <button class="live2d-card-del" data-action="delete" title="删除">✕</button>
        </div>
      `);
    }
    containerEl.innerHTML = html.join('');

    // 回收上一轮 blob URL
    toRevoke.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });

    // 绑定点击事件 (用事件委托)
    containerEl.onclick = async function (ev) {
      const card = ev.target.closest('.live2d-card');
      if (!card) return;
      const modelId = card.getAttribute('data-model-id');
      if (!modelId) return;
      if (ev.target.getAttribute('data-action') === 'delete') {
        if (!confirm('确定删除这个模型？')) return;
        try {
          await global.Live2DStorage.deleteModel(modelId);
          const curActive = await global.Live2DStorage.getActiveModelId();
          if (curActive === modelId) {
            await global.Live2DStorage.setActiveModelId('');
            await syncActiveModelToChat('');
          }
          showToast('已删除', 'success');
          await renderModelList(containerEl);
        } catch (e) {
          showToast('删除失败: ' + e.message, 'error');
        }
        return;
      }
      try {
        await global.Live2DStorage.setActiveModelId(modelId);
        await syncActiveModelToChat(modelId);
        showToast('已切换到 ' + (card.querySelector('.live2d-card-name')?.textContent || '模型'), 'success');
        await renderModelList(containerEl);
      } catch (e) {
        showToast('切换失败: ' + e.message, 'error');
      }
    };
  }

  // 渲染背景卡片列表
  async function renderBackgroundList(containerEl) {
    if (!containerEl) return;
    if (!global.db) {
      containerEl.innerHTML = '<div class="live2d-empty">IDB 未初始化</div>';
      return;
    }
    const all = await global.db.live2d_backgrounds.toArray();
    const activeId = (() => { try { return localStorage.getItem('live2d.activeBackgroundId') || ''; } catch (e) { return ''; } })();
    const sorted = all.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

    if (sorted.length === 0) {
      containerEl.innerHTML = '<div class="live2d-empty">还没有背景 · 上传图片生成背景</div>';
      return;
    }

    const toRevoke = containerEl._live2dBgUrls || [];
    containerEl._live2dBgUrls = [];

    const html = [];
    for (const bg of sorted) {
      // v0.3.5: 跟模型卡片一致, 设置页不渲染背景缩略图 (保险, 大背景图也可能崩)
      const thumb = '<div class="live2d-card-thumb live2d-card-thumb-placeholder">🖼</div>';
      const isActive = bg.id === activeId;
      const activeClass = isActive ? ' live2d-card-active' : '';
      const activeMark = isActive ? '<span class="live2d-card-mark">✓</span>' : '';
      html.push(`
        <div class="live2d-card${activeClass}" data-bg-id="${bg.id}">
          ${thumb}
          <div class="live2d-card-info">
            <div class="live2d-card-name">${escapeHtml(bg.name)}</div>
          </div>
          ${activeMark}
          <button class="live2d-card-del" data-action="delete" title="删除">✕</button>
        </div>
      `);
    }
    containerEl.innerHTML = html.join('');

    toRevoke.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });

    containerEl.onclick = async function (ev) {
      const card = ev.target.closest('.live2d-card');
      if (!card) return;
      const bgId = card.getAttribute('data-bg-id');
      if (!bgId) return;
      if (ev.target.getAttribute('data-action') === 'delete') {
        if (!confirm('确定删除这个背景？')) return;
        try {
          await global.db.live2d_backgrounds.delete(bgId);
          if (activeId === bgId) {
            try { localStorage.setItem('live2d.activeBackgroundId', ''); } catch (e) {}
            applyBackgroundToCallScreen('');
          }
          showToast('已删除', 'success');
          await renderBackgroundList(containerEl);
        } catch (e) {
          showToast('删除失败: ' + e.message, 'error');
        }
        return;
      }
      try {
        try { localStorage.setItem('live2d.activeBackgroundId', bgId); } catch (e) {}
        const bg = await global.db.live2d_backgrounds.get(bgId);
        if (bg && bg.blob) {
          const url = URL.createObjectURL(bg.blob);
          applyBackgroundToCallScreen(url);
          showToast('已切换背景', 'success');
        }
        await renderBackgroundList(containerEl);
      } catch (e) {
        showToast('切换失败: ' + e.message, 'error');
      }
    };
  }

  // 把背景图 URL 套到 video-call-screen (粉白舞台风兜底: 拉伸铺满)
  function applyBackgroundToCallScreen(url) {
    const screen = document.getElementById('video-call-screen');
    if (!screen) return;
    if (url) {
      screen.style.backgroundImage = `url("${url}")`;
      screen.style.backgroundSize = 'cover';
      screen.style.backgroundPosition = 'center';
    } else {
      screen.style.backgroundImage = '';
      screen.style.backgroundSize = '';
      screen.style.backgroundPosition = '';
    }
  }

  // 应用当前 active 背景到视频通话画面
  async function applyActiveBackground() {
    let activeId = '';
    try { activeId = localStorage.getItem('live2d.activeBackgroundId') || ''; } catch (e) {}
    if (!activeId || !global.db) return;
    const bg = await global.db.live2d_backgrounds.get(activeId);
    if (bg && bg.blob) {
      const url = URL.createObjectURL(bg.blob);
      applyBackgroundToCallScreen(url);
    }
  }

  // HTML 转义
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // 上传模型 (UI 入口) - 接 file input change 事件
  async function handleModelUpload(fileList, kind, containerEl) {
    if (!global.Live2DUploader) {
      showToast('Live2DUploader 未加载', 'error');
      return;
    }
    if (!fileList || fileList.length === 0) {
      showToast('请选择文件', 'error');
      return;
    }
    try {
      let result;
      if (kind === 'zip') {
        result = await global.Live2DUploader.uploadZip(fileList[0]);
      } else if (kind === 'folder') {
        result = await global.Live2DUploader.uploadFolder(fileList);
      } else {
        result = await global.Live2DUploader.uploadModel3WithSiblings(fileList);
      }
      // 存到 IDB
      const id = await global.Live2DStorage.saveModel(result);
      // 自动设为 active (首次上传, 让用户立刻能用)
      const existed = await global.Live2DStorage.listModels();
      if (existed.length === 1) {
        await global.Live2DStorage.setActiveModelId(id);
        await syncActiveModelToChat(id);
      }
      showToast('已上传: ' + result.name, 'success');
      if (containerEl) await renderModelList(containerEl);
    } catch (e) {
      if (e && e.name === 'Live2DMissingFilesError') {
        const names = (e.missingFiles || []).slice(0, 5).map(f => f.resolvedPath.split('/').pop()).join(', ');
        showToast(`模型引用不完整, 缺文件: ${names}${e.missingFiles.length > 5 ? ' 等' : ''}`, 'error');
      } else {
        showToast('上传失败: ' + (e.message || String(e)), 'error');
      }
    }
  }

  // 上传背景 (UI 入口)
  async function handleBackgroundUpload(file, containerEl) {
    if (!file) return;
    if (!global.db) { showToast('IDB 未初始化', 'error'); return; }
    if (!/^image\//i.test(file.type)) {
      showToast('请选择图片文件', 'error');
      return;
    }
    try {
      const id = (global.crypto && global.crypto.randomUUID)
        ? global.crypto.randomUUID()
        : 'bg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
      await global.db.live2d_backgrounds.put({
        id,
        name: file.name.replace(/\.[^.]+$/, ''),
        addedAt: Date.now(),
        blob: file,
      });
      showToast('已上传背景', 'success');
      if (containerEl) await renderBackgroundList(containerEl);
    } catch (e) {
      showToast('上传失败: ' + e.message, 'error');
    }
  }

  // 初始化 UI 入口 (页面加载完成后调用一次, 绑定 input + 渲染列表)
  function initUI() {
    // 模型管理
    const modelListEl = document.getElementById('live2d-model-list');
    const zipInputEl = document.getElementById('live2d-upload-zip-input');
    const folderInputEl = document.getElementById('live2d-upload-folder-input');
    const zipBtn = document.getElementById('live2d-upload-zip-btn');
    const folderBtn = document.getElementById('live2d-upload-folder-btn');

    if (modelListEl) renderModelList(modelListEl);
    if (zipInputEl) {
      zipInputEl.addEventListener('change', async function () {
        await handleModelUpload(this.files, 'zip', modelListEl);
        this.value = '';
      });
    }
    if (folderInputEl) {
      folderInputEl.addEventListener('change', async function () {
        await handleModelUpload(this.files, 'folder', modelListEl);
        this.value = '';
      });
    }
    if (zipBtn && zipInputEl) {
      zipBtn.addEventListener('click', () => zipInputEl.click());
    }
    if (folderBtn && folderInputEl) {
      folderBtn.addEventListener('click', () => folderInputEl.click());
    }

    // 背景管理
    const bgListEl = document.getElementById('live2d-bg-list');
    const bgInputEl = document.getElementById('live2d-upload-bg-input');
    const bgBtn = document.getElementById('live2d-upload-bg-btn');
    if (bgListEl) renderBackgroundList(bgListEl);
    if (bgInputEl) {
      bgInputEl.addEventListener('change', async function () {
        await handleBackgroundUpload(this.files && this.files[0], bgListEl);
        this.value = '';
      });
    }
    if (bgBtn && bgInputEl) {
      bgBtn.addEventListener('click', () => bgInputEl.click());
    }

    // 浮动切背景按钮 (通话时用)
    bindFloatingBgBtn();
  }

  // P1.5 浮动切背景按钮控制 (Live2D 挂载时显示, 卸载时隐藏)
  function showBackgroundSwitchBtn() {
    const btn = document.getElementById('live2d-switch-bg-btn');
    if (btn) btn.style.display = 'flex';
  }
  function hideBackgroundSwitchBtn() {
    const btn = document.getElementById('live2d-switch-bg-btn');
    if (btn) btn.style.display = 'none';
    // 顺手关 picker
    const picker = document.getElementById('live2d-bg-picker');
    if (picker) { picker.style.display = 'none'; picker.innerHTML = ''; }
  }

  // 打开背景选择器 (浮动在按钮下方)
  async function openBgPicker() {
    const picker = document.getElementById('live2d-bg-picker');
    if (!picker) return;
    if (!global.db) { picker.innerHTML = '<div class="live2d-bg-picker-empty">IDB 未初始化</div>'; picker.style.display = 'block'; return; }
    const all = await global.db.live2d_backgrounds.toArray();
    const sorted = all.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const activeId = (() => { try { return localStorage.getItem('live2d.activeBackgroundId') || ''; } catch (e) { return ''; } })();

    if (sorted.length === 0) {
      picker.innerHTML = '<div class="live2d-bg-picker-empty">还没有背景<br>去设置页 → 通话背景 上传</div>';
      picker.style.display = 'block';
      return;
    }

    // 收集这一轮要 revoke 的 URL
    const toRevoke = picker._live2dBgPickerUrls || [];
    picker._live2dBgPickerUrls = [];

    const html = ['<div class="live2d-bg-picker-title">选择通话背景</div>'];
    for (const bg of sorted) {
      const url = bg.blob ? URL.createObjectURL(bg.blob) : '';
      if (url) picker._live2dBgPickerUrls.push(url);
      const activeClass = bg.id === activeId ? ' live2d-bg-picker-item-active' : '';
      const style = url ? `background-image:url('${url}')` : 'background:#f5f5f5';
      html.push(`<div class="live2d-bg-picker-item${activeClass}" data-bg-id="${bg.id}" style="${style}"></div>`);
    }
    html.push('<div class="live2d-bg-picker-clear" data-action="clear">清除背景</div>');
    picker.innerHTML = html.join('');
    picker.style.display = 'block';

    toRevoke.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });

    picker.onclick = async function (ev) {
      const item = ev.target.closest('[data-bg-id]');
      if (item) {
        const bgId = item.getAttribute('data-bg-id');
        try {
          try { localStorage.setItem('live2d.activeBackgroundId', bgId); } catch (e) {}
          const bg = await global.db.live2d_backgrounds.get(bgId);
          if (bg && bg.blob) {
            const url = URL.createObjectURL(bg.blob);
            applyBackgroundToCallScreen(url);
          }
          showToast('已切换背景', 'success');
          await openBgPicker();  // 重渲染高亮
        } catch (e) {
          showToast('切换失败: ' + e.message, 'error');
        }
        return;
      }
      if (ev.target.getAttribute('data-action') === 'clear') {
        try { localStorage.setItem('live2d.activeBackgroundId', ''); } catch (e) {}
        applyBackgroundToCallScreen('');
        showToast('已清除背景', 'success');
        await openBgPicker();
      }
    };
  }

  // 绑定浮动按钮 click (页面加载后调一次)
  function bindFloatingBgBtn() {
    const btn = document.getElementById('live2d-switch-bg-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      const picker = document.getElementById('live2d-bg-picker');
      if (!picker) return;
      if (picker.style.display === 'block') picker.style.display = 'none';
      else openBgPicker();
    });
  }

  global.Live2DUI = {
    renderModelList,
    renderBackgroundList,
    handleModelUpload,
    handleBackgroundUpload,
    applyBackgroundToCallScreen,
    applyActiveBackground,
    syncActiveModelToChat,
    showBackgroundSwitchBtn,
    hideBackgroundSwitchBtn,
    openBgPicker,
    bindFloatingBgBtn,
    initUI,
  };
})(typeof window !== 'undefined' ? window : globalThis);
