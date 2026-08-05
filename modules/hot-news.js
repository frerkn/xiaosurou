// ========================================
// 热点日报模块（2026-07-02 新增，替换原豆瓣功能）
// 来源：抄糯米机 apps/HotNewsApp.tsx + utils/realtimeContext.ts 核心逻辑
//       改写为 330 风格（IIFE，无 React，无 TS）
// 行为：每天分 6 时段（凌晨/清晨/上午/午后/傍晚/夜间），每时段最多拉一次，
//       持久化在 Dexie `hotNewsSnapshots`，全角色共享。
//       同 in-flight 锁（群聊/多角色并发复用同一 Promise）。
// 拉取链路：前端 → /api/hotnews（330 后端代理）→ news.orz.ai → 返回 items
// ========================================

// 可选平台（key 与 news.orz.ai ?platform= 完全一致；label 给 UI 看）
// 2026-07-02 按用户偏好调整：删虎扑/豆瓣/36氪/掘金/V2EX/少数派，加全部财经
const HOTNEWS_PLATFORMS = [
  { key: 'weibo', label: '微博' },
  { key: 'zhihu', label: '知乎' },
  { key: 'baidu', label: '百度' },
  { key: 'bilibili', label: 'B站' },
  { key: 'douyin', label: '抖音' },
  { key: 'jinritoutiao', label: '今日头条' },
  { key: 'tieba', label: '贴吧' },
  { key: 'sina_finance', label: '新浪财经' },
  { key: 'eastmoney', label: '东方财富' },
  { key: 'xueqiu', label: '雪球' },
  { key: 'cls', label: '财联社' },
  { key: 'tenxunwang', label: '腾讯网' },
];

// ---- DB 包装（Dexie 3.x Promise 风格，与项目其他模块保持一致） ----
const HotNewsDB = {
  async get(id) {
    try { return await db.hotNewsSnapshots.get(id); } catch (e) { return null; }
  },
  async put(snap) {
    try { await db.hotNewsSnapshots.put(snap); } catch (e) { console.warn('[hotnews] put 失败', e); }
  },
  async getLatest() {
    try {
      const all = await db.hotNewsSnapshots.toArray();
      if (!all || all.length === 0) return null;
      all.sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));
      return all[0];
    } catch (e) { return null; }
  },
  async prune(keep = 12) {
    try {
      const all = await db.hotNewsSnapshots.toArray();
      all.sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));
      const toDelete = all.slice(keep).map(s => s.id);
      if (toDelete.length > 0) await db.hotNewsSnapshots.bulkDelete(toDelete);
    } catch (e) { /* 静默 */ }
  },
};

// ---- 时段工具 ----
// 每天 6 段，每 4 小时一段
const HOTNEWS_SLOT_LABELS = ['凌晨', '清晨', '上午', '午后', '傍晚', '夜间'];
const HOTNEWS_SLOT_WINDOWS = ['00:00–04:00', '04:00–08:00', '08:00–12:00', '12:00–16:00', '16:00–20:00', '20:00–24:00'];

function getHotNewsSlot(d = new Date()) {
  const slot = Math.min(5, Math.floor(d.getHours() / 4));
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const label = HOTNEWS_SLOT_LABELS[slot];
  return { id: `${date}#${slot}`, date, slot, label };
}

// ---- 后端拉取（走 Netlify Function，跟鱼声/网易云同款路径） ----
async function fetchHotNewsFromBackend(platforms) {
  const params = new URLSearchParams();
  if (platforms && platforms.length > 0) params.set('platforms', platforms.join(','));
  // 跟 330 现有 netlify/functions/fish-audio-tts.js 同样的 /.netlify/functions/ 路径
  // （同源部署在 Netlify 上时无 CORS 问题；file:// 协议下也会被 Netlify 域名接收）
  const url = `/.netlify/functions/hotnews?${params.toString()}`;
  // 【2026-07-15 修复】Netlify Function 慢/超时会卡死 triggerAiResponse, 加 4s AbortController
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ---- 缓存调度 + in-flight 锁 ----
// 同一时段并发只真正发一次请求（多角色同时回复时复用同一 Promise）
const _inFlight = new Map();

async function getSlottedHotNews(platforms) {
  const { id, date, slot, label } = getHotNewsSlot();
  const samePlatforms = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

  // 1. 命中本时段快照（平台一致）→ 复用
  const snap = await HotNewsDB.get(id);
  // 2026-07-04 修复：检测到旧缓存（items 里没有 content 字段，因为之前后端用了错的 desc 字段名），
  // 自动当缓存失效处理，重新走 fetchHotNewsFromBackend 拿带 content 的新数据。
  // 命中此条件说明缓存是字段名修复前的旧数据，平台一致也不复用。
  const isStaleCache = snap && Array.isArray(snap.items) && snap.items.length > 0 &&
    samePlatforms(snap.platforms, platforms) &&
    !snap.items.some(it => it && it.content);
  if (snap && Array.isArray(snap.items) && snap.items.length > 0 && samePlatforms(snap.platforms, platforms) && !isStaleCache) {
    console.log(`%c[hotnews] 命中今日${label}快照（${snap.items.length} 条）`, 'color:#16a34a');
    return snap.items;
  }

  // 2. in-flight 锁
  const inflight = _inFlight.get(id);
  if (inflight) return inflight;

  const job = (async () => {
    console.log(`%c[hotnews] 触发今日${label}拉取…`, 'color:#2563eb;font-weight:bold');
    let items = [];
    try {
      items = await fetchHotNewsFromBackend(platforms);
    } catch (e) {
      console.warn(`[hotnews] ${label} 后端拉取失败:`, e?.message || e);
    }
    if (items.length > 0) {
      await HotNewsDB.put({ id, date, slot, slotLabel: label, items, platforms, fetchedAt: Date.now() });
      HotNewsDB.prune(12).catch(() => {});
      return items;
    }
    // 失败 → 回退到最近一次快照（不写本时段，下次会重试）
    const latest = await HotNewsDB.getLatest();
    if (latest && latest.items?.length > 0) {
      console.warn(`[hotnews] ${label}拉取失败，复用最近快照（${latest.date} ${latest.slotLabel}）`);
      return latest.items;
    }
    return [];
  })();

  _inFlight.set(id, job);
  try { return await job; } finally { _inFlight.delete(id); }
}

// ---- UI: 渲染热点日报屏 ----
async function renderHotNewsScreen() {
  const listEl = document.getElementById('hot-news-list');
  const errorEl = document.getElementById('hot-news-error');
  const loadingEl = document.getElementById('hot-news-loading');
  const headerEl = document.getElementById('hot-news-header-meta');

  if (errorEl) errorEl.style.display = 'none';
  if (loadingEl) loadingEl.style.display = '';
  if (listEl) listEl.innerHTML = '';

  try {
    const platforms = (state.globalSettings.hotNewsPlatforms && state.globalSettings.hotNewsPlatforms.length > 0)
      ? state.globalSettings.hotNewsPlatforms
      : HOTNEWS_PLATFORMS.slice(0, 5).map(p => p.key);

    await getSlottedHotNews(platforms);

    const { id } = getHotNewsSlot();
    let snap = await HotNewsDB.get(id);
    if (!snap) snap = await HotNewsDB.getLatest();

    if (loadingEl) loadingEl.style.display = 'none';

    if (!snap || !snap.items || snap.items.length === 0) {
      if (errorEl) {
        errorEl.textContent = '暂时拉不到热点（可能是网络问题或后端未启动）。请稍后再试。';
        errorEl.style.display = '';
      }
      if (headerEl) headerEl.textContent = '';
      return;
    }

    // 报头
    if (headerEl) {
      const fetchedStr = new Date(snap.fetchedAt).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      });
      headerEl.textContent = `${snap.date} · ${snap.slotLabel}版（${HOTNEWS_SLOT_WINDOWS[snap.slot] || ''}） · 更新于 ${fetchedStr}`;
    }

    // 按平台分组
    const grouped = new Map();
    for (const it of snap.items) {
      const key = it.source || '其他';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(it);
    }

    // 渲染
    const frag = document.createDocumentFragment();
    for (const [source, items] of grouped) {
      const section = document.createElement('section');
      section.className = 'hot-news-section';
      const title = document.createElement('h3');
      title.className = 'hot-news-section-title';
      title.textContent = source;
      section.appendChild(title);

      const ol = document.createElement('ol');
      ol.className = 'hot-news-list';
      items.forEach((it, i) => {
        const li = document.createElement('li');
        li.className = 'hot-news-item';
        const num = document.createElement('span');
        num.className = 'hot-news-num';
        num.textContent = i + 1;
        li.appendChild(num);

        const body = document.createElement('div');
        body.className = 'hot-news-body';
        if (it.url) {
          const a = document.createElement('a');
          a.href = it.url;
          a.target = '_blank';
          a.rel = 'noreferrer';
          a.className = 'hot-news-title';
          a.textContent = it.title;
          body.appendChild(a);
        } else {
          const span = document.createElement('span');
          span.className = 'hot-news-title';
          span.textContent = it.title;
          body.appendChild(span);
        }
        if (it.content && it.content !== it.title) {
          const desc = document.createElement('p');
          desc.className = 'hot-news-desc';
          desc.textContent = it.content;
          body.appendChild(desc);
        }
        li.appendChild(body);
        ol.appendChild(li);
      });
      section.appendChild(ol);
      frag.appendChild(section);
    }
    listEl.appendChild(frag);
  } catch (e) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) {
      errorEl.textContent = '加载失败：' + (e?.message || e);
      errorEl.style.display = '';
    }
    console.error('[hotnews] renderHotNewsScreen:', e);
  }
}

// 强制刷新：无视时段去重，强制重拉当前时段
async function forceRefreshHotNews() {
  const btn = document.getElementById('hot-news-refresh-btn');
  if (btn) btn.disabled = true;
  const loadingEl = document.getElementById('hot-news-loading');
  const errorEl = document.getElementById('hot-news-error');
  if (loadingEl) loadingEl.style.display = '';
  if (errorEl) errorEl.style.display = 'none';

  try {
    const { id, date, slot, label } = getHotNewsSlot();
    const platforms = (state.globalSettings.hotNewsPlatforms && state.globalSettings.hotNewsPlatforms.length > 0)
      ? state.globalSettings.hotNewsPlatforms
      : HOTNEWS_PLATFORMS.slice(0, 5).map(p => p.key);
    const items = await fetchHotNewsFromBackend(platforms);
    if (items.length > 0) {
      await HotNewsDB.put({ id, date, slot, slotLabel: label, items, platforms, fetchedAt: Date.now() });
      state.globalSettings.hotNewsLastFetchedAt = Date.now();
      if (typeof db !== 'undefined' && db.globalSettings) {
        await db.globalSettings.put(state.globalSettings);
      }
      if (typeof showToast === 'function') showToast(`已刷新 · ${label} ${items.length} 条`, 'success');
    } else {
      if (typeof showToast === 'function') showToast('刷新失败，沿用上次结果', 'error');
    }
  } catch (e) {
    if (errorEl) {
      errorEl.textContent = '刷新失败：' + (e?.message || e);
      errorEl.style.display = '';
    }
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
    if (btn) btn.disabled = false;
    await renderHotNewsScreen();
  }
}

// 入口：打开热点日报屏
function openHotNewsScreen() {
  if (typeof showScreen === 'function') {
    showScreen('hot-news-screen');
  } else {
    document.getElementById('hot-news-screen')?.classList.add('active');
  }
  renderHotNewsScreen();
}

// ---- 设置面板：平台多选 + 开关 ----
function openHotNewsSettings() {
  const modal = document.getElementById('hot-news-settings-modal');
  if (!modal) return;

  // 渲染平台 chips
  const wrap = document.getElementById('hot-news-platforms-wrap');
  if (wrap) {
    wrap.innerHTML = '';
    const current = state.globalSettings.hotNewsPlatforms || [];
    HOTNEWS_PLATFORMS.forEach(p => {
      const active = current.includes(p.key);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `hot-news-chip${active ? ' active' : ''}`;
      chip.textContent = p.label;
      chip.addEventListener('click', () => {
        const arr = state.globalSettings.hotNewsPlatforms || [];
        if (arr.includes(p.key)) {
          state.globalSettings.hotNewsPlatforms = arr.filter(k => k !== p.key);
        } else {
          state.globalSettings.hotNewsPlatforms = [...arr, p.key];
        }
        chip.classList.toggle('active');
      });
      wrap.appendChild(chip);
    });
  }

  // 开关：从 state 读初值
  const toggle = document.getElementById('hot-news-enabled-toggle');
  if (toggle) {
    toggle.checked = state.globalSettings.hotNewsEnabled === true;
    // 2026-07-03 修复：监听 toggle 变化实时同步到 state（之前漏了这个监听器，
    // 导致点开 toggle 看起来变了，但 save 时 state 还是旧值，重进就回到 false）
    toggle.onchange = () => {
      state.globalSettings.hotNewsEnabled = toggle.checked;
    };
  }

  modal.classList.add('visible');
}

async function saveHotNewsSettings() {
  if (typeof db !== 'undefined' && db.globalSettings) {
    await db.globalSettings.put(state.globalSettings);
  }
  const modal = document.getElementById('hot-news-settings-modal');
  if (modal) modal.classList.remove('visible');
  if (typeof showToast === 'function') showToast('热点日报设置已保存', 'success');
  // 立即刷新一次屏幕
  await renderHotNewsScreen();
}

// ---- 全局暴露 ----
window.openHotNewsScreen = openHotNewsScreen;
window.forceRefreshHotNews = forceRefreshHotNews;
window.openHotNewsSettings = openHotNewsSettings;
window.saveHotNewsSettings = saveHotNewsSettings;
window.getSlottedHotNews = getSlottedHotNews;  // 给 ai-response.js 用
window.HotNewsDB = HotNewsDB;
window.HOTNEWS_PLATFORMS = HOTNEWS_PLATFORMS;

// 初始化：刷新按钮 + 设置按钮
document.addEventListener('DOMContentLoaded', () => {
  const refreshBtn = document.getElementById('hot-news-refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', forceRefreshHotNews);
  const settingsBtn = document.getElementById('hot-news-settings-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', openHotNewsSettings);
  const saveBtn = document.getElementById('save-hot-news-settings-btn');
  if (saveBtn) saveBtn.addEventListener('click', saveHotNewsSettings);
  const cancelBtn = document.getElementById('cancel-hot-news-settings-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    document.getElementById('hot-news-settings-modal')?.classList.remove('visible');
  });
});
