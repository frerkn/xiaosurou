const { proxyOpenAICompatibleRequest } = require('../../api/openai-proxy-core');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function logProxyEvent(event, payload = {}) {
  try {
    console.log(event, payload);
  } catch (error) {
    // ignore logging failures
  }
}

function getHostname(event) {
  const host = event.headers?.host || event.headers?.['x-forwarded-host'] || '';
  return String(host).split(':')[0].toLowerCase();
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(payload)
  };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, {
      error: 'Method Not Allowed',
      message: 'OpenAI compatible proxy only accepts POST requests.'
    });
  }

  const platform = 'netlify';
  const hostname = getHostname(event);
  const proxyPath = '/.netlify/functions/openai-proxy';
  logProxyEvent('API_PROXY_PLATFORM_DETECTED', {
    platform,
    hostname,
    proxyPath,
    method: event.httpMethod
  });
  logProxyEvent('API_PROXY_ENDPOINT_SELECTED', {
    platform,
    hostname,
    proxyPath,
    method: event.httpMethod
  });

  let body;
  const rawWrapperBody = event.body || '';
  try {
    body = JSON.parse(rawWrapperBody || '{}');
  } catch (error) {
    return jsonResponse(400, {
      error: 'Invalid JSON',
      message: '请求体必须是合法的 JSON。'
    });
  }

  logProxyEvent('API_PROXY_NETLIFY_BODY_READY', {
    platform,
    hostname,
    proxyPath,
    method: event.httpMethod,
    bodyLength: rawWrapperBody.length,
    contentType: event.headers?.['content-type'] || event.headers?.['Content-Type'] || ''
  });

  try {
    const result = await proxyOpenAICompatibleRequest({
      targetUrl: body.targetUrl,
      baseUrl: body.baseUrl,
      targetPath: body.targetPath,
      apiKey: body.apiKey,
      payload: body.payload,
      method: body.method,
      rawBody: body.method && String(body.method).toUpperCase() !== 'GET'
        ? JSON.stringify(body.payload || {})
        : '',
      platform,
      proxyPath
    });

    return {
      statusCode: result.status,
      headers: {
        ...corsHeaders,
        'Content-Type': result.contentType,
        'Cache-Control': 'no-store'
      },
      body: result.text
    };
  } catch (error) {
    return jsonResponse(502, {
      error: 'Proxy Request Failed',
      message: error && error.message ? error.message : 'OpenAI compatible proxy request failed.'
    });
  }
};
