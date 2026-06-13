// ============================================================
// TTS unified entry
// 数据结构：
// state.apiConfig.tts = {
//   ttsEnabled: boolean,
//   currentProvider: 'minimax' | 'fishAudio' | 'openaiCompatible',
//   providers: {
//     minimax: { provider, apiKey, model, voice, groupId, endpoint },
//     fishAudio: { provider, apiKey, model, voice, endpoint },
//     openaiCompatible: { provider, apiKey, model, voice, endpoint }
//   }
// }
// ============================================================

(function () {
  const PROVIDERS = {
    MINIMAX: 'minimax',
    FISH_AUDIO: 'fishAudio',
    OPENAI_COMPATIBLE: 'openaiCompatible'
  };

  const MINIMAX_ENDPOINT = 'https://api.minimax.chat/v1/t2a_v2';
  const FISH_AUDIO_ENDPOINT = 'https://api.fish.audio/v1/tts';

  function getDefaultTtsConfig() {
    return {
      ttsEnabled: false,
      currentProvider: PROVIDERS.MINIMAX,
      providers: {
        [PROVIDERS.MINIMAX]: {
          provider: PROVIDERS.MINIMAX,
          apiKey: '',
          model: 'speech-01-hd',
          voice: '',
          groupId: '',
          endpoint: MINIMAX_ENDPOINT
        },
        [PROVIDERS.FISH_AUDIO]: {
          provider: PROVIDERS.FISH_AUDIO,
          apiKey: '',
          model: 's2-pro',
          voice: '',
          endpoint: FISH_AUDIO_ENDPOINT
        },
        [PROVIDERS.OPENAI_COMPATIBLE]: {
          provider: PROVIDERS.OPENAI_COMPATIBLE,
          apiKey: '',
          model: '',
          voice: '',
          endpoint: ''
        }
      }
    };
  }

  function deepMerge(defaults, value) {
    const result = Array.isArray(defaults) ? [] : { ...defaults };
    if (!value || typeof value !== 'object') return result;

    Object.keys(value).forEach(key => {
      if (
        defaults[key] &&
        typeof defaults[key] === 'object' &&
        !Array.isArray(defaults[key]) &&
        value[key] &&
        typeof value[key] === 'object' &&
        !Array.isArray(value[key])
      ) {
        result[key] = deepMerge(defaults[key], value[key]);
      } else {
        result[key] = value[key];
      }
    });

    return result;
  }

  function hasLegacyMinimaxConfig(apiConfig) {
    return Boolean(
      apiConfig &&
      (
        apiConfig.minimaxGroupId ||
        apiConfig.minimaxApiKey ||
        apiConfig.minimaxModel ||
        apiConfig.minimaxDomain ||
        localStorage.getItem('minimax-group-id') ||
        localStorage.getItem('minimax-api-key') ||
        localStorage.getItem('minimax-model') ||
        localStorage.getItem('minimax-domain')
      )
    );
  }

  function migrateLegacyMinimaxConfig(apiConfig, ttsConfig) {
    if (!hasLegacyMinimaxConfig(apiConfig)) return false;

    const groupId = apiConfig.minimaxGroupId || localStorage.getItem('minimax-group-id') || '';
    const apiKey = apiConfig.minimaxApiKey || localStorage.getItem('minimax-api-key') || '';
    const model = apiConfig.minimaxModel || localStorage.getItem('minimax-model') || 'speech-01-hd';
    const legacyDomain = apiConfig.minimaxDomain || localStorage.getItem('minimax-domain') || 'https://api.minimax.chat';
    const endpoint = /\/v1\/t2a_v2\/?$/i.test(legacyDomain)
      ? legacyDomain.replace(/\/$/, '')
      : legacyDomain.replace(/\/$/, '') + '/v1/t2a_v2';

    ttsConfig.providers.minimax = {
      ...ttsConfig.providers.minimax,
      provider: PROVIDERS.MINIMAX,
      apiKey,
      model,
      groupId,
      endpoint
    };
    ttsConfig.currentProvider = PROVIDERS.MINIMAX;
    ttsConfig.ttsEnabled = Boolean(apiKey && groupId);

    delete apiConfig.minimaxGroupId;
    delete apiConfig.minimaxApiKey;
    delete apiConfig.minimaxModel;
    delete apiConfig.minimaxDomain;

    ['minimax-group-id', 'minimax-api-key', 'minimax-model', 'minimax-domain'].forEach(key => {
      try { localStorage.removeItem(key); } catch (e) { }
    });

    console.log('[TTS迁移] 已将旧版 MiniMax 配置迁移到通用 TTS 结构。');
    return true;
  }

  function normalizeTtsConfig(apiConfig) {
    if (!apiConfig) return getDefaultTtsConfig();

    const defaults = getDefaultTtsConfig();
    const merged = deepMerge(defaults, apiConfig.tts || {});

    if (!merged.providers) merged.providers = defaults.providers;
    Object.keys(defaults.providers).forEach(provider => {
      merged.providers[provider] = {
        ...defaults.providers[provider],
        ...(merged.providers[provider] || {}),
        provider
      };
    });

    if (!merged.currentProvider || !merged.providers[merged.currentProvider]) {
      merged.currentProvider = PROVIDERS.MINIMAX;
    }

    try {
      migrateLegacyMinimaxConfig(apiConfig, merged);
    } catch (error) {
      console.error('[TTS迁移] 旧配置迁移失败，请重新配置语音服务：', error);
      if (typeof showToast === 'function') showToast('旧语音配置迁移失败，请重新配置');
    }

    apiConfig.tts = merged;
    return merged;
  }

  function getActiveConfig() {
    if (!window.state || !window.state.apiConfig) {
      throw new Error('应用状态未初始化');
    }

    const ttsConfig = normalizeTtsConfig(window.state.apiConfig);
    if (!ttsConfig.ttsEnabled) return null;

    const provider = ttsConfig.currentProvider || PROVIDERS.MINIMAX;
    const providerConfig = ttsConfig.providers?.[provider];
    if (!providerConfig) {
      throw new Error(`未知 TTS 服务商：${provider}`);
    }

    return {
      provider,
      providerConfig,
      ttsConfig
    };
  }

  function isEnabled() {
    const ttsConfig = normalizeTtsConfig(window.state?.apiConfig || {});
    return Boolean(ttsConfig.ttsEnabled);
  }

  async function synthesize({ text, voice, signal, languageBoost } = {}) {
    if (!text || !String(text).trim()) {
      throw new Error('TTS 文本不能为空');
    }

    const active = getActiveConfig();
    if (!active) {
      return null;
    }

    const adapter = window.TTSAdapters?.[active.provider];
    if (!adapter || typeof adapter.synthesize !== 'function') {
      throw new Error(`TTS 适配器未加载：${active.provider}`);
    }

    const finalVoice = voice || active.providerConfig.voice || '';
    return adapter.synthesize({
      text,
      voice: finalVoice,
      config: active.providerConfig,
      signal,
      languageBoost
    });
  }

  async function persistConfig() {
    if (window.db && window.state?.apiConfig) {
      await window.db.apiConfig.put(window.state.apiConfig);
    }
  }

  window.TTSService = {
    PROVIDERS,
    MINIMAX_ENDPOINT,
    FISH_AUDIO_ENDPOINT,
    getDefaultTtsConfig,
    normalizeTtsConfig,
    synthesize,
    isEnabled,
    persistConfig
  };
})();
