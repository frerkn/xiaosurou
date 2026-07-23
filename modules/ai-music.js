// ============================================================
// ai-music.js — AI 唱歌（音乐生成 + 翻唱 Cover 模式）
// 功能：调用 MiniMax music_generation API，支持
//       1) 普通模式（prompt + lyrics → 新歌）
//       2) Cover 翻唱模式（参考音频 + 新风格/新歌词 → 同嗓音新歌）
//       端点完全固化（不依赖用户填的 baseURL）
// 来源：基于 MiniMax 官方 CLI (github.com/MiniMax-AI/cli) 的 music cover/generate 实现
// ============================================================

(function () {
  // ---------- 端点常量（完全固化，参照 mmx CLI endpoints.ts） ----------
  // 国内区 minimaxi.com；国际区是 minimax.io，按需切换下面这一行
  const MUSIC_API_URL = 'https://api.minimaxi.com/v1/music_generation';
  const MUSIC_COVER_PREPROCESS_URL = 'https://api.minimaxi.com/v1/music_cover_preprocess';

  // ---------- 全局状态 Proxy（沿用 music-player.js 的延迟加载模式） ----------
  const state = new Proxy({}, {
    get: (target, prop) => window.state?.[prop]
  });

  // ---------- API Key 获取（fallback 链） ----------
  // 优先级：musicApiKey（用户专门填的） > globalSettings.apiKey（用户填的 MiniMax 主 key）
  // 不用 mainApiConfig.apiKey（那是聊天用的同源 key）；不用 Fish Audio / 其他 TTS 的 key
  function getMusicApiKey() {
    const musicKey = state.globalSettings?.musicApiKey;
    if (musicKey && String(musicKey).trim()) return String(musicKey).trim();
    const fallback = state.globalSettings?.apiKey;
    return fallback ? String(fallback).trim() : '';
  }

  // ---------- 参考音频（从 IndexedDB 取该角色的专属音色样本） ----------
  async function getVoiceSampleBlob(chatId) {
    if (!chatId) return null;
    const sample = await window.MusicVoiceSample?.getVoiceSample?.(chatId);
    if (!sample || !sample.blob) return null;
    return sample.blob;
  }

  // ---------- Blob → base64 字符串（不带头部的 data:） ----------
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result || '';
        const idx = String(result).indexOf(',');
        resolve(idx >= 0 ? String(result).slice(idx + 1) : String(result));
      };
      reader.onerror = () => reject(new Error('Blob → base64 失败'));
      reader.readAsDataURL(blob);
    });
  }

  // ---------- hex 字符串 → Uint8Array（音乐 API 返回的 audio 字段是 hex） ----------
  function hexToBytes(hex) {
    const clean = String(hex || '').replace(/^0x/i, '').replace(/\s+/g, '');
    if (!clean || clean.length % 2 !== 0) return new Uint8Array(0);
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  // ---------- hex → Blob（MP3） ----------
  function hexToMp3Blob(hex) {
    const bytes = hexToBytes(hex);
    if (bytes.length === 0) return null;
    return new Blob([bytes], { type: 'audio/mpeg' });
  }

  // ---------- 解析响应，提取音频 ----------
  function extractAudioBlob(responseJson) {
    if (!responseJson) return null;
    if (responseJson.base_resp && responseJson.base_resp.status_code !== 0) {
      const msg = responseJson.base_resp.status_msg || '未知错误';
      throw new Error('音乐生成失败: ' + msg);
    }
    const data = responseJson.data || {};
    if (data.audio) {
      return hexToMp3Blob(data.audio);
    }
    if (data.audio_url) {
      // 24h 过期 URL 模式（output_format='url'），这里暂不直接用
      // 由调用方决定是否下载
      return { audioUrl: data.audio_url };
    }
    return null;
  }

  // ---------- 通用 fetch 包装 ----------
  async function postJson(url, apiKey, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      let errText = '';
      try { errText = await res.text(); } catch (e) { /* ignore */ }
      throw new Error('HTTP ' + res.status + ' ' + res.statusText + (errText ? ' - ' + errText.slice(0, 200) : ''));
    }
    return await res.json();
  }

  // ---------- Cover 模式（两步调用：preprocess → 主生成） ----------
  async function generateCover({ apiKey, model, prompt, lyrics, audioBase64, onProgress }) {
    let coverFeatureId = null;
    const finalLyrics = lyrics;  // 【2026-07-23 修】不再用 server 返回的 formatted_lyrics 覆盖——
                                   // preprocess 返回的 formatted_lyrics 是 server 从参考音频 ASR 出来的歌词，
                                   // 覆盖会把用户给的新词替换成参考音频里的旧词，导致 Cover 唱的还是上传内容
    let usedPreprocess = false;

    // 步骤 1：如果用户给了歌词，先跑 preprocess 提取声音特征（拿 cover_feature_id）
    if (lyrics && String(lyrics).trim()) {
      usedPreprocess = true;
      onProgress && onProgress({ stage: 'preprocess', text: '正在提取音频特征...' });
      const preprocessRes = await postJson(MUSIC_COVER_PREPROCESS_URL, apiKey, {
        model: 'music-cover',
        audio_base64: audioBase64
      });
      if (preprocessRes.base_resp && preprocessRes.base_resp.status_code !== 0) {
        throw new Error('Cover 预处理失败: ' + (preprocessRes.base_resp.status_msg || '未知错误'));
      }
      coverFeatureId = preprocessRes.cover_feature_id;
      // 故意不读 preprocessRes.formatted_lyrics——见上面注释
    }

    // 步骤 2：调主端点
    onProgress && onProgress({ stage: 'generate', text: '正在生成翻唱...' });
    const mainBody = {
      model: model,
      prompt: prompt,
      lyrics: finalLyrics,
      audio_setting: {
        format: 'mp3',
        sample_rate: 44100,
        bitrate: 256000
      },
      output_format: 'hex'
    };
    if (usedPreprocess) {
      // 已经 preprocess 过的：用 feature_id，不再传 audio_base64
      mainBody.cover_feature_id = coverFeatureId;
    } else {
      // 没歌词的：直接传 audio_base64，让 server 自己 ASR 提取
      mainBody.audio_base64 = audioBase64;
    }

    const res = await postJson(MUSIC_API_URL, apiKey, mainBody);
    return extractAudioBlob(res);
  }

  // ---------- 普通模式（无参考音频，纯 prompt+lyrics 生成） ----------
  async function generateNormal({ apiKey, model, prompt, lyrics, instrumental, onProgress }) {
    onProgress && onProgress({ stage: 'generate', text: '正在生成音乐...' });
    const body = {
      model: model,
      prompt: prompt,
      lyrics: lyrics,
      audio_setting: {
        format: 'mp3',
        sample_rate: 44100,
        bitrate: 256000
      },
      output_format: 'hex'
    };
    if (instrumental) {
      body.is_instrumental = true;
    }
    const res = await postJson(MUSIC_API_URL, apiKey, body);
    return extractAudioBlob(res);
  }

  // ---------- 主入口 ----------
  // 参数：
  //   chatId: 聊天 ID（用于取专属音色样本）
  //   prompt: 风格描述（必填）
  //   lyrics: 歌词（带 [Verse] 等结构标签，可选；不传 = 纯音乐 instrumental 模式 或 AI 自动写词）
  //   useVoiceSample: 是否使用该角色的专属音色样本（默认 true）
  //   model: 强制指定模型（默认从设置读）
  //   instrumental: 是否纯音乐（默认 false）
  //   onProgress({stage, text}): 进度回调
  // 返回：{ blob, audioUrl?, duration? } 或 throw
  async function generateSong(opts) {
    const chatId = opts?.chatId;
    const prompt = opts?.prompt;
    let lyrics = opts?.lyrics;
    const useVoiceSample = opts?.useVoiceSample !== false;
    const explicitModel = opts?.model;
    const instrumental = !!opts?.instrumental;
    const onProgress = opts?.onProgress;

    // 0. 校验开关
    if (!state.globalSettings?.enableMusicGeneration) {
      throw new Error('音乐生成未启用，请在 API 设置页开启');
    }

    // 1. 校验 API Key
    const apiKey = getMusicApiKey();
    if (!apiKey) {
      throw new Error('音乐生成 API Key 未配置（请在 API 设置页填写或确保已配置 MiniMax 主 key）');
    }

    // 2. 校验 prompt
    if (!prompt || !String(prompt).trim()) {
      throw new Error('prompt 必填');
    }

    // 3. 决定 model —— 【2026-07-21 改】默认 music-cover
    const settingsModel = state.globalSettings?.musicModel;
    let model = explicitModel || settingsModel || 'music-cover';

    // 4. 取参考音频（只要 useVoiceSample=true 且有 chatId 就取，不依赖 model）
    // 改：之前是"只有 cover 模型才取样"，现在"先取样，有样本再决定 model"
    let audioBase64 = null;
    let hasVoiceSample = false;
    if (useVoiceSample && chatId) {
      const sampleBlob = await getVoiceSampleBlob(chatId);
      if (sampleBlob) {
        hasVoiceSample = true;
        onProgress && onProgress({ stage: 'encode', text: '正在编码参考音频...' });
        audioBase64 = await blobToBase64(sampleBlob);
      }
    }

    // 4.5 【2026-07-23 改】原本强制 cover，改成读开关 autoCoverWhenHasSample（默认 true 保持原行为）
    // 关掉后 = 即使有音色样本也用用户在设置里选的普通模型（更便宜，但失去角色专属音色）
    const autoCover = state.globalSettings?.autoCoverWhenHasSample !== false;
    if (autoCover && hasVoiceSample && !String(model).startsWith('music-cover')) {
      console.log('[AIMusic] 检测到角色音色样本，自动从 ' + model + ' 切换到 music-cover（角色专属音色）');
      model = 'music-cover';
    } else if (!autoCover && hasVoiceSample && !String(model).startsWith('music-cover')) {
      console.log('[AIMusic] 角色有音色样本但用户关了 auto-cover，沿用用户选的模型: ' + model);
    }

    const isCoverModel = String(model).startsWith('music-cover');

    // 4.6 cover 模型但没样本 → 报错（强制提示用户去上传）
    if (isCoverModel && !hasVoiceSample) {
      throw new Error('Cover 模式需要先上传角色专属音色样本（在角色设置页 → 音乐设置）');
    }

    // 5. 纯音乐模式：自动清空 lyrics
    if (instrumental) {
      lyrics = undefined;
    }

    // 6. 分支调用
    if (isCoverModel && audioBase64) {
      return await generateCover({ apiKey, model, prompt, lyrics, audioBase64, onProgress });
    } else {
      return await generateNormal({ apiKey, model, prompt, lyrics, instrumental, onProgress });
    }
  }

  // ---------- 暴露 API ----------
  window.AIMusic = {
    generateSong: generateSong,
    getMusicApiKey: getMusicApiKey,
    MUSIC_API_URL: MUSIC_API_URL,
    MUSIC_COVER_PREPROCESS_URL: MUSIC_COVER_PREPROCESS_URL
  };
})();
