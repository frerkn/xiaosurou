// Live2D 加载器 — PIXI v8 + untitled-pixi-live2d-engine 1.3.5 + Cubism Core 5/6
// 跟 330 旧 loader 一样挂在 window.Live2DLoader 上, API 不变, video-voice-call.js 无需改
// 模型通过 <script type="importmap"> + PIXI v8 ESM 加载 (PIXI v6 + pixi-live2d-display 0.4.0 拆掉了)

import { Application, extensions } from 'pixi.js';
import { configureCubismSDK, Live2DModel, Live2DPlugin } from 'untitled-pixi-live2d-engine/cubism';

let pluginRegistered = false;
function ensurePlugin() {
  if (pluginRegistered) return;
  extensions.add(Live2DPlugin);
  pluginRegistered = true;
}

function isMobileRuntime() {
  if (typeof navigator === 'undefined') return false;
  if (navigator.maxTouchPoints > 1
    && typeof matchMedia === 'function'
    && matchMedia('(pointer: coarse)').matches) return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

let cubismConfigured = false;
function ensureCubismConfig() {
  if (cubismConfigured) return;
  // 移动 32MB / 桌面 64MB (跟糯米 live2dCore 默认值一致)
  configureCubismSDK({ memorySizeMB: isMobileRuntime() ? 32 : 64 });
  cubismConfigured = true;
}

async function mountLive2D(canvas, modelPath, options) {
  options = options || {};
  if (!canvas) return { success: false, error: new Error('canvas is null') };
  if (!modelPath) return { success: false, error: new Error('modelPath is empty') };

  try {
    ensurePlugin();
    ensureCubismConfig();

    const parent = canvas.parentElement;
    const w = (parent && parent.clientWidth) || canvas.clientWidth || 300;
    const h = (parent && parent.parentElement && parent.parentElement.clientHeight) || canvas.clientHeight || 400;

    // v0.1.3 兼容: canvas 显式 style, PIXI v8 也只设 width/height 属性不设 CSS
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.style.display = 'block';
    canvas.style.zIndex = '99999';
    canvas.style.pointerEvents = 'none';

    // PIXI v8 Application init 是异步的 (v6 是同步 new 出来)
    const app = new Application();
    await app.init({
      view: canvas,
      width: w,
      height: h,
      backgroundAlpha: 0,
      antialias: !isMobileRuntime(),
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      preference: 'webgl',
    });

    // Live2DModel.from 加载 model3.json + 解析引用
    // 兜底 monkey patch: PIXI v8.6+ 移除了 renderer.geometry.resetState, untitled engine 1.3.5 内部还在调
    if (app.renderer && app.renderer.geometry && typeof app.renderer.geometry.resetState !== 'function') {
      app.renderer.geometry.resetState = function () {
        if (app.renderer.runners && app.renderer.runners.reset && typeof app.renderer.runners.reset.emit === 'function') {
          try { app.renderer.runners.reset.emit(); } catch (e) {}
        }
      };
      _log('info', 'monkey patch: renderer.geometry.resetState stub 已加 (PIXI v8.6+ 兼容)');
    }
    const model = await Live2DModel.from(modelPath, {
      idleMotionGroup: 'Idle',
      // 关 mipmap 省 33% 显存 (纹理上限 8192 时很关键)
      textureOptions: { lod: false },
      // 我们自己管 pointer, 不让引擎自动接管
      autoHitTest: false,
      autoFocus: false,
    });

    app.stage.addChild(model);

    // 等几帧让 PIXI 完成 layout, 拿真实 model 尺寸
    let frameWait = 0;
    for (let fi = 0; fi < 5; fi++) {
      await new Promise(r => requestAnimationFrame(r));
      frameWait = fi + 1;
      if (model.width > 0 && model.height > 0) break;
    }

    // 70% fit (跟旧 loader 一致)
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

    // 启动 idle motion (精灵伯爵没配 Motions 字段, 大概率没 Idle 组, 失败就吞掉)
    if (options.autoStartIdle !== false) {
      try {
        await model.motion('Idle');
      } catch (e) {
        // Idle 组不存在, 静默忽略
      }
    }

    canvas._live2dApp = app;
    canvas._live2dModel = model;

    // 渲染诊断: 1s/3s 后看 model 实际状态, 排查 race condition
    setTimeout(() => {
      const internal = model && model.internalModel;
      const stage = app.stage;
      const canvasRect = canvas.getBoundingClientRect();
      const hasInStage = stage && stage.children && stage.children.indexOf(model) >= 0;
      const texs = (model.textures || []);
      // PIXI v8 texture 真实尺寸检查 (t.width/t.height 是 PIXI 算的, 比 source 更准)
      const texInfo = texs.map((t, i) => {
        if (!t) return `${i}=null`;
        const w = t.width || 0;
        const h = t.height || 0;
        const v = t.valid;
        return `${i}=${w}x${h}${v ? '✓' : '✗'}`;
      }).join(', ');
      const originalW = internal && internal.originalWidth;
      const originalH = internal && internal.originalHeight;
      const bounds = model.getBounds ? model.getBounds() : null;
      const tickerStarted = app.ticker && app.ticker.started;
      const rendererType = app.renderer && app.renderer.type;
      const ctxLost = canvas.getContext && canvas.getContext('webgl2') ? false : (canvas.getContext && canvas.getContext('webgl') ? false : '?');
      // 主动调一次 render 确认 PIXI 渲染循环
      try { app.renderer.render(app.stage); _log('info', `1s 后: 主动 render ok, tickerStarted=${tickerStarted}, rendererType=${rendererType}`); } catch (e) { _log('err', `主动 render 失败: ${e && e.message}`); }
      _log('info', `1s 后: tex=[${texInfo}], inStage=${hasInStage}, originalCanvas=${originalW}x${originalH}, bounds=${bounds ? `${Math.round(bounds.width)}x${Math.round(bounds.height)}` : 'null'}, canvasRect=${Math.round(canvasRect.width)}x${Math.round(canvasRect.height)}@${Math.round(canvasRect.top)},${Math.round(canvasRect.left)}`);
    }, 1000);
    setTimeout(() => {
      const stage = app.stage;
      const hasInStage = stage && stage.children && stage.children.indexOf(model) >= 0;
      const texs = (model.textures || []);
      const texInfo = texs.map((t, i) => {
        if (!t) return `${i}=null`;
        return `${i}=${t.width || 0}x${t.height || 0}${t.valid ? '✓' : '✗'}`;
      }).join(', ');
      const allValid = texs.length > 0 && texs.every((t) => t && t.valid && t.width > 0);
      _log(allValid ? 'ok' : 'err', `3s 后: tex=[${texInfo}], inStage=${hasInStage}, ticker=${app.ticker && app.ticker.started ? 'on' : 'OFF'}`);
    }, 3000);

    console.log('[Live2D v0.2.0] mounted:', modelPath, 'size:', w, 'x', h, 'frames:', frameWait);
    _log('ok', `mounted: ${modelPath} (canvas ${w}x${h}, model ${Math.round(model.width)}x${Math.round(model.height)})`);
    return { success: true, app, model };
  } catch (err) {
    console.warn('[Live2D] mount failed:', err, 'path:', modelPath);
    _log('err', `mount 失败: ${err && err.message ? err.message : String(err)}`);
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

async function playMotion(canvas, group, index) {
  if (group == null) group = 'Idle';
  if (index == null) index = 0;
  const model = canvas && canvas._live2dModel;
  if (!model) return false;
  try {
    await model.motion(group, index);
    return true;
  } catch (e) {
    console.warn('[Live2D] playMotion failed:', e);
    return false;
  }
}

function setExpression(canvas, expressionId) {
  const model = canvas && canvas._live2dModel;
  if (!model) return false;
  try {
    if (!expressionId) {
      // 重置: expressionId 空字符串表示回到默认
      const em = model.internalModel?.motionManager?.expressionManager;
      if (em && typeof em.resetExpression === 'function') {
        em.resetExpression();
        return true;
      }
      return false;
    }
    model.expression(expressionId);
    return true;
  } catch (e) {
    console.warn('[Live2D] setExpression failed:', e);
    return false;
  }
}

function isMounted(canvas) {
  return !!(canvas && canvas._live2dApp);
}

// v0.2.0 P1 临时诊断浮窗 — 手机 PWA 没 console, 临时挂画面顶上, 验证完删/包 dev mode
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

window.Live2DLoader = {
  mountLive2D,
  disposeLive2D,
  playMotion,
  setExpression,
  isMounted,
};
