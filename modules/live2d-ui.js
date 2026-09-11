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
          forgetBgThumb(bgId);
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

  // v0.4.3: per-chat 背景绑定 (key = live2d.activeBackgroundId.<chatId>)
  // fallback 到旧全局 activeBackgroundId (兼容老数据)
  function getActiveBackgroundIdForChat(chatId) {
    if (!chatId || typeof chatId !== 'string') return '';
    try {
      const per = localStorage.getItem('live2d.activeBackgroundId.' + chatId);
      if (per) return per;
      const glob = localStorage.getItem('live2d.activeBackgroundId');
      return glob || '';
    } catch (e) { return ''; }
  }

  function setActiveBackgroundIdForChat(chatId, bgId) {
    if (!chatId || typeof chatId !== 'string') return;
    try { localStorage.setItem('live2d.activeBackgroundId.' + chatId, bgId || ''); } catch (e) {}
  }

  // v0.4.3: 应用当前 active 背景到视频通话画面
  // 兼容旧调用: applyActiveBackground() 不传 chat → 全局共享
  // 新调用: applyActiveBackground(chat) → 该 chat 专属背景
  async function applyActiveBackground(chat) {
    let activeId = '';
    if (chat && chat.id) {
      activeId = getActiveBackgroundIdForChat(chat.id);
    } else {
      try { activeId = localStorage.getItem('live2d.activeBackgroundId') || ''; } catch (e) {}
    }
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

  // v0.5.0 P13: 上传背景前自动缩图
  // ------------------------------------------------------------
  // 为什么: 原图直存 → IDB 里一张 12MP 手机照 3-5MB; 更要命的是
  // applyBackgroundToCallScreen 用 background-size:cover, cover 只负责裁切
  // 【不省解码成本】—— 浏览器必须把整张 4000x3000 解成位图(约 48MB 内存)再裁。
  // 目标画质: 手机 3x 全屏(约 1170x2532 物理像素)够用的长边 1600px / q0.8,
  // 解压后位图约 7.7MB, 体积通常 250-450KB, 画质肉眼看不出差别。
  // 依赖 index.html 已加载的 browser-image-compression (全局 imageCompression)。
  // 契约: 【永不抛错、永不返回空】—— 任何失败都回退原文件, 上传流程不受影响。
  // 注意: useWebWorker 用 false —— 本项目在 file:// 下跑, blob worker 在
  // file:// origin 上有被拦的历史风险, 上传是一次性操作, 主线程压几百 ms 无妨。
  // ------------------------------------------------------------
  const BG_COMPRESS_OPTIONS = {
    maxWidthOrHeight: 1600,
    initialQuality: 0.8,
    maxSizeMB: 0.6,
    fileType: 'image/jpeg',
    useWebWorker: false,
  };

  async function compressBackgroundImage(file) {
    if (!file) return file;
    try {
      if (typeof global.imageCompression !== 'function') {
        console.warn('[Live2DUI] 压缩库未加载, 背景按原图上传');
        return file;
      }
      // 已经又小又是 JPEG 的就不二次压缩 (白掉画质还费时间)
      if (/^image\/jpe?g$/i.test(file.type) && file.size <= 300 * 1024) return file;

      const out = await global.imageCompression(file, BG_COMPRESS_OPTIONS);
      // 压完反而变大 / 返回空 → 保留原图 (跟 data-management.js 同策略)
      if (!out || !out.size || out.size >= file.size) {
        console.log('[Live2DUI] 背景压缩后未变小, 保留原图');
        return file;
      }
      console.log('[Live2DUI] 背景压缩: '
        + Math.round(file.size / 1024) + 'KB → ' + Math.round(out.size / 1024) + 'KB');
      return out;
    } catch (e) {
      console.warn('[Live2DUI] 背景压缩失败, 按原图上传:', e);
      return file;
    }
  }

  // v0.5.0 P14: 背景缩略图 (给选择器/列表用的小图)
  // ------------------------------------------------------------
  // 为什么: 选择器原来每个格子直接 background-image: url(原图 blob),
  // 可见即解码 —— 打开一次 = N 张全尺寸图同时解码(1600px 一张 7.7MB 位图),
  // 张数一多就是卡顿/白屏尖峰.
  // 现在: 上传时顺手生成长边 160px 小图存进 bg.thumb (160x120 约 77KB 位图,
  // 比原图小 100 倍), 选择器只吃小图.
  // 老数据没有 thumb → 先占位, 后台一张一张补生成并写回 IDB (只补一次).
  // ------------------------------------------------------------
  const BG_THUMB_MAX = 160;
  const BG_THUMB_QUALITY = 0.72;
  const bgThumbUrls = new Map();   // bgId -> blob URL (本次会话内存缓存, 页面关掉自动释放)

  /** 丢弃某个背景的缩略图缓存 (删背景时调, 别让 URL 钉着 blob) */
  function forgetBgThumb(bgId) {
    if (!bgId || !bgThumbUrls.has(bgId)) return;
    try { URL.revokeObjectURL(bgThumbUrls.get(bgId)); } catch (e) {}
    bgThumbUrls.delete(bgId);
  }

  /** 取缩略图 blob URL; 没有 thumb 返回 '' (调用方显示占位). 永不抛错 */
  function getBgThumbUrl(bg) {
    if (!bg || !bg.id || !bg.thumb) return '';
    if (bgThumbUrls.has(bg.id)) return bgThumbUrls.get(bg.id);
    try {
      const url = URL.createObjectURL(bg.thumb);
      bgThumbUrls.set(bg.id, url);
      return url;
    } catch (e) {
      console.warn('[Live2DUI] 缩略图 URL 创建失败:', e);
      return '';
    }
  }

  /** 把一张图缩成长边 160px 的 JPEG blob; 永不抛错, 失败返回 null */
  async function makeBackgroundThumbnail(blob) {
    if (!blob) return null;
    let srcUrl = '';
    try {
      srcUrl = URL.createObjectURL(blob);
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('缩略图源图解码失败'));
        im.src = srcUrl;
      });
      const iw = img.naturalWidth || 1;
      const ih = img.naturalHeight || 1;
      const scale = Math.min(1, BG_THUMB_MAX / Math.max(iw, ih));
      const w = Math.max(1, Math.round(iw * scale));
      const h = Math.max(1, Math.round(ih * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const out = await new Promise(resolve => {
        canvas.toBlob(b => resolve(b), 'image/jpeg', BG_THUMB_QUALITY);
      });
      return out || null;
    } catch (e) {
      console.warn('[Live2DUI] 生成背景缩略图失败:', e);
      return null;
    } finally {
      // 已经画进 canvas 了, 这里可以立刻放掉源 URL
      if (srcUrl) { try { URL.revokeObjectURL(srcUrl); } catch (e) {} }
    }
  }

  /** 上传前统一处理: 缩图 + 生成缩略图. 永不抛错, 最坏退回原图 + 无缩略图 */
  async function prepareBackgroundFile(file) {
    const blob = await compressBackgroundImage(file);
    const thumb = await makeBackgroundThumbnail(blob);
    return { blob: blob || file, thumb: thumb };
  }

  // 老数据的背景补缩略图: 一张一张顺序来 (避免同时解码多张大图), 只补一次
  let bgBackfillRunning = false;
  async function backfillBgThumbs(ids) {
    if (bgBackfillRunning) return;
    bgBackfillRunning = true;
    try {
      for (const id of ids) {
        const bg = await global.db.live2d_backgrounds.get(id);
        if (!bg || !bg.blob || bg.thumb) continue;
        const thumb = await makeBackgroundThumbnail(bg.blob);
        if (!thumb) continue;
        bg.thumb = thumb;
        await global.db.live2d_backgrounds.put(bg);
        // 补完立刻贴到已经渲染出来的格子上 (用户可能已经关了 picker, 那就找不到元素)
        const el = document.querySelector(`.live2d-bg-picker-item[data-bg-id="${id}"]`);
        const url = getBgThumbUrl(bg);
        if (el && url) el.style.backgroundImage = `url('${url}')`;
      }
    } catch (e) {
      console.warn('[Live2DUI] 背景缩略图补齐中断:', e);
    } finally {
      bgBackfillRunning = false;
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
      // v0.5.0 P13/P14: 先缩图 + 生成缩略图再落库; 名字仍沿用原文件名(只去掉扩展名)
      const prepared = await prepareBackgroundFile(file);
      const id = (global.crypto && global.crypto.randomUUID)
        ? global.crypto.randomUUID()
        : 'bg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
      await global.db.live2d_backgrounds.put({
        id,
        name: file.name.replace(/\.[^.]+$/, ''),
        addedAt: Date.now(),
        blob: prepared.blob,
        thumb: prepared.thumb || null,
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
  }

  // v0.5.0 P15: initUI() 的调用点
  // ------------------------------------------------------------
  // initUI() 定义了、也导出了, 但【全项目没有任何地方调用它】→ 里面的
  // input / 列表绑定从来没跑过。这里补上调用点, 只跑一次 (两个分支互斥)。
  // 注意: initUI 内部所有 DOM 获取都是 if (el) 守卫的, 老屏幕
  // (#live2d-model-list / #live2d-bg-list 等) 已随旧页面删除, 当前版本
  // 这些分支都会静默跳过。AI 换背景走的是 applyBackgroundToCallScreen,
  // 完全不经过这里的任何绑定。
  // ------------------------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
  } else {
    initUI();
  }

  global.Live2DUI = {
    renderModelList,
    renderBackgroundList,
    handleModelUpload,
    handleBackgroundUpload,
    compressBackgroundImage,
    prepareBackgroundFile,
    makeBackgroundThumbnail,
    forgetBgThumb,
    applyBackgroundToCallScreen,
    applyActiveBackground,
    getActiveBackgroundIdForChat,
    setActiveBackgroundIdForChat,
    syncActiveModelToChat,
    initUI,
  };
})(typeof window !== 'undefined' ? window : globalThis);
