// Service Worker file (sw.js)
// Whitelist cache strategy: cache only known static assets; API requests pass through.
// 2026-07-09 v0.1.18: 改用 Vercel 默认 bodyParser:true —— req.body 直接是解析后的对象，不用 rawBody 兜底
// 2026-07-09 v0.1.12: 修致命 bug — runChatWithToolLoop 内部 fetch(url) = window.fetch = wrappedFetch → 无限递归 → OOM 闪退。改用 originalFetch 绕过自己。
// 2026-07-09 v0.1.11: 修 refreshToolbarActive 闭包 bug — 把 refreshToolbarActive 提升到 IIFE module-scope 让 ensureMiniAppDom 闭包也能访问
// 2026-07-29 v1.0.0: 通用 MCP 工具服务器 — 删 mcd/luckin 硬编码, 改用 McpGenericClient + 通用 UI 列表
// 2026-07-09 v0.1.6: 诊断行暴露 preload 错误信息；重连后强制重激活当前 brand + 同步 UI；toggle click 后刷 diag
// 2026-07-09 v0.1.5: 干净设计 — 去掉"强制开启"按钮；UI 永远服从 storage；toggle 提示文案区分 token 没填/开关没开
// 2026-07-09 v0.1.4: 修 resetAll() 错误地 setEnabled(false) 残留 bug；UI 加 🔧 强制开启 / 🔄 刷UI 按钮兜底恢复
// 2026-07-09 v0.1.3: 修 MCP token 输入框 change→input 事件 + toggle click 兜底 setToken（解决"看着填了但 storage 没存"bug）
// 2026-07-15 v0.1.25: bump CACHE_VERSION 强制清缓存（hotNews + vector memory + isGenerating 残留 3 处修复 — modules/hot-news.js + modules/ai-response.js + modules/vector-memory.js）
// 2026-07-15 v0.1.24: bump CACHE_VERSION 强制清缓存（歌词解析 parseLRC 兼容无毫秒时间戳 — modules/music-player.js 改 1 处 parseLRC + index.html bump ?v=0.0.44）
// 2026-07-14 v0.1.22: bump CACHE_VERSION 强制清缓存（一起读书加 URL 抓取 + 粉白美化，index.html/main-ui.css/reading-room.js 都改了）
// 2026-07-14 v0.1.21: getProxyUrl 加 hostname 优先判断 — 双平台切换永远正确不靠缓存
// 2026-07-21 v0.1.29: bump CACHE_VERSION — 新增 js/ai-songs-store.js（AI 原创曲 IndexedDB 持久化层）
// 2026-07-24 v0.1.44: bump CACHE_VERSION 强制清缓存（Live2D 硬开关 — state.globalSettings.live2dEnabled !== true 时 mountLive2DForCall 直接 return, UI 输入框也隐藏；之前卖家模型不兼容 doDrawModel undefined '0'，保留所有 Live2D 代码和数据以备以后换兼容模型）
// 2026-07-21 v0.1.30: bump CACHE_VERSION — 视频通话 Live2D 接入（cubism core + pixi.js + pixi-live2d-display + lib/live2dcubismcore.min.js + modules/live2d-loader.js + assets/live2d/）

// 2026-07-24 v0.1.45: bump CACHE_VERSION 强制清缓存（音色样本时长上限 60s → 180s / 3 分钟 — js/role-voice-sample-ui.js MAX_DURATION 60→180、MAX_SIZE 10MB→20MB、文案跟着变。MiniMax Cover 输出音频长度受参考音频长度限制，60s 唱不完整一首歌，3 分钟够用；3 分钟 wav 25-35MB 仍超 20MB，但 mp3 5-8MB 够用，主推 mp3）
// 2026-07-23 v0.1.38: bump CACHE_VERSION 强制清缓存（"角色有音色样本时自动用 Cover" 开关 — index.html 加 #auto-cover-when-has-sample-switch 开关；settings-presets.js 加载默认 true；init-event-bindingsA.js 保存到 globalSettings.autoCoverWhenHasSample；ai-music.js 强制 cover 逻辑改成读这个开关，false 时即使有样本也用用户在设置里选的普通模型）
// 2026-07-23 v0.1.37: bump CACHE_VERSION 强制清缓存（灵动岛点击打不开播放器 — modules/init-event-bindingsA.js setupMusicIslandWidget openPlayer 原来只判 musicState.isActive，AI 自动唱歌的路径不调 startListenTogetherSession 一直是 false，加 playlist+isPlaying 兜底判断）
// 2026-07-23 v0.1.36: bump CACHE_VERSION 强制清缓存（AI 歌 caller 漏传 lyrics — ai-response.js:6739 + ai-group.js:1092 + ai-group.js:1567 三处 addAiSongToPlaylist 没传 lyrics 字段，buildLrcFromLyrics 拿不到词 → 播放器 lrcContent 一直是空，歌词不显示）
// 2026-07-23 v0.1.35: bump CACHE_VERSION 强制清缓存（Cover 模式歌词覆盖 bug — modules/ai-music.js generateCover 删掉 preprocess 返回的 formatted_lyrics 覆盖逻辑，之前是 server 从参考音频 ASR 出来的旧歌词覆盖了用户给的新词，导致 Cover 唱的还是上传内容）
// 2026-07-22 v0.1.34: bump CACHE_VERSION 强制清缓存（音色样本 file input accept 加扩展名兜底 — js/role-voice-sample-ui.js accept 改为 ".mp3,.wav,.m4a,..." 列表避免 audio/* 在 Windows Chrome/PWA 过滤掉 mp3；hidden 改 display:none 保险；js/music-voice-sample.js setVoiceSample 强制 blob mime=audio/mpeg 避免 IDB 丢 mime）
// 2026-07-22 v0.1.33: bump CACHE_VERSION 强制清缓存（悬浮球"AI 原创曲管理"入口 — modules/floating-ball.js 加 data-action="manage-ai-songs" + handleQuickManageAiSongs() mini modal 列出 IndexedDB 所有 AI 歌，每首 ▶/⤓/🗑，底部一键清空；js/ai-songs-store.js 加 listAllSongs API）
// 2026-07-22 v0.1.32: bump CACHE_VERSION 强制清缓存（AI 歌 blob 强制 mime=audio/mpeg — IDB 反序列化常丢 mime type，导致 data URI 前缀变 data:;base64, 没 mime，<audio> 拒播。修法：modules/music-player.js addAiSongToPlaylist 入口 + js/ai-songs-store.js persistSong 写库时都强制 new Blob([blob], { type: 'audio/mpeg' })）
// 2026-07-22 v0.1.31: bump CACHE_VERSION 强制清缓存（AI 原创曲按 songId 去重 — modules/music-player.js addAiSongToPlaylist 加 songId pre-dedup 块，绕过 getMusicTrackKey 不认 songId 的 bug）
// 2026-07-21 v0.1.30: bump CACHE_VERSION — 视频通话 Live2D 接入（cubism core + pixi.js + pixi-live2d-display + lib/live2dcubismcore.min.js + modules/live2d-loader.js + assets/live2d/）
// 2026-07-21 v0.1.29: bump CACHE_VERSION — 新增 js/ai-songs-store.js（AI 原创曲 IndexedDB 持久化层）
// 2026-07-24 v0.1.42: bump CACHE_VERSION 强制清缓存（SW install 改宽容：cache.addAll → Promise.allSettled，单个 URL 失败不再让整个 install 失败 — 修复"一键修复通知 SW 注册不上"根因）
// 2026-07-24 v0.1.41: bump CACHE_VERSION 强制清缓存（一键修复通知卡死修复：navigator.serviceWorker.ready 加 5s timeout + 全流程 console.log 进度 + 按钮 disabled 状态 — modules/notification-battery.js + index.html bump ?v=0.0.38）
// 2026-07-25 v0.1.46: bump CACHE_VERSION 强制清缓存（语音/视频通话 Gemini 直连修复 — video-voice-call.js 两处 isGemini 兜底：resolveApiSlotConfig 不返回 isGemini, 用 proxyUrl.includes('generativelanguage') 兜底判定）
// 2026-07-24 v0.1.40: bump CACHE_VERSION 强制清缓存（"无声智能保活"settings-item 改用标准结构 label + .settings-desc，跟其他设置项对齐 — index.html line 3173-3183）
// 2026-07-24 v0.1.39: bump CACHE_VERSION 强制清缓存（系统设置首页"数据与存储"卡片跳转目标从 sec-cloud-storage 改到 sec-data-management — modules/system-settings-home.js + index.html bump ?v=0.0.37）
// 2026-08-01 v0.1.56: MCP 菜单卡片 parse bug 修复 + 教程简化
//   1) mcp-generic-client.js callTool: safeParseJson 失败时改用 extractJsonFromMcpText
//      brace-match 抽 mcd.cn / 其他 MCP 端点 text 里嵌的 JSON (前面 markdown 描述导致 JSON.parse 整体炸)
//   2) mcp-menu-card.js parseMcpResult: McpGenericClient 包成 {success,data,rawText} 时
//      改成 return result.data (而不是 return result), 剥外层包装
//   3) mcp-menu-card.js onCard: 加诊断 log, 列出 result shape + 没解析出菜单数据时打 rawText 前 200 字符
//   4) mcp-ui-list.js 教程简化: 删 30 行 WORKER_CODE + 删"5 分钟部署教程"块 + 删"通用流程"块 + 删
//      "遇到问题"块 + 删 "copy-worker-code" 事件块 (~200 行 → 75 行), 弹窗顶部改成
//      "代理已部署好, URL 填 https://mcp.lhualan338.workers.dev/" + 2 个服务各 3 步接入
// 验证: _reports/test-extract-only.mjs 端到端跑通 — 14 分类 116 餐品, 跟用户截图"蘸酱炸鸡五选一 11.9元"对上
// 2026-08-01 v0.1.56: 修绿江章节删除按钮不响应 - checkbox 点击时同步 selectedChapters
// 2026-08-01 v0.1.57: 修绿江 AI 续写不接剧情 - prompt 拼接多章 summary + 硬性接续要求 + summary 缺失 fallback
const CACHE_VERSION = 'v0.1.58';
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
  // v1.0.0 改造: 通用 MCP 工具（删 mcd/luckin 硬编码, 删旧 mcp-ui-init + 3 个 css, 加 generic-client + ui-list）
  './js/mcp-generic-client.js',
  './js/mcp-tool-bridge.js',
  './js/mcp-ui-list.js',
  // v0.1.55 新增: MCP 菜单卡片渲染（粉白色系浮动按钮 + 全屏 sheet）
  './js/mcp-menu-card.js',
  './css/mcp-miniapp-pink.css',
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
        // 2026-07-24 修复：cache.addAll 改 allSettled 单独缓存每个文件
        // 原因：URLS_TO_CACHE 里有 25 个文件（含 5 个外部 CDN），任何一个 fetch
        // 失败（CDN 抽风 / CORS / 404）整个 addAll 就会 reject，导致 SW install
        // 永远卡 installing 状态 → navigator.serviceWorker.register() 抛错 →
        // "一键修复通知" alert 里看不到"已重新注册"的成功提示。
        // 改宽容后：单个失败只 warn 跳过，整体 install 必成功。
        return Promise.allSettled(
          URLS_TO_CACHE.map(url =>
            cache.add(url).catch(err => {
              console.warn('[SW] 缓存失败（已跳过）:', url, err.message || err);
              return null;
            })
          )
        ).then(results => {
          const ok = results.filter(r => r.status === 'fulfilled').length;
          const fail = results.length - ok;
          console.log(`[SW] Core files cached: ${ok} ok, ${fail} failed.`);
        });
      })
      .then(() => {
        console.log('[SW] skipWaiting()');
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
     // v1.0.0 改造: 通用 MCP 文件命中拦截, 走缓存（请求带回 ?v= 时也走 fetch）
     url.includes('/js/mcp-generic-client.js') ||
     url.includes('/js/mcp-tool-bridge.js') ||
     url.includes('/js/mcp-ui-list.js') ||
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
