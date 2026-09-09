// Live2D 缩略图【只读临时验证脚本】
// 用法: 复制下面整段 (IIFE 块), 粘贴到 330 浏览器 console 里执行
// 行为: 找 name === "小狼修改版" 的模型, 取第一张 texture, Canvas 缩到 max 256, 显示在右下角浮层
// 严格只读: 不 saveModel / 不 setActiveModelIdForChat / 不动 localStorage / 不动 IDB / 不调 Loader
// 透明背景: 用 image/png 输出, 不 fillRect 任何颜色, 原 PNG alpha 通道保持

(async () => {
  'use strict';

  // ===== 工具 =====
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function showOverlay(data, thumbUrl) {
    // 清理旧的
    const old = document.getElementById('__live2d_thumb_test__');
    if (old) old.remove();

    const wrap = document.createElement('div');
    wrap.id = '__live2d_thumb_test__';
    wrap.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:99999',
      'width:260px',
      'padding:12px',
      'background:linear-gradient(135deg,#fff5f9 0%,#ffffff 100%)',
      'border:1.5px solid rgba(255,142,179,.45)',
      'border-radius:14px',
      'box-shadow:0 8px 32px rgba(255,142,179,.25)',
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
      'color:#3a2a30',
    ].join(';');

    let escHandler = null;
    function close() {
      try { URL.revokeObjectURL(thumbUrl); } catch (e) {}
      wrap.remove();
      if (escHandler) document.removeEventListener('keydown', escHandler);
    }
    escHandler = (e) => { if (e.key === 'Escape') close(); };

    // checkerboard 背景, 让透明区域清晰可见
    wrap.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="font-size:13px;">${escapeHtml(data.modelName)} · 缩略图测试</strong>
        <button id="__live2d_thumb_close__" style="background:transparent;border:1px solid #ffb6c1;border-radius:6px;padding:3px 10px;font-size:11px;color:#b06a82;cursor:pointer;">关闭测试</button>
      </div>
      <div style="width:100%;height:180px;display:flex;align-items:center;justify-content:center;background:repeating-conic-gradient(#f5f5f5 0% 25%, #ffffff 0% 50%) 0 0/16px 16px;border-radius:8px;overflow:hidden;margin-bottom:8px;">
        <img src="${thumbUrl}" style="max-width:100%;max-height:100%;display:block;image-rendering:auto;" />
      </div>
      <div style="font-size:11px;line-height:1.7;color:#7a5a68;">
        原 texture: <strong>${data.originalWidth}×${data.originalHeight}</strong><br>
        缩略图: <strong>${data.thumbnailWidth}×${data.thumbnailHeight}</strong> (PNG, 透明)<br>
        Blob: <strong>${formatBytes(data.thumbnailBlobSize)}</strong><br>
        路径: <span style="word-break:break-all;">${escapeHtml(data.texturePath)}</span>
      </div>
      <div style="margin-top:8px;font-size:10px;color:#a08a98;">按 ESC 或点关闭按钮</div>
    `;

    document.body.appendChild(wrap);
    document.getElementById('__live2d_thumb_close__').onclick = close;
    document.addEventListener('keydown', escHandler);
  }

  // ===== 主流程 =====
  const result = {
    ok: false,
    error: null,
  };
  try {
    if (!window.Live2DStorage) {
      throw new Error('Live2DStorage 未加载, 请确认页面已打开并跑过 Live2D');
    }
    if (!window.Live2DStorage.listModels) {
      throw new Error('Live2DStorage.listModels 缺失');
    }
    if (!window.Live2DStorage.getModel) {
      throw new Error('Live2DStorage.getModel 缺失');
    }

    // A. 自动找"小狼"
    const models = await window.Live2DStorage.listModels();
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error('IDB 里没有任何模型');
    }
    // 改模型名: 实际 IDB 存的是 "小狼修改版", 不是 "小狼"
    const TARGET_MODEL_NAME = '小狼修改版';
    const target = models.find(x => x && x.name === TARGET_MODEL_NAME);
    if (!target) {
      throw new Error('找不到 name === "' + TARGET_MODEL_NAME + '", 现有: ' + models.map(x => x && x.name).filter(Boolean).join(', '));
    }

    // B. 读 model3.json + texture
    const data = await window.Live2DStorage.getModel(target.id);
    if (!data) throw new Error('getModel 返回 null, id = ' + target.id);
    if (!data.files || data.files.size === 0) throw new Error('model files 为空');

    const modelPath = data.modelPath;
    const modelJsonText = await data.files.get(modelPath).text();
    const modelJson = JSON.parse(modelJsonText);
    const refs = modelJson.FileReferences || modelJson.fileReferences;
    if (!refs || typeof refs !== 'object') {
      throw new Error('model3.json 无 FileReferences/fileReferences');
    }
    if (!Array.isArray(refs.Textures) || refs.Textures.length === 0) {
      throw new Error('model3.json 无 Textures 数组');
    }

    const firstTexRel = refs.Textures[0];
    const baseDir = modelPath.substring(0, modelPath.lastIndexOf('/') + 1);
    const texFullPath = baseDir + firstTexRel;
    const texBlob = data.files.get(texFullPath);
    if (!texBlob) {
      // 列一下能看到的 path 方便诊断
      const allPaths = Array.from(data.files.keys()).slice(0, 12).join('\n  ');
      throw new Error('texture 找不到, full path = ' + texFullPath + '\nrecord.files 包含:\n  ' + allPaths);
    }

    // C. 解码原图 (Image 兼容 iOS Safari 全版本, createImageBitmap 在 iOS 14.5+ 才有)
    const originalUrl = URL.createObjectURL(texBlob);
    let originalWidth = 0, originalHeight = 0;
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('Image decode 失败 (texture 太大或格式损坏)'));
        i.src = originalUrl;
      });
      originalWidth = img.naturalWidth;
      originalHeight = img.naturalHeight;
    } finally {
      try { URL.revokeObjectURL(originalUrl); } catch (e) {}
    }

    if (originalWidth === 0 || originalHeight === 0) {
      throw new Error('Image 解码后尺寸为 0, texture 可能损坏');
    }

    // C2. 缩到 max 256 (保持比例, 原图小的不放大)
    const MAX = 256;
    const ratio = Math.min(MAX / originalWidth, MAX / originalHeight, 1);
    const thumbW = Math.max(1, Math.round(originalWidth * ratio));
    const thumbH = Math.max(1, Math.round(originalHeight * ratio));

    // C3. Canvas 缩图, 保持透明 (PNG 输出, 不 fillRect)
    const canvas = document.createElement('canvas');
    canvas.width = thumbW;
    canvas.height = thumbH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // 关键: 不 fillRect 任何颜色, PNG alpha 通道保持透明
    // 用第二张临时图解码 (避免 Image 引用生命周期问题)
    const decodeUrl2 = URL.createObjectURL(texBlob);
    const drawImg = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('第二次 Image decode 失败'));
      i.src = decodeUrl2;
    });
    try {
      ctx.drawImage(drawImg, 0, 0, thumbW, thumbH);
    } finally {
      try { URL.revokeObjectURL(decodeUrl2); } catch (e) {}
    }

    // C4. toBlob → image/png (透明)
    const thumbBlob = await new Promise((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas.toBlob 返回 null')), 'image/png');
    });

    const thumbUrl = URL.createObjectURL(thumbBlob);

    const out = {
      ok: true,
      modelName: target.name,
      modelId: target.id,
      texturePath: texFullPath,
      originalWidth,
      originalHeight,
      thumbnailWidth: thumbW,
      thumbnailHeight: thumbH,
      thumbnailBlobSize: thumbBlob.size,
      thumbnailFormat: thumbBlob.type,
      note: 'PNG 透明背景 (未 fillRect, alpha 通道保持原图)',
    };

    console.log('%c[Live2D Thumbnail Test] 成功', 'color:#c2185b;font-weight:bold;', out);
    showOverlay(out, thumbUrl);
    result.ok = true;
    result.data = out;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.error('[Live2D Thumbnail Test] 失败:', msg, e);
    result.error = msg;
    // 失败时也弹个明显提示
    const old = document.getElementById('__live2d_thumb_test_err__');
    if (old) old.remove();
    const errBox = document.createElement('div');
    errBox.id = '__live2d_thumb_test_err__';
    errBox.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;max-width:340px;padding:12px;background:#fff0f0;border:1.5px solid #e88;border-radius:10px;font-family:-apple-system,sans-serif;font-size:12px;color:#a33;white-space:pre-wrap;';
    errBox.textContent = '❌ 缩略图测试失败:\n' + msg;
    document.body.appendChild(errBox);
    setTimeout(() => errBox.remove(), 12000);
  }
  return result;
})();
