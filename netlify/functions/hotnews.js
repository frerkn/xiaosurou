// Netlify Functions proxy for hot_news (orz.ai)
// Frontend path: /.netlify/functions/hotnews
// 调用：GET /.netlify/functions/hotnews?platforms=weibo,zhihu,baidu,bilibili,douyin
// 返回：{ items: [{title, source, url, desc}, ...], cachedAt: ..., hit: ... }
// （2026-07-02 新增：热点日报功能，跨域代理。给前端绕开 file:// 跨域限制。）

const HOTNEWS_UPSTREAM = 'https://orz.ai/api/v1/dailynews/';

// 平台 key → 中文显示名（与前端 hot-news.js 的 HOTNEWS_PLATFORMS 对齐）
// 2026-07-02 按用户偏好精简：删掉虎扑/豆瓣/36氪/掘金/V2EX/少数派/Stack Overflow/GitHub/Hacker News/吾爱破解
const HOTNEWS_PLATFORM_LABELS = {
  baidu: '百度', weibo: '微博', zhihu: '知乎',
  bilibili: 'B站', douyin: '抖音', jinritoutiao: '今日头条', tieba: '贴吧',
  sina_finance: '新浪财经', eastmoney: '东方财富', xueqiu: '雪球',
  cls: '财联社', tenxunwang: '腾讯网',
};

const HOTNEWS_DEFAULT_PLATFORMS = ['weibo', 'zhihu', 'baidu', 'bilibili', 'douyin'];
const HOTNEWS_PER_PLATFORM = 12;
const HOTNEWS_MAX_TOTAL = 240;
const HOTNEWS_FETCH_TIMEOUT_MS = 5000;
const HOTNEWS_TTL_MS = 5 * 60 * 1000;

// 内存缓存：{ cacheKey: { items, cachedAt } }，TTL 5 分钟
const HOTNEWS_CACHE = new Map();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonResponse(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    },
    body: JSON.stringify(payload)
  };
}

// 用 AbortController 实现 fetch 超时
function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'EPhone-HotNews/1.0' },
    signal: controller.signal
  }).finally(() => clearTimeout(timer));
}

// 单平台拉取
async function fetchHotNewsPlatform(platform) {
  const url = `${HOTNEWS_UPSTREAM}?platform=${encodeURIComponent(platform)}`;
  try {
    const res = await fetchWithTimeout(url, HOTNEWS_FETCH_TIMEOUT_MS);
    if (!res.ok) {
      console.warn(`[hotnews] ${platform} HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const arr = Array.isArray(data?.data) ? data.data : [];
    const label = HOTNEWS_PLATFORM_LABELS[platform] || platform;
    return arr
      .filter(it => it && it.title)
      .slice(0, HOTNEWS_PER_PLATFORM)
      .map(it => ({
        title: String(it.title),
        source: label,
        url: typeof it.url === 'string' && it.url ? it.url : undefined,
        // 2026-07-04 修复：orz.ai 返回字段是 content（新闻详细内容），不是 desc。
        // 之前用 desc 一直拿到空，所以 M3 只能看标题看不到内容。
        content: typeof it.content === 'string' ? it.content.replace(/\s+/g, ' ').trim() || undefined : undefined
      }));
  } catch (e) {
    console.warn(`[hotnews] ${platform} 拉取失败:`, e?.name || '', e?.message || e);
    return [];
  }
}

// 多平台并发拉取 + round-robin 交错合并（避免单一平台霸屏）
async function fetchHotNewsMerged(platforms) {
  const results = await Promise.all(platforms.map(fetchHotNewsPlatform));
  const merged = [];
  for (let rank = 0; rank < HOTNEWS_PER_PLATFORM; rank++) {
    for (const items of results) {
      if (items[rank]) merged.push(items[rank]);
    }
  }
  return merged.slice(0, HOTNEWS_MAX_TOTAL);
}

exports.handler = async function handler(event) {
  // CORS 预检
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: ''
    };
  }

  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, {
      error: 'Method Not Allowed',
      message: 'hotnews proxy only accepts GET.'
    });
  }

  // 解析 query：?platforms=weibo,zhihu,...
  const q = event.queryStringParameters || {};
  const rawPlatforms = (q.platforms || '').split(',').map(s => s.trim()).filter(Boolean);
  const platforms = rawPlatforms.length > 0 ? rawPlatforms : HOTNEWS_DEFAULT_PLATFORMS;

  const cacheKey = platforms.slice().sort().join(',');
  const now = Date.now();
  const cached = HOTNEWS_CACHE.get(cacheKey);
  if (cached && (now - cached.cachedAt) < HOTNEWS_TTL_MS) {
    return jsonResponse(200, {
      items: cached.items,
      cachedAt: cached.cachedAt,
      hit: true
    });
  }

  try {
    const items = await fetchHotNewsMerged(platforms);
    if (items.length > 0) {
      HOTNEWS_CACHE.set(cacheKey, { items, cachedAt: now });
      console.log(`[hotnews] 拉取 ${platforms.length} 平台 ${items.length} 条`);
    } else {
      console.warn(`[hotnews] 全部平台拉取失败 platforms=${platforms.join(',')}`);
    }
    return jsonResponse(200, {
      items,
      cachedAt: now,
      hit: false
    });
  } catch (e) {
    console.error('[hotnews] 处理失败:', e);
    return jsonResponse(500, {
      error: 'hotnews fetch failed',
      message: e?.message || String(e)
    });
  }
};
