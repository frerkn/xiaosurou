const { proxyOpenAICompatibleRequest } = require('./openai-proxy-core');

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function logProxyEvent(event, payload = {}) {
  try {
    console.log(event, payload);
  } catch (error) {
    // ignore logging failures
  }
}

function getHostname(req) {
  const host = req.headers?.host || req.headers?.['x-forwarded-host'] || '';
  return String(host).split(':')[0].toLowerCase();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end('');
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, {
      error: 'Method Not Allowed',
      message: 'OpenAI compatible proxy only accepts POST requests.'
    });
    return;
  }

  const platform = 'vercel';
  const hostname = getHostname(req);
  const proxyPath = '/api/openai-proxy';
  logProxyEvent('API_PROXY_PLATFORM_DETECTED', {
    platform,
    hostname,
    proxyPath,
    method: req.method
  });
  logProxyEvent('API_PROXY_ENDPOINT_SELECTED', {
    platform,
    hostname,
    proxyPath,
    method: req.method
  });

  let body = null;
  let rawBody = '';
  if (req.body && typeof req.body === 'object') {
    body = req.body;
    rawBody = JSON.stringify(req.body);
    logProxyEvent('API_PROXY_VERCEL_BODY_READY', {
      platform,
      hostname,
      proxyPath,
      method: req.method,
      bodyLength: rawBody.length,
      contentType: req.headers?.['content-type'] || ''
    });
  } else if (typeof req.body === 'string') {
    rawBody = req.body;
    try {
      body = JSON.parse(req.body || '{}');
      logProxyEvent('API_PROXY_VERCEL_BODY_READY', {
        platform,
        hostname,
        proxyPath,
        method: req.method,
        bodyLength: rawBody.length,
        contentType: req.headers?.['content-type'] || ''
      });
    } catch (error) {
      body = null;
    }
  } else {
    rawBody = '';
    body = {};
  }

  if (!body) {
    sendJson(res, 400, {
      error: 'Invalid JSON',
      message: '请求体必须是合法的 JSON。'
    });
    return;
  }

  try {
    const upstreamMethod = body.method && String(body.method).toUpperCase() === 'GET' ? 'GET' : 'POST';
    const upstreamBody = upstreamMethod === 'GET' ? '' : (body.payload && typeof body.payload === 'object' ? JSON.stringify(body.payload) : '');
    
    const result = await proxyOpenAICompatibleRequest({
      targetUrl: body.targetUrl,
      baseUrl: body.baseUrl,
      targetPath: body.targetPath,
      apiKey: body.apiKey,
      payload: body.payload,
      method: upstreamMethod,
      rawBody: upstreamBody,
      platform,
      proxyPath
    });

    res.statusCode = result.status;
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.end(result.text);
  } catch (error) {
    sendJson(res, 502, {
      error: 'Proxy Request Failed',
      message: error && error.message ? error.message : 'OpenAI compatible proxy request failed.'
    });
  }
};
