// 2026-07-14 重新启用：URL 抓取小说功能
// 浏览器端 fetch 会被 CORS 拦，所以走这个 Function 中转：
//   GET /.netlify/functions/link-preview?url=https://example.com/article
// 返回 { url, html, contentType }，由前端 importBookFromUrl 解析。
//
// 安全：拒绝 localhost / 127.x / 10.x / 172.16-31.x / 192.168.x / 169.254.x 等内网地址（防 SSRF）。
// 限制：单个页面 HTML <= 5MB（避免 Function 超时/超限）。
// 缓存：5 分钟（同一 URL 重复抓不重复打上游）。
// 伪装：iPhone Safari UA + Accept-Language zh-CN，提高对中文站点的兼容性。

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  const params = event.queryStringParameters || {};
  const targetUrl = params.url;

  if (!targetUrl) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Bad Request', message: '缺少 url 参数' })
    };
  }

  // 解析 + 协议校验
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Bad Request', message: 'url 格式不合法' })
    };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Bad Request', message: '只支持 http:// 或 https://' })
    };
  }

  // SSRF 防护：拒绝内网地址
  const hostname = parsed.hostname.toLowerCase();
  const isPrivate =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname.startsWith('169.254.') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan');

  if (isPrivate) {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Forbidden', message: '不允许抓取内网地址' })
    };
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      redirect: 'follow'
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({
          error: 'Fetch Failed',
          message: `目标站点返回 HTTP ${response.status}`
        })
      };
    }

    const contentType = response.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
      return {
        statusCode: 415,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({
          error: 'Unsupported Media Type',
          message: `不支持的内容类型: ${contentType || '(空)'}`
        })
      };
    }

    const html = await response.text();

    // 限制大小 5MB
    if (html.length > 5 * 1024 * 1024) {
      return {
        statusCode: 413,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({
          error: 'Payload Too Large',
          message: `页面太大（${(html.length / 1024 / 1024).toFixed(2)} MB > 5 MB）`
        })
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
        'Cache-Control': 'public, max-age=300'  // 5 分钟 CDN 缓存
      },
      body: JSON.stringify({
        url: targetUrl,
        html: html,
        contentType: contentType
      })
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({
        error: 'Internal Error',
        message: error.message || '抓取失败'
      })
    };
  }
};
