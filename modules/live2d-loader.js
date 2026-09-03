// Live2D 加载器 — PIXI v6.5.0 + pixi-live2d-display 0.4.0 + Cubism Core 4
// v0.3.0 回退到 330 v0.1.30 旧栈 (v8 + untitled 1.3.5 整库 PIXI v8 兼容 bug, renderOrder undefined)
// 跟之前一样挂在 window.Live2DLoader 上, API 不变, video-voice-call.js 无需改
// UMD 模式: PIXI + pixi-live2d-display 0.4.0 cubism4 都通过 <script> 加载, 暴露 window 全局

(function (global) {
  'use strict';

  // [TEMPORARY_DIAG] iPhone Safari / PWA 无 console, 把诊断日志直接渲染到屏幕 (纹理全黑定位 v2)
  function __live2dDiagLog(tag, msg) {
    try { console.warn('[DIAG]' + tag + ' ' + msg); } catch (e) {}
    try {
      var KEY = '__live2d_diag_panel_v2__';
      var panel = document.getElementById(KEY);
      if (!panel) {
        panel = document.createElement('div');
        panel.id = KEY;
        panel.style.cssText = 'position:fixed;top:8px;left:8px;right:8px;z-index:2147483647;max-height:50vh;overflow:hidden;padding:6px 8px;background:rgba(0,0,0,.88);color:#fff;font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;border-radius:6px;border:1px solid #666;box-sizing:border-box;-webkit-overflow-scrolling:touch;word-break:break-all;white-space:pre-wrap';
        var hdr = document.createElement('div');
        hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding-bottom:4px;margin-bottom:4px;border-bottom:1px solid #444;gap:6px';
        var t = document.createElement('strong'); t.textContent = 'LIVE2D DIAG v2'; t.style.cssText = 'color:#ffeb3b;font-size:11px;flex:1 1 auto';
        var closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.cssText = 'background:#333;color:#fff;border:1px solid #555;border-radius:4px;padding:0 8px;font:14px/1.4 inherit;cursor:pointer;flex:0 0 auto;min-width:28px;min-height:28px';
        closeBtn.onclick = function () { try { panel.remove(); } catch (e) {} };
        hdr.appendChild(t); hdr.appendChild(closeBtn);
        var log = document.createElement('div');
        log.id = '__live2d_diag_log_v2__';
        log.style.cssText = 'overflow-y:auto;max-height:40vh;white-space:pre-wrap;word-break:break-all';
        // 底部工具条: 复制按钮 + 滚顶
        var footer = document.createElement('div');
        footer.style.cssText = 'display:flex;gap:6px;padding-top:6px;margin-top:6px;border-top:1px solid #444';
        var copyBtn = document.createElement('button');
        copyBtn.textContent = '📋 复制全部';
        copyBtn.style.cssText = 'background:#1e7d34;color:#fff;border:1px solid #2ea64a;border-radius:4px;padding:6px 10px;font:12px/1.4 inherit;cursor:pointer;flex:1 1 auto;min-height:32px';
        copyBtn.onclick = function (ev) {
          ev && ev.preventDefault && ev.preventDefault();
          ev && ev.stopPropagation && ev.stopPropagation();
          try {
            var logEl2 = document.getElementById('__live2d_diag_log_v2__');
            var text = logEl2 ? (logEl2.innerText || logEl2.textContent || '') : '';
            var ok = false;
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(function () { copyBtn.textContent = '✓ 已复制'; }).catch(function () { fallbackCopy(text, copyBtn); });
              ok = true;
            }
            if (!ok) fallbackCopy(text, copyBtn);
          } catch (e) { copyBtn.textContent = '复制失败'; }
        };
        function fallbackCopy(text, btn) {
          try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
            document.body.appendChild(ta);
            ta.focus(); ta.select();
            var succ = document.execCommand && document.execCommand('copy');
            document.body.removeChild(ta);
            btn.textContent = succ ? '✓ 已复制' : '复制失败,请长按文本';
          } catch (e) { btn.textContent = '复制失败'; }
        }
        var topBtn = document.createElement('button');
        topBtn.textContent = '↑ 顶';
        topBtn.style.cssText = 'background:#444;color:#fff;border:1px solid #666;border-radius:4px;padding:6px 10px;font:12px/1.4 inherit;cursor:pointer;flex:0 0 auto;min-height:32px';
        topBtn.onclick = function () { try { log.scrollTop = 0; } catch (e) {} };
        footer.appendChild(copyBtn); footer.appendChild(topBtn);
        panel.appendChild(hdr); panel.appendChild(log); panel.appendChild(footer);
        (document.body || document.documentElement).appendChild(panel);
      }
      var logEl = document.getElementById('__live2d_diag_log_v2__');
      var line = document.createElement('div');
      line.textContent = tag + ' ' + msg;
      line.style.cssText = 'padding:1px 0;color:#fff';
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    } catch (e) {}
  }

  function getPixi() {
    return global.PIXI || null;
  }
  function getLive2DModel() {
    var p = global.PIXI;
    if (!p || !p.live2d) return null;
    return p.live2d.Live2DModel || null;
  }

  async function mountLive2D(canvas, modelPath, options) {
    options = options || {};
    if (!canvas) return { success: false, error: new Error('canvas is null') };
    // v0.5.0 P2.4: 接受 string (URL) 或 object (改写后的 model3.json JS 对象, 走糯米粉做法跳过 transient blob)
    if (!modelPath || (typeof modelPath !== 'string' && typeof modelPath !== 'object')) {
      return { success: false, error: new Error('modelPath is empty') };
    }

    try {
      var PIXI = getPixi();
      var Live2DModel = getLive2DModel();
      if (!PIXI) {
        return { success: false, error: new Error('window.PIXI not loaded — check pixi.min.js script tag') };
      }
      if (!Live2DModel) {
        return { success: false, error: new Error('window.PIXI.live2d.Live2DModel not loaded — check pixi-live2d-display 0.4.0 cubism4.min.js script tag') };
      }

      const parent = canvas.parentElement;
      const w = (parent && parent.clientWidth) || canvas.clientWidth || 300;
      const h = (parent && parent.parentElement && parent.parentElement.clientHeight) || canvas.clientHeight || 400;

      canvas.style.position = 'absolute';
      canvas.style.top = '0';
      canvas.style.left = '0';
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      canvas.style.display = 'block';
      canvas.style.zIndex = '99999';
      canvas.style.pointerEvents = 'none';

      // 监听 WebGL context lost
      canvas.addEventListener('webglcontextlost', function (e) {
        e.preventDefault();
        console.warn('[Live2D] WebGL context LOST — GPU 资源可能耗尽');
      }, false);
      canvas.addEventListener('webglcontextrestored', function () {
        console.log('[Live2D] WebGL context RESTORED');
      }, false);

      // v0.5.0 P1.6: iOS PWA mode 切到管理页时 canvas 还是 0x0 (clientWidth=0), 等 1 帧让 layout 完成
      // 否则 PIXI.Application init 时 createElement('canvas') 0x0 + iOS PWA WebGL 限制 -> "Network error"
      await new Promise(r => requestAnimationFrame(r));
      // PIXI v6 Application init 是同步的 (v8 才改异步)
      var app = new PIXI.Application({
        view: canvas,
        width: w,
        height: h,
        backgroundAlpha: 0,
        autoStart: true,
        antialias: true,
        resolution: global.devicePixelRatio || 1,
        autoDensity: true,
      });

      // 0.4.0 用 autoInteract: false 避免它自己接管鼠标
      // [TEMPORARY_DIAG] 在 Live2DModel.from 调用之前包一层 PIXI.Texture.fromURL + model.internalModel.settings.resolveURL
      //   - PIXI.Texture.fromURL: 库 0.4.0 内部用它加载 texture, 包它能拿到"传给 PIXI 的最终 URL"
      //   - model 内 settings.resolveURL 是在 model 创建后再包 (见下)
      // 用完删除.
      try {
        var PIXI2 = global.PIXI;
        var Tex = PIXI2 && PIXI2.Texture;
        if (Tex && typeof Tex.fromURL === 'function' && !Tex.__mavisFromURLHooked) {
          var origFromURL = Tex.fromURL;
          Tex.fromURL = function (u, options) {
            var inUrl = String(u);
            var ret;
            try { ret = origFromURL.apply(this, arguments); } catch (e) { throw e; }
            try { __live2dDiagLog('[TEXFROMURL]', 'in=' + inUrl.substring(0, 120) + ' | hasColon=' + (/^blob:https:\/\//.test(inUrl) ? 'OK' : 'BROKEN')); } catch (e) {}
            return ret;
          };
          Tex.__mavisFromURLHooked = true;
        }
      } catch (e) { try { __live2dDiagLog('[TEXFROMURL]', 'hook err=' + (e && e.message || e)); } catch (_) {} }
      const model = await Live2DModel.from(modelPath, {
        autoInteract: false,
      });

      // [TEMPORARY_DIAG] 拿到 model 后, 立即包 model.internalModel.settings.resolveURL
      //   - 库 0.4.0 用 settings.resolveURL(textureRelPath) 解析相对路径
      //   - 我们已经在 fetchLoader 绕过 blob URL, 但 textures 路径不走 fetchLoader
      //   - 直接 hook 它的 resolveURL, 看入库前 URL 是否已被破坏
      try {
        var im = model && model.internalModel;
        var settings = im && im.settings;
        if (settings && typeof settings.resolveURL === 'function' && !settings.__mavisResolveURLHooked) {
          var origResolveURL = settings.resolveURL;
          settings.resolveURL = function (rel) {
            var inRel = String(rel);
            var out;
            try { out = origResolveURL.call(this, rel); } catch (e) { throw e; }
            try { __live2dDiagLog('[SETTINGS_RESOLVEURL]', 'in=' + inRel.substring(0, 120) + ' | out=' + String(out).substring(0, 120) + ' | hasColon=' + (/^blob:https:\/\//.test(String(out)) ? 'OK' : 'BROKEN')); } catch (e) {}
            return out;
          };
          settings.__mavisResolveURLHooked = true;
        }
      } catch (e) { try { __live2dDiagLog('[SETTINGS_RESOLVEURL]', 'hook err=' + (e && e.message || e)); } catch (_) {} }

      // bridge: 0.4.0 + 老 Cubism 4 moc3 v3 模型的 drawables.renderOrders 字段可能未初始化
      // (导致 PIXI 渲染时 renderOrder[i] undefined 报错)
      // 从糯米 utils/live2dCore.ts:106 bridgeCubism6RenderOrders 抄过来, PIXI v6 + 0.4.0 兼容版
      try {
        const internal = model && model.internalModel;
        const rawModel = internal && internal.coreModel && internal.coreModel._model;
        const drawables = rawModel && rawModel.drawables;
        if (drawables && !drawables.renderOrders) {
          const renderOrders = (rawModel.getRenderOrders && rawModel.getRenderOrders()) || rawModel.renderOrders;
          if (renderOrders) {
            const drawableCount = Number(drawables.count != null ? drawables.count : renderOrders.length);
            drawables.renderOrders = typeof renderOrders.subarray === 'function'
              ? renderOrders.subarray(0, drawableCount)
              : renderOrders;
            // bridge: drawables.renderOrders 已补
          }
        }
      } catch (bridgeErr) {
        // bridge 跳过
      }

      app.stage.addChild(model);

      // [TEMPORARY_DIAG] 纹理全黑定位 v2:
      // 立刻/100ms/500ms/1500ms 4 个时刻读 model.textures[i].baseTexture 状态
      // + 同一 texture blob URL 独立 Image 解码 + WebGL texImage2D 测试
      // + GL context / getError / isContextLost
      // 只读, 不动 PIXI/库, 用完删除.
      (function () {
        try {
          var ts = (model && model.textures) || [];
          var refs = (model && model.internalModel && model.internalModel.settings &&
                     (model.internalModel.settings.fileReferences || model.internalModel.settings.FileReferences)) || null;
          var texArr = (refs && (refs.Textures || refs.textures)) || [];
          __live2dDiagLog('[INIT]', 'textures=' + ts.length + ' | texArr=' + texArr.length + ' | model.anchorX=' + (model.anchor && model.anchor.x) + ' | w=' + model.width + ' | h=' + model.height);
          // 立即
          for (var ti = 0; ti < ts.length; ti++) {
            var t = ts[ti];
            var bt = t && t.baseTexture;
            var r = bt && bt.resource;
            __live2dDiagLog('[BTX_T0]', 'i=' + ti + ' | valid=' + (bt && bt.valid) + ' | w=' + (bt && bt.width) + ' | h=' + (bt && bt.height) + ' | loaded=' + (bt && bt._isLoading) + ' | src=' + (r && r.url ? String(r.url).substring(0, 60) : (r && r.source && r.source.tagName ? '<' + r.source.tagName + '>' : (r && r.source ? String(r.source).substring(0, 60) : 'null'))) + ' | crossOrigin=' + (r && r.crossOrigin));
          }
          // GL context / 错误
          try {
            var gl = (canvas.getContext && (canvas.getContext('webgl2') || canvas.getContext('webgl'))) || null;
            __live2dDiagLog('[GL]', 'got=' + !!gl + ' | lost=' + (gl && gl.isContextLost()) + ' | err=' + (gl ? gl.getError() : -1));
          } catch (e) { __live2dDiagLog('[GL]', 'err=' + (e && e.message || e)); }
          // 100/500/1500ms 后再读一次
          [100, 500, 1500].forEach(function (delay) {
            setTimeout(function () {
              try {
                for (var ti = 0; ti < ts.length; ti++) {
                  var t = ts[ti];
                  var bt = t && t.baseTexture;
                  var r = bt && bt.resource;
                  __live2dDiagLog('[BTX_T' + delay + ']', 'i=' + ti + ' | valid=' + (bt && bt.valid) + ' | w=' + (bt && bt.width) + ' | h=' + (bt && bt.height) + ' | loaded=' + (bt && bt._isLoading) + ' | hasSource=' + !!(r && r.source));
                }
                var gl2 = (canvas.getContext && (canvas.getContext('webgl2') || canvas.getContext('webgl'))) || null;
                if (gl2) __live2dDiagLog('[GL_T' + delay + ']', 'lost=' + gl2.isContextLost() + ' | err=' + gl2.getError());
              } catch (e) { __live2dDiagLog('[BTX_T' + delay + ']', 'err=' + (e && e.message || e)); }
            }, delay);
          });
          // 独立 Image + WebGL texImage2D (绕开 PIXI)
          for (var ri = 0; ri < texArr.length; ri++) {
            (function (u, idx) {
              var img = new Image();
              var done = false;
              var t0 = Date.now();
              img.onload = function () {
                done = true;
                __live2dDiagLog('[IMG]', 'i=' + idx + ' | nw=' + img.naturalWidth + ' | nh=' + img.naturalHeight + ' | dw=' + img.width + ' | dh=' + img.height + ' | ms=' + (Date.now() - t0));
                try {
                  var c = document.createElement('canvas');
                  var gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
                  if (gl) {
                    var tex = gl.createTexture();
                    gl.bindTexture(gl.TEXTURE_2D, tex);
                    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
                    __live2dDiagLog('[GLT]', 'i=' + idx + ' | err=' + gl.getError() + ' | lost=' + gl.isContextLost());
                    gl.deleteTexture(tex);
                  } else { __live2dDiagLog('[GLT]', 'i=' + idx + ' | no-webgl'); }
                } catch (e) { __live2dDiagLog('[GLT]', 'i=' + idx + ' | err=' + (e && e.message || e)); }
              };
              img.onerror = function () { __live2dDiagLog('[IMG]', 'i=' + idx + ' | FAILED | url=' + String(u).substring(0, 60)); };
              setTimeout(function () { if (!done) __live2dDiagLog('[IMG]', 'i=' + idx + ' | TIMEOUT 8s'); }, 8000);
              img.src = u;
            })(texArr[ri], ri);
          }
        } catch (e) { __live2dDiagLog('[DIAG]', 'outer err=' + (e && e.message || e)); }
      })();

      // v0.1.4 行为: 等几帧让 internal model 完成 setup
      let frameWait = 0;
      for (let fi = 0; fi < 5; fi++) {
        await new Promise(r => requestAnimationFrame(r));
        frameWait = fi + 1;
        if (model.width > 0 && model.height > 0) break;
      }

      const defaultScale = options.scale != null ? options.scale : 0.4;
      let finalScale = defaultScale;
      if (model.width > 0 && model.height > 0) {
        const fitScale = Math.min((w * 0.7) / model.width, (h * 0.7) / model.height);
        finalScale = Math.min(fitScale, defaultScale * 5);
        if (fitScale > defaultScale) finalScale = defaultScale;
      }
      model.scale.set(finalScale, finalScale);
      model.anchor.set(0.5, 0.5);
      model.x = app.renderer.width / 2;
      model.y = app.renderer.height / 2;
      if (options.x !== undefined) model.x = options.x;
      if (options.y !== undefined) model.y = options.y;

      if (options.autoStartIdle !== false) {
        try {
          if (typeof model.motion === 'function') {
            model.motion('Idle');
          } else if (model.internalModel && model.internalModel.motionManager) {
            const mm = model.internalModel.motionManager;
            if (typeof mm.startMotion === 'function') mm.startMotion('Idle');
            else if (typeof mm.play === 'function') mm.play('Idle');
          }
        } catch (e) {
          // Idle 组不存在, 静默忽略
        }
      }

      canvas._live2dApp = app;
      canvas._live2dModel = model;

      console.log('[Live2D v0.3.0] mounted:', modelPath, 'size:', w, 'x', h, 'frames:', frameWait);
      return { success: true, app, model };
    } catch (err) {
      console.warn('[Live2D] mount failed:', err, 'path:', modelPath);
      // 清理残留 PIXI Application
      if (canvas._live2dApp) {
        try { canvas._live2dApp.destroy(true, { children: true, texture: true }); } catch (e) {}
        canvas._live2dApp = null;
      }
      return { success: false, error: err };
    }
  }

  function disposeLive2D(canvas) {
    if (!canvas || !canvas._live2dApp) return false;
    try {
      // v0.5.0 P1.4: destroy(false, ...) 第一个参数 removeView=false, 不从 DOM 移除 canvas 元素
      // 之前 destroy(true, ...) 会在切模型时把 canvas 从 DOM detach, 下次 selectModel 时
      // screenEl.querySelector('[data-role="canvas"]') 找不到 (元素已从 DOM 移除)
      // user 报 "删除模型后立即上传新模型预览报 canvas DOM 元素找不到" 真凶就是这个
      canvas._live2dApp.destroy(false, { children: true, texture: true });
    } catch (e) {
      console.warn('[Live2D] dispose error:', e);
    }
    canvas._live2dApp = null;
    canvas._live2dModel = null;
    // P1.5 revoke IDB 模式创建的 blob URL
    if (Array.isArray(canvas._live2dBlobUrls)) {
      canvas._live2dBlobUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
      canvas._live2dBlobUrls = null;
    }
    return true;
  }

  function playMotion(canvas, group, index) {
    if (group == null) group = 'Idle';
    if (index == null) index = 0;
    const model = canvas && canvas._live2dModel;
    if (!model) return false;
    try {
      if (typeof model.motion === 'function') {
        model.motion(group, index);
        return true;
      }
      if (model.internalModel && model.internalModel.motionManager) {
        const mm = model.internalModel.motionManager;
        if (typeof mm.startMotion === 'function') { mm.startMotion(group, index); return true; }
        if (typeof mm.play === 'function') { mm.play(group, index); return true; }
      }
    } catch (e) {
      console.warn('[Live2D] playMotion failed:', e);
    }
    return false;
  }

  function setExpression(canvas, expressionId) {
    const model = canvas && canvas._live2dModel;
    if (!model) return false;
    try {
      if (!expressionId) {
        const em = model.internalModel && model.internalModel.motionManager && model.internalModel.motionManager.expressionManager;
        if (em && typeof em.resetExpression === 'function') {
          em.resetExpression();
          return true;
        }
        return false;
      }
      model.internalModel.expressionManager.setExpression(expressionId);
      return true;
    } catch (e) {
      console.warn('[Live2D] setExpression failed:', e);
      return false;
    }
  }

  function isMounted(canvas) {
    return !!(canvas && canvas._live2dApp);
  }

  // P1.5 从 IndexedDB 加载模型 — 内部把 files Map 改写为 blob URL, 调原 mountLive2D
  // 依赖: window.Live2DStorage.getModel(modelId) 返回 { files: Map<path, Blob>, modelPath, ... }
  // disposeLive2D 时会自动 revoke 跟这个 canvas 关联的所有 _live2dBlobUrls
  async function mountLive2DFromIDB(canvas, modelId, options) {
    if (!canvas) return { success: false, error: new Error('canvas is null') };
    if (!modelId) return { success: false, error: new Error('modelId is empty') };
    if (!global.Live2DStorage) return { success: false, error: new Error('Live2DStorage not loaded') };

    let data;
    try {
      data = await global.Live2DStorage.getModel(modelId);
    } catch (e) {
      return { success: false, error: new Error('IDB read failed: ' + (e.message || e)) };
    }
    if (!data) return { success: false, error: new Error('model not found in IDB: ' + modelId) };
    if (!data.files || data.files.size === 0) return { success: false, error: new Error('model has no files') };

    // 1. 给每个 file 建 blob URL
    const urlMap = new Map();
    const blobUrls = [];
    // v0.5.0 P2.6: 纹理 Blob MIME 兜底 (抄自糯米机 createLive2DRuntimeTextureUrl/sniffImageMime)
    // uploader 用 JSZip.async('blob') 取 PNG/JPG/WebP 时 type 是空串, blob URL 也无 MIME,
    // iOS PWA 给 <img> 解码延迟/失败 → 模型全黑剪影. 这里按文件头嗅探真实 MIME 并 re-type.
    // 只对纹理后缀做, moc3/json 不需要 (走 fetchLoader, 不靠 MIME).
    const isTexturePath = (p) => /\.(png|jpe?g|webp)$/i.test(p || '');
    async function ensureTextureMime(blob) {
      // 已有正确 MIME 直接放行
      if (blob && (blob.type === 'image/png' || blob.type === 'image/jpeg' || blob.type === 'image/webp')) {
        return blob;
      }
      try {
        const sniff = await blob.slice(0, 16).arrayBuffer();
        const u8 = new Uint8Array(sniff);
        let mime = '';
        // PNG: 89 50 4E 47
        if (u8.length >= 4 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) mime = 'image/png';
        // JPEG: FF D8
        else if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xD8) mime = 'image/jpeg';
        // WebP: RIFF....WEBP
        else if (u8.length >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46
                 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) mime = 'image/webp';
        if (mime) {
          const ret = blob.slice(0, blob.size, mime);
          // [TEMPORARY_DIAG] 记录 re-type 后的实际 MIME
          try { __live2dDiagLog('[BLOB_OUT]', 'size=' + (blob && blob.size) + ' | sniffed=' + mime + ' | out.type=' + ret.type); } catch (e) {}
          return ret;
        }
      } catch (e) { /* sniff 失败保留原 blob */ }
      return blob;
    }
    for (const [path, blob] of data.files.entries()) {
      // [TEMPORARY_DIAG] 纹理路径: 记录原 Blob type/size/头字节 (看是不是 type="")
      if (isTexturePath(path)) {
        try {
          const head = await blob.slice(0, 8).arrayBuffer();
          const hu8 = new Uint8Array(head);
          const hex = Array.prototype.map.call(hu8, function (b) { return b.toString(16).padStart(2, '0'); }).join(' ');
          __live2dDiagLog('[BLOB_IN]', 'path=' + path + ' | size=' + blob.size + ' | type=' + JSON.stringify(blob.type) + ' | head=' + hex);
        } catch (e) { __live2dDiagLog('[BLOB_IN]', 'path=' + path + ' | err=' + (e && e.message || e)); }
      }
      const finalBlob = isTexturePath(path) ? await ensureTextureMime(blob) : blob;
      const u = URL.createObjectURL(finalBlob);
      if (isTexturePath(path)) {
        __live2dDiagLog('[CREATE]', 'path=' + path + ' | blobURL.prefix=' + u.substring(0, 40) + ' | finalBlob.type=' + JSON.stringify(finalBlob.type));
      }
      urlMap.set(path, u);
      blobUrls.push(u);
    }

    // 2. 读 + 改写 model3.json: file 引用全部变绝对 blob URL
    let modelJson;
    try {
      const txt = await data.files.get(data.modelPath).text();
      modelJson = JSON.parse(txt);
    } catch (e) {
      blobUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
      return { success: false, error: new Error('model3.json parse failed: ' + (e.message || e)) };
    }
    const baseDir = data.modelPath.substring(0, data.modelPath.lastIndexOf('/') + 1);
    const resolveBlob = (rel) => {
      if (!rel) return rel;
      // 如果本来就是 blob URL, 不动
      if (rel.startsWith('blob:')) return rel;
      const full = baseDir + rel;
      return urlMap.get(full) || rel;
    };
    const refs = (modelJson.FileReferences || modelJson.fileReferences);
    if (refs) {
      if (refs.Moc) refs.Moc = resolveBlob(refs.Moc);
      if (refs.DisplayInfo) refs.DisplayInfo = resolveBlob(refs.DisplayInfo);
      if (refs.Physics) refs.Physics = resolveBlob(refs.Physics);
      if (refs.Pose) refs.Pose = resolveBlob(refs.Pose);
      if (Array.isArray(refs.Textures)) refs.Textures = refs.Textures.map(resolveBlob);
      if (refs.Motions && typeof refs.Motions === 'object') {
        for (const groupName of Object.keys(refs.Motions)) {
          const list = refs.Motions[groupName];
          if (Array.isArray(list)) {
            for (const m of list) {
              if (m && m.File) m.File = resolveBlob(m.File);
            }
          }
        }
      }
      if (Array.isArray(refs.Expressions)) {
        for (const e of refs.Expressions) {
          if (e && e.File) e.File = resolveBlob(e.File);
        }
      }
    }

    // 3. v0.5.0 P2.4: 不再把改写后的 model3.json 包成 transient Blob + URL.createObjectURL
    //    (transient blob URL + iOS Safari XMLHttpRequest 已知有 NetworkError quirk, 见报告)
    //    改为: 补库 ModelSettings 构造需要的 .url 字段, 然后直接把 JS 对象喂给 Live2DModel.from()
    //    库内部 urlToJSON middleware 看到 source 是 object → 跳过 XHR fetch model3.json
    //    后续 setupEssentials/createInternalModel 还是会用 XHRLoader 抓 moc3/textures, 但这些都是 IDB 长期存的 Blob (well-tested)
    modelJson.url = 'live2d-package/model.model3.json';

    // 4. 挂到 canvas._live2dBlobUrls, dispose 时 revoke (只含 IDB 散文件 blob URL, 不再含 rewrittenUrl)
    canvas._live2dBlobUrls = blobUrls;

    // 5. 调原 mountLive2D (传改写后的 JS 对象, 不再传 blob URL 字符串)
    const result = await mountLive2D(canvas, modelJson, options);

    // 6. 如果 mount 失败, 立刻 revoke (成功后等 dispose 处理)
    if (!result.success) {
      canvas._live2dBlobUrls = null;
      blobUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
    }
    return result;
  }

  // [TEMPORARY_DIAG] URL 变换追踪: 找出 blob:https:// → blob:https// 这一步
  // 库 0.4.0 内部走 settings.resolveURL(blobURL) → 最终 PIXI.Texture.fromURL
  // 用完删除. 不修任何逻辑.
  function __live2dInstallUrlHook() {
    var PIXIu = global.PIXI && global.PIXI.utils;
    var candidates = [];
    if (PIXIu) {
      if (PIXIu.Url) candidates.push(['PIXI.utils.Url', PIXIu.Url]);
      if (PIXIu.url) candidates.push(['PIXI.utils.url', PIXIu.url]);
    }
    if (candidates.length === 0) return false;
    candidates.forEach(function (c) {
      var name = c[0], obj = c[1];
      if (!obj) return;
      try {
        if (obj.prototype && obj.prototype.resolve && !obj.prototype.__mavisUrlResolveHooked) {
          var origP = obj.prototype.resolve;
          obj.prototype.resolve = function (base) {
            var inUrl = String(base);
            var out;
            try { out = origP.apply(this, arguments); } catch (e) { throw e; }
            try { __live2dDiagLog('[URLRES_PROTO]', name + ' | in=' + inUrl.substring(0, 120) + ' | out=' + String(out).substring(0, 120) + ' | hasColon=' + (/^blob:https:\/\//.test(String(out)) ? 'OK' : 'BROKEN')); } catch (e) {}
            return out;
          };
          obj.prototype.__mavisUrlResolveHooked = true;
        }
        if (typeof obj.resolve === 'function' && !obj.__mavisUrlResolveStaticHooked) {
          var origS = obj.resolve;
          obj.resolve = function (base) {
            var inUrl = String(base);
            var out;
            try { out = origS.apply(this, arguments); } catch (e) { throw e; }
            try { __live2dDiagLog('[URLRES_STATIC]', name + ' | in=' + inUrl.substring(0, 120) + ' | out=' + String(out).substring(0, 120) + ' | hasColon=' + (/^blob:https:\/\//.test(String(out)) ? 'OK' : 'BROKEN')); } catch (e) {}
            return out;
          };
          obj.__mavisUrlResolveStaticHooked = true;
        }
      } catch (e) {}
    });
    return true;
  }
  if (!__live2dInstallUrlHook()) {
    var __urlHookRetries = 0;
    var __urlHookTimer = setInterval(function () {
      __urlHookRetries += 1;
      if (__live2dInstallUrlHook() || __urlHookRetries >= 60) clearInterval(__urlHookTimer);
    }, 100);
  }

  // ── v0.5.0 修复: iOS Safari 「blob URL + XMLHttpRequest」不可用 ──
  // pixi-live2d-display 0.4.0 用自带 XHRLoader (XMLHttpRequest) 读取
  // moc3 / physics / pose / motion / expression, 而 iOS Safari 对 blob: URL 的 XHR
  // 返回 status=0 且 response 为空, 导致用户上传模型在 iPhone Safari 上加载失败.
  // 这里用库官方暴露的 Live2DLoader.middlewares 扩展点, 把真正承担"网络读取"的那一层
  // 从 XHR 换成 fetch (iOS Safari 的 fetch 能正常读 blob: URL).
  // 不改库版本 / 不改存储 / 不改 UI / 不做全局 XMLHttpRequest monkey patch.
  function installFetchLive2DResourceLoader() {
    // (1) PIXI / PIXI.live2d 尚未初始化时静默返回, 不报错
    var l2d = global.PIXI && global.PIXI.live2d;
    var L2D = l2d && l2d.Live2DLoader;
    if (!L2D || !Array.isArray(L2D.middlewares)) return false;
    // (2) 不重复安装
    if (L2D.__mavisFetchLoaderInstalled) return true;

    var fetchLoader = function (payload, next) {
      if (!payload || !payload.url) { return next(); }
      // 关键修复: 库的 settings.resolveURL 会把 blob:https://... 错误转成 blob:https//...
      // (库内部把 blob: 后的整段当 origin, URL 解析器把"://"的冒号规范化掉了).
      // 对 blob: URL 必须原样用 payload.url, 不走 resolveURL.
      var url;
      if (typeof payload.url === 'string' && payload.url.indexOf('blob:') === 0) {
        url = payload.url;
      } else if (payload.settings && typeof payload.settings.resolveURL === 'function') {
        url = payload.settings.resolveURL(payload.url);
      } else {
        url = payload.url;
      }
      if (!url) { return next(); }
      return fetch(url).then(function (resp) {
        // 原 XHRLoader 在 load 时接受 status 0 或 200, 这里保持一致, 避免误判.
        if (!resp.ok && resp.status !== 0) {
          throw new Error('资源加载失败 (HTTP ' + resp.status + '): ' + url);
        }
        // (8) 正确处理 json / blob / arraybuffer
        if (payload.type === 'json') {
          return resp.json().then(function (j) { payload.result = j; return next(); });
        }
        if (payload.type === 'blob') {
          return resp.blob().then(function (b) { payload.result = b; return next(); });
        }
        // 默认按 arraybuffer 二进制处理 (moc3 / 其他二进制资源)
        return resp.arrayBuffer().then(function (buf) { payload.result = buf; return next(); });
      }).catch(function (err) {
        throw new Error('资源加载失败: ' + url + ' (' + ((err && err.message) || err) + ')');
      });
    };

    // (11) 不粗暴覆盖: Live2DLoader.middlewares 本质是"资源读取链",
    //      其承担网络读取的那一项就是 XHRLoader.loader (0.4.0 中即第 1 项).
    //      这里逐项仅替换"网络读取"函数项, 其余 middleware 一律保留.
    //      优先精确匹配 XHRLoader.loader, 找不到时才退回"替换首个函数 middleware".
    var XHRLoaderFn = (l2d.XHRLoader && typeof l2d.XHRLoader.loader === 'function')
      ? l2d.XHRLoader.loader
      : null;
    var replaced = false;
    var newMiddlewares = L2D.middlewares.map(function (mw) {
      var isNetworkLoader = (mw === XHRLoaderFn) || (!XHRLoaderFn && typeof mw === 'function' && !replaced);
      if (!replaced && isNetworkLoader) {
        replaced = true;
        return fetchLoader;
      }
      return mw;
    });
    // 兜底: 理论上 Live2DLoader.middlewares 至少含 XHRLoader.loader; 万一为空则整体设为 fetchLoader
    if (!replaced) newMiddlewares = [fetchLoader];

    // (10) 只作用于 Live2DLoader 的资源加载链, 不修改全局 fetch, 不影响页面其他 fetch
    L2D.middlewares = newMiddlewares;
    L2D.__mavisFetchLoaderInstalled = true;
    console.info('[Live2D v0.5.0] 资源加载已由 XHR 切换为 fetch (绕开 iOS Safari blob+XHR 不可用)');
    return true;
  }

  // (10) 安全安装: PIXI.live2d 就绪则立即生效; 未就绪则静默重试, 不报错, 不重复安装
  if (installFetchLive2DResourceLoader()) {
    // 已安装
  } else {
    var _live2dRetries = 0;
    var _live2dTimer = setInterval(function () {
      _live2dRetries += 1;
      if (installFetchLive2DResourceLoader() || _live2dRetries >= 60) {
        clearInterval(_live2dTimer);
      }
    }, 100);
  }

  global.Live2DLoader = {
    mountLive2D,
    mountLive2DFromIDB,
    disposeLive2D,
    playMotion,
    setExpression,
    isMounted,
  };
})(typeof window !== 'undefined' ? window : globalThis);
