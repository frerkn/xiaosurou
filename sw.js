// Service Worker file (sw.js)
// Whitelist cache strategy: cache only known static assets; API requests pass through.
// 2026-07-09 v0.1.18: 改用 Vercel 默认 bodyParser:true —— req.body 直接是解析后的对象，不用 rawBody 兜底
// 2026-07-09 v0.1.12: 修致命 bug — runChatWithToolLoop 内部 fetch(url) = window.fetch = wrappedFetch → 无限递归 → OOM 闪退。改用 originalFetch 绕过自己。
// 2026-07-09 v0.1.11: 修 refreshToolbarActive 闭包 bug — 把 refreshToolbarActive 提升到 IIFE module-scope 让 ensureMiniAppDom 闭包也能访问
// 2026-07-09 v0.1.8: 双平台部署支持 — Vercel API Routes (/api/mcp-*) + Netlify Functions 兼容；前端自动探测 + localStorage 缓存
// 2026-07-09 v0.1.6: 诊断行暴露 preload 错误信息；重连后强制重激活当前 brand + 同步 UI；toggle click 后刷 diag
// 2026-07-09 v0.1.5: 干净设计 — 去掉"强制开启"按钮；UI 永远服从 storage；toggle 提示文案区分 token 没填/开关没开
// 2026-07-09 v0.1.4: 修 resetAll() 错误地 setEnabled(false) 残留 bug；UI 加 🔧 强制开启 / 🔄 刷UI 按钮兜底恢复
// 2026-07-09 v0.1.3: 修 MCP token 输入框 change→input 事件 + toggle click 兜底 setToken（解决"看着填了但 storage 没存"bug）
// 2026-07-15 v0.1.25: bump CACHE_VERSION 强制清缓存（hotNews + vector memory + isGenerating 残留 3 处修复 — modules/hot-news.js + modules/ai-response.js + modules/vector-memory.js）
// 2026-07-15 v0.1.24: bump CACHE_VERSION 强制清缓存（歌词解析 parseLRC 兼容无毫秒时间戳 — modules/music-player.js 改 1 处 parseLRC + index.html bump ?v=0.0.44）
// 2026-07-14 v0.1.22: bump CACHE_VERSION 强制清缓存（一起读书加 URL 抓取 + 粉白美化，index.html/main-ui.css/reading-room.js 都改了）
// 2026-07-14 v0.1.21: getProxyUrl 加 hostname 优先判断 — 双平台切换永远正确不靠缓存
// 2026-07-21 v0.1.29: bump CACHE_VERSION — 新增 js/ai-songs-store.js（AI 原创曲 IndexedDB 持久化层）
// 2026-07-21 v0.1.30: bump CACHE_VERSION — 视频通话 Live2D 接入（cubism core + pixi.js + pixi-live2d-display + lib/live2dcubismcore.min.js + modules/live2d-loader.js + assets/live2d/）

// 2026-07-22 v0.1.33: bump CACHE_VERSION 强制清缓存（悬浮球"AI 原创曲管理"入口 — modules/floating-ball.js 加 data-action="manage-ai-songs" + handleQuickManageAiSongs() mini modal 列出 IndexedDB 所有 AI 歌，每首 ▶/⤓/🗑，底部一键清空；js/ai-songs-store.js 加 listAllSongs API）
// 2026-07-22 v0.1.32: bump CACHE_VERSION 强制清缓存（AI 歌 blob 强制 mime=audio/mpeg — IDB 反序列化常丢 mime type，导致 data URI 前缀变 data:;base64, 没 mime，<audio> 拒播。修法：modules/music-player.js addAiSongToPlaylist 入口 + js/ai-songs-store.js persistSong 写库时都强制 new Blob([blob], { type: 'audio/mpeg' })）
// 2026-07-22 v0.1.31: bump CACHE_VERSION 强制清缓存（AI 原创曲按 songId 去重 — modules/music-player.js addAiSongToPlaylist 加 songId pre-dedup 块，绕过 getMusicTrackKey 不认 songId 的 bug）
// 2026-07-21 v0.1.30: bump CACHE_VERSION — 视频通话 Live2D 接入（cubism core + pixi.js + pixi-live2d-display + lib/live2dcubismcore.min.js + modules/live2d-loader.js + assets/live2d/）
// 2026-07-21 v0.1.29: bump CACHE_VERSION — 新增 js/ai-songs-store.js（AI 原创曲 IndexedDB 持久化层）
const CACHE_VERSION = 'v0.1.33';
const CACHE_NAME = `ephone-cache-${CACHE_VERSION}`;

const URLS_TO_CACHE = [
  './index.html',
  './style.css',
  './online-app.css',
  './script.js',
  './modules/hot-news.js',
  './modules/runtime-diagnostics.js',
  // v0.1.28 新增：AI 唱歌（3 个新模块）
  './modules/ai-music.js',
  './js/music-voice-sample.js',
  './js/role-voice-sample-ui.js',
  // v0.1.29 新增：AI 原创曲 IndexedDB 持久化层
  './js/ai-songs-store.js',
  './js/netease-music.js',
  // v0.1.2 新增：外卖点单
  './css/mcp-settings-skyblue.css',
  './css/mcp-card.css',
  './css/mcp-miniapp-pink.css',
  './js/mcp-mcd-client.js',
  './js/mcp-luckin-client.js',
  './js/mcp-tool-bridge.js',
  './js/mcp-ui-init.js',
  // v0.1.30 新增：Live2D 视频通话（cubism 引擎 + loader + 视频通话主文件）
  './lib/live2dcubismcore.min.js',
  './modules/live2d-loader.js',
  './modules/video-voice-call.js',
  'https://unpkg.com/dexie/dist/dexie.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://phoebeboo.github.io/mewoooo/pp.js',
  'https://cdn.jsdelivr.net/npm/streamsaver@2.0.6/StreamSaver.min.js',
  'https://img.baidu.re/i/2026/07/w6p47e.png'
];

self.addEventListener('install', event => {
  console.log('[SW] Installing service worker...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Cache opened, caching core files...');
        return cache.addAll(URLS_TO_CACHE);
      })
      .then(() => {
        console.log('[SW] Core files cached.');
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', event => {
  console.log('[SW] Activating service worker...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[SW] Service worker activated.');
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  const isLocalAsset = url.startsWith(self.location.origin) &&
    (url.includes('/index.html') ||
     url.includes('/style.css') ||
     url.includes('/online-app.css') ||
     url.includes('/script.js') ||
     url.includes('/modules/hot-news.js') ||
     url.includes('/modules/runtime-diagnostics.js') ||
     // v0.1.28 新增：AI 唱歌模块
     url.includes('/modules/ai-music.js') ||
     url.includes('/js/music-voice-sample.js') ||
     url.includes('/js/role-voice-sample-ui.js') ||
     // v0.1.29 新增：AI 原创曲存储层
     url.includes('/js/ai-songs-store.js') ||
     // v0.1.2 新增：外卖点单文件命中拦截，走缓存（请求带回 ?v= 时也走 fetch）
     url.includes('/css/mcp-settings-skyblue.css') ||
     url.includes('/css/mcp-card.css') ||
     url.includes('/css/mcp-miniapp-pink.css') ||
     url.includes('/js/mcp-mcd-client.js') ||
     url.includes('/js/mcp-luckin-client.js') ||
     url.includes('/js/mcp-tool-bridge.js') ||
     url.includes('/js/mcp-ui-init.js') ||
     // v0.1.30 新增：Live2D 视频通话（引擎 + loader + 模型目录）
     url.includes('/lib/live2dcubismcore.min.js') ||
     url.includes('/modules/live2d-loader.js') ||
     url.includes('/modules/video-voice-call.js') ||
     url.includes('/assets/live2d/'));

  const isKnownCDN =
    url.includes('unpkg.com/dexie') ||
    url.includes('cdnjs.cloudflare.com/ajax/libs/html2canvas') ||
    url.includes('cdn.jsdelivr.net/npm/streamsaver') ||
    url.includes('phoebeboo.github.io/mewoooo/pp.js') ||
    url.includes('i.postimg.cc/') ||
    url.includes('img.baidu.re/') ||
    // v0.1.30 新增：Live2D 引擎 (UMD prebuilt, 完全不用 esm.sh)
    url.includes('cdn.jsdelivr.net/npm/pixi.js') ||
    url.includes('cdn.jsdelivr.net/npm/pixi-live2d-display') ||
    url.includes('cdn.jsdelivr.net/gh/dylanNew/live2d');

  if (isLocalAsset || isKnownCDN) {
    const isVersioned = url.includes('?v=');
    if (isVersioned) {
      event.respondWith(
        fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            const noQueryUrl = url.split('?')[0];
            caches.open(CACHE_NAME).then(cache => cache.put(noQueryUrl, clone));
          }
          return response;
        }).catch(() => caches.match(url.split('?')[0]))
      );
      return;
    }

    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        const fetchPromise = fetch(event.request).then(response => {
          if (response && response.status === 200) {
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, response.clone());
            });
          }
          return response;
        }).catch(() => null);

        return cachedResponse || fetchPromise;
      })
    );
  }
});

self.addEventListener('push', event => {
  console.log('[SW] Push received:', event);

  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { body: event.data.text() };
    }
  }

  const title = data.title || 'EPhone';
  const options = {
    body: data.body || 'You have a new message',
    icon: data.icon || 'https://img.baidu.re/i/2026/07/w6p47e.png',
    badge: data.badge || 'https://img.baidu.re/i/2026/07/w6p47e.png',
    tag: data.tag || 'default',
    data: data.data || {},
    requireInteraction: true,
    vibrate: [200, 100, 200],
    timestamp: Date.now()
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('message', event => {
  console.log('[SW] Message received:', event.data);

  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = event.data;
    event.waitUntil(
      self.registration.showNotification(title, options)
    );
  }
});

self.addEventListener('notificationclick', event => {
  console.log('[SW] Notification clicked:', event);

  event.notification.close();

  const chatId = event.notification.data?.chatId;
  const urlToOpen = chatId ? `/?openChat=${chatId}` : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (let client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            return client.focus().then(client => {
              if (chatId) {
                client.postMessage({ type: 'OPEN_CHAT', chatId });
              }
              return client;
            });
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});
