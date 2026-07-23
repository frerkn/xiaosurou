/**
 * 普通聊天语音消息录制功能（底部按住说话浮层 + 后台 ASR）
 * 仅用于普通聊天里的“发语音消息”，不涉及语音通话、视频通话或 TTS。
 */

(function () {
  'use strict';

  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;
  let preparedStream = null;
  let recordingStartTime = 0;
  let pressStarted = false;
  let overlayEl = null;
  let panelButtonEl = null;
  let statusEl = null;

  const MIN_RECORDING_MS = 600;

  function initVoiceRecording() {
    const voiceRecordBtn = document.getElementById('voice-record-btn');
    if (!voiceRecordBtn) {
      console.warn('录音按钮未找到');
      return;
    }

    if (!voiceRecordBtn.dataset.voiceRecordingBound) {
      voiceRecordBtn.addEventListener('click', openVoiceRecordPanel);
      voiceRecordBtn.dataset.voiceRecordingBound = 'true';
    }
  }

  function getSupportedAudioMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/mpeg'
    ];

    for (const mimeType of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(mimeType)) {
        return mimeType;
      }
    }

    return '';
  }

  async function requestAndPrepareMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('当前浏览器不支持麦克风录音');
    }

    releaseMicrophoneStream();

    preparedStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return preparedStream;
  }

  function releaseMicrophoneStream() {
    if (preparedStream) {
      preparedStream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch (error) {
          console.warn('关闭麦克风 track 失败:', error);
        }
      });
      preparedStream = null;
    }
  }

  function setPanelStatus(text) {
    if (statusEl) {
      statusEl.textContent = text || '松开后自动识别并发送';
    }
  }

  async function openVoiceRecordPanel() {
    if (!state.activeChatId) {
      alert('请先选择一个聊天');
      return;
    }

    showVoiceRecordPanel();

    try {
      setVoiceRecordButtonPreparing(true);
      await requestAndPrepareMicrophone();
    } catch (error) {
      closeVoiceRecordPanel(false);
      releaseMicrophoneStream();
      console.error('麦克风授权或准备失败:', error);
      alert('无法访问麦克风，请检查浏览器权限设置');
    } finally {
      setVoiceRecordButtonPreparing(false);
    }
  }

  function setVoiceRecordButtonPreparing(preparing) {
    const voiceRecordBtn = document.getElementById('voice-record-btn');
    if (!voiceRecordBtn) return;

    voiceRecordBtn.disabled = !!preparing;
    voiceRecordBtn.title = preparing ? '正在请求麦克风权限...' : '录音';
    voiceRecordBtn.classList.toggle('preparing', !!preparing);
  }

  function showVoiceRecordPanel() {
    closeVoiceRecordPanel(false);

    const host = document.getElementById('chat-interface-screen') || document.body;
    overlayEl = document.createElement('div');
    overlayEl.id = 'voice-record-panel-overlay';
    overlayEl.innerHTML = `
      <div class="voice-record-panel-spacer" aria-hidden="true"></div>
      <div class="voice-record-panel" role="dialog" aria-modal="true" aria-label="按住说话">
        <div class="voice-record-panel-handle"></div>
        <div class="voice-record-panel-title">按住说话</div>
        <div class="voice-record-panel-subtitle">松开后自动识别并发送</div>
        <button type="button" class="voice-hold-mic-btn" aria-label="按住录音">
          <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z"></path>
            <path d="M19 11a7 7 0 0 1-14 0"></path>
            <path d="M12 18v3"></path>
            <path d="M8 21h8"></path>
          </svg>
        </button>
        <button type="button" class="voice-record-cancel-btn">取消</button>
      </div>
    `;

    host.appendChild(overlayEl);

    panelButtonEl = overlayEl.querySelector('.voice-hold-mic-btn');
    statusEl = overlayEl.querySelector('.voice-record-panel-subtitle');

    panelButtonEl.addEventListener('pointerdown', handleHoldStart);
    window.addEventListener('pointerup', handleHoldEnd);
    window.addEventListener('pointercancel', handleHoldCancel);

    overlayEl.querySelector('.voice-record-cancel-btn').addEventListener('click', () => {
      cancelRecordingAndClose();
    });

    overlayEl.querySelector('.voice-record-panel-spacer').addEventListener('click', () => {
      cancelRecordingAndClose();
    });
  }

  function closeVoiceRecordPanel(shouldReleaseStream = true) {
    if (overlayEl) {
      window.removeEventListener('pointerup', handleHoldEnd);
      window.removeEventListener('pointercancel', handleHoldCancel);
      overlayEl.remove();
      overlayEl = null;
      panelButtonEl = null;
      statusEl = null;
    }

    if (shouldReleaseStream) {
      releaseMicrophoneStream();
    }
  }

  function cancelRecordingAndClose() {
    if (isRecording) {
      stopRecording({ cancelled: true });
    } else {
      closeVoiceRecordPanel(true);
    }
  }

  function handleHoldStart(event) {
    event.preventDefault();
    if (isRecording || !preparedStream) return;
    pressStarted = true;
    startRecording();
  }

  function handleHoldEnd(event) {
    if (!pressStarted) return;
    event.preventDefault();
    pressStarted = false;
    stopRecording({ cancelled: false });
  }

  function handleHoldCancel(event) {
    if (!pressStarted) return;
    event.preventDefault();
    pressStarted = false;
    stopRecording({ cancelled: true });
  }

  function startRecording() {
    if (!preparedStream) {
      setPanelStatus('麦克风未准备好，请重新打开录音面板');
      return;
    }

    try {
      const mimeType = getSupportedAudioMimeType();
      const options = mimeType ? { mimeType } : undefined;

      mediaRecorder = new MediaRecorder(preparedStream, options);
      audioChunks = [];
      recordingStartTime = Date.now();

      mediaRecorder.ondataavailable = event => {
        if (event.data && event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        // 录音停止后的具体处理在 stopRecording 中完成，确保松手立即停 recorder 和 stream。
      };

      mediaRecorder.start();
      isRecording = true;
      updateRecordingUi(true);
      setPanelStatus('正在录音，松开发送');

      console.log('普通聊天语音消息开始录音');
    } catch (error) {
      console.error('启动 MediaRecorder 失败:', error);
      setPanelStatus('录音启动失败');
      releaseMicrophoneStream();
      updateRecordingUi(false);
    }
  }

  async function stopRecording({ cancelled }) {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      isRecording = false;
      updateRecordingUi(false);
      releaseMicrophoneStream();
      if (cancelled) closeVoiceRecordPanel(false);
      return;
    }

    const recorder = mediaRecorder;
    const startedAt = recordingStartTime;
    const stoppedAt = Date.now();

    isRecording = false;
    updateRecordingUi(false);
    setPanelStatus(cancelled ? '已取消' : '正在整理录音...');

    const stoppedPromise = new Promise(resolve => {
      recorder.addEventListener('stop', resolve, { once: true });
    });

    try {
      recorder.stop();
      console.log('普通聊天语音消息停止 MediaRecorder');
    } catch (error) {
      console.warn('停止 MediaRecorder 失败:', error);
    }

    // 松手/取消后立即释放本次录音使用的麦克风 stream。
    releaseMicrophoneStream();

    await stoppedPromise;

    const durationMs = stoppedAt - startedAt;
    const audioBlob = new Blob(audioChunks, {
      type: recorder.mimeType || 'audio/webm'
    });

    mediaRecorder = null;

    if (cancelled) {
      audioChunks = [];
      closeVoiceRecordPanel(false);
      return;
    }

    if (durationMs < MIN_RECORDING_MS || audioBlob.size <= 0) {
      console.log('录音太短或为空，不发送语音消息');
      audioChunks = [];
      setPanelStatus('录音太短，未发送');
      window.setTimeout(() => closeVoiceRecordPanel(false), 500);
      return;
    }

    closeVoiceRecordPanel(false);
    await createUserVoiceMessageWithAsr(audioBlob, durationMs);
    audioChunks = [];
  }

  function updateRecordingUi(recording) {
    if (panelButtonEl) {
      panelButtonEl.classList.toggle('recording', !!recording);
    }

    const voiceRecordBtn = document.getElementById('voice-record-btn');
    if (voiceRecordBtn) {
      voiceRecordBtn.classList.toggle('recording', !!recording);
    }
  }

  async function createUserVoiceMessageWithAsr(audioBlob, durationMs) {
    const chat = state.chats[state.activeChatId];
    if (!chat) return;

    const audioData = await blobToDataUrl(audioBlob);
    const audioUrl = URL.createObjectURL(audioBlob);
    const duration = Math.max(1, Math.round(durationMs / 1000));

    const msg = {
      role: 'user',
      type: 'voice_message',
      content: '',
      transcript: '',
      asrText: '',
      asrStatus: 'pending',
      audioBlob,
      audioUrl,
      audioData,
      audioMimeType: audioBlob.type || 'audio/webm',
      audioDuration: duration,
      timestamp: Date.now()
    };

    try {
      if (typeof window.transcribeAudioBlob !== 'function') {
        throw new Error('ASR 模块未加载');
      }

      const transcript = String(await window.transcribeAudioBlob(audioBlob)).trim();
      msg.content = transcript || '[语音消息]';
      msg.transcript = transcript;
      msg.asrText = transcript;
      msg.asrStatus = transcript ? 'success' : 'empty';
    } catch (error) {
      console.error('普通聊天语音消息 ASR 失败:', error);
      msg.content = '[语音识别失败]';
      msg.transcript = '';
      msg.asrText = '';
      msg.asrStatus = 'failed';
      msg.asrError = error && error.message ? error.message : String(error);
    }

    if (window.messageStore) {
      await window.messageStore.addMessageToChat(chat, msg);
    } else {
      chat.history.push(msg);
      await db.chats.put(chat);
    }

    appendMessage(msg, chat);
    renderChatList();

    console.log('普通聊天语音消息已创建:', {
      timestamp: msg.timestamp,
      asrStatus: msg.asrStatus,
      transcript: msg.transcript
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVoiceRecording);
  } else {
    initVoiceRecording();
  }

  window.voiceRecording = {
    openVoiceRecordPanel,
    startRecording,
    stopRecording,
    releaseMicrophoneStream,
    isRecording: () => isRecording
  };
})();
