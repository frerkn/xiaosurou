// ============================================================
// call-lip-sync.js — 视频通话 AI 说话口型 (lip sync)
// ============================================================
// 目标: AI 通过 TTS 说话时, Live2D 模型的嘴跟着声音动。
//
// 参考实现 (糯米机, 已逐行审计):
//   utils/callAudioFeed.ts                  — 音频分析 + 自适应开口度
//   components/call/Live2DAvatarCanvas.tsx  — 每帧 beforeModelUpdate 写嘴参数
//
// 三条核心做法 (全部照抄):
//   1. 分析器读实时波形 → rms → 自适应归一的开口度 0..1
//   2. 在 engine 的 "beforeModelUpdate" 阶段写 ParamMouthOpenY。
//      该 emit 由 pixi-live2d-display 0.4.0 (cubism4) 的 InternalModel.update() 发出,
//      顺序为 ... pose → emit("beforeModelUpdate") → coreModel.update() → loadParameters()。
//      此时 motion / expression / eyeBlink / focus / breath / physics / pose 全算完,
//      是 coreModel.update() 之前最后一个可写点 —— 写在更早的阶段会被它们覆盖。
//   3. iOS/iPadOS 恒定走"节奏型假口型", 不接音频 (见下方平台闸门)。
//
// ── 两条音频取数路径 (330 的实际情况决定的) ──
//   330 的视频通话 TTS 平时走 <audio> 元素播放 (tts-audio.js:315 分支) —— 因为
//   window.voiceCallSharedAudioContext 只在"语音通话彩铃解锁"里创建, 视频通话不建它。
//   所以主力路径是 B:
//
//   A) getTapNode(ctx)   — 仅当 TTS 真的走 WebAudio BufferSource 时 (共享 ctx 恰好 running)。
//                           分析器连 destination, 由调用方 source.connect(它)。
//   B) attachElement(el) — 主力路径。<audio> 元素用 captureStream() 旁路拷贝一份流做分析,
//                           ⚠️ 刻意不 connect(destination)。
//
//   ⚠️ B 相对糯米机的 createMediaElementSource 更安全: 那个 API 会把 <audio> 的输出
//   接管进 WebAudio, AudioContext 一挂起声音就断。captureStream 只是旁路复制,
//   声音始终由 <audio> 原生输出 —— 即使 AudioContext 被系统挂起, 通话也绝不会没声音。
//   Safari 不支持 HTMLMediaElement.captureStream, 正好与"iOS 走假口型"的决策天然一致。
//
// ⚠️ 边界一: 绝不碰语音通话。getTapNode / attachElement 都只对 source === 'videoCall'
//    被调用 (见 tts-audio.js 调用点), 语音通话链路一行未改, 也拿不到任何分析器。
//
// ⚠️ 边界二: 本模块任何一步失败都不得影响声音。
//    attachElement() 失败返回 false, <audio> 照旧原生出声;
//    getTapNode() 失败返回 null, 调用方照旧直连 ctx.destination;
//    写参数失败静默跳过。
// ============================================================

(function (global) {
  'use strict';

  // ── 音频采样 ──
  // 每帧只真读一次波形 (多 canvas 同帧复用), 同糯米机 CallAudioFeed.sample 的 8ms 缓存
  var SAMPLE_CACHE_MS = 8;

  // 真分析器有可能马上建好时的等待窗口: 这段里先闭嘴, 避免
  // "假口型动两下 → 真口型接管" 的跳变。iOS 永远等不到真信号, 窗口为 0。
  var REAL_WARMUP_MS = 600;

  // ── 假口型参数 (糯米机 Live2DAvatarCanvas 同款) ──
  // 糯米机注释原话: 绝不在真/假口型之间逐帧横跳
  var FAKE_BASE = 0.16;
  var FAKE_WAVE_A = 0.35;
  var FAKE_WAVE_B = 0.2;
  var FAKE_GATE = -0.72;
  var FAKE_GATE_CLOSED = 0.08;

  // ── 元音 (v0.5.0 P13) ──
  // 频带划分与糯米机 CallAudioFeed.sample 完全一致: 低频 120~900Hz / 中频 1k~3.6kHz。
  // 元音倾向 vowel = mid / (low + mid):
  //   低频占优 (あ/お/u 类, 声道敞开、共振峰低) → 趋近 0
  //   高频占优 (い/え 类, 舌位高、共振峰高)     → 趋近 1
  var VOWEL_LOW_BAND = [120, 900];
  var VOWEL_MID_BAND = [1000, 3600];
  var VOWEL_SMOOTH = 0.25;        // 元音比开口度惰性更大, 换元音是渐变而不是跳变

  // ParamMouthForm 的摆幅。标准 Cubism 模型该参数范围 -1(嘟嘴) ~ +1(微笑),
  // 满摆幅会把"说话"演成"一直咧嘴笑", 所以只取一半: 圆口 -0.5 / 扁口 +0.5。
  var VOWEL_FORM_GAIN = 0.5;

  // 假口型的元音摆动 (糯米机 VRM 分支同款 (sin(t*8.1)+1)/2)
  var FAKE_VOWEL_WAVE = 8.1;

  var _iosCached = null;

  /**
   * iOS / iPadOS 判定。
   * iPadOS 13+ 的桌面版 UA 会伪装成 MacIntel, 靠触点数量兜住
   * (与糯米机 shouldKeepNativeCallAudio 同款写法)。
   */
  function isIOSLike() {
    if (_iosCached !== null) return _iosCached;
    var result = false;
    try {
      var nav = global.navigator || {};
      var ua = nav.userAgent || '';
      result = /iPad|iPhone|iPod/i.test(ua)
        || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
    } catch (e) {
      result = false;
    }
    _iosCached = result;
    return result;
  }

  function now() {
    try {
      if (global.performance && typeof global.performance.now === 'function') {
        return global.performance.now();
      }
    } catch (e) { /* 落到 Date.now */ }
    return Date.now();
  }

  // ============================================================
  // 一、音频侧 — 拿到"此刻声音多大"
  // ============================================================
  var speaking = false;
  var speakingStartedAt = 0;
  var peak = 0.12;
  var smoothedLevel = 0;
  var smoothedVowel = 0.5;      // 元音倾向 0..1, 0.5 = 中位 (两带都静音时的静息值)
  var lastSampleAt = 0;
  var cachedLevel = 0;
  var cachedVowel = 0.5;

  // 本次播放实际生效的分析器 (由 A / B 任一路径在播放前设置)
  var activeAnalyser = null;
  var activeTimeData = null;
  var activeFreqData = null;    // 元音用: getByteFrequencyData 的输出缓冲
  var activeContext = null;     // 元音用: 需要 ctx.sampleRate 把 bin 换算成 Hz

  // ── A 路径状态: WebAudio BufferSource (分析器连 destination) ──
  var tapContext = null;
  var tapAnalyser = null;
  var tapTimeData = null;
  var tapFreqData = null;

  // ── B 路径状态: HTMLMediaElement 旁路 (captureStream, 刻意不连 destination) ──
  var elContext = null;
  var elAnalyser = null;
  var elTimeData = null;
  var elFreqData = null;
  var elStreamSource = null;
  var elAttachedEl = null;
  var elBroken = false;
  var elResumeHooked = false;

  /**
   * B 路径专用 AudioContext。
   * 只用来跑分析图, 不接管任何音频输出 —— 所以即使它被系统挂起,
   * <audio> 的声音依旧照常, 最多是口型退回假口型。
   */
  function ensureElContext() {
    if (elBroken) return null;
    if (elContext && elContext.state !== 'closed') return elContext;
    try {
      var Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) { elBroken = true; return null; }
      elContext = new Ctx();
      return elContext;
    } catch (e) {
      elBroken = true;
      return null;
    }
  }

  /** AudioContext 首次创建时可能是 suspended; 挂一个一次性的用户手势去 resume。 */
  function hookResumeOnNextGesture() {
    if (elResumeHooked) return;
    elResumeHooked = true;
    try {
      var resume = function () {
        try { document.removeEventListener('pointerdown', resume, true); } catch (e) { /* ignore */ }
        try {
          if (elContext && elContext.state !== 'running') elContext.resume();
        } catch (e) { /* ignore */ }
        // 顺手也把通话共享 ctx 拉起来 (它才是真口型的主力)
        try {
          var shared = global.voiceCallSharedAudioContext;
          if (shared && shared.state !== 'running') shared.resume();
        } catch (e) { /* ignore */ }
      };
      document.addEventListener('pointerdown', resume, true);
    } catch (e) { /* document 不可用时忽略 */ }
  }

  // ── 通话共享 AudioContext (iOS 真口型的关键) ──
  // tts-audio.js 用 window.voiceCallSharedAudioContext.state === 'running' 决定通话 TTS
  // 走 WebAudio BufferSource 还是 <audio>。只要它 running, 视频通话的 TTS 也会走
  // WebAudio —— 那时 getTapNode 就能在音频链上插分析器, iOS 也一样能拿到真口型
  // (因为整条链本来就在 WebAudio 里, 不存在"接管原生输出"的问题)。
  //
  // 语音通话靠"启用音频"彩铃按钮在手势里建它; 视频通话没有那一步, 这里用一个
  // 静默的一次性 pointerdown 达到同样效果 —— 用户在进视频通话前必然点过屏幕。
  var sharedHooked = false;

  /** 应急开关: 控制台执行 localStorage.setItem('mavis-lipsync-ios','off') 后刷新即可关闭。 */
  function isIOSLipSyncDisabled() {
    try {
      return !!(global.localStorage && global.localStorage.getItem('mavis-lipsync-ios') === 'off');
    } catch (e) {
      return false;
    }
  }

  /**
   * 元音应急开关: 控制台执行 localStorage.setItem('mavis-lipsync-vowel','off') 后刷新,
   * 就退回只驱动开口度 (等价于 P12 的行为), 不用改代码。
   */
  function isVowelDisabled() {
    try {
      return !!(global.localStorage && global.localStorage.getItem('mavis-lipsync-vowel') === 'off');
    } catch (e) {
      return false;
    }
  }

  /**
   * 元音倾向: 中频带能量占比。逐字照抄糯米机 CallAudioFeed.vowelFromBands
   * (它自带单测: 低频占优 <0.2 / 高频占优 >0.8 / 双静音回 0.5 不产生 NaN)。
   *
   * @param {number} lowEnergy 120~900Hz 带平均能量 (已归一到 0..1)
   * @param {number} midEnergy 1k~3.6kHz 带平均能量 (已归一到 0..1)
   * @returns {number} 0 = 低频占优(圆口) .. 1 = 高频占优(扁口)
   */
  function vowelFromBands(lowEnergy, midEnergy) {
    var total = lowEnergy + midEnergy;
    if (total < 1e-3) return 0.5;
    var v = midEnergy / total;
    if (!isFinite(v)) return 0.5;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }

  function ensureSharedContext() {
    if (isIOSLipSyncDisabled()) return null;
    try {
      var Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return null;
      if (!global.voiceCallSharedAudioContext) {
        global.voiceCallSharedAudioContext = new Ctx();
      }
      var shared = global.voiceCallSharedAudioContext;
      if (shared && shared.state !== 'running') {
        try { shared.resume(); } catch (e) { /* 需要手势, 交给 pointerdown 兜底 */ }
      }
      return shared;
    } catch (e) {
      return null;
    }
  }

  function hookSharedUnlock() {
    if (sharedHooked) return;
    sharedHooked = true;
    try {
      var unlock = function () {
        try { document.removeEventListener('pointerdown', unlock, true); } catch (e) { /* ignore */ }
        ensureSharedContext();
      };
      // capture 阶段, 仍在手势的同步执行栈内 —— 这是 iOS 愿意 resume 的时机
      document.addEventListener('pointerdown', unlock, true);
    } catch (e) { /* document 不可用时忽略 */ }
  }

  /**
   * 预热: 视频通话建立时调一次, 让分析用 AudioContext 尽早 resume。
   * AudioContext 首次创建通常是 suspended, resume() 又是异步的 —— 不预热的话
   * 第一句 AI 台词会来不及 (attachElement 当次返回 false, 退回假口型)。
   * 只创建/恢复用于分析的 AudioContext, 不接管任何音频输出。
   */
  function prewarm() {
    // 1. 通话共享 AudioContext —— 它一 running, tts-audio.js 就会把视频通话 TTS
    //    也切到 WebAudio BufferSource, getTapNode 便能插上分析器 (iOS 同理)。
    //    这就是语音通话"启用音频"彩铃按钮做的事, 只是视频通话不需要彩铃:
    //    见 hookSharedUnlock —— 用户在进通话前点过屏幕就够了。
    var shared = ensureSharedContext();
    hookSharedUnlock();

    // 2. captureStream 兜底路径的独立 ctx (桌面在 <audio> 路径下用它)
    if (!isIOSLike() && !elBroken) ensureElContext();
    hookResumeOnNextGesture();

    return !!(shared && shared.state === 'running');
  }

  /**
   * 由 tts-audio.js 在【视频通话】TTS 走 WebAudio BufferSource 时调用。
   *
   * 返回 AnalyserNode 时, 调用方应 source.connect(它) —— 它已自行 connect(destination);
   * 返回 null 时, 调用方必须照旧 source.connect(ctx.destination)。
   * 两种情况下声音都正常。
   */
  function getTapNode(ctx) {
    if (!ctx) return null;

    // 应急开关 (见 isIOSLipSyncDisabled)
    if (isIOSLipSyncDisabled()) return null;

    // ⚠️ 这里【刻意没有】iOS 闸门 —— 与 attachElement 的处理不同, 这是有意的。
    // attachElement 走 captureStream/createMediaElementSource, 那类做法会把 <audio>
    // 的输出接管进 WebAudio, ctx 一挂起通话就没声音, 所以 iOS 必须回避。
    // 但这条路径不一样: 音频本来就由 WebAudio 的 BufferSource 产生
    // (tts-audio.js 的 useWebAudio 分支), 链路是 BufferSource → analyser → destination,
    // analyser 是直通节点、不改声音。我们只是在一个已经在跑的 WebAudio 图里
    // 多插一个旁路采样节点, 不存在"接管原生输出"的问题。
    // 语音通话在 iOS 上走的一直就是这条路。

    if (tapContext && tapContext !== ctx) {
      // 通话重开换了 AudioContext → 旧分析器作废, 不能跨 ctx 复用
      tapAnalyser = null;
      tapTimeData = null;
      tapFreqData = null;
      tapContext = null;
    }
    if (tapAnalyser) {
      activeAnalyser = tapAnalyser;
      activeTimeData = tapTimeData;
      activeFreqData = tapFreqData;
      activeContext = tapContext;
      return tapAnalyser;
    }

    try {
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.5;
      analyser.connect(ctx.destination);
      tapAnalyser = analyser;
      tapContext = ctx;
      tapTimeData = new Uint8Array(analyser.fftSize);
      // 元音用: 频域缓冲长度必须是 frequencyBinCount (fftSize/2), 不是 fftSize
      tapFreqData = new Uint8Array(analyser.frequencyBinCount);
      activeAnalyser = analyser;
      activeTimeData = tapTimeData;
      activeFreqData = tapFreqData;
      activeContext = ctx;
      return analyser;
    } catch (e) {
      // createAnalyser / connect 失败 → 退回 destination 直连, 声音照常
      tapAnalyser = null;
      tapTimeData = null;
      tapFreqData = null;
      tapContext = null;
      return null;
    }
  }

  /**
   * 由 tts-audio.js 在【视频通话】TTS 走 <audio> 元素播放时调用 (主力路径)。
   *
   * 用 captureStream() 旁路拷一份流给分析器, 不接管 <audio> 的原生输出。
   * 返回 true = 本次可走真口型; false = 退回假口型 (声音始终正常)。
   */
  function attachElement(el) {
    if (!el) return false;
    // ⚠️ 平台闸门只在这条路径上, getTapNode 刻意没有 —— 理由见 getTapNode 顶部注释。
    // captureStream / createMediaElementSource 会接管 <audio> 的音频输出, iOS 上必须回避;
    // getTapNode 只是往已经跑在 WebAudio 里的图上插一个直通分析器, 不存在这个问题。
    if (isIOSLike()) return false;
    if (elBroken) return false;

    if (elAttachedEl === el && elAnalyser) {
      activeAnalyser = elAnalyser;
      activeTimeData = elTimeData;
      activeFreqData = elFreqData;
      activeContext = elContext;
      return true;
    }

    // captureStream 是必备能力; Safari (含 iOS) 不提供, 天然走假口型
    if (typeof el.captureStream !== 'function') { elBroken = true; return false; }

    var ctx = ensureElContext();
    if (!ctx) return false;
    if (ctx.state !== 'running') {
      // 首次创建常常是 suspended: 直接 resume, 同时挂手势兜底。
      // 本次先退回假口型, 下次播放再试。
      try { ctx.resume(); } catch (e) { /* 需要用户手势 */ }
      hookResumeOnNextGesture();
      if (ctx.state !== 'running') return false;
    }

    try {
      var stream = el.captureStream();
      if (!stream) { elBroken = true; return false; }
      var src = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.5;
      // ⚠️ 刻意不 connect(destination): 声音继续由 <audio> 原生输出,
      //    这里只是旁路复制一份流做分析。
      src.connect(analyser);
      elAnalyser = analyser;
      elTimeData = new Uint8Array(analyser.fftSize);
      // 元音用: 频域缓冲长度 = frequencyBinCount
      elFreqData = new Uint8Array(analyser.frequencyBinCount);
      elStreamSource = src;
      elAttachedEl = el;
      activeAnalyser = analyser;
      activeTimeData = elTimeData;
      activeFreqData = elFreqData;
      activeContext = ctx;
      return true;
    } catch (e) {
      elBroken = true;
      elAnalyser = null;
      elTimeData = null;
      elFreqData = null;
      elStreamSource = null;
      elAttachedEl = null;
      return false;
    }
  }

  /**
   * AI 开始 / 结束念一句 TTS 时由 tts-audio.js 调用 (仅 source === 'videoCall')。
   * @param {boolean} on
   */
  function notifySpeaking(on) {
    speaking = !!on;
    if (speaking) {
      speakingStartedAt = now();
      peak = 0.12;
      lastSampleAt = 0;
    }
    smoothedLevel = 0;
    smoothedVowel = 0.5;
    cachedLevel = 0;
    cachedVowel = 0.5;
  }

  /** 把 Hz 换算到频域 bin, 取该带平均能量并归一到 0..1 (糯米机 bandEnergy 同款)。 */
  function bandEnergy(freqData, hzPerBin, fromHz, toHz) {
    if (!freqData || !(hzPerBin > 0)) return 0;
    var from = Math.floor(fromHz / hzPerBin);
    var to = Math.ceil(toHz / hzPerBin);
    if (from < 0) from = 0;
    if (to > freqData.length - 1) to = freqData.length - 1;
    if (to < from) return 0;
    var sum = 0;
    for (var i = from; i <= to; i++) sum += freqData[i];
    return sum / Math.max(1, to - from + 1) / 255;
  }

  /**
   * 每帧取样, 返回 { level, vowel, active }。
   *   level 0..1 开口度 (驱动 ParamMouthOpenY)
   *   vowel 0..1 元音倾向 (驱动 ParamMouthForm: 0 圆口 .. 1 扁口)
   *   active 是否来自真实音频信号 (false = 假口型)
   */
  function sampleFrame() {
    if (!speaking) return { level: 0, vowel: smoothedVowel, active: false };

    var t = now();
    var analyser = activeAnalyser;
    var timeData = activeTimeData;

    if (analyser && timeData) {
      if (t - lastSampleAt < SAMPLE_CACHE_MS) {
        return { level: cachedLevel, vowel: cachedVowel, active: true };
      }
      lastSampleAt = t;

      try {
        analyser.getByteTimeDomainData(timeData);
      } catch (e) {
        // 分析器被外部关闭 → 摘掉, 本句后续走假口型
        activeAnalyser = null;
        activeTimeData = null;
        activeFreqData = null;
        activeContext = null;
        return { level: 0, vowel: smoothedVowel, active: false };
      }

      var sum = 0;
      for (var i = 0; i < timeData.length; i++) {
        var v = (timeData[i] - 128) / 128;
        sum += v * v;
      }
      var rms = Math.sqrt(sum / timeData.length);

      // 自适应归一 (糯米机 adaptiveMouthLevel): 运行峰值每次 ×0.996 缓慢回落,
      // 换到音量更小的语音片段后 1~2 秒内恢复满幅口型; 低于 6% 视为底噪, 直接闭嘴,
      // 避免静音段嘴唇抖动。
      peak = Math.max(0.05, peak * 0.996, rms);
      var raw = rms / (peak * 0.85);
      var target = raw < 0.06 ? 0 : (raw > 1 ? 1 : raw);

      // 快起慢落: 辅音爆破立即张嘴, 词尾自然合拢
      var rate = target > smoothedLevel ? 0.55 : 0.22;
      smoothedLevel += (target - smoothedLevel) * rate;
      if (smoothedLevel < 0) smoothedLevel = 0;
      if (smoothedLevel > 1) smoothedLevel = 1;

      // ── 元音 (v0.5.0 P13) ──
      // 频带能量比 → 元音倾向。分析器/缓冲/ ctx 任一缺失就保持上一次的值,
      // 不把口型突然拉回中位 (那会在说话中途闪一下"标准微笑")。
      if (!isVowelDisabled()) {
        var freqData = activeFreqData;
        var ctx = activeContext;
        var rate2 = ctx && typeof ctx.sampleRate === 'number' ? ctx.sampleRate : 0;
        if (freqData && rate2 > 0 && typeof analyser.getByteFrequencyData === 'function') {
          try {
            analyser.getByteFrequencyData(freqData);
            var hzPerBin = rate2 / 2 / freqData.length;
            var vowel = vowelFromBands(
              bandEnergy(freqData, hzPerBin, VOWEL_LOW_BAND[0], VOWEL_LOW_BAND[1]),
              bandEnergy(freqData, hzPerBin, VOWEL_MID_BAND[0], VOWEL_MID_BAND[1])
            );
            smoothedVowel += (vowel - smoothedVowel) * VOWEL_SMOOTH;
            if (smoothedVowel < 0) smoothedVowel = 0;
            if (smoothedVowel > 1) smoothedVowel = 1;
          } catch (e2) { /* 取频域失败 → 保持上次元音, 口型继续 */ }
        }
      }

      cachedLevel = smoothedLevel;
      cachedVowel = smoothedVowel;
      return { level: cachedLevel, vowel: cachedVowel, active: true };
    }

    // ── 假口型 (iOS / 拿不到实时信号) ──
    // 非 iOS 时先等 REAL_WARMUP_MS: 这段窗口里真分析器可能刚建好 (音频还在 decode),
    // 先闭嘴, 免得出现"假口型动两下再被真口型接管"的跳变。
    if (!isIOSLike() && t - speakingStartedAt < REAL_WARMUP_MS) {
      return { level: 0, vowel: smoothedVowel, active: false };
    }

    var sec = t / 1000;
    var rhythm = FAKE_BASE
      + Math.sin(sec * 13.1) * FAKE_WAVE_A
      + Math.sin(sec * 21.7 + 0.8) * FAKE_WAVE_B;
    var gate = Math.sin(sec * 3.15) > FAKE_GATE ? 1 : FAKE_GATE_CLOSED;
    var fake = rhythm * gate;
    if (fake < 0) fake = 0;
    if (fake > 1) fake = 1;

    // 假口型的元音也用缓慢摆动带一下, 免得假口型期间嘴型僵在一个形状
    var fakeVowel = (Math.sin(sec * FAKE_VOWEL_WAVE) + 1) * 0.5;
    smoothedVowel = fakeVowel;

    smoothedLevel = fake;
    cachedLevel = fake;
    cachedVowel = fakeVowel;
    return { level: fake, vowel: fakeVowel, active: false };
  }

  /** 兼容旧调用方: 只要开口度。 */
  function sampleMouthLevel() {
    return sampleFrame().level;
  }

  function reset() {
    speaking = false;
    speakingStartedAt = 0;
    peak = 0.12;
    smoothedLevel = 0;
    smoothedVowel = 0.5;
    cachedLevel = 0;
    cachedVowel = 0.5;
    lastSampleAt = 0;
  }

  // ============================================================
  // 二、模型侧 — 每帧把开口度写进 ParamMouthOpenY
  // ============================================================
  var attachedCanvas = null;
  var attachedModel = null;
  var attachedInternal = null;
  var attachedHandler = null;
  var mouthTargets = null;
  var formTargets = null;

  function isSpeaking() {
    return speaking;
  }

  function clampNum(v, lo, hi) {
    if (!isFinite(v)) return lo;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  /** 在 core 上按 id 取参数下标, 不存在返回 -1。 */
  function findParamIndex(core, id) {
    if (!id) return -1;
    try {
      var idx = core.getParameterIndex(id);
      return typeof idx === 'number' && idx >= 0 ? idx : -1;
    } catch (e) {
      return -1;
    }
  }

  /**
   * 开口度目标。
   * 首选 ParamMouthOpenY (Cubism 4 标准参数名, 330 调试台与糯米机都用它);
   * 该模型没这个参数时, 退回读 model3.json 的 Groups[Name === 'LipSync'] 里的第一个可用 id。
   */
  function resolveMouthTargets(core, modelJson) {
    var targets = [];

    function push(id) {
      if (!id) return;
      for (var i = 0; i < targets.length; i++) {
        if (targets[i].id === id) return;
      }
      var idx = findParamIndex(core, id);
      if (idx >= 0) targets.push({ id: id, index: idx });
    }

    push('ParamMouthOpenY');
    if (targets.length === 0 && modelJson) {
      var groups = Array.isArray(modelJson.Groups) ? modelJson.Groups : [];
      for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        if (!grp || (grp.Name !== 'LipSync' && grp.name !== 'LipSync')) continue;
        var ids = Array.isArray(grp.Ids) ? grp.Ids : [];
        for (var k = 0; k < ids.length; k++) {
          push(ids[k]);
          if (targets.length > 0) break;   // 只取组里第一个能用的
        }
        break;
      }
    }
    return targets;
  }

  /**
   * 元音 (嘴型) 目标 —— v0.5.0 P13。
   * ParamMouthForm 是 Cubism 标准里控制嘴型的参数: -1 嘟嘴(圆口) .. +1 微笑(扁口)。
   * 元音倾向正好是同一根轴: 低频占优的 あ/お/u 要圆口, 高频占优的 い/え 要扁口,
   * 所以 vowel 0..1 线性映射到 -gain..+gain。
   *
   * 顺序: 先认标准名 ParamMouthForm; 模型没这个名字时, 去 model3.json 的
   * Groups[LipSync].Ids 里找名字含 MouthForm 的那个兜住。
   * 都找不到就返回空数组 —— 该模型不做元音, 只驱动开口度, 绝不硬造参数。
   */
  function resolveFormTargets(core, modelJson) {
    var targets = [];

    function push(id) {
      if (!id) return;
      for (var i = 0; i < targets.length; i++) {
        if (targets[i].id === id) return;
      }
      var idx = findParamIndex(core, id);
      if (idx >= 0) targets.push({ id: id, index: idx });
    }

    push('ParamMouthForm');
    if (targets.length === 0 && modelJson) {
      var groups = Array.isArray(modelJson.Groups) ? modelJson.Groups : [];
      for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        if (!grp || (grp.Name !== 'LipSync' && grp.name !== 'LipSync')) continue;
        var ids = Array.isArray(grp.Ids) ? grp.Ids : [];
        for (var k = 0; k < ids.length; k++) {
          if (/MouthForm/i.test(String(ids[k]))) push(ids[k]);
        }
        break;
      }
    }
    return targets;
  }

  /**
   * 每帧写嘴。frame = { level, vowel, active }。
   *
   * 开口度: 直接覆盖 (说话时嘴的开合就该由声音决定)。
   * 嘴型:   在"当前值"基础上叠加元音偏移, 不是覆盖 ——
   *         当前值里带着 AI 表情 (微笑/嘟嘴) 和动作曲线贡献的基线,
   *         覆盖会把"微笑"直接抹成无表情。加性写入 = 微笑 + 元音波动。
   *         (此处在 beforeModelUpdate 阶段, 引擎已 saveParameters,
   *          每帧都从授权值重新读, 所以不会逐帧累积漂移。)
   */
  function writeMouth(core, frame) {
    var level = frame.level;

    var targets = mouthTargets;
    if (targets && targets.length) {
      for (var i = 0; i < targets.length; i++) {
        try {
          core.setParameterValueByIndex(targets[i].index, level);
        } catch (e) { /* 单个参数写失败不影响其他 */ }
      }
    }

    // 嘴几乎闭着时不动嘴型: 这时看不出形状, 写了只会干扰表情
    if (level <= 0.02) return;

    var forms = formTargets;
    if (!forms || forms.length === 0) return;
    if (isVowelDisabled()) return;

    var offset = (frame.vowel - 0.5) * 2 * VOWEL_FORM_GAIN;
    if (Math.abs(offset) < 1e-4) return;

    // 读不到"当前值"就不写嘴型: 没有基线就只能按 0 覆盖, 那等于把 AI 表情
    // (微笑/嘟嘴) 抹平成"由元音决定的单一形状"。宁可不动嘴型, 保住表情。
    // (引擎保证有这个 API: loadParameters 每帧恢复基线, 所以读到的永远是
    //  表情/动作算出来的值, 不包含我们上一帧写的偏移 —— 不会累积漂移。)
    if (typeof core.getParameterValueByIndex !== 'function') return;

    for (var j = 0; j < forms.length; j++) {
      try {
        var current = core.getParameterValueByIndex(forms[j].index) || 0;
        core.setParameterValueByIndex(forms[j].index, clampNum(current + offset, -1, 1));
      } catch (e) { /* 单个参数读写失败不影响其他 */ }
    }
  }

  /**
   * 给视频通话的 Live2D canvas 挂口型钩子。
   * 幂等: 同一 internalModel 重复调用直接返回 true。
   * @param {HTMLCanvasElement} canvas 已挂载 Live2D 的 canvas (canvas._live2dModel / _live2dModelJson)
   */
  function attachToCanvas(canvas) {
    if (!canvas) return false;

    var model = canvas._live2dModel;
    var internal = model && model.internalModel;
    if (!internal || typeof internal.on !== 'function') return false;
    if (attachedInternal === internal) return true;

    // 换模型 / 重挂 → 先把旧的摘掉
    detachFromCanvas();

    var core = internal.coreModel
      || internal._model
      || (internal.coreModel && internal.coreModel._model)
      || null;
    if (!core || typeof core.setParameterValueByIndex !== 'function') return false;

    var modelJson = canvas._live2dModelJson || null;

    attachedCanvas = canvas;
    attachedModel = model;
    attachedInternal = internal;
    mouthTargets = resolveMouthTargets(core, modelJson);
    formTargets = resolveFormTargets(core, modelJson);

    attachedHandler = function () {
      // 模型已被替换 / 销毁 → 立刻停手 (dispose 后老 internal 不再 emit, 这里只是双保险)
      if (canvas._live2dModel !== model) return;
      // 没在说话 → 不接管嘴参数, 让模型自己的 idle / 呼吸保持原样
      if (!isSpeaking()) return;
      writeMouth(core, sampleFrame());
    };

    try {
      internal.on('beforeModelUpdate', attachedHandler);
    } catch (e) {
      attachedHandler = null;
      attachedCanvas = null;
      attachedModel = null;
      attachedInternal = null;
      mouthTargets = null;
      formTargets = null;
      return false;
    }
    return true;
  }

  /** 摘掉口型钩子 (通话挂断 / 换模型 / 切屏时调用)。幂等, 任何时候调都安全。 */
  function detachFromCanvas() {
    if (attachedInternal && attachedHandler && typeof attachedInternal.off === 'function') {
      try {
        attachedInternal.off('beforeModelUpdate', attachedHandler);
      } catch (e) { /* 引擎已销毁, 忽略 */ }
    }
    attachedCanvas = null;
    attachedModel = null;
    attachedInternal = null;
    attachedHandler = null;
    mouthTargets = null;
    formTargets = null;
    reset();
  }

  // 模块加载即挂一次性手势钩子 —— 用户在进入视频通话前必然点过屏幕 (打开应用、
  // 选聊天、点视频通话按钮), 那时就把共享 AudioContext 建好并 resume,
  // 进通话后第一句 AI 台词就能走 WebAudio 拿到真口型。
  hookSharedUnlock();

  global.CallLipSync = {
    prewarm: prewarm,
    getTapNode: getTapNode,
    attachElement: attachElement,
    notifySpeaking: notifySpeaking,
    attachToCanvas: attachToCanvas,
    detachFromCanvas: detachFromCanvas,
    isIOSLike: isIOSLike,
    // 调试 / 实测用
    _debug: {
      sampleMouthLevel: sampleMouthLevel,
      sampleFrame: sampleFrame,
      vowelFromBands: vowelFromBands,
      isSpeaking: isSpeaking,
      isVowelDisabled: isVowelDisabled,
      hasTap: function () { return !!activeAnalyser; },
      hasElAnalyser: function () { return !!elAnalyser; },
      isElBroken: function () { return elBroken; },
      getMouthTargets: function () { return mouthTargets ? mouthTargets.slice() : null; },
      getFormTargets: function () { return formTargets ? formTargets.slice() : null; },
      getVowel: function () { return smoothedVowel; },
      isAttached: function () { return !!attachedInternal; },
      reset: reset
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
