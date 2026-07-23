(function () {
  'use strict';

  function getAsrConfig() {
    return (window.state && window.state.apiConfig) || {};
  }

  function buildAsrTranscriptionUrl(asrBaseUrl) {
    const trimmedBaseUrl = String(asrBaseUrl || '').trim();

    if (trimmedBaseUrl.endsWith('/audio/transcriptions')) {
      return trimmedBaseUrl;
    }

    return trimmedBaseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
  }

  async function readAsrErrorMessage(response) {
    try {
      const data = await response.json();
      if (data && data.error) {
        if (typeof data.error === 'string') return data.error;
        if (data.error.message) return data.error.message;
        return JSON.stringify(data.error);
      }
      if (data && data.message) return data.message;
      return JSON.stringify(data);
    } catch (jsonError) {
      try {
        return await response.text();
      } catch (textError) {
        return '';
      }
    }
  }

  async function transcribeAudioBlob(audioBlob, options = {}) {
    const apiConfig = getAsrConfig();
    const asrBaseUrl = String(apiConfig.asrBaseUrl || '').trim();
    const asrApiKey = String(apiConfig.asrApiKey || '').trim();
    const asrModel = String(apiConfig.asrModel || '').trim();
    const asrLanguage = String(apiConfig.asrLanguage || '').trim() || 'zh';

    if (!asrBaseUrl || !asrApiKey || !asrModel) {
      throw new Error('ASR 未配置完整');
    }

    const requestUrl = buildAsrTranscriptionUrl(asrBaseUrl);
    const formData = new FormData();
    formData.append('file', audioBlob, 'speech.webm');
    formData.append('model', asrModel);
    formData.append('language', asrLanguage);
    formData.append('response_format', 'json');

    let response;
    try {
      response = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + asrApiKey
        },
        body: formData
      });
    } catch (error) {
      throw new Error('ASR 接口请求失败: ' + (error && error.message ? error.message : String(error)));
    }

    if (!response.ok) {
      const errorMessage = await readAsrErrorMessage(response);
      throw new Error('ASR 接口失败: ' + (errorMessage || response.status + ' ' + response.statusText));
    }

    let result;
    try {
      result = await response.json();
    } catch (error) {
      throw new Error('ASR 返回结果解析失败: ' + (error && error.message ? error.message : String(error)));
    }

    if (!result || typeof result.text === 'undefined' || result.text === null) {
      throw new Error('ASR 返回结果中没有 text');
    }

    return result.text;
  }

  window.transcribeAudioBlob = transcribeAudioBlob;
})();
