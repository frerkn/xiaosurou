/**
 * 网易云音乐 API 代理 (Netlify Function 版)
 * - 接收前端的 POST /.netlify/functions/netease-proxy
 * - body: { action, ...params }
 * - 头: X-Netease-Cookie: MUSIC_U=xxx; ...
 * - 翻译 action → api-enhanced 真实路径
 * - 转发 GET 到 Vercel 上的 api-enhanced
 * - 返回 JSON
 *
 * 配置:
 * - Netlify 环境变量: NETEASE_API_ENHANCED_URL (默认 api-enhanced-pi-ten.vercel.app)
 * - 部署在 netlify/functions/ 目录, 自动被 netlify 识别为 /.netlify/functions/netease-proxy
 *
 * 参考:
 * - 糯米 worker 的 /netease/* 路由 (worker/index.js:1976-2061)
 * - 糯米 worker 的 action 翻译 + 上游容灾 (worker/index.js:575-787)
 * - api-enhanced: https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced
 */

// ★★ 修改这里 ★★ (或用 Netlify 环境变量 NETEASE_API_ENHANCED_URL)
const NETEASE_API_ENHANCED =
  process.env.NETEASE_API_ENHANCED_URL || 'https://api-enhanced-pi-ten.vercel.app';

// 国内 IP 伪装: 部分接口需要 realIP 参数才会返回内地版权数据
const NETEASE_REAL_IP = '116.25.146.177';

// 已知 action → 真实上游路径的映射
const ACTION_PATH = {
  'search':           '/cloudsearch',     // 用 cloudsearch 返回更完整字段
  'song/url':         '/song/url/v1',
  'lyric':            '/lyric',
  'lyric/new':        '/lyric/new',
  'song/detail':      '/song/detail',
  'user/account':     '/user/account',
  'user/playlist':    '/user/playlist',
  'user/record':      '/user/record',
  'user/cloud':       '/user/cloud',
  'user/subcount':    '/user/subcount',
  'likelist':         '/likelist',
  'like':             '/like',
  'login/status':     '/login/status',
  'login/cellphone':  '/login/cellphone',
  'login/qr/key':     '/login/qr/key',
  'login/qr/create':  '/login/qr/create',
  'login/qr/check':   '/login/qr/check',
  'captcha/sent':     '/captcha/sent',
  'captcha/verify':   '/captcha/verify',
  'logout':           '/logout',
  'playlist/detail':  '/playlist/detail',
  'playlist/track/all': '/playlist/track/all',
  'recommend/songs':  '/recommend/songs',
  'recommend/resource': '/recommend/resource',
  'daily_signin':     '/daily_signin',
  'toplist':          '/toplist',
  'top/playlist':     '/top/playlist',
  'personalized':     '/personalized',
  'personalized/newsong': '/personalized/newsong',
  'banner':           '/banner',
  'album':            '/album',
  'artists':          '/artists',
  'artist/songs':     '/artist/songs',
  'mv/detail':        '/mv/detail',
  'mv/url':           '/mv/url',
  'comment/music':    '/comment/music',
};

// action 白名单 — 只允许 api-enhanced 已知的安全接口
const ACTION_ALLOWED = new Set([
  ...Object.keys(ACTION_PATH),
  // 同时允许同名 (在 ACTION_PATH 里有写)
  'search/suggest',
  'search/hot',
  'search/default',
  'check/music',
]);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Netease-Cookie',
  'Access-Control-Max-Age': '86400',
};

function buildUpstreamPath(action, body, cookie) {
  const basePath = ACTION_PATH[action] || `/${action}`;
  const p = new URLSearchParams();
  // 【0.0.37 关键修复】cookie 必须作为 URL query 参数传给 api-enhanced,
  // 不能只在 HTTP Cookie 头里 — 否则 api-enhanced 拿不到登录态, VIP 也只能 30 秒试听
  if (cookie && cookie.trim()) p.set('cookie', cookie.trim());
  p.set('realIP', NETEASE_REAL_IP);
  // cache-buster, 避免 Vercel 边缘缓存干扰登录态
  p.set('timestamp', Date.now().toString());

  if (action === 'search') {
    p.set('keywords', body.keyword || body.keywords || '');
    p.set('type', String(body.type || 1));
    p.set('limit', String(body.limit || 30));
    p.set('offset', String(body.offset || 0));
  } else if (action === 'song/url') {
    const ids = Array.isArray(body.ids) ? body.ids : (body.id != null ? [body.id] : []);
    if (ids.length) p.set('id', ids.join(','));
    p.set('level', body.level || 'exhigh');
  } else if (action === 'song/detail') {
    const ids = Array.isArray(body.ids) ? body.ids : (body.id != null ? [body.id] : []);
    if (ids.length) p.set('ids', ids.join(','));
  } else if (action === 'like') {
    p.set('id', String(body.id || ''));
    p.set('like', body.like === true || body.like === 'true' ? 'true' : 'false');
  } else if (action === 'user/playlist') {
    if (body.uid != null) p.set('uid', String(body.uid));
    p.set('limit', String(body.limit || 30));
    p.set('offset', String(body.offset || 0));
  } else if (action === 'user/record') {
    if (body.uid != null) p.set('uid', String(body.uid));
    p.set('type', String(body.type ?? 1));
  } else {
    // 通用: 所有其余参数直接透传
    for (const [k, v] of Object.entries(body || {})) {
      if (v == null) continue;
      if (Array.isArray(v)) p.set(k, v.join(','));
      else p.set(k, String(v));
    }
  }

  return `${basePath}?${p.toString()}`;
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(payload),
  };
}

function passthroughResponse(statusCode, text) {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: text,
  };
}

exports.handler = async function (event) {
  // CORS 预检
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  // 解析 body
  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return jsonResponse(400, { error: 'Invalid JSON' });
    }
  }

  const action = body.action;
  if (!action) {
    return jsonResponse(400, { error: 'Missing action' });
  }

  if (!ACTION_ALLOWED.has(action)) {
    return jsonResponse(404, {
      error: 'Unknown or unallowed action',
      action,
      hint: '支持: search, song/url, lyric, song/detail, login/status, login/cellphone, login/qr/key, login/qr/create, login/qr/check, user/account, user/playlist, user/record, user/cloud, likelist, like 等',
    });
  }

  // 提取 cookie
  const cookie = event.headers['x-netease-cookie'] || event.headers['X-Netease-Cookie'] || '';

  // 提取业务参数 (剔除 action)
  const params = { ...body };
  delete params.action;

  // 翻译成上游路径 (cookie 作为 query 参数传给 api-enhanced, 关键!)
  const upstreamPath = buildUpstreamPath(action, params, cookie);
  const upstreamUrl = `${NETEASE_API_ENHANCED}${upstreamPath}`;

  // 转发 GET 到 api-enhanced
  try {
    const headers = { 'Accept': 'application/json' };
    if (cookie.trim()) {
      headers['Cookie'] = cookie.trim();
    }
    const res = await fetch(upstreamUrl, { method: 'GET', headers });

    const text = await res.text();
    return passthroughResponse(res.status, text);
  } catch (e) {
    return jsonResponse(502, {
      error: 'upstream fetch failed',
      detail: String(e),
      upstream: NETEASE_API_ENHANCED,
    });
  }
};
