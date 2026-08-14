// ============================================================
// notification-battery.js
// 从 script.js 拆分出来的通知、水印功能模块
// 包含：聊天内通知、系统级通知、截图水印
// 原始行范围：8891~8960, 36475~36490, 36608~37175, 37178~37448
// ============================================================

// --- 依赖说明 ---
// 需要 window.state (来自 script.js DOMContentLoaded 内部)
// 需要 DEFAULT_NOTIFICATION_SOUND (来自 script.js DOMContentLoaded 内部)
// 需要 notificationTimeout (来自 script.js DOMContentLoaded 内部)
// 需要 defaultAvatar (来自 script.js DOMContentLoaded 内部)
// 需要 openChat, updateBackButtonUnreadCount, playNotificationSound, showCustomAlert (来自 script.js)

// ========== 工具函数 ==========

/**
 * 将 base64 编码的 VAPID 公钥转换为 ArrayBuffer
 * ★ v0.2.02 改回 v0.1.84 跑通的版本: 返回 ArrayBuffer (u8.buffer)
 *   v0.1.95 改返回 Uint8Array<ArrayBuffer> —— iOS 18.3.2 严格 PWA 拒, 报 "valid P-256 public key"
 *   v0.1.84 用 Uint8Array.from + return u8.buffer 跑通了, 改回这个
 * @param {string} base64String - VAPID 公钥的 base64 字符串
 * @returns {ArrayBuffer}
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  // iOS 18.3.2 PWA 严格模式: 必须返回 ArrayBuffer (u8.buffer) —— v0.1.84 跑通的格式
  const u8 = Uint8Array.from(rawData, c => c.charCodeAt(0));
  return u8.buffer;
}

// v0.2.15.3 加: Uint8Array → base64url 字符串 (绕开 iOS PWA 模式 subscription.toJSON() 字段值污染 ByteString)
//   v0.2.15.2 失败根因: replace(/[^\x00-\x7F]/g, '') 只能去非 ASCII 字符, 不能恢复原始 base64url 字符, 截短后 web-push Buffer.from(p256dh, 'base64url') 还是炸
//   v0.2.15.3 修法: subscription.getKey() 返回 ArrayBuffer (不经过字符串转换, iOS bug 不会污染), 手动 base64url 编码 → 干净 base64url 字符
function uint8ArrayToBase64Url(uint8Array) {
  let binary = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// v0.2.15.3 加: 用 pushSubscription 对象 (不经 toJSON() 字符串转换) 构造干净 pushSubscription JSON
//   subscription.endpoint 是 URL 字符串, 不会被 iOS bug 污染
//   subscription.getKey('p256dh') + getKey('auth') 返回 ArrayBuffer, 不经过字符串转换, iOS bug 不会污染
//   手动 base64url 编码 → 干净 base64url 字符 → 永远不发 rawJson (toJSON() 输出, 字段值可能被污染)
function buildCleanPushSub(subscription) {
  const endpoint = String(subscription.endpoint || '');
  const p256dhBuffer = subscription.getKey('p256dh');
  const authBuffer = subscription.getKey('auth');
  let p256dh = '';
  let auth = '';
  if (p256dhBuffer) {
    try {
      p256dh = uint8ArrayToBase64Url(new Uint8Array(p256dhBuffer));
    } catch (e) {
      console.warn('[buildCleanPushSub] p256dh 编码失败:', e.message);
    }
  }
  if (authBuffer) {
    try {
      auth = uint8ArrayToBase64Url(new Uint8Array(authBuffer));
    } catch (e) {
      console.warn('[buildCleanPushSub] auth 编码失败:', e.message);
    }
  }
  return { endpoint, keys: { p256dh, auth } };
}

window.buildCleanPushSub = buildCleanPushSub;

/**
 * 获取或创建当前 PWA 的唯一 userId (v0.2.10+)
 * ★ 关键: 同一个 netlify URL 上的不同 PWA 用户必须用不同 userId, 否则会"串台"
 *   - 老逻辑: 用 state.onlineChatState?.userId / globalSettings?.nickname, 没配就掉到 'default-user' / 'anonymous'
 *   - 多用户场景下, 所有人都掉到 fallback → 同一 userId → 推送全给最后订阅那个人
 *   - 新逻辑: 每个 PWA 启动时生成自己的 UUID 存 localStorage, 永不换
 *   - 即使卸载重装 PWA, localStorage 被清, 也会重新生成新的 UUID (新订阅)
 * @returns {string} 唯一 userId (UUID 格式)
 */
function getOrCreatePushUserId() {
  try {
    const KEY = 'pushUserId_v1';
    let uid = localStorage.getItem(KEY);
    if (uid && /^[0-9a-f-]{32,}$/i.test(uid)) return uid;
    // crypto.randomUUID 是现代浏览器/iOS PWA 都支持的
    uid = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'pwa-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
    localStorage.setItem(KEY, uid);
    console.log('[服务器推送] 新 PWA 生成 pushUserId:', uid);
    return uid;
  } catch (e) {
    // localStorage 异常 (隐私模式等) 退化: 用 sessionStorage + 时间戳, 至少保证本次会话内一致
    console.warn('[服务器推送] getOrCreatePushUserId 异常, 用 session fallback:', e.message);
    return 'pwa-fallback-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
  }
}

// 兼容老调用: window.getOrCreatePushUserId 也暴露, 方便其他模块直接用
window.getOrCreatePushUserId = getOrCreatePushUserId;

/**
 * 订阅服务器推送
 * @param {string} userId - 当前用户ID
 * @param {string} serverUrl - 推送服务器地址
 * @returns {Promise<boolean>}
 */
async function subscribeToPushServer(userId, serverUrl) {
  try {
    console.log('[服务器推送] 开始订阅流程...');

    // 1. 请求通知权限
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error('通知权限未授予');
    }

    // 2. 获取 Service Worker 注册
    const registration = await navigator.serviceWorker.ready;
    console.log('[服务器推送] Service Worker 已就绪');

    // 3. 从服务器获取 VAPID 公钥
    const keyResponse = await fetch(`${serverUrl}/api/vapid-public-key`);
    if (!keyResponse.ok) {
      throw new Error(`获取公钥失败: ${keyResponse.status}`);
    }
    const { publicKey } = await keyResponse.json();
    console.log('[服务器推送] 已获取公钥');

    // 4. 订阅推送 (iOS 18.x PWA 双 fallback: ArrayBuffer 优先, Uint8Array 兜底)
    const abKey = urlBase64ToUint8Array(publicKey);
    let subscription;
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: abKey
      });
      console.log('[服务器推送] 已创建订阅 (ArrayBuffer)');
    } catch (abErr) {
      console.warn('[服务器推送] ArrayBuffer 失败, 试 Uint8Array:', abErr.message);
      const u8Key = new Uint8Array(abKey);
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: u8Key
      });
      console.log('[服务器推送] 已创建订阅 (Uint8Array fallback)');
    }

    // 5. v0.2.21+userId: 二进制 raw bytes 传输 (DeepSeek 方案, 不用 FormData/multer 避免引入新包)
    //   之前 v0.2.15.3 base64url string 还是会触发 push-server 端 V8 ToStringByteString 错
    //   现在 PWA 端拿干净 ArrayBuffer (getKey 不经字符串转换, iOS bug 不污染) + 手写 raw bytes 协议
    //   push-server 端 express.raw 接 Buffer, 直接存 Neon BYTEA, web-push 库从 BYTEA 还原
    //   协议: [4 字节 userId 长度 (uint32) | N 字节 userId (UTF-8) | 2 字节 endpoint 长度 (uint16) | N 字节 endpoint (UTF-8) | 65 字节 p256dh (raw) | 16 字节 auth (raw)]
    //   ★ userId 必须在 body 头部 (push-server 端 express.raw 不解析 URL query, 跟 /api/heartbeat 等 JSON 端点不同)
    const p256dhBuffer = subscription.getKey('p256dh');
    const authBuffer = subscription.getKey('auth');
    if (!p256dhBuffer || !authBuffer) {
      throw new Error('subscription.getKey 返回空, 浏览器可能不支持原生 Push API');
    }
    const p256dhU8 = new Uint8Array(p256dhBuffer);
    const authU8 = new Uint8Array(authBuffer);
    if (p256dhU8.length !== 65) {
      console.warn('[服务器推送] p256dh 字节数异常:', p256dhU8.length, '(预期 65, web-push P-256 uncompressed public key)');
    }
    if (authU8.length !== 16) {
      console.warn('[服务器推送] auth 字节数异常:', authU8.length, '(预期 16, web-push auth secret)');
    }
    const enc = new TextEncoder();
    const userIdBytes = enc.encode(String(userId || ''));
    if (userIdBytes.length > 4294967295) {
      throw new Error('userId 太长 (超过 4GB)');
    }
    const endpointBytes = enc.encode(String(subscription.endpoint || ''));
    if (endpointBytes.length > 65535) {
      throw new Error('endpoint 太长 (超过 65535 字节)');
    }
    const totalLen = 4 + userIdBytes.length + 2 + endpointBytes.length + p256dhU8.length + authU8.length;
    const body = new Uint8Array(totalLen);
    const dv = new DataView(body.buffer);
    dv.setUint32(0, userIdBytes.length);
    body.set(userIdBytes, 4);
    const off1 = 4 + userIdBytes.length;
    dv.setUint16(off1, endpointBytes.length);
    body.set(endpointBytes, off1 + 2);
    body.set(p256dhU8, off1 + 2 + endpointBytes.length);
    body.set(authU8, off1 + 2 + endpointBytes.length + p256dhU8.length);
    console.log('[服务器推送] v0.2.21: raw bytes 上传, userId 字节数:', userIdBytes.length, 'endpoint 字节数:', endpointBytes.length, 'p256dh:', p256dhU8.length, 'auth:', authU8.length, '总:', totalLen);

    // 6. raw bytes POST (application/octet-stream), 完全不走 string 转换
    const saveResponse = await fetch(`${serverUrl}/api/save-subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body
    });

    if (!saveResponse.ok) {
      throw new Error(`保存订阅失败: ${saveResponse.status}`);
    }

    console.log('[服务器推送] 订阅已保存到服务器');
    return true;
  } catch (error) {
    console.error('[服务器推送] 订阅失败:', error);
    throw error;
  }
}

/**
 * 取消订阅服务器推送
 * @returns {Promise<boolean>}
 */
async function unsubscribeFromPushServer() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await subscription.unsubscribe();
      console.log('[服务器推送] 已取消订阅');
      return true;
    }
    return false;
  } catch (error) {
    console.error('[服务器推送] 取消订阅失败:', error);
    return false;
  }
}

// ========== 聊天内通知 ==========
// 原始位置：script.js 第 36475~36490 行

  // 2026-06-30 修复：用户之前手动填过期的 catbox URL 到 notificationSoundUrl，每次新消息
  // 通知都会触发 player.src 重设 → 浏览器重 fetch 死链 → ERR_CONNECTION_RESET → play reject。
  // 失败过的 URL 加内存黑名单，避免反复刷屏报错。state 里的原值不动，让用户保留设置入口可手动更换。
  const _failedNotificationSoundUrls = new Set();

  function playNotificationSound() {
    const player = document.getElementById('notification-sound-player');

    const soundUrl = state.globalSettings.notificationSoundUrl || DEFAULT_NOTIFICATION_SOUND;


    if (soundUrl && soundUrl.trim() && !_failedNotificationSoundUrls.has(soundUrl)) {
      player.src = soundUrl;
      // 应用音量设置
      player.volume = state.globalSettings.notificationVolume !== undefined ? state.globalSettings.notificationVolume : 1.0;

      player.play().catch(error => {
        // 一次失败即列入黑名单 + 主动清掉 src，避免后续每条消息都重 fetch 死链
        _failedNotificationSoundUrls.add(soundUrl);
        try { player.pause(); } catch (e) {}
        try { player.removeAttribute('src'); } catch (e) {}
        try { player.load(); } catch (e) {}
        console.warn('[通知音] URL 已失效（已加入黑名单，不再重试）:', soundUrl, '·', (error && error.message) || error);
      });
    }
  }

  // 暴露黑名单复位入口：用户更换 URL 后调用，让新 URL 有机会再试一次
  window.__resetFailedNotificationSoundUrls = function () {
    _failedNotificationSoundUrls.clear();
  };

// 原始位置：script.js 第 8891~8960 行
  function showNotification(chatId, messageContent) {
    const chat = state.chats[chatId];
    if (!chat) return;

    // 检查是否禁用内部弹窗通知
    const disableInternalNotification = state.globalSettings.systemNotification?.disableInternalNotification || false;

    // 如果未禁用内部弹窗，则显示内部弹窗
    if (!disableInternalNotification) {
      playNotificationSound();

      clearTimeout(notificationTimeout);

      const bar = document.getElementById('notification-bar');

      document.getElementById('notification-avatar').src = chat.settings.aiAvatar || chat.settings.groupAvatar || defaultAvatar;
      document.getElementById('notification-content').querySelector('.name').textContent = chat.name;
      document.getElementById('notification-content').querySelector('.message').textContent = messageContent;

      bar.classList.remove('visible');

      void bar.offsetWidth;

      bar.classList.add('visible');

      const newBar = bar.cloneNode(true);
      bar.parentNode.replaceChild(newBar, bar);
      newBar.addEventListener('click', () => {
        openChat(chatId);
        newBar.classList.remove('visible');
      });

      notificationTimeout = setTimeout(() => {
        newBar.classList.remove('visible');
      }, 4000);
      updateBackButtonUnreadCount();
    }

    // 新增：触发系统级通知
    console.log('[系统通知调试] showNotification 被调用:', {
      chatId,
      messageContent,
      systemNotificationEnabled: state.globalSettings.systemNotification?.enabled,
      disableInternalNotification: disableInternalNotification,
      notificationPermission: typeof Notification !== 'undefined' ? Notification.permission : 'N/A'
    });

    if (state.globalSettings.systemNotification?.enabled) {
      console.log('[系统通知调试] 准备调用 handleSystemNotification');
      handleSystemNotification(chatId, messageContent);
    } else {
      console.log('[系统通知调试] 系统通知未启用或配置不存在');
    }
  }

  // 新增：在聊天页面也触发系统级通知（如果启用了相应选项）
  function triggerSystemNotificationInChatPage(chatId, messageContent) {
    // 检查是否启用了"在聊天页面也发送通知"选项
    const notifyInChatPage = state.globalSettings.systemNotification?.notifyInChatPage || false;

    if (notifyInChatPage && state.globalSettings.systemNotification?.enabled) {
      console.log('[系统通知调试] 在聊天页面触发系统级通知:', {
        chatId,
        messageContent
      });
      handleSystemNotification(chatId, messageContent);
    }
  }

// ========== 系统级通知功能 ==========
// 原始位置：script.js 第 36608~37175 行

  // 初始化系统通知
  function initSystemNotification() {
    if (!('Notification' in window)) {
      console.warn('此浏览器不支持系统通知');
    }

    updateNotificationPermissionStatus();
    bindSystemNotificationEvents();
    loadSystemNotificationSettings(); // 🔥 修复：页面加载时恢复所有设置和子菜单显示状态

    // 定时检查权限状态变化（兼容不支持 permissions.onchange 的浏览器）
    setInterval(() => {
      updateNotificationPermissionStatus();
    }, 3000);
  }

  function ensureSystemNotificationConfig() {
    if (!state.globalSettings.systemNotification) {
      state.globalSettings.systemNotification = {};
    }
    if (!state.globalSettings.systemNotification.pushServer) {
      state.globalSettings.systemNotification.pushServer = {
        enabled: false,
        serverUrl: '',
        apiKey: ''
      };
    }
    return state.globalSettings.systemNotification;
  }

  function getReadableNotificationError(error) {
    const rawMessage = error?.message || String(error || '未知错误');
    if (rawMessage.includes('denied') || rawMessage.includes('permission')) return '通知权限未开启';
    if (rawMessage.includes('Service Worker') || rawMessage.includes('service worker')) return 'Service Worker 不可用';
    if (rawMessage.includes('Push') || rawMessage.includes('push')) return 'Push 订阅不可用';
    if (rawMessage.includes('applicationServerKey') || rawMessage.includes('VAPID')) return '服务器推送未配置公钥';
    if (rawMessage.includes('secure') || rawMessage.includes('Only secure')) return '需要 HTTPS 或本地环境';
    return rawMessage.slice(0, 80);
  }

  function formatNotificationTime(value) {
    if (!value) return '未记录';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '未记录';
    return date.toLocaleString();
  }

  async function persistSystemNotificationHealthFields() {
    try {
      if (window.db?.globalSettings?.put && state.globalSettings) {
        await window.db.globalSettings.put(state.globalSettings);
      }
    } catch (error) {
      console.warn('[系统通知健康检测] 保存轻量状态失败:', error);
    }
  }

  function setStatusText(elementId, text, color = '#999') {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = text;
    el.style.color = color;
  }

  function renderNotificationHealthStatus(health) {
    const config = ensureSystemNotificationConfig();
    const panel = document.getElementById('notification-health-panel');
    const legacyContainer = document.getElementById('notification-permission-status');
    const enabled = !!config.enabled;

    if (panel) panel.style.display = enabled ? 'block' : 'none';
    if (legacyContainer) legacyContainer.style.display = 'none';

    const permissionMap = {
      granted: ['已授权', '#4cd964'],
      denied: ['已拒绝', '#ff3b30'],
      default: ['未授权', '#ff9500'],
      unsupported: ['不支持', '#999']
    };
    const permissionInfo = permissionMap[health?.permission || 'unsupported'] || permissionMap.unsupported;
    setStatusText('permission-status-text', permissionInfo[0], permissionInfo[1]);
    setStatusText('permission-status-text-legacy', permissionInfo[0], permissionInfo[1]);

    let swText = '未检测';
    let swColor = '#999';
    if (health) {
      if (!health.serviceWorkerSupported) {
        swText = '不支持';
      } else if (health.serviceWorkerRegistered) {
        swText = '已注册';
        swColor = '#4cd964';
      } else if (health.serviceWorkerError) {
        swText = '注册失败';
        swColor = '#ff3b30';
      } else {
        swText = '未注册';
        swColor = '#ff9500';
      }
    }
    setStatusText('notification-sw-status-text', swText, swColor);

    let pushText = '未检测';
    let pushColor = '#999';
    if (health) {
      if (!health.pushManagerSupported) {
        pushText = '不支持';
      } else if (health.pushSubscriptionExists) {
        pushText = '正常';
        pushColor = '#4cd964';
      } else if (health.pushSubscriptionError) {
        pushText = '创建失败';
        pushColor = '#ff3b30';
      } else {
        pushText = '不存在';
        pushColor = '#ff9500';
      }
    }
    setStatusText('notification-push-status-text', pushText, pushColor);

    const lastTestResult = config.lastNotificationTestResult;
    let lastTestText = '未测试';
    let lastTestColor = '#999';
    if (lastTestResult === 'success') {
      lastTestText = `成功（${formatNotificationTime(config.lastNotificationTestAt)}）`;
      lastTestColor = '#4cd964';
    } else if (lastTestResult === 'failed') {
      lastTestText = `失败（${config.lastNotificationTestError || '未知错误'}，${formatNotificationTime(config.lastNotificationTestAt)}）`;
      lastTestColor = '#ff3b30';
    }
    setStatusText('notification-last-test-text', lastTestText, lastTestColor);

    const overallMap = {
      normal: ['正常', '#4cd964'],
      repair: ['需要修复', '#ff9500'],
      unavailable: ['不可用', '#ff3b30'],
      unknown: ['未检测', '#999']
    };
    const overallInfo = overallMap[config.notificationHealthStatus || health?.overallStatus || 'unknown'] || overallMap.unknown;
    setStatusText('notification-health-overall-text', overallInfo[0], overallInfo[1]);
    setStatusText('notification-last-health-check-text', formatNotificationTime(config.lastNotificationHealthCheckAt), '#999');
  }

  function calculateNotificationOverallStatus(health) {
    if (!health.notificationSupported || health.permission === 'denied') return 'unavailable';
    if (!health.systemNotificationEnabled) return 'repair';
    if (health.permission !== 'granted') return 'repair';
    if (!health.serviceWorkerSupported || !health.serviceWorkerRegistered) return 'repair';
    if (health.pushServerEnabled && (!health.pushManagerSupported || !health.pushSubscriptionExists)) return 'repair';
    if (health.lastNotificationTestResult === 'failed') return 'repair';
    return 'normal';
  }

  // 通知健康检测：不只看 Notification.permission，同时检查 SW、Push、本地测试记录和开关状态
  async function checkNotificationHealth(options = {}) {
    const { persist = true, render = true } = options;
    const config = ensureSystemNotificationConfig();
    const health = {
      notificationSupported: 'Notification' in window,
      permission: 'Notification' in window ? Notification.permission : 'unsupported',
      serviceWorkerSupported: 'serviceWorker' in navigator,
      serviceWorkerRegistered: false,
      serviceWorkerError: '',
      pushManagerSupported: false,
      pushSubscriptionExists: false,
      pushSubscriptionError: '',
      systemNotificationEnabled: !!config.enabled,
      pushServerEnabled: !!config.pushServer?.enabled,
      lastNotificationTestResult: config.lastNotificationTestResult || '',
      lastNotificationTestAt: config.lastNotificationTestAt || '',
      lastNotificationTestError: config.lastNotificationTestError || ''
    };

    let registration = null;
    if (health.serviceWorkerSupported) {
      try {
        registration = await navigator.serviceWorker.getRegistration();
        if (!registration && navigator.serviceWorker.ready) {
          try {
            registration = await Promise.race([
              navigator.serviceWorker.ready,
              new Promise(resolve => setTimeout(() => resolve(null), 1500))
            ]);
          } catch (readyError) {
            health.serviceWorkerError = getReadableNotificationError(readyError);
          }
        }
        health.serviceWorkerRegistered = !!registration;
      } catch (error) {
        health.serviceWorkerError = getReadableNotificationError(error);
      }
    }

    if (registration && 'PushManager' in window && registration.pushManager) {
      health.pushManagerSupported = true;
      try {
        const subscription = await registration.pushManager.getSubscription();
        health.pushSubscriptionExists = !!subscription;
        config.lastPushSubscriptionCheckedAt = new Date().toISOString();
      } catch (error) {
        health.pushSubscriptionError = getReadableNotificationError(error);
        config.lastPushSubscriptionCheckedAt = new Date().toISOString();
      }
    } else {
      health.pushManagerSupported = 'PushManager' in window;
    }

    health.overallStatus = calculateNotificationOverallStatus(health);
    config.lastNotificationHealthCheckAt = new Date().toISOString();
    config.notificationHealthStatus = health.overallStatus;

    if (health.permission === 'granted' && window.notificationManager) {
      window.notificationManager.permissionGranted = true;
    }

    if (render) renderNotificationHealthStatus(health);
    if (persist) await persistSystemNotificationHealthFields();

    return health;
  }

  function getConfiguredPushApplicationServerKey() {
    const pushServer = ensureSystemNotificationConfig().pushServer || {};
    const key = pushServer.applicationServerKey || pushServer.vapidPublicKey || pushServer.publicKey || '';
    if (!key || typeof key !== 'string') return null;
    return urlBase64ToUint8Array(key.trim());
  }

  async function tryCreatePushSubscription(registration) {
    if (!registration?.pushManager || !('PushManager' in window)) {
      return {
        ok: false,
        message: 'PushManager 不支持'
      };
    }

    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      return {
        ok: true,
        message: '已存在本地 Push 订阅'
      };
    }

    // v0.2.23 改: 删 fallback 字段, applicationServerKey 长度检查 (0 字节 ArrayBuffer 也算空)
    //   之前 !applicationServerKey 检查走漏 urlBase64ToUint8Array(空字符串)=0 字节 ArrayBuffer (不 null) → push.subscribe 报 P-256 错
    //   改用 applicationServerKey?.byteLength === 65 (P-256 uncompressed) 严格检查
    let applicationServerKey = null;
    try {
      const pushServerUrl = (ensureSystemNotificationConfig().pushServer?.serverUrl || '').replace(/\/$/, '');
      if (pushServerUrl) {
        const keyResponse = await fetch(`${pushServerUrl}/api/vapid-public-key`);
        if (keyResponse.ok) {
          const { publicKey } = await keyResponse.json();
          applicationServerKey = urlBase64ToUint8Array(publicKey);
          console.log('[tryCreatePushSubscription] ✅ fetch VAPID 公钥成功, 长度:', applicationServerKey?.byteLength, '字节');
        } else {
          throw new Error(`获取公钥失败: HTTP ${keyResponse.status}`);
        }
      } else {
        throw new Error('推送服务器地址未配置');
      }
    } catch (e) {
      // v0.2.23 改: fetch 拿 VAPID 失败时直接抛错 (不调 fallback 字段, 避免空字符串 → 0 字节 ArrayBuffer → P-256 错误诊)
      console.error('[tryCreatePushSubscription] fetch VAPID 公钥失败:', e.message);
      return {
        ok: false,
        message: '服务器推送未配置公钥: ' + e.message
      };
    }
    if (!applicationServerKey || applicationServerKey.byteLength !== 65) {
      // 严格检查 byteLength === 65 (P-256 uncompressed 长度), 0 字节或非 65 字节都视为无效
      return {
        ok: false,
        message: `服务器推送公钥无效: byteLength=${applicationServerKey?.byteLength || 0} (预期 65)`
      };
    }

    // iOS 18.x PWA 双 fallback
    try {
      await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey
      });
    } catch (abErr) {
      console.warn('[tryCreatePushSubscription] ArrayBuffer 失败, 试 Uint8Array:', abErr.message);
      await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: new Uint8Array(applicationServerKey)
      });
    }
    return {
      ok: true,
      message: '本地 Push 订阅已创建'
    };
  }

  // 一键修复通知：重新获取/注册 SW、按需请求权限、检查或创建 Push 订阅
  async function repairSystemNotification() {
    const config = ensureSystemNotificationConfig();
    const messages = [];
    const repairBtn = document.getElementById('repair-system-notification-btn');
    const originalBtnText = repairBtn ? repairBtn.textContent : '';
    // 2026-07-24 修复：按钮加 disabled + 状态文字，给用户"点了有反应"的即时反馈，
    // 并避免多次连点 + 排查"点了一键修复通知没反应"问题（之前的卡住可能由
    // navigator.serviceWorker.ready 永久 pending 导致）
    if (repairBtn) {
      repairBtn.disabled = true;
      repairBtn.textContent = '修复中…';
    }
    console.log('[系统通知修复] 启动');

    try {
      let registration = null;

      if (!('Notification' in window)) {
        console.warn('[系统通知修复] 浏览器不支持系统通知');
        alert('当前浏览器不支持系统通知');
        await checkNotificationHealth();
        return;
      }

      if ('serviceWorker' in navigator) {
        // 2026-07-24 修复：file:// 协议下 origin='null'，浏览器禁止注册 SW
        // (SecurityError: "The URL protocol of the current origin ('null') is not supported")
        // 直接跳过整个 SW 块，不当作"失败"，只提示用户升级访问方式
        const isFileProtocol = location.protocol === 'file:' || location.origin === 'null';
        if (isFileProtocol) {
          console.log('[系统通知修复] 当前是 file:// 协议，跳过 SW 注册（浏览器不支持）');
          messages.push('当前是 file:// 协议，Service Worker 不可用（如需 SW 推送请用 HTTPS / localhost / PWA 打开）');
        } else try {
          console.log('[系统通知修复] 检查 SW 注册状态...');
          registration = await navigator.serviceWorker.getRegistration();
          if (!registration) {
            console.log('[系统通知修复] 未注册，正在注册新 SW...');
            registration = await navigator.serviceWorker.register('./sw.js');
            messages.push('Service Worker 已重新注册');
          } else {
            console.log('[系统通知修复] 已存在 SW registration');
            messages.push('Service Worker 已获取');
          }
          if (navigator.serviceWorker.ready) {
            console.log('[系统通知修复] 等待 SW ready（最多 5s）...');
            // 2026-07-24 修复：iOS PWA 模式下 navigator.serviceWorker.ready 偶尔不 resolve，
            // 加 5s timeout 兜底，避免整个修复流程卡死
            try {
              registration = await Promise.race([
                navigator.serviceWorker.ready,
                new Promise((_, reject) => setTimeout(
                  () => reject(new Error('SW ready timeout (5s)')),
                  5000
                ))
              ]);
              console.log('[系统通知修复] SW ready 已就绪');
            } catch (readyErr) {
              console.warn('[系统通知修复] SW ready 等待超时:', readyErr.message);
              messages.push('SW ready 等待超时（5s），已跳过该步骤');
            }
          }
          if (window.notificationManager && registration) {
            window.notificationManager.swRegistration = registration;
            window.notificationManager.isInitialized = true;
          }
        } catch (error) {
          console.error('[系统通知修复] SW 注册失败:', error);
          // 2026-07-24 显示详细错误信息（error.name + error.message），
          // 帮用户快速分辨是 SecurityError（file:// 协议不支持）/
          // NetworkError（sw.js 404 或跨域）/
          // TypeError（旧 SW 卡 installing 状态，新 register() 冲突）
          const errDetail = `${error?.name || 'Error'}: ${error?.message || String(error)}`;
          messages.push('Service Worker 注册失败：' + getReadableNotificationError(error) + ' [' + errDetail + ']');
        }
      } else {
        messages.push('当前浏览器不支持 Service Worker');
      }

      console.log('[系统通知修复] 检查通知权限...');
      if (Notification.permission === 'default') {
        const permissionGranted = await requestNotificationPermission();
        messages.push(permissionGranted ? '通知权限已授权' : '通知权限未授权');
      } else if (Notification.permission === 'granted') {
        messages.push('通知权限已授权');
      } else {
        messages.push('通知权限已拒绝，需要在浏览器或系统设置中手动开启');
      }

      console.log('[系统通知修复] 检查 Push 订阅...');
      if (Notification.permission === 'granted' && registration && 'PushManager' in window) {
        try {
          const pushResult = await tryCreatePushSubscription(registration);
          messages.push(pushResult.message);
          // v0.2.09 修: 删 v0.2.02 时代遗留的 "VAPID 公钥未发现" 警告
          //   永远触发 (getConfiguredPushApplicationServerKey() 永远返 null, 因为 v0.2.02 后
          //   VAPID 公钥改成 fetch /api/vapid-public-key, UI 没字段了)
          //   真实状态看 tryCreatePushSubscription 返回的 message (成功/失败/原因)
        } catch (error) {
          messages.push('Push 订阅检查失败：' + getReadableNotificationError(error));
        }
      } else if (!('PushManager' in window)) {
        messages.push('当前浏览器不支持 PushManager');
      }

      console.log('[系统通知修复] 重新检测健康状态...');
      await checkNotificationHealth();
      console.log('[系统通知修复] 完成:', messages);
      // 2026-07-24 修复：alert 顶部加 success/failure summary
      // 之前直接 alert(messages.join('\n'))，如果 SW 注册失败、push 失败，
      // 用户看到的就是一堆失败消息，没有任何"流程跑完了"的反馈。
      // 现在：顶部明确告诉用户"全部成功"/"部分需要关注"+ 失败项数量
      // 注意：file:// 协议下"SW 不可用"是环境限制不算失败，PushManager 不支持也不算失败
      const failureCount = messages.filter(m =>
        m.includes('失败') || m.includes('未授权') || m.includes('已拒绝')
      ).length;
      const summary = failureCount === 0
        ? '✅ 通知修复成功'
        : `⚠️ 通知修复流程已执行（${failureCount} 项需要关注）`;
      alert(`${summary}\n\n${messages.join('\n')}`);
    } catch (error) {
      console.error('[系统通知修复] 失败:', error);
      alert('❌ 一键修复失败：' + getReadableNotificationError(error));
      await checkNotificationHealth();
    } finally {
      // 恢复按钮状态（无论成功失败）
      if (repairBtn) {
        repairBtn.disabled = false;
        repairBtn.textContent = originalBtnText || '一键修复通知';
      }
    }
  }

  // 更新权限状态显示
  async function updateNotificationPermissionStatus() {
    await checkNotificationHealth({
      persist: false,
      render: true
    });
  }

  // 请求通知权限 - iOS优化版
  async function requestNotificationPermission() {
    // 检测是否为iOS设备
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    // iOS特殊检查：是否在PWA模式下运行
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;

    if (isIOS && !isStandalone) {
      alert('iOS设备需要先将网页添加到主屏幕才能使用系统通知功能\n\n' +
        '操作步骤：\n' +
        '1. 点击 Safari 分享按钮\n' +
        '2. 选择"添加到主屏幕"\n' +
        '3. 从主屏幕打开应用');
      return false;
    }

    if (!('Notification' in window)) {
      alert(isIOS ?
        'iOS设备需要将网页添加到主屏幕后才能使用通知功能' :
        '您的浏览器不支持系统通知');
      return false;
    }

    try {
      // 直接用 Notification.permission（最可靠，兼容所有浏览器包括 iOS）
      let currentPermission = Notification.permission;

      if (currentPermission === 'granted') {
        if (window.notificationManager) {
          window.notificationManager.permissionGranted = true;
        }
        updateNotificationPermissionStatus();
        return true;
      }

      if (currentPermission === 'denied') {
        alert(isIOS ?
          '通知权限已被拒绝\n\n请在 iPhone 设置 > 通知 中手动开启' :
          '通知权限已被拒绝，请在浏览器设置中手动开启');
        return false;
      }

      // 请求权限（必须通过 Notification API）
      if (typeof Notification.requestPermission === 'function') {
        const permission = await Notification.requestPermission();
        await updateNotificationPermissionStatus();

        if (permission !== 'granted') {
          alert(isIOS ?
            '未授予通知权限\n\n如需开启，请在 iPhone 设置 > 通知 中手动开启' :
            '未授予通知权限，系统通知功能将无法使用');
          const switchEl = document.getElementById('system-notification-enabled-switch');
          if (switchEl) switchEl.checked = false;
          state.globalSettings.systemNotification.enabled = false;
          return false;
        }

        return true;
      } else {
        alert('您的浏览器不支持请求通知权限');
        return false;
      }
    } catch (error) {
      console.error('[权限请求] 失败:', error);
      alert(isIOS ?
        '请求通知权限失败\n\n请确保已将网页添加到主屏幕' :
        '请求通知权限失败: ' + error.message);
      return false;
    }
  }

  // 震动设备
  function vibrateDevice() {
    if (!('vibrate' in navigator)) {
      return;
    }

    const patterns = {
      short: [200],
      medium: [200, 100, 200],
      long: [400, 100, 400, 100, 400]
    };

    const pattern = state.globalSettings.systemNotification?.vibration?.pattern || 'short';
    navigator.vibrate(patterns[pattern]);
  }

  // 播放系统通知提示音
  function playSystemNotificationSound() {
    const soundConfig = state.globalSettings.systemNotification?.sound;

    if (!soundConfig || !soundConfig.enabled) {
      return;
    }

    let soundUrl;
    if (soundConfig.useGlobalSound) {
      soundUrl = state.globalSettings.notificationSoundUrl || DEFAULT_NOTIFICATION_SOUND;
    } else {
      soundUrl = soundConfig.customSoundUrl || DEFAULT_NOTIFICATION_SOUND;
    }

    // 2026-06-30：失败过的 URL 直接跳过，避免重复刷报错（与 playNotificationSound 共享黑名单）
    if (!soundUrl || !soundUrl.trim() || _failedNotificationSoundUrls.has(soundUrl)) return;

    const audio = new Audio(soundUrl);
    // 应用音量设置
    audio.volume = state.globalSettings.notificationVolume !== undefined ? state.globalSettings.notificationVolume : 1.0;
    audio.play().catch(err => {
      _failedNotificationSoundUrls.add(soundUrl);
      console.warn('[系统通知音] URL 已失效（已加入黑名单，不再重试）:', soundUrl, '·', (err && err.message) || err);
    });
  }

  // 显示系统通知（每条消息独立通知）- iOS优化版
  async function showSystemNotification(chatId, messageContent, options = {}) {
    console.log('[系统通知调试] showSystemNotification 被调用:', {
      chatId,
      messageContent,
      options,
      enabled: state.globalSettings.systemNotification?.enabled
    });

    if (!state.globalSettings.systemNotification?.enabled) {
      console.log('[系统通知调试] 系统通知未启用');
      return;
    }

    // 直接用 Notification.permission 检查权限（最可靠，兼容所有浏览器）
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      console.log('[系统通知调试] 通知权限未授予:', typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
      return;
    }

    const chat = state.chats[chatId];
    if (!chat) {
      console.log('[系统通知调试] 找不到聊天:', chatId);
      return;
    }

    const appName = state.globalSettings.systemNotification.appName || 'EPhone';
    const title = options.title || `${appName} - ${chat.name}`;
    const body = messageContent;
    const icon = chat.settings.aiAvatar || chat.settings.groupAvatar || 'https://i.postimg.cc/nMbyyt1t/D7CD735A73F5FD1D7B8407E0EB8BBAC0.png';

    // 每条消息使用唯一的 tag，确保每条都显示
    const uniqueTag = `chat-${chatId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    console.log('[系统通知调试] 准备创建通知:', {
      title,
      body,
      icon,
      tag: uniqueTag
    });

    try {
      // 检测是否为iOS设备
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

      // iOS友好的通知配置（简化版）
      const notifyOptions = {
        body: body,
        icon: icon,
        badge: icon,
        tag: uniqueTag,
        data: { chatId }
      };

      // Android/桌面端可以使用更多特性
      if (!isIOS) {
        notifyOptions.requireInteraction = true; // iOS不支持
        notifyOptions.renotify = true;
        notifyOptions.actions = [ // iOS不支持操作按钮
          { action: 'reply', title: '回复' },
          { action: 'dismiss', title: '关闭' }
        ];
      }

      // 优先使用 Service Worker（Android/桌面端/iOS PWA）
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        const registration = await navigator.serviceWorker.ready;
        console.log('[系统通知调试] Service Worker 已就绪');

        await registration.showNotification(title, notifyOptions);
        console.log('[系统通知调试] 通知创建成功（通过ServiceWorker）');
      } else if ('Notification' in window && Notification.permission === 'granted') {
        // Fallback 到 Notification API（iOS Safari可能需要）
        console.log('[系统通知调试] 使用 Notification API fallback');
        new Notification(title, notifyOptions);
      } else {
        console.warn('[系统通知调试] 无可用的通知方式');
        return;
      }

      // 播放提示音
      if (state.globalSettings.systemNotification.sound?.enabled) {
        console.log('[系统通知调试] 播放提示音');
        playSystemNotificationSound();
      }

      // 触发震动（使用通用的Vibration API）
      if (state.globalSettings.systemNotification.vibration?.enabled) {
        console.log('[系统通知调试] 触发震动');
        if (navigator.vibrate) {
          // iOS只支持简单震动模式，Android支持复杂模式
          const vibratePattern = isIOS ? 200 : [200, 100, 200, 100, 200];
          navigator.vibrate(vibratePattern);
        } else {
          // 使用原有的vibrateDevice()作为fallback
          vibrateDevice();
        }
      }
    } catch (error) {
      console.error('[系统通知调试] 创建通知失败:', error);
      // iOS友好的错误提示
      if (error.name === 'TypeError' && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
        console.warn('[系统通知调试] iOS设备：请确保已将网页添加到主屏幕');
      }
    }
  }

  // 处理系统通知（每条消息单独通知，不合并）
  async function handleSystemNotification(chatId, messageContent) {
    console.log('[系统通知调试] handleSystemNotification 被调用:', {
      chatId,
      messageContent,
      config: state.globalSettings.systemNotification
    });

    const config = state.globalSettings.systemNotification;

    if (!config || !config.enabled) {
      console.log('[系统通知调试] 配置检查失败:', {
        configExists: !!config,
        enabled: config?.enabled
      });
      return;
    }

    // 直接用 Notification.permission 检查权限（最可靠，兼容所有浏览器）
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      console.log('[系统通知调试] 通知权限未授予:', typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
      return;
    }

    console.log('[系统通知调试] 检查通过，准备显示通知');

    // 每条消息都单独显示通知，不使用合并逻辑
    console.log('[系统通知调试] 直接显示单条通知');
    showSystemNotification(chatId, messageContent);
  }

  // 发送测试通知
  async function sendTestNotification() {
    console.log('[系统通知调试] sendTestNotification 被调用');
    const config = ensureSystemNotificationConfig();
    const appName = config.appName || 'EPhone';

    try {
      const health = await checkNotificationHealth({
        persist: true,
        render: true
      });

      if (!health.notificationSupported || health.permission !== 'granted') {
        throw new Error(health.notificationSupported ? '通知权限未开启' : '当前浏览器不支持系统通知');
      }

      console.log('[系统通知调试] 准备创建测试通知, appName:', appName);

      // 检测是否为iOS设备
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

      // iOS友好的测试通知配置
      const testNotifyOptions = {
        body: '这是一条测试通知 🎉',
        icon: 'https://i.postimg.cc/nMbyyt1t/D7CD735A73F5FD1D7B8407E0EB8BBAC0.png',
        badge: 'https://i.postimg.cc/nMbyyt1t/D7CD735A73F5FD1D7B8407E0EB8BBAC0.png',
        tag: `test-notification-${Date.now()}`
      };

      const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;

      // 优先使用 Service Worker（Android/桌面端/iOS PWA）
      if (registration) {
        console.log('[系统通知调试] Service Worker Registration 可用');

        await registration.showNotification(appName, testNotifyOptions);
      } else if ('Notification' in window && Notification.permission === 'granted') {
        // Fallback 到 Notification API（iOS Safari可能需要）
        console.log('[系统通知调试] 使用 Notification API fallback');
        new Notification(appName, testNotifyOptions);
      } else {
        throw new Error(isIOS ?
          '请将网页添加到主屏幕并允许通知' :
          '没有可用的通知发送方式');
      }

      console.log('[系统通知调试] 测试通知创建成功');

      if (config.sound?.enabled) {
        playSystemNotificationSound();
      }

      if (config.vibration?.enabled) {
        vibrateDevice();
      }

      config.lastNotificationTestAt = new Date().toISOString();
      config.lastNotificationTestResult = 'success';
      config.lastNotificationTestError = '';
      await checkNotificationHealth({
        persist: true,
        render: true
      });
      alert('测试通知已发送');
    } catch (error) {
      const readableError = getReadableNotificationError(error);
      console.error('[系统通知调试] 创建测试通知失败:', error);
      config.lastNotificationTestAt = new Date().toISOString();
      config.lastNotificationTestResult = 'failed';
      config.lastNotificationTestError = readableError;
      await checkNotificationHealth({
        persist: true,
        render: true
      });
      alert('测试通知失败：' + readableError);
    }
  }

  // 绑定系统通知相关事件
  function bindSystemNotificationEvents() {
    const enabledSwitch = document.getElementById('system-notification-enabled-switch');
    const detailsDiv = document.getElementById('system-notification-details');
    const appNameInput = document.getElementById('system-notification-app-name');
    const testBtn = document.getElementById('test-system-notification-btn');
    const checkHealthBtn = document.getElementById('check-system-notification-health-btn');
    const repairBtn = document.getElementById('repair-system-notification-btn');

    const pushServerSwitch = document.getElementById('push-server-enabled-switch');
    const pushServerDetails = document.getElementById('push-server-details');
    const pushServerUrl = document.getElementById('push-server-url');
    const pushServerApiKey = document.getElementById('push-server-api-key');

    const vibrationSwitch = document.getElementById('notification-vibration-enabled-switch');
    const vibrationSelector = document.getElementById('vibration-pattern-selector');
    const vibrationPattern = document.getElementById('vibration-pattern-select');

    const soundSwitch = document.getElementById('notification-sound-enabled-switch');
    const soundDetails = document.getElementById('notification-sound-details');
    const useGlobalSound = document.getElementById('use-global-sound-switch');
    const customSoundWrapper = document.getElementById('custom-sound-input-wrapper');
    const customSoundUrl = document.getElementById('custom-notification-sound-url');

    if (enabledSwitch) {
      enabledSwitch.addEventListener('change', async () => {
        if (enabledSwitch.checked) {
          const granted = await requestNotificationPermission();
          if (granted) {
            state.globalSettings.systemNotification.enabled = true;
            detailsDiv.style.display = 'block';
            updateNotificationPermissionStatus();
          } else {
            enabledSwitch.checked = false;
          }
        } else {
          state.globalSettings.systemNotification.enabled = false;
          detailsDiv.style.display = 'none';
          updateNotificationPermissionStatus();
        }
      });
    }

    if (appNameInput) {
      appNameInput.addEventListener('input', () => {
        state.globalSettings.systemNotification.appName = appNameInput.value.trim() || 'EPhone';
      });
    }

    if (checkHealthBtn) {
      checkHealthBtn.addEventListener('click', async () => {
        await checkNotificationHealth({
          persist: true,
          render: true
        });
        alert('通知状态检测完成');
      });
    }

    if (repairBtn) {
      repairBtn.addEventListener('click', repairSystemNotification);
    }

    if (testBtn) {
      testBtn.addEventListener('click', sendTestNotification);
    }

    if (pushServerSwitch) {
      pushServerSwitch.addEventListener('change', async () => {
        const enabled = pushServerSwitch.checked;
        state.globalSettings.systemNotification.pushServer.enabled = enabled;
        pushServerDetails.style.display = enabled ? 'block' : 'none';

        if (enabled) {
          // 用户开启服务器推送
          try {
            // 获取当前 PWA 的唯一 userId (v0.2.10+: 不用 onlineChatState/nickname, 避免多 PWA 串台)
            const userId = getOrCreatePushUserId();

            // 获取服务器地址（从输入框读取，不再检查是否为空）
            let serverUrl = pushServerUrl?.value.trim() || state.globalSettings.systemNotification.pushServer.serverUrl || '';

            if (!serverUrl) {
              // 如果用户还没填写服务器地址，提示用户填写
              alert('请先填写推送服务器地址');
              pushServerSwitch.checked = false;
              state.globalSettings.systemNotification.pushServer.enabled = false;
              pushServerDetails.style.display = 'none';
              return;
            }

            // 去掉末尾的斜杠
            serverUrl = serverUrl.replace(/\/$/, '');

            // 保存服务器地址到 state 和 localStorage
            state.globalSettings.systemNotification.pushServer.serverUrl = serverUrl;
            localStorage.setItem('pushServerUrl', serverUrl);

            // 开始订阅流程
            console.log('[服务器推送] 用户开启推送，开始订阅...', { userId, serverUrl });
            await subscribeToPushServer(userId, serverUrl);

            alert('服务器推送已启用！');
            console.log('[服务器推送] 订阅成功');
          } catch (error) {
            console.error('[服务器推送] 订阅失败:', error);
            alert(`服务器推送启用失败: ${error.message}`);
            pushServerSwitch.checked = false;
            state.globalSettings.systemNotification.pushServer.enabled = false;
            pushServerDetails.style.display = 'none';
          }
        } else {
          // 用户关闭服务器推送
          try {
            await unsubscribeFromPushServer();
            console.log('[服务器推送] 已取消订阅');
          } catch (error) {
            console.error('[服务器推送] 取消订阅时出错:', error);
          }
        }

        await checkNotificationHealth({
          persist: true,
          render: true
        });
      });
    }

    if (pushServerUrl) {
      pushServerUrl.addEventListener('input', () => {
        const url = pushServerUrl.value.trim();
        state.globalSettings.systemNotification.pushServer.serverUrl = url;
        // 保存到 localStorage
        localStorage.setItem('pushServerUrl', url);
      });
    }

    if (pushServerApiKey) {
      pushServerApiKey.addEventListener('input', () => {
        state.globalSettings.systemNotification.pushServer.apiKey = pushServerApiKey.value.trim();
      });
    }

    if (vibrationSwitch) {
      vibrationSwitch.addEventListener('change', () => {
        state.globalSettings.systemNotification.vibration.enabled = vibrationSwitch.checked;
        vibrationSelector.style.display = vibrationSwitch.checked ? 'block' : 'none';
      });
    }

    if (vibrationPattern) {
      vibrationPattern.addEventListener('change', () => {
        state.globalSettings.systemNotification.vibration.pattern = vibrationPattern.value;
      });
    }

    if (soundSwitch) {
      soundSwitch.addEventListener('change', () => {
        state.globalSettings.systemNotification.sound.enabled = soundSwitch.checked;
        soundDetails.style.display = soundSwitch.checked ? 'block' : 'none';
      });
    }

    if (useGlobalSound) {
      useGlobalSound.addEventListener('change', () => {
        state.globalSettings.systemNotification.sound.useGlobalSound = useGlobalSound.checked;
        customSoundWrapper.style.display = useGlobalSound.checked ? 'none' : 'block';
      });
    }

    if (customSoundUrl) {
      customSoundUrl.addEventListener('input', () => {
        state.globalSettings.systemNotification.sound.customSoundUrl = customSoundUrl.value.trim();
      });
    }

    // 在聊天页面也发送通知
    const notifyInChatPageSwitch = document.getElementById('notify-in-chat-page-switch');
    if (notifyInChatPageSwitch) {
      notifyInChatPageSwitch.addEventListener('change', () => {
        state.globalSettings.systemNotification.notifyInChatPage = notifyInChatPageSwitch.checked;
      });
    }

    // 禁用内部弹窗
    const disableInternalNotificationSwitch = document.getElementById('disable-internal-notification-switch');
    if (disableInternalNotificationSwitch) {
      disableInternalNotificationSwitch.addEventListener('change', () => {
        state.globalSettings.systemNotification.disableInternalNotification = disableInternalNotificationSwitch.checked;
      });
    }
  }

  // 加载系统通知设置到UI
  function loadSystemNotificationSettings() {
    const config = state.globalSettings.systemNotification;
    if (!config) return;

    const enabledSwitch = document.getElementById('system-notification-enabled-switch');
    const detailsDiv = document.getElementById('system-notification-details');
    const appNameInput = document.getElementById('system-notification-app-name');

    const pushServerSwitch = document.getElementById('push-server-enabled-switch');
    const pushServerDetails = document.getElementById('push-server-details');
    const pushServerUrl = document.getElementById('push-server-url');
    const pushServerApiKey = document.getElementById('push-server-api-key');

    const vibrationSwitch = document.getElementById('notification-vibration-enabled-switch');
    const vibrationSelector = document.getElementById('vibration-pattern-selector');
    const vibrationPattern = document.getElementById('vibration-pattern-select');

    const soundSwitch = document.getElementById('notification-sound-enabled-switch');
    const soundDetails = document.getElementById('notification-sound-details');
    const useGlobalSound = document.getElementById('use-global-sound-switch');
    const customSoundWrapper = document.getElementById('custom-sound-input-wrapper');
    const customSoundUrl = document.getElementById('custom-notification-sound-url');

    // 加载主开关状态
    if (enabledSwitch) {
      enabledSwitch.checked = config.enabled || false;
      detailsDiv.style.display = config.enabled ? 'block' : 'none';
    }

    if (appNameInput) {
      appNameInput.value = config.appName || 'EPhone';
    }

    // 加载推送服务器设置
    if (pushServerSwitch) {
      pushServerSwitch.checked = config.pushServer?.enabled || false;
      pushServerDetails.style.display = config.pushServer?.enabled ? 'block' : 'none';
    }

    if (pushServerUrl) {
      // 优先从 localStorage 读取，如果没有则使用 config 中的值，最后使用默认值
      const savedUrl = localStorage.getItem('pushServerUrl');
      const urlToUse = savedUrl || config.pushServer?.serverUrl || 'https://ppc-asset-card-ease.trycloudflare.com';
      pushServerUrl.value = urlToUse;
      // 同步到 state
      if (!config.pushServer) {
        config.pushServer = { enabled: false, serverUrl: '', apiKey: '' };
      }
      config.pushServer.serverUrl = urlToUse;
    }

    if (pushServerApiKey) {
      pushServerApiKey.value = config.pushServer?.apiKey || '';
    }

    // 加载震动设置
    if (vibrationSwitch) {
      vibrationSwitch.checked = config.vibration?.enabled || false;
      vibrationSelector.style.display = config.vibration?.enabled ? 'block' : 'none';
    }

    if (vibrationPattern) {
      vibrationPattern.value = config.vibration?.pattern || 'short';
    }

    // 加载声音设置
    if (soundSwitch) {
      soundSwitch.checked = config.sound?.enabled || false;
      soundDetails.style.display = config.sound?.enabled ? 'block' : 'none';
    }

    if (useGlobalSound) {
      useGlobalSound.checked = config.sound?.useGlobalSound !== false;
      customSoundWrapper.style.display = config.sound?.useGlobalSound !== false ? 'none' : 'block';
    }

    if (customSoundUrl) {
      customSoundUrl.value = config.sound?.customSoundUrl || '';
    }

    renderNotificationHealthStatus({
      notificationSupported: 'Notification' in window,
      permission: 'Notification' in window ? Notification.permission : 'unsupported',
      serviceWorkerSupported: 'serviceWorker' in navigator,
      serviceWorkerRegistered: false,
      pushManagerSupported: 'PushManager' in window,
      pushSubscriptionExists: false,
      systemNotificationEnabled: !!config.enabled,
      pushServerEnabled: !!config.pushServer?.enabled,
      overallStatus: config.notificationHealthStatus || 'unknown'
    });

    // 加载在聊天页面也发送通知设置
    const notifyInChatPageSwitch = document.getElementById('notify-in-chat-page-switch');
    if (notifyInChatPageSwitch) {
      notifyInChatPageSwitch.checked = config.notifyInChatPage || false;
    }

    // 加载禁用内部弹窗设置
    const disableInternalNotificationSwitch = document.getElementById('disable-internal-notification-switch');
    if (disableInternalNotificationSwitch) {
      disableInternalNotificationSwitch.checked = config.disableInternalNotification || false;
    }

    updateNotificationPermissionStatus();
  }

  // ========== 系统级通知功能结束 ==========

  // ========== 截图水印功能开始 ==========
  // 原始位置：script.js 第 37178~37448 行

  // 水印配置
  let watermarkConfig = {
    enabled: false,
    text: '保密内容 请勿外传',
    layout: 'diagonal', // diagonal, grid, sparse, dense
    color: '#000000',
    opacity: 0.1,
    fontSize: 20,
    fontFamily: "'Microsoft YaHei', sans-serif"
  };

  // 创建水印层
  function createWatermarkLayer() {
    // 移除已存在的水印层
    const existingWatermark = document.getElementById('screenshot-watermark-layer');
    if (existingWatermark) {
      existingWatermark.remove();
    }

    if (!watermarkConfig.enabled) return;

    const watermarkLayer = document.createElement('div');
    watermarkLayer.id = 'screenshot-watermark-layer';
    watermarkLayer.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      pointer-events: none;
      z-index: 999999;
      overflow: hidden;
    `;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // 根据屏幕宽度计算缩放比例（移动端适配）
    const screenWidth = window.innerWidth;
    const isMobile = screenWidth < 768;
    const scaleFactor = isMobile ? Math.max(0.5, screenWidth / 768) : 1;
    
    // 根据布局方式设置canvas大小（移动端自适应）
    let canvasWidth, canvasHeight;
    switch (watermarkConfig.layout) {
      case 'diagonal':
        canvasWidth = Math.round(400 * scaleFactor);
        canvasHeight = Math.round(200 * scaleFactor);
        break;
      case 'grid':
        canvasWidth = Math.round(300 * scaleFactor);
        canvasHeight = Math.round(150 * scaleFactor);
        break;
      case 'sparse':
        canvasWidth = Math.round(600 * scaleFactor);
        canvasHeight = Math.round(300 * scaleFactor);
        break;
      case 'dense':
        canvasWidth = Math.round(250 * scaleFactor);
        canvasHeight = Math.round(125 * scaleFactor);
        break;
      default:
        canvasWidth = Math.round(400 * scaleFactor);
        canvasHeight = Math.round(200 * scaleFactor);
    }

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    // 计算自适应字体大小
    const adaptiveFontSize = Math.round(watermarkConfig.fontSize * scaleFactor);

    // 绘制水印文字
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.font = `${adaptiveFontSize}px ${watermarkConfig.fontFamily}`;
    ctx.fillStyle = watermarkConfig.color;
    ctx.globalAlpha = watermarkConfig.opacity;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (watermarkConfig.layout === 'diagonal') {
      // 斜向排列
      ctx.translate(canvasWidth / 2, canvasHeight / 2);
      ctx.rotate(-25 * Math.PI / 180);
      ctx.fillText(watermarkConfig.text, 0, 0);
    } else if (watermarkConfig.layout === 'grid') {
      // 网格排列（水平）
      ctx.fillText(watermarkConfig.text, canvasWidth / 2, canvasHeight / 2);
    } else if (watermarkConfig.layout === 'sparse' || watermarkConfig.layout === 'dense') {
      // 稀疏/密集排列（斜向）
      ctx.translate(canvasWidth / 2, canvasHeight / 2);
      ctx.rotate(-30 * Math.PI / 180);
      ctx.fillText(watermarkConfig.text, 0, 0);
    }

    // 将canvas转换为背景图片
    const dataURL = canvas.toDataURL('image/png');
    watermarkLayer.style.backgroundImage = `url(${dataURL})`;
    watermarkLayer.style.backgroundRepeat = 'repeat';
    
    document.body.appendChild(watermarkLayer);
  }

  // 加载水印设置
  function loadWatermarkSettings() {
    const savedConfig = localStorage.getItem('watermarkConfig');
    if (savedConfig) {
      try {
        const parsed = JSON.parse(savedConfig);
        watermarkConfig = { ...watermarkConfig, ...parsed };
      } catch (e) {
        console.error('加载水印配置失败:', e);
      }
    }

    // 更新UI
    const enabledSwitch = document.getElementById('watermark-enabled-switch');
    const textInput = document.getElementById('watermark-text');
    const layoutSelect = document.getElementById('watermark-layout');
    const colorInput = document.getElementById('watermark-color');
    const opacityInput = document.getElementById('watermark-opacity');
    const fontSizeInput = document.getElementById('watermark-font-size');
    const fontFamilySelect = document.getElementById('watermark-font-family');
    const settingsContainer = document.getElementById('watermark-settings-container');

    if (enabledSwitch) enabledSwitch.checked = watermarkConfig.enabled;
    if (textInput) textInput.value = watermarkConfig.text;
    if (layoutSelect) layoutSelect.value = watermarkConfig.layout;
    if (colorInput) colorInput.value = watermarkConfig.color;
    if (opacityInput) opacityInput.value = watermarkConfig.opacity;
    if (fontSizeInput) fontSizeInput.value = watermarkConfig.fontSize;
    if (fontFamilySelect) fontFamilySelect.value = watermarkConfig.fontFamily;
    if (settingsContainer) settingsContainer.style.display = watermarkConfig.enabled ? 'block' : 'none';

    // 更新显示值
    updateWatermarkDisplayValues();

    // 如果启用，创建水印层
    if (watermarkConfig.enabled) {
      createWatermarkLayer();
    }
  }

  // 保存水印设置
  function saveWatermarkSettings() {
    localStorage.setItem('watermarkConfig', JSON.stringify(watermarkConfig));
  }

  // 更新显示值
  function updateWatermarkDisplayValues() {
    const colorDisplay = document.getElementById('watermark-color-display');
    const opacityDisplay = document.getElementById('watermark-opacity-display');
    const fontSizeDisplay = document.getElementById('watermark-font-size-display');

    if (colorDisplay) colorDisplay.textContent = watermarkConfig.color;
    if (opacityDisplay) opacityDisplay.textContent = Math.round(watermarkConfig.opacity * 100) + '%';
    if (fontSizeDisplay) fontSizeDisplay.textContent = watermarkConfig.fontSize + 'px';
  }

  // 绑定水印设置事件
  function bindWatermarkEvents() {
    const enabledSwitch = document.getElementById('watermark-enabled-switch');
    const textInput = document.getElementById('watermark-text');
    const layoutSelect = document.getElementById('watermark-layout');
    const colorInput = document.getElementById('watermark-color');
    const opacityInput = document.getElementById('watermark-opacity');
    const fontSizeInput = document.getElementById('watermark-font-size');
    const fontFamilySelect = document.getElementById('watermark-font-family');
    const previewBtn = document.getElementById('watermark-preview-btn');
    const settingsContainer = document.getElementById('watermark-settings-container');

    // 启用/禁用水印
    if (enabledSwitch) {
      enabledSwitch.addEventListener('change', function() {
        watermarkConfig.enabled = this.checked;
        if (settingsContainer) {
          settingsContainer.style.display = this.checked ? 'block' : 'none';
        }
        saveWatermarkSettings();
        createWatermarkLayer();
      });
    }

    // 水印文字
    if (textInput) {
      textInput.addEventListener('input', function() {
        watermarkConfig.text = this.value || '保密内容 请勿外传';
        saveWatermarkSettings();
        if (watermarkConfig.enabled) {
          createWatermarkLayer();
        }
      });
    }

    // 布局方式
    if (layoutSelect) {
      layoutSelect.addEventListener('change', function() {
        watermarkConfig.layout = this.value;
        saveWatermarkSettings();
        if (watermarkConfig.enabled) {
          createWatermarkLayer();
        }
      });
    }

    // 颜色
    if (colorInput) {
      colorInput.addEventListener('input', function() {
        watermarkConfig.color = this.value;
        updateWatermarkDisplayValues();
        saveWatermarkSettings();
        if (watermarkConfig.enabled) {
          createWatermarkLayer();
        }
      });
    }

    // 透明度
    if (opacityInput) {
      opacityInput.addEventListener('input', function() {
        watermarkConfig.opacity = parseFloat(this.value);
        updateWatermarkDisplayValues();
        saveWatermarkSettings();
        if (watermarkConfig.enabled) {
          createWatermarkLayer();
        }
      });
    }

    // 字体大小
    if (fontSizeInput) {
      fontSizeInput.addEventListener('input', function() {
        watermarkConfig.fontSize = parseInt(this.value);
        updateWatermarkDisplayValues();
        saveWatermarkSettings();
        if (watermarkConfig.enabled) {
          createWatermarkLayer();
        }
      });
    }

    // 字体
    if (fontFamilySelect) {
      fontFamilySelect.addEventListener('change', function() {
        watermarkConfig.fontFamily = this.value;
        saveWatermarkSettings();
        if (watermarkConfig.enabled) {
          createWatermarkLayer();
        }
      });
    }

    // 预览按钮
    if (previewBtn) {
      previewBtn.addEventListener('click', function() {
        // 临时显示水印3秒
        const wasEnabled = watermarkConfig.enabled;
        watermarkConfig.enabled = true;
        createWatermarkLayer();
        
        // 显示提示
        showCustomAlert('预览水印', '水印效果已显示，将在3秒后自动隐藏');
        
        setTimeout(() => {
          watermarkConfig.enabled = wasEnabled;
          createWatermarkLayer();
        }, 3000);
      });
    }
  }

  // 在页面加载时初始化
  setTimeout(() => {
    loadWatermarkSettings();
    bindWatermarkEvents();
  }, 500);

  // 监听窗口大小变化，重新创建水印层（移动端旋转屏幕适配）
  let resizeTimer;
  window.addEventListener('resize', () => {
    if (watermarkConfig.enabled) {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        createWatermarkLayer();
      }, 300);
    }
  });

  // ========== 截图水印功能结束 ==========

// ========== 电池管理（遗漏的函数，原 script.js DOMContentLoaded 闭包内） ==========

  let lastKnownBatteryLevel = 1;
  let alertFlags = {
    hasShown40: false,
    hasShown20: false,
    hasShown10: false
  };
  let batteryAlertTimeout;

  function showBatteryAlert(imageUrl, text) {
    const batteryAlertModal = document.getElementById('battery-alert-modal');
    if (!batteryAlertModal) return;
    clearTimeout(batteryAlertTimeout);
    document.getElementById('battery-alert-image').src = imageUrl;
    document.getElementById('battery-alert-text').textContent = text;
    batteryAlertModal.classList.add('visible');
    const closeAlert = () => {
      batteryAlertModal.classList.remove('visible');
      batteryAlertModal.removeEventListener('click', closeAlert);
    };
    batteryAlertModal.addEventListener('click', closeAlert);
    batteryAlertTimeout = setTimeout(closeAlert, 2000);
  }

  function updateBatteryDisplay(battery) {
    const batteryContainer = document.getElementById('status-bar-battery');
    if (!batteryContainer) return;
    const batteryLevelEl = batteryContainer.querySelector('.battery-level');
    const batteryTextEl = batteryContainer.querySelector('.battery-text');
    const level = Math.floor(battery.level * 100);
    batteryLevelEl.style.width = `${level}%`;
    batteryTextEl.textContent = `${level}%`;
    if (battery.charging) {
      batteryContainer.classList.add('charging');
    } else {
      batteryContainer.classList.remove('charging');
    }
  }

  function handleBatteryChange(battery) {
    updateBatteryDisplay(battery);
    const level = battery.level;
    if (!battery.charging) {
      if (level <= 0.4 && lastKnownBatteryLevel > 0.4 && !alertFlags.hasShown40) {
        showBatteryAlert('https://i.postimg.cc/T2yKJ0DV/40.jpg', '有点饿了，可以去找充电器惹');
        alertFlags.hasShown40 = true;
      }
      if (level <= 0.2 && lastKnownBatteryLevel > 0.2 && !alertFlags.hasShown20) {
        showBatteryAlert('https://i.postimg.cc/qB9zbKs9/20.jpg', '赶紧的充电，要饿死了');
        alertFlags.hasShown20 = true;
      }
      if (level <= 0.1 && lastKnownBatteryLevel > 0.1 && !alertFlags.hasShown10) {
        showBatteryAlert('https://i.postimg.cc/ThMMVfW4/10.jpg', '已阵亡，还有30秒爆炸');
        alertFlags.hasShown10 = true;
      }
    }
    if (level > 0.4) alertFlags.hasShown40 = false;
    if (level > 0.2) alertFlags.hasShown20 = false;
    if (level > 0.1) alertFlags.hasShown10 = false;
    lastKnownBatteryLevel = level;
  }

  async function initBatteryManager() {
    if ('getBattery' in navigator) {
      try {
        const battery = await navigator.getBattery();
        lastKnownBatteryLevel = battery.level;
        handleBatteryChange(battery);
        battery.addEventListener('levelchange', () => handleBatteryChange(battery));
        battery.addEventListener('chargingchange', () => {
          handleBatteryChange(battery);
          if (battery.charging) {
            showBatteryAlert('https://i.postimg.cc/3NDQ0dWG/image.jpg', '窝爱泥，电量吃饱饱');
          }
        });
      } catch (err) {
        console.error("无法获取电池信息:", err);
        const batteryText = document.querySelector('.battery-text');
        if (batteryText) batteryText.textContent = 'ᗜωᗜ';
      }
    } else {
      console.log("浏览器不支持电池状态API。");
      const batteryText = document.querySelector('.battery-text');
      if (batteryText) batteryText.textContent = 'ᗜωᗜ';
    }
  }

  // ========== 全局暴露 ==========
  window.initSystemNotification = initSystemNotification;
  window.initBatteryManager = initBatteryManager;
  // 2026-07-24 暴露 repairSystemNotification 到 window（诊断用）：
  // 让用户在 console 直接调 `await window.repairSystemNotification()` 排查卡点
  window.repairSystemNotification = repairSystemNotification;

  // ========== 从 script.js 迁移：updateUnreadIndicator ==========
  function updateUnreadIndicator(count) {
    unreadPostsCount = count;
    localStorage.setItem('unreadPostsCount', count);
    const navItem = document.querySelector('.nav-item[data-view="qzone-screen"]');
    if (!navItem) return;
    const targetSpan = navItem.querySelector('span');
    let indicator = navItem.querySelector('.unread-indicator');
    if (count > 0) {
      if (!indicator) {
        indicator = document.createElement('span');
        indicator.className = 'unread-indicator';
        targetSpan.style.position = 'relative';
        targetSpan.appendChild(indicator);
      }
      indicator.textContent = count > 99 ? '99+' : count;
      indicator.style.display = 'block';
    } else {
      if (indicator) indicator.style.display = 'none';
    }
    if (typeof updateBackButtonUnreadCount === 'function') updateBackButtonUnreadCount();
  }
  window.updateUnreadIndicator = updateUnreadIndicator;
