// ============================================================
// video-voice-call.js
// 来源：script.js 第 25404 ~ 26812 行
// 功能：视频通话 & 语音通话 & 拍一拍 & 通话消息操作
// ============================================================

(function () {
  // state 通过全局作用域访问（window.state，由 init-and-state.js 初始化）

  let videoCallState = {
    isActive: false,
    isAwaitingResponse: false,
    isGroupCall: false,
    activeChatId: null,
    initiator: null,
    startTime: null,
    participants: [],
    isUserParticipating: true,
    callHistory: [],
    preCallContext: "",
    isAiResponding: false,
    isAiSpeaking: false,
    isTtsPlaying: false,
    canUserSpeak: true
  };

  let voiceCallState = {
    isActive: false,
    isAwaitingResponse: false,
    isGroupCall: false,
    activeChatId: null,
    initiator: null,
    startTime: null,
    participants: [],
    isUserParticipating: true,
    callHistory: [],
    preCallContext: "",
    isAiResponding: false,
    isAiSpeaking: false,
    isTtsPlaying: false,
    canUserSpeak: true
  };

  let callTimerInterval = null;
  let voiceCallTimerInterval = null;
  let videoCallAiTurnSeq = 0;

  // ============================================================
  // v0.1.30 Live2D 视频通话 - 挂载/卸载/fallback 辅助函数
  // 设计: 配了 live2dModelPath 就挂 Live2D, 失败回退静态图, 没配保持原样
  // ============================================================

  /**
   * 挂载 Live2D 到视频通话对面画面区 (异步, 不阻塞通话初始化)
   * 设计: 把 canvas 塞到 #remote-video-large 里, 替换原本的对面静态图
   * @param {Object} chat - 当前通话的 chat 对象
   */
  async function mountLive2DForCall(chat) {
    // v0.0.50 Live2D 硬开关 — 默认禁用, 卖家模型不兼容 pixi-live2d-display 时整个模块不工作
    // 以后想恢复: state.globalSettings.live2dEnabled = true (用户在设置里调, 或代码里写死)
    if (!state || !state.globalSettings || state.globalSettings.live2dEnabled !== true) {
      return; // 不挂 Live2D, 不动原图, 视频通话走静态图 (原 330 行为)
    }
    console.log('[Live2D] mountLive2DForCall called, chat:', chat && chat.name, 'modelPath:', chat && chat.settings && chat.settings.live2dModelPath);
    try {
    const screen = document.getElementById('video-call-screen');
    if (!screen || !chat) return;

    // 1. 先清理残留 (旧 canvas)
    unmountLive2DForCall();

    // 2. 检查是否配了 live2dModelPath
    const modelPath = chat.settings && chat.settings.live2dModelPath;
    if (!modelPath) {
      console.log('[Live2D] no modelPath configured, skip (use original video area)');
      return;
    }
    if (!window.Live2DLoader) {
      console.warn('[Live2D] window.Live2DLoader not loaded, skip');
      return;
    }

    // v0.1.6: 彻底隐藏所有可能遮挡的"对面画面区"元素
    // - #video-display-area 整个隐藏 (applyVideoOptimizationToCall 设的 block 会被覆盖)
    // - #remote-video-img 隐藏 (不显示背景图)
    // - #participant-avatars-grid 隐藏 (不显示参与者头像)
    const displayArea = document.getElementById('video-display-area');
    if (displayArea) displayArea.style.display = 'none';
    const remoteImg = document.getElementById('remote-video-img');
    if (remoteImg) remoteImg.style.display = 'none';
    const participantGrid = document.getElementById('participant-avatars-grid');
    if (participantGrid && participantGrid.parentElement) {
      participantGrid.parentElement.style.display = 'none';
    }

    // v0.1.2: 创建 canvas 直接塞进 #video-call-screen 顶层 (不塞 #remote-video-large)
    // 避免父元素 CSS 布局问题, 永远在最前面
    const canvas = document.createElement('canvas');
    canvas.id = 'live2d-canvas';
    screen.appendChild(canvas);

    // 4. 加载模型
    const result = await window.Live2DLoader.mountLive2D(canvas, modelPath, {
      scale: 0.4,
      autoStartIdle: true,
    });

    if (!result.success) {
      console.warn('[Live2D] mount failed:', result.error, '— restoring original video area');
      canvas.remove();
      // v0.1.34: 关键修复 — Live2D 加载失败时必须恢复原图显示
      // 否则视频通话整个对面画面区都被 hide, 用户看到黑屏
      restoreVideoCallOriginalDisplay();
    } else {
      console.log('[Live2D] mount success');
    }
    } catch (e) {
      console.error('[Live2D] mountLive2DForCall threw:', e);
    }
  }

  /**
   * 恢复视频通话原始画面区显示 (清除 mountLive2DForCall 隐藏的 inline style)
   * 挂断瞬间无闪现: endVideoCall 是同步流程, unmount 后下一帧才 showScreen 隐藏 #video-call-screen,
   * inline style 恢复后原图被父元素一起隐藏, 不会出现 1 帧闪现.
   */
  function restoreVideoCallOriginalDisplay() {
    const displayArea = document.getElementById('video-display-area');
    if (displayArea) displayArea.style.display = '';
    const remoteImg = document.getElementById('remote-video-img');
    if (remoteImg) remoteImg.style.display = '';
    const participantGrid = document.getElementById('participant-avatars-grid');
    if (participantGrid && participantGrid.parentElement) {
      participantGrid.parentElement.style.display = '';
    }
  }

  /**
   * 卸载 Live2D (释放 PIXI GL 资源 + 移除 canvas) + 恢复原图显示
   * v0.1.34: 必须恢复原图显示, 否则:
   *  - 挂断后下次视频通话整个对面画面区都被 hide, Live2D 又加载失败 → 黑屏
   *  - Live2D 加载失败时如果不恢复, 通话过程中对面也是黑的
   */
  function unmountLive2DForCall() {
    const canvas = document.getElementById('live2d-canvas');
    if (canvas && window.Live2DLoader) {
      window.Live2DLoader.disposeLive2D(canvas);
      canvas.remove();
    }
    // 恢复原图显示 — 让下次视频通话 / Live2D 失败时能正常显示对面
    restoreVideoCallOriginalDisplay();
  }

  let videoCallMicStream = null;
  let videoCallMediaRecorder = null;
  let videoCallRecordedChunks = [];
  let isVideoCallRecording = false;
  let videoCallAutoListenEnabled = false;
  let videoCallIsListening = false;
  let videoCallIsRecording = false;
  let videoCallIsRecognizing = false;
  let videoCallAudioContext = null;
  let videoCallAudioSource = null;
  let videoCallAnalyser = null;
  let videoCallAutoListenAnimationFrame = null;
  let videoCallAutoListenTimers = [];
  let videoCallAutoListenStartedAt = 0;
  let videoCallUserSpeechStartedAt = 0;
  let videoCallLastVoiceAt = 0;
  let videoCallHasDetectedSpeech = false;
  let videoCallAutoStopReason = 'manual';

  const VIDEO_CALL_AUTO_LISTEN_CONFIG = {
    noSpeechTimeoutMs: 8000,
    minRecordingMs: 800,
    silenceAfterSpeechMs: 1800,
    maxRecordingMs: 30000,
    volumeThreshold: 0.035
  };

  let voiceCallMicStream = null;
  let voiceCallMediaRecorder = null;
  let voiceCallRecordedChunks = [];
  let isVoiceCallRecording = false;
  let voiceCallAutoListenEnabled = false;
  let voiceCallIsListening = false;
  let voiceCallIsRecording = false;
  let voiceCallIsRecognizing = false;
  let voiceCallAudioContext = null;
  let voiceCallAnalyser = null;
  let voiceCallAutoListenAnimationFrame = null;
  let voiceCallAutoListenTimers = [];
  let voiceCallAutoListenStartedAt = 0;
  let voiceCallUserSpeechStartedAt = 0;
  let voiceCallLastVoiceAt = 0;
  let voiceCallHasDetectedSpeech = false;
  let voiceCallAutoStopReason = 'manual';

  const VOICE_CALL_AUTO_LISTEN_CONFIG = {
    noSpeechTimeoutMs: 8000,
    minRecordingMs: 800,
    silenceAfterSpeechMs: 1800,
    maxRecordingMs: 30000,
    volumeThreshold: 0.035
  };

  function setVideoCallStatusText(text) {
    const statusText = document.getElementById('video-call-status-text');
    if (statusText) {
      statusText.textContent = text || '';
    }
  }

  function setVoiceCallStatusText(text) {
    const statusText = document.getElementById('voice-call-status-text');
    if (statusText) {
      statusText.textContent = text || '';
    }
  }

  // v0.2.30.37: 语音通话光晕 — thinking/speaking 分开挂不同元素
  // 根因: wrapper 包含 img + name 文字, 是 70x90 矩形, box-shadow 渲染成椭圆 + 名字区暗色
  // 修法:
  //   - thinking: class 给 wrapper (::before/::after 伪元素做光环, img 不支持伪元素)
  //   - speaking: class 给 img (box-shadow 在 70x70 正方形上渲染成完美正圆柔光)
  // state 取值:
  //   'idle'      — 默认, 无光晕
  //   'listening' — 用户说话, 挂断键外发光
  //   'thinking'  — AI 思考, wrapper 上 ::before/::after 旋转光环
  //   'speaking'  — AI 说话, img 上 box-shadow 大柔光闪烁
  function setVoiceCallGlowState(state) {
    const screen = document.getElementById('voice-call-screen');
    const hangupBtn = document.getElementById('voice-hang-up-btn');
    const avatarWrapper = document.querySelector('#voice-participant-avatars-grid .participant-avatar-wrapper');
    const avatarImg = document.querySelector('#voice-participant-avatars-grid .participant-avatar');

    // AI 状态时 (thinking / speaking / transitioning), 头像位置下移到屏幕中央
    if (screen) {
      screen.classList.toggle('voice-call-ai-active', state === 'thinking' || state === 'speaking' || state === 'transitioning');
    }

    // 挂断键 glow (listening) — 过渡时移除
    if (hangupBtn) {
      hangupBtn.classList.remove('glow-listening', 'glow-thinking', 'glow-speaking');
      if (state === 'listening') hangupBtn.classList.add('glow-listening');
    }

    // thinking 状态: class 给 wrapper (伪元素风车光环)
    // speaking 状态: class 也给 wrapper (::before 圆环 box-shadow, img 上 box-shadow iOS Safari 不可靠)
    // transitioning 状态: 过渡光斑 (聚光灯从挂断键位置飞到 AI 头像) — 跟 thinking/speaking 互斥
    if (avatarWrapper) {
      avatarWrapper.classList.remove('glow-thinking', 'glow-speaking', 'glow-transitioning');
      if (state === 'thinking') avatarWrapper.classList.add('glow-thinking');
      if (state === 'speaking') avatarWrapper.classList.add('glow-speaking');
      if (state === 'transitioning') avatarWrapper.classList.add('glow-transitioning');
    }
  }

  function markVideoCallAiResponseRendered(turnId) {
    if (!videoCallState.isActive) return;
    if (turnId && videoCallState.currentAiTurnId && videoCallState.currentAiTurnId !== turnId) return;

    videoCallState.hasRenderedAiResponse = true;
    videoCallState.renderedAiTurnId = turnId || videoCallState.currentAiTurnId || 0;
  }

  function cleanMinimaxCallResponse(rawText, providerInfo = {}) {
    const beforeText = String(rawText || '');
    const provider = providerInfo.provider || providerInfo.proxyUrl || providerInfo.baseURL || providerInfo.baseUrl || '';
    const isOfficialMinimax = String(provider || '').toLowerCase().includes('api.minimaxi.com');
    if (!isOfficialMinimax || typeof window.cleanMinimaxResponseText !== 'function') {
      return beforeText;
    }

    const cleanedText = window.cleanMinimaxResponseText(beforeText, {
      provider,
      model: providerInfo.model || ''
    }, {
      fallbackText: '我在。'
    });

    try {
      window.runtimeDiag?.log?.('CALL_RESPONSE_CLEANED', {
        provider,
        model: providerInfo.model || '',
        beforeLength: beforeText.length,
        afterLength: cleanedText.length
      });
    } catch (error) {
      console.warn('[通话Minimax清洗诊断日志失败]', error);
    }

    return cleanedText;
  }


  async function handleInitiateCall() {
    if (!state.activeChatId || videoCallState.isActive || videoCallState.isAwaitingResponse) return;

    const chat = state.chats[state.activeChatId];
    videoCallState.isGroupCall = chat.isGroup;
    videoCallState.isAwaitingResponse = true;
    videoCallState.initiator = 'user';
    videoCallState.activeChatId = chat.id;
    videoCallState.isUserParticipating = true;


    if (chat.isGroup) {
      document.getElementById('outgoing-call-avatar').src = chat.settings.myAvatar || defaultMyGroupAvatar;
      document.getElementById('outgoing-call-name').textContent = chat.settings.myNickname || '我';
    } else {
      document.getElementById('outgoing-call-avatar').src = chat.settings.aiAvatar || defaultAvatar;
      document.getElementById('outgoing-call-name').textContent = chat.name;
    }
    document.querySelector('#outgoing-call-screen .caller-text').textContent = chat.isGroup ? "正在呼叫所有成员..." : "正在呼叫...";
    showScreen('outgoing-call-screen');


    const requestMessage = {
      role: 'system',
      content: chat.isGroup ?
        `[系统提示：用户 (${chat.settings.myNickname || '我'}) 发起了群视频通话请求。请你们各自决策，并使用 "group_call_response" 指令，设置 "decision" 为 "join" 或 "decline" 来回应。]` :
        `[系统提示：用户向你发起了视频通话请求。请根据你的人设，使用 "video_call_response" 指令，并设置 "decision" 为 "accept" 或 "reject" 来回应。]`,
      timestamp: Date.now(),
      isHidden: true,
    };
    chat.history.push(requestMessage);
    await db.chats.put(chat);


    await triggerAiResponse();
  }


  function startVideoCall() {
    const chat = state.chats[videoCallState.activeChatId];
    if (!chat) return;

    videoCallState.isActive = true;
    videoCallState.isAwaitingResponse = false;
    videoCallState.startTime = Date.now();
    videoCallState.callHistory = [];


    const preCallHistory = chat.history.slice(-10);
    videoCallState.preCallContext = preCallHistory.map(msg => {
      const sender = msg.role === 'user' ? (chat.settings.myNickname || '我') : (msg.senderName || chat.name);
      return `${sender}: ${String(msg.content).substring(0, 50)}...`;
    }).join('\n');


    updateParticipantAvatars();

    document.getElementById('video-call-main').innerHTML = `<em>${videoCallState.isGroupCall ? '群聊已建立...' : '正在接通...'}</em>`;
    videoCallState.isAiResponding = false;
    videoCallState.isAiSpeaking = false;
    videoCallState.isTtsPlaying = false;
    videoCallState.canUserSpeak = true;
    videoCallState.currentAiTurnId = 0;
    videoCallState.hasRenderedAiResponse = false;
    videoCallState.renderedAiTurnId = 0;
    setVideoCallStatusText('');
    videoCallAutoListenEnabled = true;
    resetVideoCallAutoListenState();
    showScreen('video-call-screen');

    // 应用视频通话优化设置
    if (typeof window.applyVideoOptimizationToCall === 'function') {
      window.applyVideoOptimizationToCall(chat);
    }

    hideVideoCallManualMicButton();
    document.getElementById('join-call-btn').style.display = videoCallState.isUserParticipating ? 'none' : 'block';

    // v0.1.30 挂载 Live2D (异步, 不阻塞通话初始化)
    mountLive2DForCall(chat);

    if (callTimerInterval) clearInterval(callTimerInterval);
    callTimerInterval = setInterval(updateCallTimer, 1000);
    updateCallTimer();

    triggerAiInCallAction();
  }

  function minimizeVideoCall() {
    if (!videoCallState.isActive) return;


    document.getElementById('video-call-restore-btn').style.display = 'flex';


    showScreen('chat-interface-screen');


    console.log("视频通话已最小化。");
  }


  function restoreVideoCall() {
    if (!videoCallState.isActive) return;


    document.getElementById('video-call-restore-btn').style.display = 'none';


    showScreen('video-call-screen');
    console.log("视频通话已恢复。");
  }

  function getVideoCallRecordingMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ];

    if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') {
      return '';
    }

    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
  }

  async function ensureVideoCallMicStream() {
    if (videoCallMicStream && videoCallMicStream.getAudioTracks().some(track => track.readyState === 'live')) {
      return videoCallMicStream;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('当前环境不支持麦克风录音');
    }

    videoCallMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return videoCallMicStream;
  }

  function setVideoCallRecordingButtonState(isRecording) {
    const speakBtn = document.getElementById('user-speak-btn');
    if (!speakBtn) return;

    speakBtn.classList.toggle('recording', isRecording);
    speakBtn.title = isRecording ? '点击停止录音并识别' : '点击开始录音';
  }

  function hideVideoCallManualMicButton() {
    const speakBtn = document.getElementById('user-speak-btn');
    if (speakBtn) {
      speakBtn.style.display = 'none';
    }
  }

  function clearVideoCallAutoListenTimers() {
    videoCallAutoListenTimers.forEach(timerId => clearTimeout(timerId));
    videoCallAutoListenTimers = [];

    if (videoCallAutoListenAnimationFrame) {
      cancelAnimationFrame(videoCallAutoListenAnimationFrame);
      videoCallAutoListenAnimationFrame = null;
    }
  }

  function cleanupVideoCallAudioAnalysis() {
    clearVideoCallAutoListenTimers();

    if (videoCallAudioSource) {
      try {
        videoCallAudioSource.disconnect();
      } catch (error) {
        console.warn('视频通话音量检测输入节点断开失败:', error);
      }
      videoCallAudioSource = null;
    }

    if (videoCallAnalyser) {
      try {
        videoCallAnalyser.disconnect();
      } catch (error) {
        console.warn('视频通话音量检测节点断开失败:', error);
      }
      videoCallAnalyser = null;
    }

    if (videoCallAudioContext) {
      try {
        videoCallAudioContext.close();
      } catch (error) {
        console.warn('视频通话 AudioContext 关闭失败:', error);
      }
      videoCallAudioContext = null;
    }
  }

  function stopVideoCallMicStream() {
    if (videoCallMicStream) {
      videoCallMicStream.getTracks().forEach(track => track.stop());
      videoCallMicStream = null;
    }
  }

  function resetVideoCallAutoListenState() {
    videoCallIsListening = false;
    videoCallIsRecording = false;
    videoCallIsRecognizing = false;
    videoCallAutoListenStartedAt = 0;
    videoCallUserSpeechStartedAt = 0;
    videoCallLastVoiceAt = 0;
    videoCallHasDetectedSpeech = false;
    videoCallAutoStopReason = 'manual';
  }

  function stopVideoCallRecording(shouldProcessRecording = true, stopReason = 'manual') {
    if (!videoCallMediaRecorder || videoCallMediaRecorder.state === 'inactive') return;

    videoCallAutoStopReason = stopReason;
    videoCallMediaRecorder.__shouldProcessVideoCallRecording = shouldProcessRecording;
    videoCallMediaRecorder.stop();
  }

  async function processVideoCallRecording(audioBlob) {
    if (!videoCallState.isActive || !audioBlob || audioBlob.size === 0) return;

    const userAvatar = document.querySelector('.participant-avatar-wrapper[data-participant-id="user"] .participant-avatar');

    try {
      videoCallIsRecognizing = true;
      setVideoCallStatusText('正在识别…');

      if (typeof window.transcribeAudioBlob !== 'function') {
        throw new Error('ASR 转写函数不可用');
      }

      const recognizedText = String(await window.transcribeAudioBlob(audioBlob)).trim();
      if (!recognizedText) {
        setVideoCallStatusText('未识别到有效语音');
        return;
      }

      if (userAvatar) {
        userAvatar.classList.add('speaking');
      }

      triggerAiInCallAction(recognizedText);
    } catch (error) {
      console.error('视频通话 ASR 识别失败:', error);
      setVideoCallStatusText('语音识别失败');
      if (typeof showToast === 'function') {
        showToast('语音识别失败：' + (error && error.message ? error.message : '未知错误'));
      } else if (typeof showCustomAlert === 'function') {
        showCustomAlert('语音识别失败', error && error.message ? error.message : '未知错误');
      }
    } finally {
      videoCallIsRecognizing = false;
      if (userAvatar) {
        userAvatar.classList.remove('speaking');
      }
    }
  }

  async function startVideoCallRecording() {
    if (!videoCallState.isActive || !videoCallState.isUserParticipating || isVideoCallRecording) return;

    const stream = await ensureVideoCallMicStream();
    const mimeType = getVideoCallRecordingMimeType();
    const recorderOptions = mimeType ? { mimeType } : {};

    videoCallRecordedChunks = [];
    videoCallMediaRecorder = new MediaRecorder(stream, recorderOptions);
    videoCallMediaRecorder.__shouldProcessVideoCallRecording = true;

    videoCallMediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) {
        videoCallRecordedChunks.push(event.data);
      }
    });

    videoCallMediaRecorder.addEventListener('stop', () => {
      const chunks = videoCallRecordedChunks;
      const shouldProcessRecording = videoCallMediaRecorder.__shouldProcessVideoCallRecording;
      const blobType = videoCallMediaRecorder.mimeType || mimeType || 'audio/webm';
      const stopReason = videoCallAutoStopReason;

      isVideoCallRecording = false;
      videoCallIsRecording = false;
      videoCallIsListening = false;
      setVideoCallRecordingButtonState(false);
      cleanupVideoCallAudioAnalysis();
      stopVideoCallMicStream();
      videoCallRecordedChunks = [];
      videoCallMediaRecorder = null;

      const recordedMs = Date.now() - videoCallAutoListenStartedAt;
      resetVideoCallAutoListenState();

      if (!shouldProcessRecording || !videoCallState.isActive) {
        if (stopReason === 'no-speech' && videoCallState.isActive) {
          setVideoCallStatusText('未检测到有效语音');
        }
        return;
      }

      if (recordedMs < VIDEO_CALL_AUTO_LISTEN_CONFIG.minRecordingMs) {
        setVideoCallStatusText('未识别到有效语音');
        return;
      }

      if (chunks.length === 0) {
        setVideoCallStatusText('未识别到有效语音');
        return;
      }

      const audioBlob = new Blob(chunks, { type: blobType });
      processVideoCallRecording(audioBlob);
    }, { once: true });

    videoCallMediaRecorder.start();
    isVideoCallRecording = true;
    videoCallIsRecording = true;
    setVideoCallRecordingButtonState(true);
  }

  async function handleVideoCallUserSpeak() {
    if (!videoCallState.isActive || !videoCallState.isUserParticipating) return;

    if (isVideoCallRecording) {
      stopVideoCallRecording(true);
      return;
    }

    try {
      await startVideoCallRecording();
    } catch (error) {
      console.error('视频通话录音启动失败:', error);
      setVideoCallRecordingButtonState(false);
      stopVideoCallMicStream();
      if (typeof showToast === 'function') {
        showToast('无法开始录音：' + (error && error.message ? error.message : '未知错误'));
      } else if (typeof showCustomAlert === 'function') {
        showCustomAlert('无法开始录音', error && error.message ? error.message : '未知错误');
      }
    }
  }

  function stopVideoCallAutoListening(shouldProcessRecording = false, stopReason = 'manual') {
    clearVideoCallAutoListenTimers();
    cleanupVideoCallAudioAnalysis();

    if (videoCallMediaRecorder && videoCallMediaRecorder.state !== 'inactive') {
      stopVideoCallRecording(shouldProcessRecording, stopReason);
      return;
    }

    stopVideoCallMicStream();
    videoCallRecordedChunks = [];
    isVideoCallRecording = false;
    videoCallIsRecording = false;
    resetVideoCallAutoListenState();
    setVideoCallRecordingButtonState(false);
  }

  function releaseVideoCallMicrophone() {
    stopVideoCallAutoListening(false, 'hangup');
  }

  function monitorVideoCallSilence() {
    if (!videoCallState.isActive || !videoCallAutoListenEnabled || !videoCallIsListening || !videoCallAnalyser) return;

    const buffer = new Uint8Array(videoCallAnalyser.fftSize);
    videoCallAnalyser.getByteTimeDomainData(buffer);

    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) {
      const normalized = (buffer[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }

    const volume = Math.sqrt(sumSquares / buffer.length);
    const now = Date.now();
    const elapsed = now - videoCallAutoListenStartedAt;
    const hasVoice = volume >= VIDEO_CALL_AUTO_LISTEN_CONFIG.volumeThreshold;

    if (hasVoice) {
      videoCallLastVoiceAt = now;
      if (!videoCallHasDetectedSpeech) {
        videoCallHasDetectedSpeech = true;
        videoCallUserSpeechStartedAt = now;
        setVideoCallStatusText('检测到你在说话…');
      }
    }

    if (!videoCallHasDetectedSpeech && elapsed >= VIDEO_CALL_AUTO_LISTEN_CONFIG.noSpeechTimeoutMs) {
      stopVideoCallRecording(false, 'no-speech');
      return;
    }

    if (videoCallHasDetectedSpeech && elapsed >= VIDEO_CALL_AUTO_LISTEN_CONFIG.minRecordingMs && now - videoCallLastVoiceAt >= VIDEO_CALL_AUTO_LISTEN_CONFIG.silenceAfterSpeechMs) {
      stopVideoCallRecording(true, 'silence');
      return;
    }

    if (elapsed >= VIDEO_CALL_AUTO_LISTEN_CONFIG.maxRecordingMs) {
      stopVideoCallRecording(true, 'max-duration');
      return;
    }

    videoCallAutoListenAnimationFrame = requestAnimationFrame(monitorVideoCallSilence);
  }

  async function startVideoCallAutoListening() {
    if (!videoCallState.isActive || !videoCallState.isUserParticipating || !videoCallAutoListenEnabled) return;
    if (videoCallState.isAiResponding || videoCallState.isAiSpeaking || videoCallState.isTtsPlaying || videoCallIsListening || videoCallIsRecognizing || isVideoCallRecording) return;

    try {
      setVideoCallStatusText('我在听…');
      await startVideoCallRecording();

      if (!videoCallState.isActive || !videoCallAutoListenEnabled || videoCallState.isAiResponding || videoCallState.isAiSpeaking || videoCallState.isTtsPlaying) {
        stopVideoCallAutoListening(false, 'interrupted');
        return;
      }

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('当前环境不支持 Web Audio 音量检测');
      }

      videoCallAudioContext = new AudioContextClass();
      videoCallAudioSource = videoCallAudioContext.createMediaStreamSource(videoCallMicStream);
      videoCallAnalyser = videoCallAudioContext.createAnalyser();
      videoCallAnalyser.fftSize = 2048;
      videoCallAudioSource.connect(videoCallAnalyser);

      videoCallIsListening = true;
      videoCallAutoListenStartedAt = Date.now();
      videoCallUserSpeechStartedAt = 0;
      videoCallLastVoiceAt = 0;
      videoCallHasDetectedSpeech = false;
      videoCallAutoStopReason = 'manual';

      videoCallAutoListenTimers.push(setTimeout(() => {
        if (videoCallIsListening && !videoCallHasDetectedSpeech) {
          stopVideoCallRecording(false, 'no-speech');
        }
      }, VIDEO_CALL_AUTO_LISTEN_CONFIG.noSpeechTimeoutMs));

      videoCallAutoListenTimers.push(setTimeout(() => {
        if (videoCallIsListening) {
          stopVideoCallRecording(true, 'max-duration');
        }
      }, VIDEO_CALL_AUTO_LISTEN_CONFIG.maxRecordingMs));

      monitorVideoCallSilence();
    } catch (error) {
      console.error('视频通话自动聆听启动失败:', error);
      stopVideoCallAutoListening(false, 'start-error');
      setVideoCallStatusText('无法开始聆听');
      if (typeof showToast === 'function') {
        showToast('无法开始聆听：' + (error && error.message ? error.message : '未知错误'));
      }
    }
  }

  async function endVideoCall() {
    if (!videoCallState.isActive) return;
    // v0.1.30 卸载 Live2D (释放 PIXI GL 资源)
    unmountLive2DForCall();
    stopTtsQueue();
    document.getElementById('video-call-restore-btn').style.display = 'none';
    const duration = Math.floor((Date.now() - videoCallState.startTime) / 1000);
    const durationText = `${Math.floor(duration / 60)}分${duration % 60}秒`;
    const endCallText = `通话结束，时长 ${durationText}`;

    const chat = state.chats[videoCallState.activeChatId];
    if (chat) {

      const participantsData = [];
      if (videoCallState.isGroupCall) {
        videoCallState.participants.forEach(p => participantsData.push({
          name: p.originalName,
          avatar: p.avatar
        }));
        if (videoCallState.isUserParticipating) {
          participantsData.unshift({
            name: chat.settings.myNickname || '我',
            avatar: chat.settings.myAvatar || defaultMyGroupAvatar
          });
        }
      } else {
        participantsData.push({
          name: chat.name,
          avatar: chat.settings.aiAvatar || defaultAvatar
        });
        participantsData.unshift({
          name: '我',
          avatar: chat.settings.myAvatar || defaultAvatar
        });
      }

      const callRecord = {
        chatId: videoCallState.activeChatId,
        timestamp: Date.now(),
        duration: duration,
        participants: participantsData,
        transcript: [...videoCallState.callHistory]
      };
      const newRecordId = await db.callRecords.add(callRecord);
      console.log("通话记录已保存:", callRecord);


      let summaryMessage = {
        role: videoCallState.initiator === 'user' ? 'user' : 'assistant',
        content: endCallText,
        timestamp: Date.now(),
        callRecordId: newRecordId
      };
      if (chat.isGroup && summaryMessage.role === 'assistant') {
        summaryMessage.senderName = videoCallState.callRequester || chat.members[0]?.originalName || chat.name;
      }
      chat.history.push(summaryMessage);






      const callTranscriptForAI = videoCallState.callHistory.map(h => {
        const sender = h.role === 'user' ? (chat.settings.myNickname || '我') : h.senderName;
        return `${sender}: ${h.content}`;
      }).join('\n');



      summarizeCallTranscript(chat.id, callTranscriptForAI);


      const hiddenReactionInstruction = {
        role: 'system',
        content: `[系统指令：视频通话刚刚结束。请你以角色的口吻，向用户主动发送一两条消息，来自然地总结这次通话的要点、确认达成的约定，或者表达你的感受。]`,
        timestamp: Date.now() + 1,
        isHidden: true
      };
      chat.history.push(hiddenReactionInstruction);


      await db.chats.put(chat);
    }


    clearInterval(callTimerInterval);
    callTimerInterval = null;

    videoCallAutoListenEnabled = false;
    releaseVideoCallMicrophone();

    // 停止摄像头
    if (typeof stopCamera === 'function') {
      stopCamera();
    }

    videoCallState = {
      isActive: false,
      isAwaitingResponse: false,
      isGroupCall: false,
      activeChatId: null,
      initiator: null,
      startTime: null,
      participants: [],
      isUserParticipating: true,
      callHistory: [],
      preCallContext: "",
      isAiResponding: false,
      isAiSpeaking: false,
      isTtsPlaying: false,
      canUserSpeak: true
    };


    if (chat) {
      openChat(chat.id);
      triggerAiResponse();
    }
  }




  function updateParticipantAvatars() {
    const grid = document.getElementById('participant-avatars-grid');
    grid.innerHTML = '';
    const chat = state.chats[videoCallState.activeChatId];
    if (!chat) return;

    let participantsToRender = [];


    if (videoCallState.isGroupCall) {

      participantsToRender = [...videoCallState.participants];

      if (videoCallState.isUserParticipating) {
        participantsToRender.unshift({
          id: 'user',
          name: chat.settings.myNickname || '我',
          avatar: chat.settings.myAvatar || defaultMyGroupAvatar
        });
      }
    } else {

      participantsToRender.push({
        id: 'ai',
        name: chat.name,
        avatar: chat.settings.aiAvatar || defaultAvatar
      });
    }

    participantsToRender.forEach(p => {
      const wrapper = document.createElement('div');
      wrapper.className = 'participant-avatar-wrapper';
      wrapper.dataset.participantId = p.id;
      const displayName = p.groupNickname || p.name;
      wrapper.innerHTML = `
            <img src="${p.avatar}" class="participant-avatar" alt="${displayName}">
            <div class="participant-name">${displayName}</div>
        `;
      grid.appendChild(wrapper);
    });
  }


  function handleUserJoinCall() {
    if (!videoCallState.isActive || videoCallState.isUserParticipating) return;

    videoCallState.isUserParticipating = true;
    updateParticipantAvatars();


    hideVideoCallManualMicButton();
    document.getElementById('join-call-btn').style.display = 'none';


    triggerAiInCallAction("[系统提示：用户加入了通话]");
  }



  function updateCallTimer() {
    if (!videoCallState.isActive) return;
    const elapsed = Math.floor((Date.now() - videoCallState.startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    document.getElementById('call-timer').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }


  function showIncomingCallModal(callType = 'video', chat = null) {
    // 如果没有传入 chat，则从 state 中获取
    if (!chat) {
      const activeChatId = callType === 'video' ? videoCallState.activeChatId : voiceCallState.activeChatId;
      chat = state.chats[activeChatId];
    }
    if (!chat) return;

    const callTypeText = callType === 'video' ? '视频通话' : '语音通话';
    const callTypeTextShort = callType === 'video' ? '视频' : '语音';

    if (chat.isGroup) {
      const currentCallState = callType === 'video' ? videoCallState : voiceCallState;
      const requesterName = currentCallState.callRequester || chat.members[0]?.name || '一位成员';
      document.getElementById('caller-avatar').src = chat.settings.groupAvatar || defaultGroupAvatar;
      document.getElementById('caller-name').textContent = chat.name;
      document.querySelector('.incoming-call-content .caller-text').textContent = `${requesterName} 邀请你加入群${callTypeTextShort}`;
    } else {
      document.getElementById('caller-avatar').src = chat.settings.aiAvatar || defaultAvatar;
      document.getElementById('caller-name').textContent = chat.name;
      document.querySelector('.incoming-call-content .caller-text').textContent = `邀请你${callTypeText}`;
    }

    // 保存通话类型到 modal 的 dataset 中，以便接听/拒绝时使用
    const modal = document.getElementById('incoming-call-modal');
    modal.dataset.callType = callType;
    modal.classList.add('visible');
  }



  function hideIncomingCallModal() {
    document.getElementById('incoming-call-modal').classList.remove('visible');
  }


  async function triggerAiInCallAction(userInput = null) {
    if (!videoCallState.isActive || videoCallState.isAiResponding) return;

    stopVideoCallAutoListening(false, 'ai-start');

    const aiTurnId = ++videoCallAiTurnSeq;
    videoCallState.currentAiTurnId = aiTurnId;
    videoCallState.hasRenderedAiResponse = false;
    videoCallState.renderedAiTurnId = 0;
    videoCallState.isAiResponding = true;
    videoCallState.canUserSpeak = false;
    if (userInput) {
      setVideoCallStatusText('AI正在思考…');
    }

    const chat = state.chats[videoCallState.activeChatId];
    // 与主聊天保持一致：实时通过 resolveApiSlotConfig 解析主 API 配置，
    // 否则 state.apiConfig 在使用预设引用 / 切换预设 / 角色独立配置时可能为空或过期，
    // 导致代理 baseUrl 非法、通话接不通
    let { proxyUrl, apiKey, model, isGemini, geminiSafetySettings } = state.apiConfig;

    if (typeof window.resolveApiSlotConfig === 'function') {
      const resolvedConfig = await window.resolveApiSlotConfig('main', {
        apiOverride: chat.apiOverride, // Use chat-specific override
        character: state.character,
      });
      if (resolvedConfig) {
        // Use a new object to avoid modifying the original resolvedConfig
        const config = { ...resolvedConfig };
        proxyUrl = config.proxyUrl;
        apiKey = config.apiKey;
        model = config.model;
        isGemini = config.isGemini;
        geminiSafetySettings = config.geminiSafetySettings;
      }
    }

    // 兜底: resolveApiSlotConfig 不返回 isGemini, 上面赋值后是 undefined
    // 用 proxyUrl 重新判断, 跟主聊天 / 群聊 / cphone 保持一致
    if (!isGemini && proxyUrl) {
      isGemini = proxyUrl.includes('generativelanguage');
    }

    if (!proxyUrl || !apiKey || !model) {
      console.error('Video Call failed: API config not resolved.', { proxyUrl, apiKey, model });
      const callFeed = document.getElementById('video-call-main');
      const errorBubble = document.createElement('div');
      errorBubble.className = 'call-message-bubble ai-speech';
      errorBubble.style.color = '#ff8a80';
      errorBubble.textContent = `[ERROR: API configuration is missing or incomplete.]`;
      if(callFeed) callFeed.appendChild(errorBubble);
      onVideoCallTtsQueueFinished(); // Ensure state is cleaned up
      return;
    }
    const callFeed = document.getElementById('video-call-main');
    const userNickname = chat.settings.myNickname || '我';

    let worldBookContent = '';
    // 获取所有应该使用的世界书ID（包括手动选择的和全局的）
    let allWorldBookIds = [...(chat.settings.linkedWorldBookIds || [])];
    // 添加所有全局世界书
    state.worldBooks.forEach(wb => {
      if (wb.isGlobal && !allWorldBookIds.includes(wb.id)) {
        allWorldBookIds.push(wb.id);
      }
    });

    if (allWorldBookIds.length > 0) {
      const linkedContents = allWorldBookIds.map(bookId => {
        const worldBook = state.worldBooks.find(wb => wb.id === bookId);
        return worldBook && worldBook.content ? `\n\n## 世界书: ${worldBook.name}\n${worldBook.content}` : '';
      }).filter(Boolean).join('');
        if (linkedContents) {
          worldBookContent = `# --- 世界书 (World Book) ---
# 【最高优先级指令：绝对真理】
# 以下内容是你所在世界的"物理法则"和"基础常识"。
# 无论用户是否提及，你都【必须】时刻主动应用这些设定来指导你的思考和描写。
# 它们是无条件生效的，不需要触发词。
${linkedContents}
# --- 世界书设定结束 ---
`;
        }
      }
    let longTermMemoryContent = '';
    const memMode = chat.settings?.memoryMode || (chat.settings?.enableStructuredMemory ? 'structured' : 'diary');
    if (memMode === 'vector' && window.vectorMemoryManager) {
      longTermMemoryContent = window.vectorMemoryManager.serializeCoreMemories(chat);
    } else if (memMode === 'structured' && window.structuredMemoryManager) {
      longTermMemoryContent = window.structuredMemoryManager.serializeForPrompt(chat);
    } else if (chat.longTermMemory && chat.longTermMemory.length > 0) {
      longTermMemoryContent = chat.longTermMemory.map(mem => `- (记录于 ${formatTimeAgo(mem.timestamp)}) ${mem.content}`).join('\n');
    }
    const longTermMemoryContext = longTermMemoryContent ? `\n# 长期记忆 (必须参考)\n${longTermMemoryContent}` : '';

    // ★ 时间感知：跟主聊天走（enableTimePerception / 自定义时间 / 时区）
    const timeContextText = (() => {
      if (!chat.settings.enableTimePerception) return '';
      const now = new Date();
      const customTimeInfo = typeof window.getCustomTime === 'function' ? window.getCustomTime() : null;
      const customTimeEnabled = customTimeInfo && customTimeInfo.enabled;
      let currentTime, localizedDate;
      if (customTimeEnabled) {
        const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const weekDay = weekDays[customTimeInfo.date.getDay()];
        currentTime = `${customTimeInfo.year}年${customTimeInfo.month}月${customTimeInfo.day}日${weekDay} ${String(customTimeInfo.hour).padStart(2, '0')}:${String(customTimeInfo.minute).padStart(2, '0')}`;
        localizedDate = customTimeInfo.date;
      } else {
        const selectedTimeZone = chat.settings.timeZone || 'Asia/Shanghai';
        currentTime = now.toLocaleString('zh-CN', { timeZone: selectedTimeZone, dateStyle: 'full', timeStyle: 'short' });
        localizedDate = new Date(now.toLocaleString('en-US', { timeZone: selectedTimeZone }));
      }
      const timeOfDayGreeting = typeof window.getTimeOfDayGreeting === 'function' ? window.getTimeOfDayGreeting(localizedDate) : '';
      return `- **当前时间**: ${currentTime} (${timeOfDayGreeting})`;
    })();
    const timeContextBlock = timeContextText ? `\n# 当前时间\n${timeContextText}` : '';

    if (userInput && videoCallState.isUserParticipating) {
      const userTimestamp = Date.now();
      const userBubble = document.createElement('div');
      userBubble.className = 'call-message-bubble user-speech';
      userBubble.textContent = userInput;
      userBubble.dataset.timestamp = userTimestamp;
      addLongPressListener(userBubble, () => showCallMessageActions(userTimestamp));
      callFeed.appendChild(userBubble);
      callFeed.scrollTop = callFeed.scrollHeight;

      // 检查是否启用真实摄像头并获取截图
      let userContent = userInput;
      if (chat.videoOptimization && chat.videoOptimization.enableRealCamera) {
        const capturedImage = window.getLastCameraCapture ? window.getLastCameraCapture() : null;
        if (capturedImage) {
          // 为支持视觉的模型构建多模态消息
          userContent = [
            { type: 'text', text: userInput },
            { type: 'image_url', image_url: { url: capturedImage } }
          ];
        }
      }

      videoCallState.callHistory.push({
        role: 'user',
        content: userContent,
        timestamp: userTimestamp
      });
    }


    let inCallPrompt;
    if (videoCallState.isGroupCall) {
      const participantNames = videoCallState.participants.map(p => p.name);
      if (videoCallState.isUserParticipating) {
        participantNames.unshift(userNickname);
      }
      inCallPrompt = `
        # 你的任务
        你是一个群聊视频通话的导演。你的任务是扮演所有【除了用户以外】的AI角色，并以【第三人称旁观视角】来描述他们在通话中的所有动作和语言。
        # 核心规则
        1.  **【身份铁律】**: 用户的身份是【${userNickname}】。你【绝对不能】生成 \`name\` 字段为 **"${userNickname}"** 的发言。
        2.  **【视角铁律】**: 你的回复【绝对不能】使用第一人称"我"。
        3.  **格式**: 你的回复【必须】是一个JSON数组，每个对象代表一个角色的发言，格式为：\`{"name": "角色名", "speech": "*他笑了笑* 大家好啊！"}\`。
        4.  **角色扮演**: 严格遵守每个角色的设定。
        # 当前情景
        你们正在一个群视频通话中。
         ${longTermMemoryContext}
        **通话前的聊天摘要**:
        ${videoCallState.preCallContext}
        **当前参与者**: ${participantNames.join('、 ')}。
        **通话刚刚开始...**
        ${worldBookContent}${timeContextBlock}
        现在，请根据【通话前摘要】和下面的【通话实时记录】，继续进行对话。
        `;
    } else {
      let openingContext = videoCallState.initiator === 'user' ?
        `你刚刚接听了用户的视频通话请求。` :
        `用户刚刚接听了你主动发起的视频通话。`;
      const interleavedMode = chat.videoOptimization && chat.videoOptimization.interleavedMode;
      const layoutRule = interleavedMode
        ? `4.  **【穿插排版】**: 旁白和对话按自然发生的顺序穿插排列。例如：先一段动作描写，再说一两句话，再一段动作描写，再说话。不要把所有旁白堆在一起。
        5.  **【对话规则】**: 对话是角色实际说出的话，每句对话会独立显示，可以连续说多句话。`
        : `4.  **【旁白规则】**: 旁白只描述动作、表情、神态等视觉信息，所有旁白会合并显示为一段灰色文字。
        5.  **【对话规则】**: 对话是角色实际说出的话，每句对话会独立显示，可以连续说多句话。`;
      inCallPrompt = `
        # 你的任务
        你现在是一个场景描述引擎。你的任务是扮演 ${chat.name} (${chat.settings.aiPersona})，并以【第三人称旁观视角】来描述TA在视频通话中的所有动作和语言。
        # 核心规则
        1.  **【【【视角铁律】】】**: 你的回复【绝对不能】使用第一人称"我"。必须使用第三人称，如"他"、"她"、或直接使用角色名"${chat.name}"。
        2.  **【格式要求】**: 你的回复【必须】是一个JSON数组，包含旁白和对话。格式如下：
           - 旁白（动作、表情描述）：\`{"type": "narration", "content": "他笑了笑，挠了挠头"}\`
           - 对话（角色说的话）：\`{"type": "dialogue", "content": "你好啊！"}\`
        3.  **【多句发言】**: 你可以一次说多句话，每句话作为独立的dialogue对象。例如：
           \`[{"type": "narration", "content": "他笑了笑"}, {"type": "dialogue", "content": "你好啊！"}, {"type": "dialogue", "content": "最近怎么样？"}]\`
        ${layoutRule}
        # 当前情景
        你正在和用户（${userNickname}，人设: ${chat.settings.myPersona}）进行视频通话。
        ${longTermMemoryContext}${timeContextBlock}
        **${openingContext}**
        **通话前的聊天摘要 (这是你们通话的原因，至关重要！)**:
        ${videoCallState.preCallContext}
        现在，请根据【通话前摘要】和下面的【通话实时记录】，继续进行对话。记住：必须返回JSON数组格式，区分旁白和对话。
        `;
    }


    const messagesForApi = [{
      role: 'system',
      content: inCallPrompt
    },
    ...videoCallState.callHistory.map(h => ({
      role: h.role,
      content: h.content
    }))
    ];

    if (videoCallState.callHistory.length === 0) {
      const firstLineTrigger = videoCallState.initiator === 'user' ? `*你按下了接听键...*` : `*对方按下了接听键...*`;
      messagesForApi.push({
        role: 'user',
        content: firstLineTrigger
      });
    }

    try {
      // let isGemini = proxyUrl === GEMINI_API_URL; // isGemini is now resolved from config
      let geminiConfig = toGeminiRequestData(model, apiKey, inCallPrompt, messagesForApi)
      const callPayload = {
        model: model,
        messages: messagesForApi,
        temperature: state.globalSettings.apiTemperature || 0.8,
        top_p: state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0,
        presence_penalty: state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0,
        frequency_penalty: state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0
      };
      // 当”主API代理”开启时，与主聊天保持一致，走后端代理转发，否则直连会因渠道仅支持后端代理而无法接通
      const useMainApiProxy = !isGemini
        && typeof window.fetchViaOpenAICompatibleProxy === 'function'
        && typeof window.isMainApiProxyEnabled === 'function'
        && window.isMainApiProxyEnabled();
      const response = isGemini
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : useMainApiProxy
          ? await window.fetchViaOpenAICompatibleProxy({
            baseUrl: proxyUrl,
            targetPath: '/chat/completions',
            apiKey,
            payload: callPayload,
            method: 'POST'
          })
          : await fetch(`${proxyUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(callPayload)
          });
      if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try { const errData = await response.json(); errMsg = errData?.error?.message || errData?.message || errData?.detail || JSON.stringify(errData); } catch(e) { errMsg += ` (${response.statusText})`; }
        throw new Error(errMsg);
      }

      const data = await response.json();
      const rawAiResponse = isGemini ? data.candidates[0].content.parts[0].text : data.choices[0].message.content;
      const aiResponse = cleanMinimaxCallResponse(rawAiResponse, { provider: proxyUrl, model });
      if (!String(aiResponse || '').trim()) {
        throw new Error('AI返回为空');
      }

      const connectingElement = callFeed.querySelector('em');
      if (connectingElement) connectingElement.remove();
      if (videoCallState.isGroupCall) {
        const speechArray = parseAiResponse(aiResponse);
        let renderedAiContentCount = 0;
        speechArray.forEach(turn => {
          if (!turn.name || turn.name === userNickname || !turn.speech) return;
          const aiTimestamp = Date.now() + Math.random();
          const aiBubble = document.createElement('div');
          aiBubble.className = 'call-message-bubble ai-speech';
          aiBubble.innerHTML = `<strong>${turn.name}:</strong> ${turn.speech}`;
          aiBubble.dataset.timestamp = aiTimestamp;
          addLongPressListener(aiBubble, () => showCallMessageActions(aiTimestamp));
          callFeed.appendChild(aiBubble);
          renderedAiContentCount++;
          markVideoCallAiResponseRendered(aiTurnId);
          videoCallState.callHistory.push({
            role: 'assistant',
            content: `${turn.name}: ${turn.speech}`,
            timestamp: aiTimestamp
          });

          const speaker = videoCallState.participants.find(p => p.name === turn.name);
          if (speaker) {
            const speakingAvatar = document.querySelector(`.participant-avatar-wrapper[data-participant-id="${speaker.id}"] .participant-avatar`);
            if (speakingAvatar) {
              speakingAvatar.classList.add('speaking');
              setTimeout(() => speakingAvatar.classList.remove('speaking'), 2000);
            }
          }
        });
        if (renderedAiContentCount === 0) {
          throw new Error('AI返回为空');
        }
        onVideoCallTtsQueueFinished();
      } else {
        // 单人视频通话：支持旁白和多句对话
        const enableTts = chat.settings.enableTts !== false;
        const voiceId = chat.settings.minimaxVoiceId;
        const interleavedMode = chat.videoOptimization && chat.videoOptimization.interleavedMode;
        let hasVideoCallTtsPlayback = false;

        // 尝试解析为JSON数组
        const messagesArray = parseAiResponse(aiResponse);

        if (interleavedMode) {
          // 穿插模式：按原始顺序逐条渲染
          let dialogueCount = 0;
          let renderedAiContentCount = 0;
          messagesArray.forEach((msg, index) => {
            const aiTimestamp = Date.now() + index + 1;

            if (msg.type === 'narration') {
              const narrationBubble = document.createElement('div');
              narrationBubble.className = 'call-message-bubble ai-narration';
              narrationBubble.style.color = '#999';
              narrationBubble.style.fontStyle = 'italic';
              narrationBubble.textContent = msg.content;
              narrationBubble.dataset.timestamp = aiTimestamp;
              addLongPressListener(narrationBubble, () => showCallMessageActions(aiTimestamp));
              callFeed.appendChild(narrationBubble);
              renderedAiContentCount++;
              markVideoCallAiResponseRendered(aiTurnId);

              videoCallState.callHistory.push({
                role: 'assistant',
                content: `[旁白] ${msg.content}`,
                timestamp: aiTimestamp
              });
            } else {
              const aiBubble = document.createElement('div');
              aiBubble.className = 'call-message-bubble ai-speech';
              aiBubble.textContent = msg.content;
              aiBubble.dataset.timestamp = aiTimestamp;
              addLongPressListener(aiBubble, () => showCallMessageActions(aiTimestamp));
              callFeed.appendChild(aiBubble);
              renderedAiContentCount++;
              markVideoCallAiResponseRendered(aiTurnId);

              videoCallState.callHistory.push({
                role: 'assistant',
                content: msg.content,
                timestamp: aiTimestamp
              });

              if (enableTts && voiceId) {
                setVideoCallStatusText('AI正在说话…');
                if (playVideoCallPureTTS(msg.content, voiceId, { source: 'videoCall' })) {
                  hasVideoCallTtsPlayback = true;
                  videoCallState.isAiSpeaking = true;
                  videoCallState.isTtsPlaying = true;
                }
              }
              dialogueCount++;
            }
          });

          // 头像动画
          const speakingAvatar = document.querySelector(`.participant-avatar-wrapper[data-participant-id="ai"] .participant-avatar`);
          if (speakingAvatar && dialogueCount > 0) {
            speakingAvatar.classList.add('speaking');
            const totalLength = messagesArray.filter(m => m.type === 'dialogue').reduce((sum, m) => sum + (m.content || '').length, 0);
            const speakTime = Math.min(totalLength * 200, 5000);
            setTimeout(() => speakingAvatar.classList.remove('speaking'), speakTime);
          }
          if (renderedAiContentCount === 0) {
            throw new Error('AI返回为空');
          }
          if (!hasVideoCallTtsPlayback) {
            onVideoCallTtsQueueFinished();
          }
        } else {
          // 默认模式：旁白合并在前，对话在后
          let renderedAiContentCount = 0;
          const narrations = messagesArray.filter(m => m.type === 'narration');
          const dialogues = messagesArray.filter(m => m.type === 'dialogue' || m.type === 'text' || (!m.type && (m.content || m.speech)));

          if (narrations.length > 0) {
            const narrationTimestamp = Date.now();
            const narrationBubble = document.createElement('div');
            narrationBubble.className = 'call-message-bubble ai-narration';
            narrationBubble.style.color = '#999';
            narrationBubble.style.fontStyle = 'italic';
            const narrationText = narrations.map(n => n.content).join(' ');
            narrationBubble.textContent = narrationText;
            narrationBubble.dataset.timestamp = narrationTimestamp;
            addLongPressListener(narrationBubble, () => showCallMessageActions(narrationTimestamp));
            callFeed.appendChild(narrationBubble);
            renderedAiContentCount++;
            markVideoCallAiResponseRendered(aiTurnId);

            videoCallState.callHistory.push({
              role: 'assistant',
              content: `[旁白] ${narrationText}`,
              timestamp: narrationTimestamp
            });
          }

          dialogues.forEach((msg, index) => {
            const messageContent = msg.content || msg.speech || '';
            if (!String(messageContent || '').trim()) return;
            const aiTimestamp = Date.now() + index + 1;

            const aiBubble = document.createElement('div');
            aiBubble.className = 'call-message-bubble ai-speech';
            aiBubble.textContent = messageContent;
            aiBubble.dataset.timestamp = aiTimestamp;
            addLongPressListener(aiBubble, () => showCallMessageActions(aiTimestamp));
            callFeed.appendChild(aiBubble);
            renderedAiContentCount++;
            markVideoCallAiResponseRendered(aiTurnId);

            videoCallState.callHistory.push({
              role: 'assistant',
              content: messageContent,
              timestamp: aiTimestamp
            });

            if (enableTts && voiceId) {
              setVideoCallStatusText('AI正在说话…');
              if (playVideoCallPureTTS(messageContent, voiceId, { source: 'videoCall' })) {
                hasVideoCallTtsPlayback = true;
                videoCallState.isAiSpeaking = true;
                videoCallState.isTtsPlaying = true;
              }
            }
          });

          // 头像动画
          const speakingAvatar = document.querySelector(`.participant-avatar-wrapper[data-participant-id="ai"] .participant-avatar`);
          if (speakingAvatar) {
            speakingAvatar.classList.add('speaking');
            const totalLength = dialogues.reduce((sum, msg) => sum + (msg.content || '').length, 0);
            const speakTime = Math.min(totalLength * 200, 5000);
            setTimeout(() => speakingAvatar.classList.remove('speaking'), speakTime);
          }
          if (renderedAiContentCount === 0) {
            throw new Error('AI返回为空');
          }
          if (!hasVideoCallTtsPlayback) {
            onVideoCallTtsQueueFinished();
          }
        }
      }

      callFeed.scrollTop = callFeed.scrollHeight;

    } catch (error) {
      const errorBubble = document.createElement('div');
      errorBubble.className = 'call-message-bubble ai-speech';
      errorBubble.style.color = '#ff8a80';
      errorBubble.textContent = `[ERROR: ${error.message}]`;
      callFeed.appendChild(errorBubble);
      callFeed.scrollTop = callFeed.scrollHeight;
      videoCallState.callHistory.push({
        role: 'assistant',
        content: `[ERROR: ${error.message}]`
      });
      markVideoCallAiResponseRendered(aiTurnId);
      onVideoCallTtsQueueFinished();
    }
    // ★ 每次发送后修剪历史
    trimCallHistory(videoCallState);
  }
  function trimCallHistory(callState) {
    if (callState.callHistory.length > 100) {
      callState.callHistory = callState.callHistory.slice(-100);
    }
  }




  function toggleCallButtons(isGroup) {
    document.getElementById('video-call-btn').style.display = isGroup ? 'none' : 'flex';
    document.getElementById('group-video-call-btn').style.display = isGroup ? 'flex' : 'none';
    document.getElementById('voice-call-btn').style.display = isGroup ? 'none' : 'flex';
    document.getElementById('group-voice-call-btn').style.display = isGroup ? 'flex' : 'none';
  }

  function logCallTtsRecoveryDiag(callType, reason = '') {
    if (!reason) return;
    try {
      window.runtimeDiag?.log?.('CALL_STATE_RECOVERED_AFTER_TTS_ERROR', {
        callType,
        errorType: reason,
        textLength: 0
      });
    } catch (error) {
      console.warn('[通话TTS恢复诊断日志失败]', error);
    }
  }

  function onVideoCallTtsQueueFinished(reason = '') {
    if (!videoCallState.isActive) return;
    if (videoCallState.isAiResponding && !videoCallState.hasRenderedAiResponse) {
      console.warn('[视频通话] 忽略早于本轮 AI 回复渲染的 TTS 完成回调。');
      return;
    }

    videoCallState.isAiResponding = false;
    videoCallState.isAiSpeaking = false;
    videoCallState.isTtsPlaying = false;
    videoCallState.canUserSpeak = true;
    setVideoCallStatusText(reason ? '语音播放失败，已跳过本句，可以说话' : 'AI已说完，可以说话');
    logCallTtsRecoveryDiag('video', reason);
    console.log('[视频通话] AI 多段 TTS 已全部播放完成，可以说话。');
    startVideoCallAutoListening();
  }

  // ==================== 语音通话功能 ====================

  async function handleInitiateVoiceCall() {
    if (!state.activeChatId || voiceCallState.isActive || voiceCallState.isAwaitingResponse) return;

    const chat = state.chats[state.activeChatId];
    voiceCallState.isGroupCall = chat.isGroup;
    voiceCallState.isAwaitingResponse = true;
    voiceCallState.initiator = 'user';
    voiceCallState.activeChatId = chat.id;
    voiceCallState.isUserParticipating = true;

    if (chat.isGroup) {
      document.getElementById('outgoing-call-avatar').src = chat.settings.myAvatar || defaultMyGroupAvatar;
      document.getElementById('outgoing-call-name').textContent = chat.settings.myNickname || '我';
    } else {
      document.getElementById('outgoing-call-avatar').src = chat.settings.aiAvatar || defaultAvatar;
      document.getElementById('outgoing-call-name').textContent = chat.name;
    }
    document.querySelector('#outgoing-call-screen .caller-text').textContent = chat.isGroup ? "正在呼叫所有成员..." : "正在呼叫...";
    showScreen('outgoing-call-screen');

    const requestMessage = {
      role: 'system',
      content: chat.isGroup ?
        `[系统提示：用户 (${chat.settings.myNickname || '我'}) 发起了群语音通话请求。请你们各自决策，并使用 "group_voice_response" 指令，设置 "decision" 为 "join" 或 "decline" 来回应。]` :
        `[系统提示：用户向你发起了语音通话请求。请根据你的人设，使用 "voice_call_response" 指令，并设置 "decision" 为 "accept" 或 "reject" 来回应。]`,
      timestamp: Date.now(),
      isHidden: true,
    };
    chat.history.push(requestMessage);
    await db.chats.put(chat);

    await triggerAiResponse();
  }

  function getVoiceCallRecordingMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ];

    if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') {
      return '';
    }

    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
  }

  async function ensureVoiceCallMicStream() {
    if (voiceCallMicStream && voiceCallMicStream.getAudioTracks().some(track => track.readyState === 'live')) {
      return voiceCallMicStream;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('当前环境不支持麦克风录音');
    }

    voiceCallMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return voiceCallMicStream;
  }

  function setVoiceCallRecordingButtonState(isRecording) {
    const speakBtn = document.getElementById('voice-user-speak-btn');
    if (!speakBtn) return;

    speakBtn.classList.toggle('recording', isRecording);
    speakBtn.title = isRecording ? '点击停止录音并识别' : '点击开始录音';
  }

  function hideVoiceCallManualMicButton() {
    const speakBtn = document.getElementById('voice-user-speak-btn');
    if (speakBtn) {
      speakBtn.style.display = 'none';
    }
  }

  function clearVoiceCallAutoListenTimers() {
    voiceCallAutoListenTimers.forEach(timerId => clearTimeout(timerId));
    voiceCallAutoListenTimers = [];

    if (voiceCallAutoListenAnimationFrame) {
      cancelAnimationFrame(voiceCallAutoListenAnimationFrame);
      voiceCallAutoListenAnimationFrame = null;
    }
  }

  function cleanupVoiceCallAudioAnalysis() {
    clearVoiceCallAutoListenTimers();

    if (voiceCallAnalyser) {
      try {
        voiceCallAnalyser.disconnect();
      } catch (error) {
        console.warn('语音通话音量检测节点断开失败:', error);
      }
      voiceCallAnalyser = null;
    }

    if (voiceCallAudioContext) {
      try {
        voiceCallAudioContext.close();
      } catch (error) {
        console.warn('语音通话 AudioContext 关闭失败:', error);
      }
      voiceCallAudioContext = null;
    }
  }

  function stopVoiceCallMicStream() {
    if (voiceCallMicStream) {
      voiceCallMicStream.getTracks().forEach(track => track.stop());
      voiceCallMicStream = null;
    }
  }

  function resetVoiceCallAutoListenState() {
    voiceCallIsListening = false;
    voiceCallIsRecording = false;
    voiceCallIsRecognizing = false;
    voiceCallAutoListenStartedAt = 0;
    voiceCallUserSpeechStartedAt = 0;
    voiceCallLastVoiceAt = 0;
    voiceCallHasDetectedSpeech = false;
    voiceCallAutoStopReason = 'manual';
  }

  function stopVoiceCallRecording(shouldProcessRecording = true, stopReason = 'manual') {
    if (!voiceCallMediaRecorder || voiceCallMediaRecorder.state === 'inactive') return;

    voiceCallAutoStopReason = stopReason;
    voiceCallMediaRecorder.__shouldProcessVoiceCallRecording = shouldProcessRecording;
    voiceCallMediaRecorder.stop();
  }

  async function processVoiceCallRecording(audioBlob) {
    if (!voiceCallState.isActive || !audioBlob || audioBlob.size === 0) return;

    const userAvatar = document.querySelector('#voice-participant-avatars-grid .participant-avatar-wrapper[data-participant-id="user"] .participant-avatar');

    try {
      voiceCallIsRecognizing = true;
      // v0.2.30.25: 不切到"正在识别…", 保持"倾听中"直到 ASR 完成
      // (用户原话: 提示文字应该只有"倾听中/思考中/点击打断")

      if (typeof window.transcribeAudioBlob !== 'function') {
        throw new Error('ASR 转写函数不可用');
      }

      const recognizedText = String(await window.transcribeAudioBlob(audioBlob)).trim();
      if (!recognizedText) {
        setVoiceCallStatusText('未识别到有效语音');
        return;
      }

      if (userAvatar) {
        userAvatar.classList.add('speaking');
      }

      triggerAiInVoiceCallAction(recognizedText);
    } catch (error) {
      console.error('语音通话 ASR 识别失败:', error);
      setVoiceCallStatusText('语音识别失败');
      if (typeof showToast === 'function') {
        showToast('语音识别失败：' + (error && error.message ? error.message : '未知错误'));
      } else if (typeof showCustomAlert === 'function') {
        showCustomAlert('语音识别失败', error && error.message ? error.message : '未知错误');
      }
    } finally {
      voiceCallIsRecognizing = false;
      if (userAvatar) {
        userAvatar.classList.remove('speaking');
      }
    }
  }

  async function startVoiceCallRecording() {
    if (!voiceCallState.isActive || !voiceCallState.isUserParticipating || isVoiceCallRecording) return;

    const stream = await ensureVoiceCallMicStream();
    const mimeType = getVoiceCallRecordingMimeType();
    const recorderOptions = mimeType ? { mimeType } : {};

    voiceCallRecordedChunks = [];
    voiceCallMediaRecorder = new MediaRecorder(stream, recorderOptions);
    voiceCallMediaRecorder.__shouldProcessVoiceCallRecording = true;

    voiceCallMediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) {
        voiceCallRecordedChunks.push(event.data);
      }
    });

    voiceCallMediaRecorder.addEventListener('stop', () => {
      const chunks = voiceCallRecordedChunks;
      const shouldProcessRecording = voiceCallMediaRecorder.__shouldProcessVoiceCallRecording;
      const blobType = voiceCallMediaRecorder.mimeType || mimeType || 'audio/webm';
      const stopReason = voiceCallAutoStopReason;

      isVoiceCallRecording = false;
      voiceCallIsRecording = false;
      voiceCallIsListening = false;
      setVoiceCallRecordingButtonState(false);
      cleanupVoiceCallAudioAnalysis();
      stopVoiceCallMicStream();
      voiceCallRecordedChunks = [];
      voiceCallMediaRecorder = null;

      const recordedMs = Date.now() - voiceCallAutoListenStartedAt;
      resetVoiceCallAutoListenState();

      if (!shouldProcessRecording || !voiceCallState.isActive) return;

      if (stopReason === 'no-speech') {
        setVoiceCallStatusText('未检测到有效语音');
        return;
      }

      if (recordedMs < VOICE_CALL_AUTO_LISTEN_CONFIG.minRecordingMs) {
        setVoiceCallStatusText('未识别到有效语音');
        return;
      }

      const audioBlob = new Blob(chunks, { type: blobType });
      processVoiceCallRecording(audioBlob);
    }, { once: true });

    voiceCallMediaRecorder.start();
    isVoiceCallRecording = true;
    voiceCallIsRecording = true;
    setVoiceCallRecordingButtonState(true);

    // v0.2.30.24: 用户开始说话 → 切换光晕到 listening (挂断键位置, 大光晕闪烁)
    setVoiceCallGlowState('listening');
    setVoiceCallStatusText('倾听中');
  }

  async function handleVoiceCallUserSpeak() {
    if (!voiceCallState.isActive || !voiceCallState.isUserParticipating) return;

    if (isVoiceCallRecording) {
      stopVoiceCallRecording(true);
      return;
    }

    // v0.2.30.24: "点击打断" 逻辑 — AI 正在说话时, 先停 TTS 再录音
    if (voiceCallState.isTtsPlaying || voiceCallState.isAiSpeaking) {
      try {
        stopTtsQueue();
      } catch (e) {
        console.warn('[语音通话] stopTtsQueue 失败:', e);
      }
      // 状态清零, 让 startVoiceCallRecording 不会因为 isAiSpeaking/isTtsPlaying return
      voiceCallState.isAiResponding = false;
      voiceCallState.isAiSpeaking = false;
      voiceCallState.isTtsPlaying = false;
      voiceCallState.canUserSpeak = true;
    }

    try {
      await startVoiceCallRecording();
    } catch (error) {
      console.error('语音通话录音启动失败:', error);
      if (typeof showToast === 'function') {
        showToast('无法开始录音：' + (error && error.message ? error.message : '未知错误'));
      } else if (typeof showCustomAlert === 'function') {
        showCustomAlert('无法开始录音', error && error.message ? error.message : '未知错误');
      }
    }
  }

  function stopVoiceCallAutoListening(shouldProcessRecording = false, stopReason = 'manual') {
    clearVoiceCallAutoListenTimers();
    cleanupVoiceCallAudioAnalysis();

    if (voiceCallMediaRecorder && voiceCallMediaRecorder.state !== 'inactive') {
      stopVoiceCallRecording(shouldProcessRecording, stopReason);
      return;
    }

    stopVoiceCallMicStream();
    voiceCallRecordedChunks = [];
    isVoiceCallRecording = false;
    voiceCallIsRecording = false;
    resetVoiceCallAutoListenState();
    setVoiceCallRecordingButtonState(false);
  }

  function releaseVoiceCallMicrophone() {
    stopVoiceCallAutoListening(false, 'hangup');
  }

  function monitorVoiceCallSilence() {
    if (!voiceCallState.isActive || !voiceCallAutoListenEnabled || !voiceCallIsListening || !voiceCallAnalyser) return;

    const buffer = new Uint8Array(voiceCallAnalyser.fftSize);
    voiceCallAnalyser.getByteTimeDomainData(buffer);

    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) {
      const normalized = (buffer[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }

    const volume = Math.sqrt(sumSquares / buffer.length);
    const now = Date.now();
    const elapsed = now - voiceCallAutoListenStartedAt;
    const hasVoice = volume >= VOICE_CALL_AUTO_LISTEN_CONFIG.volumeThreshold;

    if (hasVoice) {
      voiceCallLastVoiceAt = now;
      if (!voiceCallHasDetectedSpeech) {
        voiceCallHasDetectedSpeech = true;
        voiceCallUserSpeechStartedAt = now;
        // v0.2.30.25: 不切到"检测到你在说话…", 保持"倾听中"
      }
    }

    if (!voiceCallHasDetectedSpeech && elapsed >= VOICE_CALL_AUTO_LISTEN_CONFIG.noSpeechTimeoutMs) {
      stopVoiceCallRecording(false, 'no-speech');
      return;
    }

    if (voiceCallHasDetectedSpeech && elapsed >= VOICE_CALL_AUTO_LISTEN_CONFIG.minRecordingMs && now - voiceCallLastVoiceAt >= VOICE_CALL_AUTO_LISTEN_CONFIG.silenceAfterSpeechMs) {
      stopVoiceCallRecording(true, 'silence');
      return;
    }

    if (elapsed >= VOICE_CALL_AUTO_LISTEN_CONFIG.maxRecordingMs) {
      stopVoiceCallRecording(true, 'max-duration');
      return;
    }

    voiceCallAutoListenAnimationFrame = requestAnimationFrame(monitorVoiceCallSilence);
  }

  async function startVoiceCallAutoListening() {
    if (!voiceCallState.isActive || !voiceCallState.isUserParticipating || !voiceCallAutoListenEnabled) return;
    if (voiceCallState.isAiResponding || voiceCallState.isAiSpeaking || voiceCallState.isTtsPlaying || voiceCallIsListening || voiceCallIsRecognizing || isVoiceCallRecording) return;

    try {
      // v0.2.30.25: 不切到"我在听…", startVoiceCallRecording 内部会立刻 setVoiceCallStatusText('倾听中')
      await startVoiceCallRecording();

      if (!voiceCallState.isActive || !voiceCallAutoListenEnabled || voiceCallState.isAiResponding || voiceCallState.isAiSpeaking || voiceCallState.isTtsPlaying) {
        stopVoiceCallAutoListening(false, 'interrupted');
        return;
      }

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('当前环境不支持 Web Audio 音量检测');
      }

      voiceCallAudioContext = new AudioContextClass();
      const source = voiceCallAudioContext.createMediaStreamSource(voiceCallMicStream);
      voiceCallAnalyser = voiceCallAudioContext.createAnalyser();
      voiceCallAnalyser.fftSize = 2048;
      source.connect(voiceCallAnalyser);

      voiceCallIsListening = true;
      voiceCallAutoListenStartedAt = Date.now();
      voiceCallUserSpeechStartedAt = 0;
      voiceCallLastVoiceAt = 0;
      voiceCallHasDetectedSpeech = false;
      voiceCallAutoStopReason = 'manual';

      voiceCallAutoListenTimers.push(setTimeout(() => {
        if (voiceCallIsListening && !voiceCallHasDetectedSpeech) {
          stopVoiceCallRecording(false, 'no-speech');
        }
      }, VOICE_CALL_AUTO_LISTEN_CONFIG.noSpeechTimeoutMs));

      voiceCallAutoListenTimers.push(setTimeout(() => {
        if (voiceCallIsListening) {
          stopVoiceCallRecording(true, 'max-duration');
        }
      }, VOICE_CALL_AUTO_LISTEN_CONFIG.maxRecordingMs));

      monitorVoiceCallSilence();
    } catch (error) {
      console.error('语音通话自动聆听启动失败:', error);
      stopVoiceCallAutoListening(false, 'start-error');
      setVoiceCallStatusText('无法开始聆听');
      if (typeof showToast === 'function') {
        showToast('无法开始聆听：' + (error && error.message ? error.message : '未知错误'));
      }
    }
  }

  function logVoiceCallDiag(event, details = {}) {
    try {
      window.runtimeDiag?.log?.(event, {
        textLength: typeof details.textLength === 'number' ? details.textLength : undefined,
        skipReason: details.skipReason || undefined,
        durationMs: typeof details.durationMs === 'number' ? details.durationMs : undefined,
        queueLength: typeof details.queueLength === 'number'
          ? details.queueLength
          : (typeof window.getCallTtsQueueLength === 'function' ? window.getCallTtsQueueLength() : 0),
        isTtsPlaying: typeof details.isTtsPlaying === 'boolean'
          ? details.isTtsPlaying
          : Boolean(voiceCallState.isTtsPlaying || (typeof window.isCallTtsPlaying === 'function' && window.isCallTtsPlaying())),
        hasVoiceId: Boolean(details.hasVoiceId)
      });
    } catch (error) {
      console.warn('[语音通话诊断日志失败]', event, error);
    }
  }

  function enqueueVoiceCallDisplayTextTts(displayText, voiceId) {
    const ttsText = String(displayText || '').trim();
    const queueLength = typeof window.getCallTtsQueueLength === 'function' ? window.getCallTtsQueueLength() : 0;
    const hasVoiceId = Boolean(voiceId);

    logVoiceCallDiag('VOICE_CALL_TTS_ENQUEUE_ATTEMPT', {
      textLength: ttsText.length,
      queueLength,
      hasVoiceId
    });

    if (!ttsText) {
      logVoiceCallDiag('VOICE_CALL_TTS_ENQUEUE_SKIP', {
        textLength: 0,
        skipReason: 'emptyDisplayText',
        queueLength,
        hasVoiceId
      });
      return false;
    }

    const enqueued = typeof playVideoCallPureTTS === 'function'
      ? playVideoCallPureTTS(ttsText, voiceId, { source: 'voiceCall' })
      : false;

    if (enqueued) {
      voiceCallState.isAiSpeaking = true;
      voiceCallState.isTtsPlaying = true;
      voiceCallState.canUserSpeak = false;
      setVoiceCallStatusText('点击打断');
      // v0.2.30.24: AI 开始说话 → 光晕迁移到 AI 头像 (大, 闪烁)
      setVoiceCallGlowState('speaking');
      return true;
    }

    logVoiceCallDiag('VOICE_CALL_TTS_ENQUEUE_SKIP', {
      textLength: ttsText.length,
      skipReason: 'enqueueRejected',
      queueLength,
      hasVoiceId
    });
    return false;
  }

  function onVoiceCallTtsQueueFinished(reason = '') {
    if (!voiceCallState.isActive) return;

    voiceCallState.isAiResponding = false;
    voiceCallState.isAiSpeaking = false;
    voiceCallState.isTtsPlaying = false;
    voiceCallState.canUserSpeak = true;
    // v0.2.30.24: AI 说完 → 状态清空, 不显示"可以说话了"中间态
    // 下一轮是倾听中, autoListen 启动后监测到声音才切 'listening' + "倾听中"
    setVoiceCallStatusText('');
    setVoiceCallGlowState('idle');
    logCallTtsRecoveryDiag('voice', reason);
    logVoiceCallDiag('VOICE_CALL_TTS_RECOVERED', {
      textLength: 0,
      skipReason: reason || undefined,
      queueLength: typeof window.getCallTtsQueueLength === 'function' ? window.getCallTtsQueueLength() : 0,
      hasVoiceId: false,
      isTtsPlaying: false
    });
    console.log('[语音通话] AI 多段 TTS 已全部播放完成，可以说话。');
    startVoiceCallAutoListening();
  }

  function startVoiceCall() {
    const chat = state.chats[voiceCallState.activeChatId];
    if (!chat) return;

    voiceCallState.isActive = true;
    voiceCallState.isAwaitingResponse = false;
    voiceCallState.startTime = Date.now();
    voiceCallState.callHistory = [];
    voiceCallState.isAiResponding = false;
    voiceCallState.isAiSpeaking = false;
    voiceCallState.isTtsPlaying = false;
    voiceCallState.canUserSpeak = true;

    const preCallHistory = chat.history.slice(-10);
    voiceCallState.preCallContext = preCallHistory.map(msg => {
      const sender = msg.role === 'user' ? (chat.settings.myNickname || '我') : (msg.senderName || chat.name);
      return `${sender}: ${String(msg.content).substring(0, 50)}...`;
    }).join('\n');

    updateVoiceParticipantAvatars();

    document.getElementById('voice-call-main').innerHTML = `<em>${voiceCallState.isGroupCall ? '群聊已建立...' : '正在接通...'}</em>`;
    setVoiceCallStatusText('');
    voiceCallAutoListenEnabled = true;
    resetVoiceCallAutoListenState();
    showScreen('voice-call-screen');

    hideVoiceCallManualMicButton();
    document.getElementById('voice-join-call-btn').style.display = voiceCallState.isUserParticipating ? 'none' : 'block';

    // 通话开始: 显示并重置"启用音频"按钮
    // 防御: 极端路径下(如挂断状态错乱)按钮可能停在 connected
    setVoiceCallAudioUnlockBtnVisibility(true);
    // v0.2.30.24: 通话开始 → 光晕回到 idle (隐藏), 状态文字清零
    setVoiceCallGlowState('idle');
    setVoiceCallStatusText('');

    if (voiceCallTimerInterval) clearInterval(voiceCallTimerInterval);
    voiceCallTimerInterval = setInterval(updateVoiceCallTimer, 1000);
    updateVoiceCallTimer();

    triggerAiInVoiceCallAction();
  }

  function minimizeVoiceCall() {
    if (!voiceCallState.isActive) return;
    document.getElementById('voice-call-restore-btn').style.display = 'flex';
    showScreen('chat-interface-screen');
    console.log("语音通话已最小化。");
  }

  function restoreVoiceCall() {
    if (!voiceCallState.isActive) return;
    document.getElementById('voice-call-restore-btn').style.display = 'none';
    showScreen('voice-call-screen');
    console.log("语音通话已恢复。");
  }

  async function endVoiceCall() {
    // === 挂断停止背景音乐 START ===
    if (window.voiceCallBgAudio) {
      console.log('[Audio] 挂断通话，立刻停止背景音乐');
      window.voiceCallBgAudio.pause();
      window.voiceCallBgAudio.currentTime = 0;
      window.voiceCallBgAudio = null;
    }
    // === 挂断停止背景音乐 END ===

    // 挂断: 重置"启用音频"按钮到 unlock-inactive 并显示
    // 下次再打时按钮要重新出现
    setVoiceCallAudioUnlockBtnVisibility(true);

    if (!voiceCallState.isActive) return;
    stopTtsQueue();
    document.getElementById('voice-call-restore-btn').style.display = 'none';
    const duration = Math.floor((Date.now() - voiceCallState.startTime) / 1000);
    const durationText = `${Math.floor(duration / 60)}分${duration % 60}秒`;
    const endCallText = `语音通话结束，时长 ${durationText}`;

    const chat = state.chats[voiceCallState.activeChatId];
    if (chat) {
      const participantsData = [];
      if (voiceCallState.isGroupCall) {
        voiceCallState.participants.forEach(p => participantsData.push({
          name: p.originalName,
          avatar: p.avatar
        }));
        if (voiceCallState.isUserParticipating) {
          participantsData.unshift({
            name: chat.settings.myNickname || '我',
            avatar: chat.settings.myAvatar || defaultMyGroupAvatar
          });
        }
      } else {
        participantsData.push({
          name: chat.name,
          avatar: chat.settings.aiAvatar || defaultAvatar
        });
        participantsData.unshift({
          name: '我',
          avatar: chat.settings.myAvatar || defaultAvatar
        });
      }

      const callRecord = {
        chatId: voiceCallState.activeChatId,
        timestamp: Date.now(),
        duration: duration,
        participants: participantsData,
        transcript: [...voiceCallState.callHistory],
        callType: 'voice'
      };
      const newRecordId = await db.callRecords.add(callRecord);
      console.log("语音通话记录已保存:", callRecord);

      let summaryMessage = {
        role: voiceCallState.initiator === 'user' ? 'user' : 'assistant',
        content: endCallText,
        timestamp: Date.now(),
        callRecordId: newRecordId
      };
      if (chat.isGroup && summaryMessage.role === 'assistant') {
        summaryMessage.senderName = voiceCallState.callRequester || chat.members[0]?.originalName || chat.name;
      }
      chat.history.push(summaryMessage);

      const callTranscriptForAI = voiceCallState.callHistory.map(h => {
        const sender = h.role === 'user' ? (chat.settings.myNickname || '我') : h.senderName;
        return `${sender}: ${h.content}`;
      }).join('\n');

      summarizeCallTranscript(chat.id, callTranscriptForAI);

      const hiddenReactionInstruction = {
        role: 'system',
        content: `[系统指令：语音通话刚刚结束。请你以角色的口吻，向用户主动发送一两条消息，来自然地总结这次通话的要点、确认达成的约定，或者表达你的感受。]`,
        timestamp: Date.now() + 1,
        isHidden: true
      };
      chat.history.push(hiddenReactionInstruction);

      await db.chats.put(chat);
    }

    clearInterval(voiceCallTimerInterval);
    voiceCallTimerInterval = null;

    voiceCallAutoListenEnabled = false;
    releaseVoiceCallMicrophone();

    voiceCallState.isActive = false;
    voiceCallState.isAwaitingResponse = false;
    voiceCallState.isGroupCall = false;
    voiceCallState.activeChatId = null;
    voiceCallState.initiator = null;
    voiceCallState.startTime = null;
    voiceCallState.participants = [];
    voiceCallState.isUserParticipating = true;
    voiceCallState.callHistory = [];
    voiceCallState.preCallContext = "";
    voiceCallState.isAiResponding = false;
    voiceCallState.isAiSpeaking = false;
    voiceCallState.isTtsPlaying = false;
    voiceCallState.canUserSpeak = true;

    if (chat) {
      openChat(chat.id);
      triggerAiResponse();
    }
  }

  function updateVoiceParticipantAvatars() {
    const grid = document.getElementById('voice-participant-avatars-grid');
    grid.innerHTML = '';
    const chat = state.chats[voiceCallState.activeChatId];
    if (!chat) return;

    let participantsToRender = [];

    if (voiceCallState.isGroupCall) {
      participantsToRender = [...voiceCallState.participants];
      if (voiceCallState.isUserParticipating) {
        participantsToRender.unshift({
          id: 'user',
          name: chat.settings.myNickname || '我',
          avatar: chat.settings.myAvatar || defaultMyGroupAvatar
        });
      }
    } else {
      participantsToRender.push({
        id: 'ai',
        name: chat.name,
        avatar: chat.settings.aiAvatar || defaultAvatar
      });
    }

    participantsToRender.forEach(p => {
      const wrapper = document.createElement('div');
      wrapper.className = 'participant-avatar-wrapper';
      wrapper.dataset.participantId = p.id;
      const displayName = p.groupNickname || p.name;
      // v0.2.30.71: img 放回 wrapper 直接子元素 (listening/speaking 状态显示)
      // vortex wrap 单独嵌套 (thinking 状态显示, 内部 .ccw-avatar 装 img)
      // 之前 v0.2.30.60-70: img 嵌套在 .ccw-avatar 里, vortex wrap 改 absolute 居中但 absolute 参照父级错
      // 跑到 .voice-call-avatar-area 去了, 跟 wrapper 内的 img 错位 80px (用户截图反馈)
      // 修法: wrapper 顶端直接 img + vortex wrap 单独嵌套含 .ccw-avatar img
      // listening/speaking: wrapper 直接 img 显示, vortex display:none
      // thinking: wrapper 直接 img 隐藏, vortex display:flex (内含 .ccw-avatar img 跟漩涡流光叠)
      // 两份 img 用同一 src, 浏览器缓存复用, 网络无压力
      wrapper.innerHTML = `
        <img src="${p.avatar}" class="participant-avatar" alt="${displayName}">
        <div class="ccw-vortex-wrap">
          <div class="ccw-layer">
            <div class="ccw-glow-base"></div>
            <div class="ccw-inner-light"></div>
            <svg class="ccw-svg" viewBox="0 0 148 148">
              <defs>
                <linearGradient id="voice-call-soft-gold-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#FFFDF0" stop-opacity="0.72"/>
                  <stop offset="18%" stop-color="#FFF0AD" stop-opacity="0.60"/>
                  <stop offset="35%" stop-color="#FFD66A" stop-opacity="0.48"/>
                  <stop offset="55%" stop-color="#FFB52E" stop-opacity="0.30"/>
                  <stop offset="80%" stop-color="#F28A18" stop-opacity="0.10"/>
                  <stop offset="100%" stop-color="#E85B00" stop-opacity="0"/>
                </linearGradient>
              </defs>
              <g class="ccw-soft-halo" stroke="url(#voice-call-soft-gold-gradient)" fill="none" stroke-linecap="round" stroke-width="7">
                <path d="M74 23 C56 22 38 29 25 44 C17 53 12 61 8 69" transform="rotate(0 74 74)"/>
                <path d="M74 23 C56 22 38 29 25 44 C17 53 12 61 8 69" transform="rotate(60 74 74)"/>
                <path d="M74 23 C56 22 38 29 25 44 C17 53 12 61 8 69" transform="rotate(120 74 74)"/>
                <path d="M74 23 C56 22 38 29 25 44 C17 53 12 61 8 69" transform="rotate(180 74 74)"/>
                <path d="M74 23 C56 22 38 29 25 44 C17 53 12 61 8 69" transform="rotate(240 74 74)"/>
                <path d="M74 23 C56 22 38 29 25 44 C17 53 12 61 8 69" transform="rotate(300 74 74)"/>
              </g>
              <g class="ccw-soft-streak" stroke="url(#voice-call-soft-gold-gradient)" fill="none" stroke-linecap="round" stroke-width="4">
                <path d="M74 24 C57 23 40 30 27 44 C19 52 14 59 10 66" transform="rotate(0 74 74)"/>
                <path d="M74 24 C57 23 40 30 27 44 C19 52 14 59 10 66" transform="rotate(60 74 74)"/>
                <path d="M74 24 C57 23 40 30 27 44 C19 52 14 59 10 66" transform="rotate(120 74 74)"/>
                <path d="M74 24 C57 23 40 30 27 44 C19 52 14 59 10 66" transform="rotate(180 74 74)"/>
                <path d="M74 24 C57 23 40 30 27 44 C19 52 14 59 10 66" transform="rotate(240 74 74)"/>
                <path d="M74 24 C57 23 40 30 27 44 C19 52 14 59 10 66" transform="rotate(300 74 74)"/>
              </g>
            </svg>
          </div>
          <div class="ccw-avatar">
            <img src="${p.avatar}" class="participant-avatar" alt="${displayName}">
          </div>
        </div>
      `;
      grid.appendChild(wrapper);
    });
  }

  function handleUserJoinVoiceCall() {
    if (!voiceCallState.isActive || voiceCallState.isUserParticipating) return;

    voiceCallState.isUserParticipating = true;
    updateVoiceParticipantAvatars();

    hideVoiceCallManualMicButton();
    document.getElementById('voice-join-call-btn').style.display = 'none';

    triggerAiInVoiceCallAction("[系统提示：用户加入了通话]");
  }

  function updateVoiceCallTimer() {
    if (!voiceCallState.isActive) return;
    const elapsed = Math.floor((Date.now() - voiceCallState.startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    document.getElementById('voice-call-timer').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  // 立即停止语音通话等待背景音乐（"启用音频"按钮播放的 call-waiting.mp3）
  // 在 AI 文字出现的第一时间硬停止，避免淡出造成的延迟
  // v0.2.30.52: 修 "通话接通后彩铃按钮没消失" — 之前 if (!window.voiceCallBgAudio) return 早返回, 没用过"启用音频"按钮 (没创建 bgAudio) 时根本走不到隐藏按钮那行
  // 改成"先隐藏按钮, 再停止音频"解耦 — 通话接通按钮就该消失, 跟彩铃有没有在播无关
  function stopVoiceCallWaitingMusic(reason = '') {
    // 1. 先隐藏彩铃按钮 — 不管彩铃有没有在播, AI 文字出现 = 通话已开始, 按钮历史使命完成
    setVoiceCallAudioUnlockBtnVisibility(false);

    // 2. 再尝试停止彩铃音频 (没创建过 bgAudio 就跳过)
    if (!window.voiceCallBgAudio) return;
    try {
      window.voiceCallBgAudio.pause();
      window.voiceCallBgAudio.currentTime = 0;
    } catch (e) {
      console.warn('[Audio] 停止背景音乐失败:', e);
    }
    window.voiceCallBgAudio = null;
    console.log('[Audio] AI 文字出现，立即停止背景音乐' + (reason ? ` (${reason})` : ''));
  }

  async function triggerAiInVoiceCallAction(userInput = null) {
    if (!voiceCallState.isActive || voiceCallState.isAiResponding) return;

    stopVoiceCallAutoListening(false, 'ai-start');
    voiceCallState.isAiResponding = true;
    voiceCallState.isAiSpeaking = false;
    voiceCallState.isTtsPlaying = false;
    voiceCallState.canUserSpeak = false;
    setVoiceCallStatusText('思考中');
    // v0.2.30.56: 过渡动画 — listening → 光斑从挂断键飞 → thinking
    // v0.2.30.68 改 animation 0.5s → 0.7s, v0.2.30.71 setTimeout 0.5s → 0.7s 跟 animation 匹配
    // 之前 500ms < 0.7s animation — 过渡没飞完就切到 thinking, vortex wrap + transitioning ::before 叠在一起看着"光晕占据"
    setVoiceCallGlowState('transitioning');
    setTimeout(() => {
      setVoiceCallGlowState('thinking');
    }, 700);

    const chat = state.chats[voiceCallState.activeChatId];
    // 与主聊天保持一致：实时通过 resolveApiSlotConfig 解析主 API 配置，
    // 否则 state.apiConfig 在使用预设引用 / 切换预设 / 角色独立配置时可能为空或过期，
    // 导致代理 baseUrl 非法、通话接不通
    let { proxyUrl, apiKey, model, isGemini, geminiSafetySettings } = state.apiConfig;

    if (typeof window.resolveApiSlotConfig === 'function') {
      const resolvedConfig = await window.resolveApiSlotConfig('main', {
        apiOverride: chat.apiOverride, // Use chat-specific override
        character: state.character,
      });
      if (resolvedConfig) {
        // Use a new object to avoid modifying the original resolvedConfig
        const config = { ...resolvedConfig };
        proxyUrl = config.proxyUrl;
        apiKey = config.apiKey;
        model = config.model;
        isGemini = config.isGemini;
        geminiSafetySettings = config.geminiSafetySettings;
      }
    }

    // 兜底: resolveApiSlotConfig 不返回 isGemini, 上面赋值后是 undefined
    // 用 proxyUrl 重新判断, 跟主聊天 / 群聊 / cphone 保持一致
    if (!isGemini && proxyUrl) {
      isGemini = proxyUrl.includes('generativelanguage');
    }

    if (!proxyUrl || !apiKey || !model) {
      console.error('Voice Call failed: API config not resolved.', { proxyUrl, apiKey, model });
      const callFeed = document.getElementById('voice-call-main');
      const errorBubble = document.createElement('div');
      errorBubble.className = 'call-message-bubble ai-speech';
      errorBubble.style.color = '#ff8a80';
      errorBubble.textContent = `[ERROR: API configuration is missing or incomplete.]`;
      if(callFeed) callFeed.appendChild(errorBubble);
      onVoiceCallTtsQueueFinished(); // Ensure state is cleaned up
      return;
    }
    const callFeed = document.getElementById('voice-call-main');
    const userNickname = chat.settings.myNickname || '我';

    let worldBookContent = '';
    let allWorldBookIds = [...(chat.settings.linkedWorldBookIds || [])];
    state.worldBooks.forEach(wb => {
      if (wb.isGlobal && !allWorldBookIds.includes(wb.id)) {
        allWorldBookIds.push(wb.id);
      }
    });

    if (allWorldBookIds.length > 0) {
      const linkedContents = allWorldBookIds.map(bookId => {
        const worldBook = state.worldBooks.find(wb => wb.id === bookId);
        return worldBook && worldBook.content ? `\n\n## 世界书: ${worldBook.name}\n${worldBook.content}` : '';
      }).filter(Boolean).join('');
        if (linkedContents) {
          worldBookContent = `# --- 世界书 (World Book) ---
# 【最高优先级指令：绝对真理】
# 以下内容是你所在世界的"物理法则"和"基础常识"。
# 无论用户是否提及，你都【必须】时刻主动应用这些设定来指导你的思考和描写。
# 它们是无条件生效的，不需要触发词。
${linkedContents}
# --- 世界书设定结束 ---
`;
      }
    }
    let longTermMemoryContent = '';
    const memMode = chat.settings?.memoryMode || (chat.settings?.enableStructuredMemory ? 'structured' : 'diary');
    if (memMode === 'vector' && window.vectorMemoryManager) {
      longTermMemoryContent = window.vectorMemoryManager.serializeCoreMemories(chat);
    } else if (memMode === 'structured' && window.structuredMemoryManager) {
      longTermMemoryContent = window.structuredMemoryManager.serializeForPrompt(chat);
    } else if (chat.longTermMemory && chat.longTermMemory.length > 0) {
      longTermMemoryContent = chat.longTermMemory.map(mem => `- (记录于 ${formatTimeAgo(mem.timestamp)}) ${mem.content}`).join('\n');
    }
    const longTermMemoryContext = longTermMemoryContent ? `\n# 长期记忆 (必须参考)\n${longTermMemoryContent}` : '';

    // ★ 时间感知：跟主聊天走（enableTimePerception / 自定义时间 / 时区）
    const timeContextText = (() => {
      if (!chat.settings.enableTimePerception) return '';
      const now = new Date();
      const customTimeInfo = typeof window.getCustomTime === 'function' ? window.getCustomTime() : null;
      const customTimeEnabled = customTimeInfo && customTimeInfo.enabled;
      let currentTime, localizedDate;
      if (customTimeEnabled) {
        const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const weekDay = weekDays[customTimeInfo.date.getDay()];
        currentTime = `${customTimeInfo.year}年${customTimeInfo.month}月${customTimeInfo.day}日${weekDay} ${String(customTimeInfo.hour).padStart(2, '0')}:${String(customTimeInfo.minute).padStart(2, '0')}`;
        localizedDate = customTimeInfo.date;
      } else {
        const selectedTimeZone = chat.settings.timeZone || 'Asia/Shanghai';
        currentTime = now.toLocaleString('zh-CN', { timeZone: selectedTimeZone, dateStyle: 'full', timeStyle: 'short' });
        localizedDate = new Date(now.toLocaleString('en-US', { timeZone: selectedTimeZone }));
      }
      const timeOfDayGreeting = typeof window.getTimeOfDayGreeting === 'function' ? window.getTimeOfDayGreeting(localizedDate) : '';
      return `- **当前时间**: ${currentTime} (${timeOfDayGreeting})`;
    })();
    const timeContextBlock = timeContextText ? `\n# 当前时间\n${timeContextText}` : '';

    if (userInput && voiceCallState.isUserParticipating) {
      const userTimestamp = Date.now();
      const userBubble = document.createElement('div');
      userBubble.className = 'call-message-bubble user-speech';
      userBubble.textContent = userInput;
      userBubble.dataset.timestamp = userTimestamp;
      addLongPressListener(userBubble, () => showCallMessageActions(userTimestamp));
      callFeed.appendChild(userBubble);
      callFeed.scrollTop = callFeed.scrollHeight;

      voiceCallState.callHistory.push({
        role: 'user',
        content: userInput,
        timestamp: userTimestamp
      });
    }

    let inCallPrompt;
    if (voiceCallState.isGroupCall) {
      const participantNames = voiceCallState.participants.map(p => p.name);
      if (voiceCallState.isUserParticipating) {
        participantNames.unshift(userNickname);
      }
      inCallPrompt = `
# 你的任务
你是一个群聊语音通话的导演。你的任务是扮演所有【除了用户以外】的AI角色，并生成他们在通话中说的话。

# 【核心规则 - 语音通话专用】
1. **【身份铁律】**: 用户的身份是【${userNickname}】。你【绝对不能】生成 \`name\` 字段为 **"${userNickname}"** 的发言。
2. **【纯对话铁律】**: 这是语音通话，不是视频通话。你们只能听到声音，看不到对方。因此：
   - 你的回复【只能包含角色说的话】
   - 【绝对禁止】任何动作描写（如：*笑了笑*、*点头*、*挥手*等）
   - 【绝对禁止】任何表情符号（如：😊、❤️等）
   - 【绝对禁止】任何视觉相关的描述（如：看起来、表情、动作等）
3. **格式**: 你的回复【必须】是一个JSON数组，每个对象代表一个角色的发言，格式为：\`{"name": "角色名", "speech": "大家好啊！"}\`。
4. **角色扮演**: 严格遵守每个角色的设定。

# 当前情景
你们正在一个群语音通话中。你们只能通过声音交流，看不到彼此。
${longTermMemoryContext}
**通话前的聊天摘要**:
${voiceCallState.preCallContext}
**当前参与者**: ${participantNames.join('、 ')}。
**通话刚刚开始...**
${worldBookContent}${timeContextBlock}
现在，请根据【通话前摘要】和下面的【通话实时记录】，继续进行对话。记住：只输出对话内容，不要有任何动作或表情描写。
`;
    } else {
      let openingContext = voiceCallState.initiator === 'user' ?
        `你刚刚接听了用户的语音通话请求。` :
        `用户刚刚接听了你主动发起的语音通话。`;
      inCallPrompt = `
# 你的任务
你现在正在和用户进行语音通话。你扮演 ${chat.name} (${chat.settings.aiPersona})。

# 【核心规则 - 语音通话专用】
1. **【纯对话铁律】**: 这是语音通话，不是视频通话。你们只能听到声音，看不到对方。因此：
   - 你的回复【只能包含你说的话】
   - 【绝对禁止】任何动作描写（如：*笑了笑*、*点头*、*挥手*、*看着你*等）
   - 【绝对禁止】任何表情符号（如：😊、❤️、😂等）
   - 【绝对禁止】任何视觉相关的描述（如：看起来、表情、眼神、动作等）
   - 【绝对禁止】使用星号*或其他符号来描述动作
2. **【角色认知】**: 你知道这是语音通话，你看不到用户，用户也看不到你。你们只能通过声音交流。
3. **【多句发言】**: 你可以一次说多句话，每句话会显示为独立的气泡。格式：
   - 如果只说一句话：直接返回纯文本，如 "喂，你好啊！"
   - 如果要说多句话：返回JSON数组，如 [{"type": "text", "content": "喂，你好啊！"}, {"type": "text", "content": "最近怎么样？"}]
4. **格式灵活性**: 你可以根据情况选择单句（纯文本）或多句（JSON数组）格式。

# 当前情景
你正在和用户（${userNickname}，人设: ${chat.settings.myPersona}）进行语音通话。你们只能通过声音交流，看不到彼此。
${longTermMemoryContext}${timeContextBlock}
**${openingContext}**
**通话前的聊天摘要 (这是你们通话的原因，至关重要！)**:
${voiceCallState.preCallContext}
${worldBookContent}
现在，请根据【通话前摘要】和下面的【通话实时记录】，继续进行对话。记住：只输出对话内容，不要有任何动作、表情或视觉描写。
`;
    }

    const messagesForApi = [{
      role: 'system',
      content: inCallPrompt
    },
    ...voiceCallState.callHistory.map(h => ({
      role: h.role,
      content: h.content
    }))
    ];

    if (voiceCallState.callHistory.length === 0) {
      const firstLineTrigger = voiceCallState.initiator === 'user' ? `喂？` : `喂，你好？`;
      messagesForApi.push({
        role: 'user',
        content: firstLineTrigger
      });
    }

    try {
      // let isGemini = proxyUrl === GEMINI_API_URL; // isGemini is now resolved from config
      let geminiConfig = toGeminiRequestData(model, apiKey, inCallPrompt, messagesForApi)
      const callPayload = {
        model: model,
        messages: messagesForApi,
        temperature: state.globalSettings.apiTemperature || 0.8,
        top_p: state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0,
        presence_penalty: state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0,
        frequency_penalty: state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0
      };
      // 当”主API代理”开启时，与主聊天保持一致，走后端代理转发，否则直连会因渠道仅支持后端代理而无法接通
      const useMainApiProxy = !isGemini
        && typeof window.fetchViaOpenAICompatibleProxy === 'function'
        && typeof window.isMainApiProxyEnabled === 'function'
        && window.isMainApiProxyEnabled();
      const response = isGemini
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : useMainApiProxy
          ? await window.fetchViaOpenAICompatibleProxy({
            baseUrl: proxyUrl,
            targetPath: '/chat/completions',
            apiKey,
            payload: callPayload,
            method: 'POST'
          })
          : await fetch(`${proxyUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(callPayload)
          });
      const rawText = await response.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch (e) {
        data = null;
      }

      if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        if (data) {
          errMsg = data?.error?.message || data?.message || data?.detail || JSON.stringify(data);
        } else if (rawText) {
          errMsg = rawText;
        } else if (response.statusText) {
          errMsg += ` (${response.statusText})`;
        }
        throw new Error(errMsg);
      }

      if (!data) {
        throw new Error('API 响应不是有效 JSON');
      }

      const rawAiResponse = isGemini ? data.candidates[0].content.parts[0].text : data.choices[0].message.content;
      const aiResponse = cleanMinimaxCallResponse(rawAiResponse, { provider: proxyUrl, model });

      const connectingElement = callFeed.querySelector('em');
      if (connectingElement) connectingElement.remove();

      // AI 文字即将出现：在第一时间立即停止等待背景音乐（覆盖单聊 / 群聊两种分支）
      stopVoiceCallWaitingMusic('ai-text-rendered');

      let hasVoiceCallTtsPlayback = false;

      if (voiceCallState.isGroupCall) {
        const speechArray = parseAiResponse(aiResponse);
        const enableTts = chat.settings.enableTts !== false;
        const voiceId = chat.settings.minimaxVoiceId;
        speechArray.forEach(turn => {
          const displayText = `${turn.name || ''}: ${turn.speech || ''}`.trim();
          if (!turn.name || turn.name === userNickname || !displayText) return;
          const aiTimestamp = Date.now() + Math.random();
          const aiBubble = document.createElement('div');
          aiBubble.className = 'call-message-bubble ai-speech';
          aiBubble.textContent = displayText;
          aiBubble.dataset.timestamp = aiTimestamp;
          addLongPressListener(aiBubble, () => showCallMessageActions(aiTimestamp));
          callFeed.appendChild(aiBubble);
          voiceCallState.callHistory.push({
            role: 'assistant',
            content: displayText,
            timestamp: aiTimestamp
          });

          logVoiceCallDiag('VOICE_CALL_DISPLAY_TEXT_READY', {
            textLength: displayText.length,
            hasVoiceId: Boolean(voiceId)
          });
          if (enqueueVoiceCallDisplayTextTts(displayText, voiceId)) {
            hasVoiceCallTtsPlayback = true;
          }

          const speaker = voiceCallState.participants.find(p => p.name === turn.name);
          if (speaker) {
            const speakingAvatar = document.querySelector(`.participant-avatar-wrapper[data-participant-id="${speaker.id}"] .participant-avatar`);
            if (speakingAvatar) {
              speakingAvatar.classList.add('speaking');
              setTimeout(() => speakingAvatar.classList.remove('speaking'), 2000);
            }
          }
        });
      } else {
        // 单聊模式：支持多条消息
        const voiceId = chat.settings.minimaxVoiceId;

        // 尝试解析为JSON数组（多条消息）
        const messagesArray = parseAiResponse(aiResponse);

        messagesArray.forEach((msg, index) => {
          const displayText = String(msg.content || msg.speech || aiResponse || '').trim();
          if (!displayText) {
            logVoiceCallDiag('VOICE_CALL_TTS_ENQUEUE_SKIP', {
              textLength: 0,
              skipReason: 'emptyDisplayText',
              hasVoiceId: Boolean(voiceId)
            });
            return;
          }
          const aiTimestamp = Date.now() + index;

          const aiBubble = document.createElement('div');
          aiBubble.className = 'call-message-bubble ai-speech';
          aiBubble.textContent = displayText;
          aiBubble.dataset.timestamp = aiTimestamp;
          addLongPressListener(aiBubble, () => showCallMessageActions(aiTimestamp));
          callFeed.appendChild(aiBubble);

          voiceCallState.callHistory.push({
            role: 'assistant',
            content: displayText,
            timestamp: aiTimestamp
          });

          logVoiceCallDiag('VOICE_CALL_DISPLAY_TEXT_READY', {
            textLength: displayText.length,
            hasVoiceId: Boolean(voiceId)
          });
          if (enqueueVoiceCallDisplayTextTts(displayText, voiceId)) {
            hasVoiceCallTtsPlayback = true;
          }
        });

        const speakingAvatar = document.querySelector(`.participant-avatar-wrapper[data-participant-id="ai"] .participant-avatar`);
        if (speakingAvatar) {
          speakingAvatar.classList.add('speaking');
          const totalLength = messagesArray.reduce((sum, msg) => sum + String(msg.content || msg.speech || aiResponse || '').trim().length, 0);
          const speakTime = Math.min(totalLength * 200, 5000);
          setTimeout(() => speakingAvatar.classList.remove('speaking'), speakTime);
        }
      }

      callFeed.scrollTop = callFeed.scrollHeight;

      if (!hasVoiceCallTtsPlayback) {
        // v0.2.30.25: AI 没 TTS 输出 (无语音) → 保持"思考中" 1.5 秒让用户感知 AI 处理过了
        // 1.5 秒后再切 idle + 启动 autoListen, 不让用户感觉"AI 没说话就直接让说"
        setVoiceCallGlowState('thinking');
        setVoiceCallStatusText('思考中');
        setTimeout(() => {
          onVoiceCallTtsQueueFinished();
        }, 1500);
      }

    } catch (error) {
      const errorBubble = document.createElement('div');
      errorBubble.className = 'call-message-bubble ai-speech';
      errorBubble.style.color = '#ff8a80';
      errorBubble.textContent = `[ERROR: ${error.message}]`;
      callFeed.appendChild(errorBubble);
      callFeed.scrollTop = callFeed.scrollHeight;
      voiceCallState.callHistory.push({
        role: 'assistant',
        content: `[ERROR: ${error.message}]`
      });
      stopVoiceCallWaitingMusic('error');
      onVoiceCallTtsQueueFinished();
    }
    // ★ 每次发送后修剪历史
    trimCallHistory(voiceCallState);
  }

  // ==================== 语音通话功能结束 ====================





  async function handleUserPat(chatId, characterOriginalName) {
    const chat = state.chats[chatId];
    if (!chat) return;


    let displayNameForUI;
    if (chat.isGroup) {

      displayNameForUI = getDisplayNameInGroup(chat, characterOriginalName);
    } else {

      displayNameForUI = chat.name;
    }

    const phoneScreen = document.getElementById('phone-screen');
    phoneScreen.classList.remove('pat-animation');
    void phoneScreen.offsetWidth;
    phoneScreen.classList.add('pat-animation');


    const suffix = await showCustomPrompt(
      `你拍了拍 "${displayNameForUI}"`,
      "（可选）输入后缀",
      "",
      "text"
    );

    if (suffix === null) return;

    // 获取用户昵称，如果是 {{user}} 则使用 "你"
    let myNickname = state.qzoneSettings.nickname;
    if (!myNickname || myNickname === '{{user}}') {
      myNickname = '你';
    }

    // 如果是群聊，使用群昵称
    if (chat.isGroup) {
      myNickname = chat.settings.myNickname || '你';
    }



    const visibleMessageContent = `${myNickname} 拍了拍 "${displayNameForUI}" ${suffix.trim()}`;
    const visibleMessage = {
      role: 'system',
      type: 'pat_message',
      content: visibleMessageContent,
      timestamp: Date.now()
    };
    chat.history.push(visibleMessage);


    const hiddenMessageContent = `[系统提示：用户（${myNickname}）刚刚拍了拍你（${characterOriginalName}）${suffix.trim()}。请你对此作出回应。]`;
    const hiddenMessage = {
      role: 'system',
      content: hiddenMessageContent,
      timestamp: Date.now() + 1,
      isHidden: true
    };
    chat.history.push(hiddenMessage);

    await db.chats.put(chat);
    if (state.activeChatId === chatId) {
      appendMessage(visibleMessage, chat);
    }
    await renderChatList();
  }

  // 新增：处理用户拍自己的功能
  async function handleUserPatSelf(chatId) {
    const chat = state.chats[chatId];
    if (!chat) return;

    const phoneScreen = document.getElementById('phone-screen');
    phoneScreen.classList.remove('pat-animation');
    void phoneScreen.offsetWidth;
    phoneScreen.classList.add('pat-animation');

    // 获取用户昵称，如果是 {{user}} 则使用 "你"
    let myNickname = state.qzoneSettings.nickname;
    if (!myNickname || myNickname === '{{user}}') {
      myNickname = '你';
    }

    // 如果是群聊，使用群昵称
    if (chat.isGroup) {
      myNickname = chat.settings.myNickname || '你';
    }

    // 弹出输入框让用户输入拍自己的后缀
    const suffix = await showCustomPrompt(
      `${myNickname} 拍了拍自己`,
      "输入拍一拍后缀",
      "",
      "text"
    );

    if (suffix === null) return;

    // 创建可见的拍一拍消息
    const visibleMessageContent = `${myNickname} 拍了拍自己 ${suffix.trim()}`;
    const visibleMessage = {
      role: 'system',
      type: 'pat_message',
      content: visibleMessageContent,
      timestamp: Date.now()
    };
    chat.history.push(visibleMessage);

    // 创建隐藏的系统提示，让AI知道用户拍了自己
    const hiddenMessageContent = `[系统提示：用户（${myNickname}）刚刚拍了拍自己${suffix.trim()}。你可以对此作出回应或评论。]`;
    const hiddenMessage = {
      role: 'system',
      content: hiddenMessageContent,
      timestamp: Date.now() + 1,
      isHidden: true
    };
    chat.history.push(hiddenMessage);

    await db.chats.put(chat);
    if (state.activeChatId === chatId) {
      appendMessage(visibleMessage, chat);
    }
    await renderChatList();
  }

  let activeCallMessageTimestamp = null;
  let isFrameManagementMode = false;
  let selectedFrames = new Set();

  function showCallMessageActions(timestamp) {
    activeCallMessageTimestamp = timestamp;
    document.getElementById('call-message-actions-modal').classList.add('visible');
  }


  function hideCallMessageActions() {
    document.getElementById('call-message-actions-modal').classList.remove('visible');
    activeCallMessageTimestamp = null;
  }


  async function openCallMessageEditor() {
    if (!activeCallMessageTimestamp) return;

    const timestampToEdit = activeCallMessageTimestamp;
    
    // 判断当前是视频通话还是语音通话
    const isVideoCall = videoCallState.isActive || document.getElementById('video-call-screen').classList.contains('active');
    const currentCallState = isVideoCall ? videoCallState : voiceCallState;
    
    const message = currentCallState.callHistory.find(m => m.timestamp === timestampToEdit);
    if (!message) return;

    hideCallMessageActions();

    let contentForEditing = message.content;

    if (currentCallState.isGroupCall && message.role === 'assistant') {
      const parts = message.content.split(': ');
      if (parts.length > 1) {
        contentForEditing = parts.slice(1).join(': ');
      }
    }

    const newContent = await showCustomPrompt(
      '编辑通话消息',
      '在此修改内容...',
      contentForEditing,
      'textarea'
    );

    if (newContent !== null) {
      await saveEditedCallMessage(timestampToEdit, newContent, isVideoCall);
    }
  }


  async function saveEditedCallMessage(timestamp, newContent, isVideoCall = true) {
    const currentCallState = isVideoCall ? videoCallState : voiceCallState;
    const message = currentCallState.callHistory.find(m => m.timestamp === timestamp);
    
    if (message) {
      let finalContent = newContent;

      if (currentCallState.isGroupCall && message.role === 'assistant') {
        const parts = message.content.split(': ');
        const senderName = parts[0];
        finalContent = `${senderName}: ${newContent}`;
      }
      message.content = finalContent;

      const messageBubble = document.querySelector(`.call-message-bubble[data-timestamp="${timestamp}"]`);
      if (messageBubble) {
        if (currentCallState.isGroupCall && message.role === 'assistant') {
          const parts = message.content.split(': ');
          const senderName = parts[0];
          messageBubble.innerHTML = `<strong>${senderName}:</strong> ${newContent}`;
        } else {
          messageBubble.textContent = newContent;
        }
      }
    }
    await showCustomAlert('成功', '通话消息已更新！');
  }


  async function deleteCallMessage() {
    if (!activeCallMessageTimestamp) return;

    const confirmed = await showCustomConfirm('删除消息', '确定要删除这条通话消息吗？', {
      confirmButtonClass: 'btn-danger'
    });
    if (confirmed) {
      const timestampToDelete = activeCallMessageTimestamp;
      hideCallMessageActions();

      // 判断当前是视频通话还是语音通话
      const isVideoCall = videoCallState.isActive || document.getElementById('video-call-screen').classList.contains('active');
      const currentCallState = isVideoCall ? videoCallState : voiceCallState;

      const messageIndex = currentCallState.callHistory.findIndex(m => m.timestamp === timestampToDelete);
      if (messageIndex > -1) {
        currentCallState.callHistory.splice(messageIndex, 1);
      }

      const messageBubble = document.querySelector(`.call-message-bubble[data-timestamp="${timestampToDelete}"]`);
      if (messageBubble) {
        messageBubble.remove();
      }
    } else {
      hideCallMessageActions();
    }
  }


  // ========== 导出到全局作用域 ==========
  window.videoCallState = videoCallState;
  window.voiceCallState = voiceCallState;
  window.handleInitiateCall = handleInitiateCall;
  window.startVideoCall = startVideoCall;
  window.minimizeVideoCall = minimizeVideoCall;
  window.restoreVideoCall = restoreVideoCall;
  window.endVideoCall = endVideoCall;
  window.updateParticipantAvatars = updateParticipantAvatars;
  window.handleUserJoinCall = handleUserJoinCall;
  window.updateCallTimer = updateCallTimer;
  window.handleVideoCallUserSpeak = handleVideoCallUserSpeak;
  window.showIncomingCallModal = showIncomingCallModal;
  window.hideIncomingCallModal = hideIncomingCallModal;
  window.triggerAiInCallAction = triggerAiInCallAction;
  window.onVideoCallTtsQueueFinished = onVideoCallTtsQueueFinished;
  window.toggleCallButtons = toggleCallButtons;
  window.handleInitiateVoiceCall = handleInitiateVoiceCall;
  window.startVoiceCall = startVoiceCall;
  window.minimizeVoiceCall = minimizeVoiceCall;
  window.restoreVoiceCall = restoreVoiceCall;
  window.endVoiceCall = endVoiceCall;
  window.updateVoiceParticipantAvatars = updateVoiceParticipantAvatars;
  window.handleUserJoinVoiceCall = handleUserJoinVoiceCall;
  window.updateVoiceCallTimer = updateVoiceCallTimer;
  window.handleVoiceCallUserSpeak = handleVoiceCallUserSpeak;
  window.triggerAiInVoiceCallAction = triggerAiInVoiceCallAction;
  window.onVoiceCallTtsQueueFinished = onVoiceCallTtsQueueFinished;
  window.handleUserPat = handleUserPat;
  window.handleUserPatSelf = handleUserPatSelf;
  window.showCallMessageActions = showCallMessageActions;
  window.hideCallMessageActions = hideCallMessageActions;
  window.openCallMessageEditor = openCallMessageEditor;
  window.saveEditedCallMessage = saveEditedCallMessage;
  window.deleteCallMessage = deleteCallMessage;
  window.isFrameManagementMode = isFrameManagementMode;
  window.selectedFrames = selectedFrames;

  // --- 启用音频按钮功能 ---
  // 辅助: 控制"启用音频"按钮的显示/重置状态
  // - 彩铃停止(AI 文字出现)后隐藏 — 任务完成, 按钮完成使命
  // - 挂断/下次通话开始时显示并重置回 unlock-inactive
  function setVoiceCallAudioUnlockBtnVisibility(visible) {
    const btn = document.querySelector('#voice-regenerate-call-btn');
    if (!btn) return;
    if (visible) {
      btn.style.display = '';
      // 重置回 unlock-inactive (防御: 挂断后按钮可能停在 connected)
      btn.classList.remove('unlock-loading', 'unlock-connected');
      btn.classList.add('unlock-inactive');
      btn.textContent = '启用音频';
    } else {
      btn.style.display = 'none';
    }
  }

  function setupVoiceCallAudioUnlock() {
    const unlockBtn = document.querySelector('#voice-regenerate-call-btn');

    if (!unlockBtn) {
      // 按钮可能还未渲染，稍后重试
      setTimeout(setupVoiceCallAudioUnlock, 500);
      return;
    }

    // 避免重复绑定
    if (unlockBtn.dataset.audioUnlockBound) {
      return;
    }
    unlockBtn.dataset.audioUnlockBound = 'true';

    unlockBtn.addEventListener('click', function handleVoiceCallAudioUnlock() {
      // [防叠加] 已有 bgAudio 且在播 → 直接 return, 不创建新实例
      // 防止用户多次点击导致多个 Audio 实例同时播放谁也停不下来
      if (window.voiceCallBgAudio && !window.voiceCallBgAudio.paused) {
        console.log('[Audio] 彩铃已在播放, 忽略重复点击');
        return;
      }

      // 防重复点击
      if (window.isVoiceCallAudioUnlocking) {
        console.log('[Audio] 正在激活中,请勿重复点击');
        return;
      }
      window.isVoiceCallAudioUnlocking = true;
      
      // 切换到加载状态
      unlockBtn.classList.remove('unlock-inactive');
      unlockBtn.classList.add('unlock-loading');
      unlockBtn.textContent = '连接中…';
      
      // 复用或创建 bgAudio — 只有第一次才 new, 后续失败清理后下次重试也是新的
      let bgAudio = window.voiceCallBgAudio;
      if (!bgAudio) {
        bgAudio = new Audio('assets/audio/call-waiting.mp3');
        bgAudio.loop = true;
        bgAudio.volume = 0.25;
        // 立即记下, 防止并发点击再 new 一个
        window.voiceCallBgAudio = bgAudio;
      }
      
      bgAudio.play()
        .then(() => {
          console.log('[Audio] 背景音乐播放成功');
          
          // [iOS 授权] 在 user gesture 内建一个共享 AudioContext 并 resume
          // iOS 14+ 上已 resume 的 AudioContext 会被认为"已授权",
          // 后续的 BufferSourceNode 播放不会被 user gesture 链限制
          try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass && !window.voiceCallSharedAudioContext) {
              window.voiceCallSharedAudioContext = new AudioContextClass();
              console.log('[Audio] 已建共享 AudioContext, state=', window.voiceCallSharedAudioContext.state);
            }
            if (window.voiceCallSharedAudioContext && window.voiceCallSharedAudioContext.state === 'suspended') {
              window.voiceCallSharedAudioContext.resume().then(() => {
                console.log('[Audio] 共享 AudioContext 已 resume, state=', window.voiceCallSharedAudioContext.state);
              }).catch(err => {
                console.warn('[Audio] 共享 AudioContext resume 失败:', err);
              });
            }
          } catch (audioCtxErr) {
            console.warn('[Audio] 共享 AudioContext 初始化失败(将回退到 <audio> 路径):', audioCtxErr);
          }
          
          // 切换到已连接状态
          unlockBtn.classList.remove('unlock-loading');
          unlockBtn.classList.add('unlock-connected');
          unlockBtn.textContent = '已连接';
          
          // 释放状态锁
          window.isVoiceCallAudioUnlocking = false;
        })
        .catch(err => {
          console.error('[Audio] 背景音乐播放失败:', err);
          
          // 失败清理: 允许下次点击重试 (创建新 bgAudio)
          if (window.voiceCallBgAudio === bgAudio) {
            try { bgAudio.pause(); bgAudio.currentTime = 0; } catch (e) { /* ignore */ }
            window.voiceCallBgAudio = null;
          }
          
          // 切换回初始状态
          unlockBtn.classList.remove('unlock-loading');
          unlockBtn.classList.add('unlock-inactive');
          unlockBtn.textContent = '启用音频';
          
          // 释放状态锁
          window.isVoiceCallAudioUnlocking = false;
        });
    });
  }

  // 由于按钮是动态添加到页面的，我们需要在合适的时机去绑定事件
  // startVoiceCall 是语音通话界面的入口函数，是绑定事件的好时机
  // 但为了不修改原函数，我们采用监听 DOM 变化或定时器的方式
  // 这里用一个简单的定时器来查找并绑定按钮
  // 同时，在 startVoiceCall 内部调用此函数可以更精确，但会违反“不修改函数”的约束
  // 因此，在脚本加载时就开始尝试绑定
  setupVoiceCallAudioUnlock();
  // --- 启用音频按钮功能结束 ---

})();
