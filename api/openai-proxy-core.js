const DEFAULT_CONTENT_TYPE = 'text/plain; charset=utf-8';

function normalizeTargetUrl(targetUrl) {
  if (typeof targetUrl !== 'string') return '';
  const trimmed = targetUrl.trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      return '';
    }
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (error) {
    return '';
  }
}

function normalizeEndpointPath(path) {
  const rawPath = typeof path === 'string' ? path.trim() : '';
  if (!rawPath) return '';
  const cleaned = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  if (cleaned === '/chat/completions' || cleaned === '/models') return cleaned;
  return '';
}

function buildTargetUrlFromBase(baseUrl, targetPath) {
  const endpointPath = normalizeEndpointPath(targetPath);
  if (!endpointPath || typeof baseUrl !== 'string' || !baseUrl.trim()) return '';

  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== 'https:') return '';

    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    parsed.search = '';

    let pathname = parsed.pathname || '/';
    pathname = pathname.replace(/\/+$/, '');
    pathname = pathname.replace(/\/chat\/completions$/i, '');
    pathname = pathname.replace(/\/models$/i, '');

    parsed.pathname = `${pathname}${endpointPath}`.replace(/\/{2,}/g, '/');
    return parsed.toString();
  } catch (error) {
    return '';
  }
}

function getSafeUrlSummary(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.host,
      path: parsed.pathname,
      finalUrl: `${parsed.protocol}//${parsed.host}${parsed.pathname}`
    };
  } catch (error) {
    return {
      host: '',
      path: '',
      finalUrl: ''
    };
  }
}

function logProxyEvent(event, payload = {}) {
  try {
    console.log(event, payload);
  } catch (error) {
    // ignore logging failures
  }
}

async function proxyOpenAICompatibleRequest({
  targetUrl,
  baseUrl,
  targetPath,
  apiKey,
  payload,
  method,
  signal,
  platform = '',
  proxyPath = '',
  rawBody = ''
} = {}) {
  const normalizedTargetUrl = normalizeTargetUrl(targetUrl)
    || buildTargetUrlFromBase(baseUrl, targetPath);
  const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  const normalizedMethod = String(method || 'POST').toUpperCase();
  const safeSummary = getSafeUrlSummary(normalizedTargetUrl);
  const finalPath = safeSummary.path;
  const streamMode = payload && payload.stream === true ? 'stream' : 'non-stream';
  const requestContentType = 'application/json';

  if (!normalizedTargetUrl) {
    return {
      status: 400,
      contentType: 'application/json',
      text: JSON.stringify({
        error: 'Invalid targetUrl',
        message: 'targetUrl/baseUrl 必须是有效的 https 地址，且只能转发到 /chat/completions 或 /models。'
      }),
      safeSummary
    };
  }

  if (!normalizedApiKey) {
    return {
      status: 400,
      contentType: 'application/json',
      text: JSON.stringify({
        error: 'Missing apiKey',
        message: 'apiKey 不能为空。'
      }),
      safeSummary
    };
  }

  if (normalizedMethod !== 'POST' && normalizedMethod !== 'GET') {
    return {
      status: 405,
      contentType: 'application/json',
      text: JSON.stringify({
        error: 'Method Not Allowed',
        message: 'OpenAI compatible proxy only supports POST and GET upstream requests.'
      }),
      safeSummary
    };
  }

  const headers = {
    Authorization: `Bearer ${normalizedApiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  const fetchOptions = {
    method: normalizedMethod,
    headers,
    signal
  };

  if (normalizedMethod !== 'GET') {
    fetchOptions.body = typeof rawBody === 'string' && rawBody.trim()
      ? rawBody
      : JSON.stringify(payload || {});
  }

  logProxyEvent(targetPath === '/models' ? 'API_PROXY_MODELS_TARGET_BUILT' : 'API_PROXY_CHAT_TARGET_BUILT', {
    platform,
    proxyPath,
    method: normalizedMethod,
    host: safeSummary.host,
    path: safeSummary.path,
    finalPath,
    hasAuthorization: !!normalizedApiKey,
    contentType: requestContentType,
    streamMode
  });

  const upstreamResponse = await fetch(normalizedTargetUrl, fetchOptions);
  const responseText = await upstreamResponse.text();
  logProxyEvent('API_PROXY_RESPONSE_BODY_READ_ONCE', {
    platform,
    proxyPath,
    method: normalizedMethod,
    host: safeSummary.host,
    path: safeSummary.path,
    finalPath,
    status: upstreamResponse.status,
    bodyLength: responseText.length,
    hasAuthorization: !!normalizedApiKey,
    contentType: upstreamResponse.headers.get('content-type') || DEFAULT_CONTENT_TYPE,
    streamMode
  });

  if (!upstreamResponse.ok) {
    logProxyEvent('API_PROXY_NON_2XX_RESPONSE', {
      platform,
      proxyPath,
      method: normalizedMethod,
      host: safeSummary.host,
      path: safeSummary.path,
      finalPath,
      status: upstreamResponse.status,
      bodyLength: responseText.length,
      hasAuthorization: !!normalizedApiKey,
      contentType: upstreamResponse.headers.get('content-type') || DEFAULT_CONTENT_TYPE,
      streamMode
    });
  }

  return {
    status: upstreamResponse.status,
    contentType: upstreamResponse.headers.get('content-type') || DEFAULT_CONTENT_TYPE,
    text: responseText,
    safeSummary
  };
}

module.exports = {
  buildTargetUrlFromBase,
  normalizeTargetUrl,
  proxyOpenAICompatibleRequest
};
