// Live2D 加载器 — PIXI v6.5.0 + pixi-live2d-display 0.4.0 + Cubism Core 4
// v0.3.0 回退到 330 v0.1.30 旧栈 (v8 + untitled 1.3.5 整库 PIXI v8 兼容 bug, renderOrder undefined)
// 跟之前一样挂在 window.Live2DLoader 上, API 不变, video-voice-call.js 无需改
// UMD 模式: PIXI + pixi-live2d-display 0.4.0 cubism4 都通过 <script> 加载, 暴露 window 全局

(function (global) {
  'use strict';

  // 诊断浮窗 (v0.2.1 加, 移动端 PWA 无 console 救星, 验证完可包 dev mode)
  const _diag = (() => {
    if (typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.dataset.live2dDiag = '1';
    el.style.cssText = 'position:fixed;top:env(safe-area-inset-top,0);left:0;right:0;z-index:2147483647;padding:8px 12px;font:13px/1.4 -apple-system,system-ui,sans-serif;color:#fff;background:rgba(20,20,28,.92);border-bottom:1px solid rgba(255,255,255,.15);word-break:break-all;pointer-events:none;white-space:pre-wrap;max-height:30vh;overflow:auto;';
    document.body.appendChild(el);
    return el;
  })();
  function _log(level, msg) {
    if (!_diag) return;
    const colors = { ok: '#7ee787', err: '#ff7b72', info: '#d2a8ff', dim: '#8b949e' };
    const icon = { ok: '✓', err: '✗', info: '·', dim: '·' };
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = document.createElement('div');
    line.style.cssText = `color:${colors[level] || '#fff'}`;
    line.textContent = `${icon[level] || '·'} ${time}  ${msg}`;
    _diag.appendChild(line);
    while (_diag.children.length > 6) _diag.removeChild(_diag.firstChild);
    if (level === 'err') console.warn('[Live2D-diag]', msg);
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
      _log('ok', `mounted: ${modelPath} (canvas ${w}x${h}, model ${Math.round(model.width)}x${Math.round(model.height)})`);
      return { success: true, app, model };
    } catch (err) {
      console.warn('[Live2D] mount failed:', err, 'path:', modelPath);
      _log('err', `mount 失败: ${err && err.message ? err.message : String(err)}`);
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
    _log('dim', 'disposed');
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

  global.Live2DLoader = {
    mountLive2D,
    disposeLive2D,
    playMotion,
    setExpression,
    isMounted,
  };
})(typeof window !== 'undefined' ? window : globalThis);
