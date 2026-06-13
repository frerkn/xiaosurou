// Service Worker 文件 (sw.js)
// 【智能缓存策略 - 修复版】- 只缓存明确已知的静态资源，API 请求全部放行

// 缓存版本号（修改后请更新此版本，使旧缓存自动清除）
const CACHE_VERSION = 'v0.0.54';
const CACHE_NAME = `ephone-cache-${CACHE_VERSION}`;
const CACHE_VERSION = 'v0.0.57';
// force deploy 2026.06.13
// 需要被缓存的核心静态文件（用于离线访问）
const URLS_TO_CACHE = [
  './index.html',
  './style.css',
  './online-app.css',
  './script.js',
  './modules/runtime-diagnostics.js',
  'https://unpkg.com/dexie/dist/dexie.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://phoebeboo.github.io/mewoooo/pp.js',
  'https://cdn.jsdelivr.net/npm/streamsaver@2.0.6/StreamSaver.min.js',
  'https://i.postimg.cc/nMbyyt1t/D7CD735A73F5FD1D7B8407E0EB8BBAC0.png'
];

// ---------- 安装 ----------
self.addEventListener('install', event => {
  console.log('[SW] 正在安装 Service Worker (白名单缓存策略)...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] 缓存已打开，正在缓存核心文件...');
        return cache.addAll(URLS_TO_CACHE);
      })
      .then(() => {
        console.log('[SW] 所有核心文件已缓存成功！');
        return self.skipWaiting();
      })
  );
});

// ---------- 激活 ----------
self.addEventListener('activate', event => {
  console.log('[SW] 正在激活 Service Worker...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] 正在删除旧的缓存:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[SW] Service Worker 已激活！使用白名单缓存策略。');
      return self.clients.claim();
    })
  );
});

// ---------- 请求拦截（核心修改） ----------
self.addEventListener('fetch', event => {
  // 只处理 GET 请求
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  // ----- 定义哪些是“我们要缓存的已知静态资源” -----
  // 1. 本站核心页面和资源（相对路径）
  const isLocalAsset = url.startsWith(self.location.origin) && 
    (url.includes('/index.html') ||
     url.includes('/style.css') ||
     url.includes('/online-app.css') ||
     url.includes('/script.js') ||
     url.includes('/modules/runtime-diagnostics.js'));

  // 2. 明确引用的外部 CDN 资源（图片、脚本等）
  const isKnownCDN = 
    url.includes('unpkg.com/dexie') ||
    url.includes('cdnjs.cloudflare.com/ajax/libs/html2canvas') ||
    url.includes('cdn.jsdelivr.net/npm/streamsaver') ||
    url.includes('phoebeboo.github.io/mewoooo/pp.js') ||
    url.includes('i.postimg.cc/');

  // 3. 应用内部的图标/图片资源（如果需要可以补充）
  // const isAppImage = url.startsWith(self.location.origin) && /\.(png|jpg|svg|ico)$/.test(url);

  // ===== 白名单匹配：只拦截我们明确要缓存的资源 =====
  if (isLocalAsset || isKnownCDN) {
    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        // 后台发起网络请求更新缓存
        const fetchPromise = fetch(event.request).then(response => {
          if (response && response.status === 200) {
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, response.clone());
            });
          }
          return response;
        }).catch(() => null);

        // 如果有缓存立即返回，否则等待网络
        return cachedResponse || fetchPromise;
      })
    );
  }
  // ===== 其他所有请求（包括所有 API、未知资源）完全放行，不缓存 =====
  // 不需要调用 event.respondWith，浏览器正常进行网络请求
});

// ---------- 以下为推送通知相关，未修改 ----------
self.addEventListener('push', event => {
  console.log('[SW] 收到推送消息:', event);
  
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
    body: data.body || '您有新消息',
    icon: data.icon || 'https://i.postimg.cc/nMbyyt1t/D7CD735A73F5FD1D7B8407E0EB8BBAC0.png',
    badge: data.badge || 'https://i.postimg.cc/nMbyyt1t/D7CD735A73F5FD1D7B8407E0EB8BBAC0.png',
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
  console.log('[SW] 收到页面消息:', event.data);
  
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = event.data;
    event.waitUntil(
      self.registration.showNotification(title, options)
    );
  }
});

self.addEventListener('notificationclick', event => {
  console.log('[SW] 通知被点击:', event);
  
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
