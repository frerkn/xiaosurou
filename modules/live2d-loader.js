// Live2D 加载器 - UMD 模式 (PIXI v6 + pixi-live2d-display 0.4.0)
// 不用 ESM dynamic import, 不用 import map
// window.PIXI 全局 + window.PIXI.live2d.Live2DModel 由 index.html <script> 标签引入
// 设计原则: 纯工具, 不耦合视频通话/角色设置/任何上层逻辑
// 加载失败返回 {success: false, error}, 不抛异常, 让调用方决定 fallback

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

  /**
   * 挂载 Live2D 模型到指定 canvas
   * @param {HTMLCanvasElement} canvas - 目标 canvas 元素
   * @param {string} modelPath - model3.json 的相对路径
   * @param {Object} options - { scale, x, y, motionGroup, autoStartIdle }
   * @returns {Promise<{success: boolean, app?: any, model?: any, error?: Error}>}
   */
  async function mountLive2D(canvas, modelPath, options) {
    options = options || {};
    if (!canvas) {
      return { success: false, error: new Error('canvas is null') };
    }
    if (!modelPath) {
      return { success: false, error: new Error('modelPath is empty') };
    }
    var PIXI = getPixi();
    var Live2DModel = getLive2DModel();
    if (!PIXI) {
      return { success: false, error: new Error('window.PIXI not loaded — check pixi.min.js script tag') };
    }
    if (!Live2DModel) {
      return { success: false, error: new Error('window.PIXI.live2d.Live2DModel not loaded — check pixi-live2d-display index.min.js script tag') };
    }

    try {
      // 容器尺寸 - 如果父元素还没布局, 给个默认
      var parent = canvas.parentElement;
      var w = (parent && parent.clientWidth) || canvas.clientWidth || 300;
      var h = (parent && parent.parentElement && parent.parentElement.clientHeight) || canvas.clientHeight || 400;

      // v0.1.3: 显式设置 canvas style 尺寸 (PIXI 只设 width/height 属性, 不设 CSS 尺寸)
      // 不显式设 style 的话 canvas 是 inline 300x150, 模型被裁掉或看不见
      canvas.style.position = 'absolute';
      canvas.style.top = '0';
      canvas.style.left = '0';
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      canvas.style.display = 'block';
      canvas.style.zIndex = '99999';  // v0.1.3: 提到 99999, 压过其他 3 个 canvas
      canvas.style.pointerEvents = 'none';

      // v0.1.2: 监听 WebGL context lost (PIXI 静默不报, 这是渲染黑洞常见原因)
      canvas.addEventListener('webglcontextlost', function (e) {
        e.preventDefault();
        console.warn('[Live2D] WebGL context LOST — GPU 资源可能耗尽');
      }, false);
      canvas.addEventListener('webglcontextrestored', function () {
        console.log('[Live2D] WebGL context RESTORED');
      }, false);

      var app = new PIXI.Application({
        view: canvas,
        width: w,
        height: h,
        backgroundAlpha: 0,  // 透明背景
        autoStart: true,
        antialias: true,
        resolution: global.devicePixelRatio || 1,
        autoDensity: true,
      });

      // 加载 model3.json
      var model = await Live2DModel.from(modelPath, {
        autoInteract: false,  // 0.4.0 v6 语法
      });

      // v0.1.2: 强制等一帧再设位置/缩放, 让 PIXI 内部 model 初始化完
      // (之前 mount success 时 model 加载完, 但 internalModel 还在 setup)
      await new Promise(function (r) { return requestAnimationFrame(r); });

      app.stage.addChild(model);

      // v0.1.4: 等 internal model 初始化 (Live2DModel.from 完成后, model.width 可能是 0)
      // 等几帧让 Cubism 内部完成 setup
      for (var fi = 0; fi < 5; fi++) {
        await new Promise(function (r) { return requestAnimationFrame(r); });
        if (model.width > 0 && model.height > 0) break;
      }
      console.log('[Live2D] model actual size:', model.width, 'x', model.height, '(after', fi, 'frames)');

      // v0.1.4: 用 model 实际尺寸 fit 到画布 70%
      var defaultScale = options.scale != null ? options.scale : 0.4;
      var finalScale = defaultScale;
      if (model.width > 0 && model.height > 0) {
        var fitScale = Math.min((w * 0.7) / model.width, (h * 0.7) / model.height);
        finalScale = Math.min(fitScale, defaultScale * 5);  // 兜底, 别缩到 5x
        if (fitScale > defaultScale) finalScale = defaultScale;  // 比默认还大就保持默认
      }
      model.scale.set(finalScale, finalScale);
      model.anchor.set(0.5, 0.5);
      // 位置用 renderer 内部坐标 (含 devicePixelRatio) 才能精准居中
      model.x = app.renderer.width / 2;
      model.y = app.renderer.height / 2;
      if (options.x !== undefined) model.x = options.x;
      if (options.y !== undefined) model.y = options.y;

      // 启动 idle motion — 0.4.0 用 model.motion() 高阶 API
      if (options.autoStartIdle !== false) {
        var motionGroup = options.motionGroup || 'Idle';
        try {
          if (typeof model.motion === 'function') {
            model.motion(motionGroup);
          } else if (model.internalModel && model.internalModel.motionManager) {
            // 兜底: 老 API
            var mm = model.internalModel.motionManager;
            if (typeof mm.startMotion === 'function') mm.startMotion(motionGroup);
            else if (typeof mm.play === 'function') mm.play(motionGroup);
          }
        } catch (e) {
          console.warn('[Live2D] idle motion play failed:', e && e.message);
        }
      }

      // 引用挂到 canvas 上, 方便 dispose
      canvas._live2dApp = app;
      canvas._live2dModel = model;

      console.log('[Live2D] mounted:', modelPath, 'size:', w, 'x', h);
      return { success: true, app: app, model: model };
    } catch (err) {
      console.warn('[Live2D] mount failed:', err, 'path:', modelPath);
      // 清理残留的 PIXI Application
      if (canvas._live2dApp) {
        try { canvas._live2dApp.destroy(true, { children: true, texture: true }); } catch (e) {}
        canvas._live2dApp = null;
      }
      return { success: false, error: err };
    }
  }

  /**
   * 卸载 Live2D
   */
  function disposeLive2D(canvas) {
    if (!canvas || !canvas._live2dApp) return false;
    try {
      canvas._live2dApp.destroy(true, { children: true, texture: true });
    } catch (e) {
      console.warn('[Live2D] dispose error:', e);
    }
    canvas._live2dApp = null;
    canvas._live2dModel = null;
    return true;
  }

  /**
   * 播放动作 (motion)
   */
  function playMotion(canvas, group, index) {
    if (group == null) group = 'Idle';
    if (index == null) index = 0;
    var model = canvas && canvas._live2dModel;
    if (!model) return false;
    try {
      if (typeof model.motion === 'function') {
        model.motion(group, index);
        return true;
      }
      if (model.internalModel && model.internalModel.motionManager) {
        var mm = model.internalModel.motionManager;
        if (typeof mm.startMotion === 'function') { mm.startMotion(group, index); return true; }
        if (typeof mm.play === 'function') { mm.play(group, index); return true; }
      }
    } catch (e) {
      console.warn('[Live2D] playMotion failed:', e);
    }
    return false;
  }

  /**
   * 设置表情
   */
  function setExpression(canvas, expressionId) {
    var model = canvas && canvas._live2dModel;
    if (!model || !model.internalModel || !model.internalModel.expressionManager) return false;
    try {
      model.internalModel.expressionManager.setExpression(expressionId);
      return true;
    } catch (e) {
      console.warn('[Live2D] setExpression failed:', e);
      return false;
    }
  }

  /**
   * 检查是否挂载
   */
  function isMounted(canvas) {
    return !!(canvas && canvas._live2dApp);
  }

  // 暴露到 window
  global.Live2DLoader = {
    mountLive2D: mountLive2D,
    disposeLive2D: disposeLive2D,
    playMotion: playMotion,
    setExpression: setExpression,
    isMounted: isMounted,
  };
})(typeof window !== 'undefined' ? window : globalThis);
