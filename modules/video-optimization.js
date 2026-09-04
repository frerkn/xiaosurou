/**
 * 视频通话优化功能
 * 从 script.js 第 80389 ~ 80888 行提取
 * 包含：视频通话优化设置、摄像头控制、对话提取、TTS文本处理
 */

// ========================================
// 视频通话优化功能
// ========================================

// 摄像头相关变量
let cameraStream = null;
let captureInterval = null;
let lastCapturedImage = null;
let currentCameraFacingMode = 'user';
let isSwitchingCamera = false;

// 提取对话内容（只保留引号内的文本）
function extractDialogueOnly(text) {
  if (!text) return text;

  // 支持的引号类型：尽可能全面的引号格式
  const quotePatterns = [
    /"([^"]*)"/g,        // 英文双引号
    /'([^']*)'/g,        // 英文单引号
    /「([^」]*)」/g,     // 中文直角引号
    /『([^』]*)』/g,     // 中文直角双引号
    /\u201c([^\u201d]*)\u201d/g,        // 中文双引号
    /\u2018([^\u2019]*)\u2019/g,        // 中文单引号
    /‹([^›]*)›/g,        // 单书名号
    /«([^»]*)»/g,        // 双书名号
    /‚([^\u2019]*)\u2019/g,        // 德语单引号
    /„([^\u201d]*)\u201d/g,        // 德语双引号
    /【([^】]*)】/g,     // 方括号（部分场景用作对话）
    /『([^』]*)』/g      // 繁体中文引号
  ];

  let dialogues = [];

  // 提取所有引号内的内容
  for (const pattern of quotePatterns) {
    // 重置正则表达式的lastIndex，避免状态污染
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match[1] && match[1].trim()) {
        const dialogue = match[1].trim();
        // 避免重复添加相同的对话片段
        if (!dialogues.includes(dialogue)) {
          dialogues.push(dialogue);
        }
      }
    }
  }

  // 如果找到了引号内容，返回引号内容（只读对话）
  if (dialogues.length > 0) {
    console.log('[对话提取] 成功提取到 ' + dialogues.length + ' 段对话');
    return dialogues.join(' ');
  }

  // 如果没有找到任何引号，返回原文（保证TTS能正常工作）
  console.log('[对话提取] 未找到引号，返回原文');
  return text;
}


// P3-2: 删 window.getProcessedTTSText (P3-0 审计已确认无任何外部调用方; tts-audio.js 直接调 extractDialogueOnly)
//   ttsDialogueOnly 字段读取保留在 tts-audio.js (P6 才动 AI 逻辑, 本阶段保证不抛错)


// 初始化视频通话优化事件监听
// v0.5.0 P3-1: 加 prefix 参数支持多套 DOM 实例
// v0.5.0 P3-2: 聊天设置页"视频通话优化"板块已删除, prefix 默认值不再有意义但保留兼容
//   prefix === 'prep-' → 视频通话准备页 #live2d-call-prep-screen 的"我的画面"卡片
function initVideoOptimization(prefix) {
  prefix = prefix || '';

  // 我方视频图片 - 本地上传 (P3-2: URL 输入框已从准备页删除, 保留 file input + preview + placeholder)
  const localVideoInput = document.getElementById(prefix + 'local-video-input');
  if (localVideoInput) {
    localVideoInput.addEventListener('change', function (e) {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = function (event) {
          const imgUrl = event.target.result;
          document.getElementById(prefix + 'local-video-preview').src = imgUrl;
          document.getElementById(prefix + 'local-video-preview').style.display = 'block';
          document.getElementById(prefix + 'local-video-placeholder').style.display = 'none';
        };
        reader.readAsDataURL(file);
      }
    });
  }

  // 我方视频图片 - 重置按钮
  const localVideoResetBtn = document.getElementById(prefix + 'local-video-reset-btn');
  if (localVideoResetBtn) {
    localVideoResetBtn.addEventListener('click', function () {
      document.getElementById(prefix + 'local-video-preview').src = '';
      document.getElementById(prefix + 'local-video-preview').style.display = 'none';
      const ph = document.getElementById(prefix + 'local-video-placeholder');
      if (ph) ph.style.display = 'flex';
      // P3-2: URL 输入框已从准备页删除, 加守卫避免删 DOM 后 .value='' 抛 null 错
      const urlInput = document.getElementById(prefix + 'local-video-url-input');
      if (urlInput) urlInput.value = '';
      const localVideoInputEl = document.getElementById(prefix + 'local-video-input');
      if (localVideoInputEl) localVideoInputEl.value = '';
    });
  }

  // 真实摄像头开关
  // v0.5.0 P3-1: 准备页 (prefix='prep-') 只配置不启动, 关闭时不调 stopCamera()
  const enableRealCameraSwitch = document.getElementById(prefix + 'enable-real-camera-switch');
  const cameraIntervalSetting = document.getElementById(prefix + 'camera-interval-setting');
  if (enableRealCameraSwitch) {
    enableRealCameraSwitch.addEventListener('change', function () {
      if (this.checked) {
        cameraIntervalSetting.style.display = 'block';
      } else {
        cameraIntervalSetting.style.display = 'none';
        if (prefix === '') stopCamera();
      }
    });
  }

  // 后置摄像头开关 - 通话中实时切换
  // v0.5.0 P3-1: 准备页 (prefix='prep-') 上也有此开关, 但已有 videoCallState.isActive 守卫
  //   → 准备页 cameraStream === null && videoCallState.isActive === false, handler 自然 no-op
  const enableRearCameraSwitch = document.getElementById(prefix + 'enable-rear-camera-switch');
  if (enableRearCameraSwitch) {
    enableRearCameraSwitch.addEventListener('change', async function () {
      // 如果正在通话中且摄像头已启动，实时切换
      if (cameraStream && videoCallState && videoCallState.isActive) {
        const facingMode = this.checked ? 'environment' : 'user';
        const success = await window.switchVideoCallCameraFacingMode(facingMode);
        if (!success) {
          this.checked = currentCameraFacingMode === 'environment';
        }
      }
    });
  }

  // 点击小屏互换位置 (这是通话屏的 DOM, 不加 prefix)
  const localVideoSmall = document.getElementById('local-video-small');
  if (localVideoSmall) {
    localVideoSmall.addEventListener('click', swapVideoPosition);
  }
}


// 互换视频位置
function swapVideoPosition() {
  const remoteImg = document.getElementById('remote-video-img');
  const localImg = document.getElementById('local-video-img');

  const tempSrc = remoteImg.src;
  remoteImg.src = localImg.src;
  localImg.src = tempSrc;
}

// 加载视频通话优化设置
// v0.5.0 P3-1: 加 prefix 参数支持多套 DOM 实例
// v0.5.0 P3-2: 聊天设置页"视频通话优化"板块已删除
//   - 删主开关 / configContainer / remoteVideoUrl / ttsDialogueOnly / interleavedMode 加载
//   - 仅剩 localVideoUrl / enableRealCamera / cameraInterval / useRearCamera 加载 (准备页"我的画面"卡片用)
window.loadVideoOptimizationSettings = function (chat, prefix) {
  if (!chat) return;
  prefix = prefix || '';

  const settings = chat.videoOptimization || {};

  if (settings.localVideoUrl) {
    const localPreview = document.getElementById(prefix + 'local-video-preview');
    if (localPreview) {
      localPreview.src = settings.localVideoUrl;
      localPreview.style.display = 'block';
    }
    const localPlaceholder = document.getElementById(prefix + 'local-video-placeholder');
    if (localPlaceholder) localPlaceholder.style.display = 'none';
    const localUrlInput = document.getElementById(prefix + 'local-video-url-input');
    if (localUrlInput) localUrlInput.value = settings.localVideoUrl;
  } else {
    const localPreview = document.getElementById(prefix + 'local-video-preview');
    if (localPreview) localPreview.style.display = 'none';
    const localPlaceholder = document.getElementById(prefix + 'local-video-placeholder');
    if (localPlaceholder) localPlaceholder.style.display = 'flex';
    const localUrlInput = document.getElementById(prefix + 'local-video-url-input');
    if (localUrlInput) localUrlInput.value = '';
  }

  // 加载真实摄像头设置
  const enableRealCameraSwitch = document.getElementById(prefix + 'enable-real-camera-switch');
  const cameraIntervalSetting = document.getElementById(prefix + 'camera-interval-setting');
  const cameraIntervalInput = document.getElementById(prefix + 'camera-capture-interval');

  if (enableRealCameraSwitch) {
    enableRealCameraSwitch.checked = settings.enableRealCamera || false;
    if (cameraIntervalSetting) {
      cameraIntervalSetting.style.display = settings.enableRealCamera ? 'block' : 'none';
    }
  }

  if (cameraIntervalInput) {
    cameraIntervalInput.value = settings.cameraInterval || 5;
  }

  // 加载后置摄像头设置
  const enableRearCameraSwitch = document.getElementById(prefix + 'enable-rear-camera-switch');
  if (enableRearCameraSwitch) {
    enableRearCameraSwitch.checked = settings.useRearCamera || false;
  }
};

// 保存视频通话优化设置
// v0.5.0 P3-1: 加 prefix 参数支持多套 DOM 实例
// v0.5.0 P3-2: 聊天设置页"视频通话优化"板块已删除
//   - 删 enabled / remoteVideoUrl / ttsDialogueOnly / interleavedMode 字段
//   - 仅存 localVideoUrl / enableRealCamera / useRearCamera / cameraInterval (准备页"我的画面"卡片用)
window.saveVideoOptimizationSettings = function (chat, prefix) {
  if (!chat) return;
  prefix = prefix || '';

  const localVideoPreview = document.getElementById(prefix + 'local-video-preview');
  const enableRealCameraSwitch = document.getElementById(prefix + 'enable-real-camera-switch');
  const cameraIntervalInput = document.getElementById(prefix + 'camera-capture-interval');
  const enableRearCameraSwitch = document.getElementById(prefix + 'enable-rear-camera-switch');

  chat.videoOptimization = {
    localVideoUrl: localVideoPreview && localVideoPreview.style.display === 'block' ? localVideoPreview.src : '',
    enableRealCamera: enableRealCameraSwitch ? enableRealCameraSwitch.checked : false,
    useRearCamera: enableRearCameraSwitch ? enableRearCameraSwitch.checked : false,
    cameraInterval: cameraIntervalInput ? parseInt(cameraIntervalInput.value) || 5 : 5
  };

  // 不需要在这里put到数据库，因为调用方会统一保存
};


// 应用视频通话优化到视频界面
// v0.5.0 P3-2: remoteVideoUrl 废弃, "对方"由 Live2D 替代; 删 settings.enabled / settings.remoteVideoUrl 分支
//   触发条件改为: localVideoUrl 或 enableRealCamera 任一为真
window.applyVideoOptimizationToCall = async function (chat) {
  const videoDisplayArea = document.getElementById('video-display-area');
  const avatarArea = document.querySelector('.video-call-avatar-area');

  if (!chat || !chat.videoOptimization || (!chat.videoOptimization.localVideoUrl && !chat.videoOptimization.enableRealCamera)) {
    videoDisplayArea.style.display = 'none';
    if (avatarArea) avatarArea.style.display = 'flex';
    updateVideoCallCameraSwitchButton(false);
    stopCamera();
    return;
  }

  const settings = chat.videoOptimization;
  if (settings.localVideoUrl || settings.enableRealCamera) {
    videoDisplayArea.style.display = 'block';
    if (avatarArea) avatarArea.style.display = 'none';

    // 处理我方画面：真实摄像头或静态图片
    const localImg = document.getElementById('local-video-img');
    const localVideo = document.getElementById('local-camera-video');

    if (settings.enableRealCamera) {
      // 使用真实摄像头
      localImg.style.display = 'none';
      localVideo.style.display = 'block';
      updateVideoCallCameraSwitchButton(true);

      const facingMode = settings.useRearCamera ? 'environment' : 'user';
      const success = await startCamera(facingMode);
      if (success) {
        // 启动定时截图
        const interval = settings.cameraInterval || 5;
        startCameraCapture(interval);
      }
    } else if (settings.localVideoUrl) {
      // 使用静态图片
      localVideo.style.display = 'none';
      localImg.style.display = 'block';
      localImg.src = settings.localVideoUrl;
      updateVideoCallCameraSwitchButton(false);
      stopCamera();
    }
  } else {
    videoDisplayArea.style.display = 'none';
    if (avatarArea) avatarArea.style.display = 'flex';
    updateVideoCallCameraSwitchButton(false);
    stopCamera();
  }
};

// 启动摄像头
async function startCamera(useFacingMode, options = {}) {
  try {
    const facing = useFacingMode || 'user';
    const previousCameraStream = cameraStream;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: facing
      },
      audio: false
    });

    if (options.stopPreviousVideoTracks && previousCameraStream && previousCameraStream !== stream) {
      previousCameraStream.getVideoTracks().forEach(track => track.stop());
    }

    cameraStream = stream;
    currentCameraFacingMode = facing;
    const videoElement = document.getElementById('local-camera-video');
    if (videoElement) {
      videoElement.srcObject = stream;
    }

    // 更新状态显示
    updateCameraStatus(true, '摄像头已启动');

    return true;
  } catch (error) {
    console.error('无法访问摄像头:', error);
    updateCameraStatus(false, '摄像头启动失败: ' + error.message);
    return false;
  }
}

function getActiveVideoCallChat() {
  if (typeof videoCallState === 'undefined' || !videoCallState || !videoCallState.isActive) {
    return null;
  }

  if (typeof state === 'undefined' || !state.chats || !videoCallState.activeChatId) {
    return null;
  }

  return state.chats[videoCallState.activeChatId] || null;
}

function updateVideoCallCameraSwitchButton(enabled) {
  const switchButton = document.getElementById('regenerate-call-btn');
  if (!switchButton) return;

  switchButton.disabled = !enabled;
  switchButton.style.opacity = enabled ? '1' : '0.45';
  switchButton.title = enabled ? '切换前/后摄像头' : '仅真实摄像头模式可切换摄像头';
  switchButton.setAttribute('aria-label', switchButton.title);
}

window.switchVideoCallCameraFacingMode = async function (targetFacingMode) {
  if (isSwitchingCamera) return false;

  const chat = getActiveVideoCallChat();
  const settings = chat && chat.videoOptimization;
  if (!settings || !settings.enabled || !settings.enableRealCamera) {
    updateVideoCallCameraSwitchButton(false);
    updateCameraStatus(false, '当前不是真实摄像头模式，无法切换摄像头');
    return false;
  }

  const previousFacingMode = currentCameraFacingMode || (settings.useRearCamera ? 'environment' : 'user');
  const nextFacingMode = targetFacingMode || (previousFacingMode === 'environment' ? 'user' : 'environment');

  isSwitchingCamera = true;
  updateVideoCallCameraSwitchButton(false);

  try {
    const success = await startCamera(nextFacingMode, { stopPreviousVideoTracks: true });
    if (!success) {
      const videoElement = document.getElementById('local-camera-video');
      if (videoElement && cameraStream && videoElement.srcObject !== cameraStream) {
        videoElement.srcObject = cameraStream;
      }
      currentCameraFacingMode = previousFacingMode;
      updateCameraStatus(!!cameraStream, '切换摄像头失败，已保持原摄像头画面');
      return false;
    }

    settings.useRearCamera = nextFacingMode === 'environment';
    const enableRearCameraSwitch = document.getElementById('enable-rear-camera-switch');
    if (enableRearCameraSwitch) {
      enableRearCameraSwitch.checked = settings.useRearCamera;
    }

    const interval = settings.cameraInterval || 5;
    startCameraCapture(interval);
    updateCameraStatus(true, settings.useRearCamera ? '已切换为后置摄像头' : '已切换为前置摄像头');
    return true;
  } finally {
    isSwitchingCamera = false;
    updateVideoCallCameraSwitchButton(!!cameraStream);
  }
};

// 停止摄像头
function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }

  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }

  const videoElement = document.getElementById('local-camera-video');
  if (videoElement) {
    videoElement.srcObject = null;
  }

  updateCameraStatus(false, '摄像头已停止');
}

// 更新摄像头状态显示
function updateCameraStatus(isActive, message) {
  const statusDiv = document.getElementById('camera-status');
  const statusIcon = document.getElementById('camera-status-icon');
  const statusText = document.getElementById('camera-status-text');

  if (statusDiv && statusIcon && statusText) {
    statusDiv.style.display = 'block';
    statusIcon.style.background = isActive ? '#4cd964' : '#ccc';
    statusText.textContent = message;
  }
}

// 截取摄像头画面
function captureCameraFrame() {
  const videoElement = document.getElementById('local-camera-video');
  if (!videoElement || !cameraStream) return null;

  const canvas = document.createElement('canvas');
  canvas.width = videoElement.videoWidth;
  canvas.height = videoElement.videoHeight;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoElement, 0, 0);

  // 转换为base64
  const imageData = canvas.toDataURL('image/jpeg', 0.8);
  lastCapturedImage = imageData;

  return imageData;
}

// 启动定时截图
function startCameraCapture(intervalSeconds) {
  if (captureInterval) {
    clearInterval(captureInterval);
  }

  // 立即截取一次
  captureCameraFrame();

  // 定时截取
  captureInterval = setInterval(() => {
    captureCameraFrame();
    console.log('已截取摄像头画面');
  }, intervalSeconds * 1000);
}

// 获取最新截图
window.getLastCameraCapture = function () {
  return lastCapturedImage;
};

// P3-2: 删 DOMContentLoaded 自动 initVideoOptimization() (旧聊天设置页 DOM 已删, 不再需要自动绑)
//   准备页由 Live2DCallPrep.init() 显式调 initVideoOptimization('prep-')
