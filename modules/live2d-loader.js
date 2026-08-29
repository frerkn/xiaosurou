// Live2D 加载器 — PIXI v6.5.0 + pixi-live2d-display 0.4.0 + Cubism Core 4
// v0.3.0 回退到 330 v0.1.30 旧栈 (v8 + untitled 1.3.5 整库 PIXI v8 兼容 bug, renderOrder undefined)
// 跟之前一样挂在 window.Live2DLoader 上, API 不变, video-voice-call.js 无需改
// UMD 模式: PIXI + pixi-live2d-display 0.4.0 cubism4 都通过 <script> 加载, 暴露 window 全局

(function (global) {
  'use strict';

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
    if (!modelPath) return { success: false, error: new Error('modelPath is empty') };

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
      const model = await Live2DModel.from(modelPath, {
        autoInteract: false,
      });

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
      canvas._live2dApp.destroy(true, { children: true, texture: true });
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
    for (const [path, blob] of data.files.entries()) {
      const u = URL.createObjectURL(blob);
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

    // 3. 把改写后的 model3.json 转 blob URL
    const rewrittenBlob = new Blob([JSON.stringify(modelJson)], { type: 'application/json' });
    const rewrittenUrl = URL.createObjectURL(rewrittenBlob);
    blobUrls.push(rewrittenUrl);

    // 4. 挂到 canvas._live2dBlobUrls, dispose 时 revoke
    canvas._live2dBlobUrls = blobUrls;

    // 5. 调原 mountLive2D
    const result = await mountLive2D(canvas, rewrittenUrl, options);

    // 6. 如果 mount 失败, 立刻 revoke (成功后等 dispose 处理)
    if (!result.success) {
      canvas._live2dBlobUrls = null;
      blobUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
    }
    return result;
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
