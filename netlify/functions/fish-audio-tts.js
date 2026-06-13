// Netlify Functions proxy for Fish Audio TTS
// Frontend path: /.netlify/functions/fish-audio-tts

const FISH_AUDIO_TTS_URL = 'https://api.fish.audio/v1/tts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  };
}

function normalizeRequestBody(payload) {
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const voice = typeof payload.voice === 'string' ? payload.voice.trim() : '';
  const model = typeof payload.model === 'string' && payload.model.trim()
    ? payload.model.trim()
    : 's2-pro';

  const options = payload.options && typeof payload.options === 'object' ? payload.options : {};

  const fishBody = {
    text,
    temperature: 0.7,
    top_p: 0.7,
    prosody: {
      speed: 1,
      volume: 0,
      normalize_loudness: true
    },
    chunk_length: 300,
    normalize: true,
    format: 'mp3',
    sample_rate: 44100,
    mp3_bitrate: 128,
    latency: 'normal',
    max_new_tokens: 1024,
    repetition_penalty: 1.2,
    min_chunk_length: 50,
    condition_on_previous_chunks: true,
    early_stop_threshold: 1,
    ...options
  };

  if (voice) {
    fishBody.reference_id = voice;
  }

  return { text, model, fishBody };
}

async function readFishError(response) {
  const contentType = response.headers.get('content-type') || '';

  try {
    if (contentType.includes('application/json')) {
      const data = await response.json();
      return {
        message: data.message || data.error?.message || data.error || JSON.stringify(data),
        details: data
      };
    }

    const text = await response.text();
    return {
      message: text || response.statusText || 'Fish Audio API 请求失败',
      details: text
    };
  } catch (error) {
    return {
      message: response.statusText || 'Fish Audio API 请求失败',
      details: String(error && error.message ? error.message : error)
    };
  }
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
      message: 'Fish Audio TTS proxy only accepts POST requests.'
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (error) {
    return jsonResponse(400, {
      error: 'Invalid JSON',
      message: '请求体必须是合法的 JSON。'
    });
  }

  const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
  if (!apiKey) {
    return jsonResponse(400, {
      error: 'Missing apiKey',
      message: 'Fish Audio API Key 不能为空。'
    });
  }

  const { text, model, fishBody } = normalizeRequestBody(payload);
  if (!text) {
    return jsonResponse(400, {
      error: 'Missing text',
      message: 'TTS 文本不能为空。'
    });
  }

  try {
    const fishResponse = await fetch(FISH_AUDIO_TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        model
      },
      body: JSON.stringify(fishBody)
    });

    const contentType = fishResponse.headers.get('content-type') || 'audio/mpeg';

    if (!fishResponse.ok) {
      const errorInfo = await readFishError(fishResponse);
      return jsonResponse(fishResponse.status, {
        error: 'Fish Audio API Error',
        message: errorInfo.message,
        details: errorInfo.details,
        status: fishResponse.status
      });
    }

    const audioBuffer = Buffer.from(await fishResponse.arrayBuffer());

    if (!audioBuffer.length) {
      return jsonResponse(502, {
        error: 'Empty Audio',
        message: 'Fish Audio API 未返回音频数据。'
      });
    }

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': contentType || 'audio/mpeg',
        'Cache-Control': 'no-store'
      },
      body: audioBuffer.toString('base64'),
      isBase64Encoded: true
    };
  } catch (error) {
    return jsonResponse(502, {
      error: 'Proxy Request Failed',
      message: error && error.message ? error.message : 'Fish Audio 代理请求失败。'
    });
  }
};
