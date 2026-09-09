// ============================================================
// OpenAI兼容生图设置：仅设置保存/恢复、API预设快捷填充、模型拉取
// 不接入聊天出图，不新增 openaiimag，不修改旧三套生图生成逻辑
// ============================================================

(function () {
  const STORAGE_KEYS = {
    enabled: 'openaiCompatImageEnabled',
    presetId: 'openaiCompatImagePresetId',
    baseUrl: 'openaiCompatImageBaseUrl',
    apiKey: 'openaiCompatImageApiKey',
    model: 'openaiCompatImageModel',
    aspectRatio: 'openaiCompatImageAspectRatio'
  };

  const CONTROL_IDS = {
    enabled: 'openai-compatible-image-switch',
    preset: 'openai-compatible-image-preset',
    baseUrl: 'openai-compatible-image-endpoint',
    apiKey: 'openai-compatible-image-api-key',
    modelInput: 'openai-compatible-image-model',
    modelSelect: 'openai-compatible-image-model-select',
    fetchModelsBtn: 'openai-compatible-image-fetch-models-btn',
    aspectRatio: 'openai-compatible-image-aspect-ratio',
    saveBtn: 'openai-compatible-image-save-btn'
  };

  const IMAGE_GENERATION_SWITCH_IDS = [
    'enable-ai-drawing-switch',
    'novelai-switch',
    'google-imagen-switch',
    CONTROL_IDS.enabled
  ];

  let cachedPresetRows = [];

  function getEl(id) {
    return document.getElementById(id);
  }

  function getControlElements() {
    return {
      enabled: getEl(CONTROL_IDS.enabled),
      preset: getEl(CONTROL_IDS.preset),
      baseUrl: getEl(CONTROL_IDS.baseUrl),
      apiKey: getEl(CONTROL_IDS.apiKey),
      modelInput: getEl(CONTROL_IDS.modelInput),
      modelSelect: getEl(CONTROL_IDS.modelSelect),
      fetchModelsBtn: getEl(CONTROL_IDS.fetchModelsBtn),
      aspectRatio: getEl(CONTROL_IDS.aspectRatio),
      saveBtn: getEl(CONTROL_IDS.saveBtn)
    };
  }

  function hasOpenAICompatibleImageControls() {
    return !!getEl(CONTROL_IDS.saveBtn);
  }

  function notify(message) {
    alert(message);
  }

  function normalizeOpenAICompatibleImageBaseUrl(rawUrl) {
    return (rawUrl || '')
      .trim()
      .replace(/\/+$/, '');
  }

  function validateExclusiveImageGenerationSwitches() {
    const enabledSwitches = [];

    IMAGE_GENERATION_SWITCH_IDS.forEach((id) => {
      const el = getEl(id);
      if (!el) {
        console.warn('[生图设置] 生图开关 DOM id 缺失:', id);
        return;
      }

      if (el.checked) {
        enabledSwitches.push(id);
      }
    });

    if (enabledSwitches.length > 1) {
      notify('请只保持一个生图开关打开');
      return false;
    }

    return true;
  }

  function getSavedSettings() {
    return {
      enabled: localStorage.getItem(STORAGE_KEYS.enabled) === 'true',
      presetId: localStorage.getItem(STORAGE_KEYS.presetId) || '',
      baseUrl: localStorage.getItem(STORAGE_KEYS.baseUrl) || '',
      apiKey: localStorage.getItem(STORAGE_KEYS.apiKey) || '',
      model: localStorage.getItem(STORAGE_KEYS.model) || '',
      aspectRatio: localStorage.getItem(STORAGE_KEYS.aspectRatio) || '1:1'
    };
  }

  function ensureAspectRatioOptions(selectEl, selectedValue) {
    if (!selectEl) return;
    const allowed = ['1:1', '9:16', '16:9'];
    selectEl.innerHTML = '';
    allowed.forEach((ratio) => {
      const opt = document.createElement('option');
      opt.value = ratio;
      opt.textContent = ratio;
      selectEl.appendChild(opt);
    });
    selectEl.value = allowed.includes(selectedValue) ? selectedValue : '1:1';
  }

  function setModelSelectOptions(models, selectedValue) {
    const { modelSelect } = getControlElements();
    if (!modelSelect) return;

    modelSelect.innerHTML = '';

    if (!Array.isArray(models) || models.length === 0) {
      const opt = document.createElement('option');
      opt.value = selectedValue || '';
      opt.textContent = selectedValue || '暂无模型';
      modelSelect.appendChild(opt);
      modelSelect.value = selectedValue || '';
      return;
    }

    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '请选择模型';
    modelSelect.appendChild(emptyOpt);

    models.forEach((modelId) => {
      const opt = document.createElement('option');
      opt.value = modelId;
      opt.textContent = modelId;
      modelSelect.appendChild(opt);
    });

    if (selectedValue && models.includes(selectedValue)) {
      modelSelect.value = selectedValue;
    } else {
      modelSelect.value = '';
    }
  }

  async function getOpenAICompatibleImagePresetRows() {
    if (!window.db || !db.apiPresets || typeof db.apiPresets.toArray !== 'function') {
      return [];
    }

    const presets = await db.apiPresets.toArray();
    return presets
      .filter((preset) => preset && preset.proxyUrl && preset.apiKey)
      .map((preset) => ({
        id: preset.id,
        name: preset.name || `预设 #${preset.id}`,
        proxyUrl: normalizeOpenAICompatibleImageBaseUrl(preset.proxyUrl || ''),
        apiKey: preset.apiKey || ''
      }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

  async function populateOpenAICompatibleImagePresetSelect(selectedId) {
    const { preset } = getControlElements();
    if (!preset) return;

    const currentSelectedId = selectedId != null ? String(selectedId) : (preset.value || '');

    // 每次渲染前清空旧 option，避免重复增殖。
    preset.innerHTML = '';

    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '不选择 API 预设';
    preset.appendChild(emptyOpt);

    cachedPresetRows = await getOpenAICompatibleImagePresetRows();

    cachedPresetRows.forEach((row) => {
      const opt = document.createElement('option');
      opt.value = String(row.id);
      opt.textContent = row.name;
      preset.appendChild(opt);
    });

    if (currentSelectedId && Array.from(preset.options).some((opt) => opt.value === currentSelectedId)) {
      preset.value = currentSelectedId;
    } else {
      preset.value = '';
    }
  }

  function applyPresetToOpenAICompatibleImageInputs(presetId) {
    const { baseUrl, apiKey } = getControlElements();
    const selected = cachedPresetRows.find((row) => String(row.id) === String(presetId));

    if (!selected) return;

    if (baseUrl) baseUrl.value = selected.proxyUrl || '';
    if (apiKey) apiKey.value = selected.apiKey || '';
  }

  async function loadOpenAICompatibleImageSettings() {
    if (!hasOpenAICompatibleImageControls()) return;

    const controls = getControlElements();
    const saved = getSavedSettings();

    await populateOpenAICompatibleImagePresetSelect(saved.presetId);

    if (controls.enabled) controls.enabled.checked = saved.enabled;
    if (controls.preset) controls.preset.value = saved.presetId;
    if (controls.baseUrl) controls.baseUrl.value = saved.baseUrl;
    if (controls.apiKey) controls.apiKey.value = saved.apiKey;
    if (controls.modelInput) controls.modelInput.value = saved.model;

    ensureAspectRatioOptions(controls.aspectRatio, saved.aspectRatio);
    setModelSelectOptions(saved.model ? [saved.model] : [], saved.model);
  }

  function saveOpenAICompatibleImageSettings() {
    if (!validateExclusiveImageGenerationSwitches()) {
      return false;
    }

    const controls = getControlElements();
    const baseUrl = normalizeOpenAICompatibleImageBaseUrl((controls.baseUrl && controls.baseUrl.value) || '');

    if (controls.baseUrl) controls.baseUrl.value = baseUrl;

    localStorage.setItem(STORAGE_KEYS.enabled, controls.enabled && controls.enabled.checked ? 'true' : 'false');
    localStorage.setItem(STORAGE_KEYS.presetId, (controls.preset && controls.preset.value) || '');
    localStorage.setItem(STORAGE_KEYS.baseUrl, baseUrl);
    localStorage.setItem(STORAGE_KEYS.apiKey, (controls.apiKey && controls.apiKey.value) || '');
    localStorage.setItem(STORAGE_KEYS.model, (controls.modelInput && controls.modelInput.value.trim()) || '');
    localStorage.setItem(STORAGE_KEYS.aspectRatio, (controls.aspectRatio && controls.aspectRatio.value) || '1:1');

    notify('OpenAI兼容生图设置已保存');
    return true;
  }

  function buildModelsUrl(baseUrl) {
    return `${baseUrl.replace(/\/+$/, '')}/models`;
  }

  function extractModelIds(payload) {
    if (!payload) return [];
    const list = Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
    return list
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item.id === 'string') return item.id;
        return '';
      })
      .filter(Boolean);
  }

  function getOpenAICompatibleImageSize(aspectRatio) {
    const ratio = String(aspectRatio || '1:1').trim();
    if (ratio === '9:16') return '1024x1792';
    if (ratio === '16:9') return '1792x1024';
    return '1024x1024';
  }

  function buildOpenAICompatibleImageGenerationUrl(baseUrl) {
    return `${normalizeOpenAICompatibleImageBaseUrl(baseUrl).replace(/\/+$/, '')}/images/generations`;
  }

  async function generateOpenAICompatibleImageFromPrompt(prompt) {
    const finalPrompt = String(prompt || '').trim();
    const settings = getSavedSettings();
    const baseUrl = normalizeOpenAICompatibleImageBaseUrl(settings.baseUrl);
    const apiKey = String(settings.apiKey || '').trim();
    const model = String(settings.model || '').trim();

    if (!baseUrl) {
      throw new Error('OpenAI兼容生图失败：请先填写 API地址。');
    }
    if (!apiKey) {
      throw new Error('OpenAI兼容生图失败：请先填写 API Key。');
    }
    if (!model) {
      throw new Error('OpenAI兼容生图失败：请先填写模型名。');
    }
    if (!finalPrompt) {
      throw new Error('OpenAI兼容生图失败：prompt 不能为空。');
    }
    const requestUrl = buildOpenAICompatibleImageGenerationUrl(baseUrl);
    const size = getOpenAICompatibleImageSize(settings.aspectRatio);

    try {
      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          prompt: finalPrompt,
          size,
          n: 1
        })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${errorText ? `: ${errorText.slice(0, 500)}` : ''}`);
      }

      const payload = await response.json();
      const firstImage = payload && Array.isArray(payload.data) ? payload.data[0] : null;
      let imageUrl = '';

      if (firstImage && typeof firstImage.b64_json === 'string' && firstImage.b64_json.trim()) {
        imageUrl = `data:image/png;base64,${firstImage.b64_json.trim()}`;
      } else if (firstImage && typeof firstImage.url === 'string' && firstImage.url.trim()) {
        imageUrl = firstImage.url.trim();
      }

      if (!imageUrl) {
        throw new Error('返回结果中没有 data[0].b64_json 或 data[0].url。');
      }

      return {
        imageUrl,
        fullPrompt: finalPrompt,
        prompt: finalPrompt,
        model,
        provider: 'openaiCompatible',
        size
      };
    } catch (error) {
      console.error('[OpenAI兼容生图] 生成失败:', error);
      throw new Error(`OpenAI兼容生图失败：${error.message || error}`);
    }
  }

  async function fetchOpenAICompatibleImageModels() {
    const controls = getControlElements();
    const baseUrl = (controls.baseUrl && controls.baseUrl.value.trim()) || '';
    const apiKey = (controls.apiKey && controls.apiKey.value.trim()) || '';

    if (!baseUrl) {
      notify('请先填写 OpenAI兼容 API地址');
      return;
    }

    const url = buildModelsUrl(baseUrl);

    try {
      if (controls.fetchModelsBtn) controls.fetchModelsBtn.disabled = true;

      const headers = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${errorText ? `: ${errorText.slice(0, 200)}` : ''}`);
      }

      const payload = await response.json();
      const modelIds = extractModelIds(payload);

      if (modelIds.length === 0) {
        notify('未从 /models 返回结果中读取到模型');
        setModelSelectOptions([], (controls.modelInput && controls.modelInput.value.trim()) || '');
        return;
      }

      setModelSelectOptions(modelIds, (controls.modelInput && controls.modelInput.value.trim()) || '');
      notify(`已拉取 ${modelIds.length} 个模型，请选择模型后点击“保存生图设置”持久化`);
    } catch (error) {
      console.error('[OpenAI兼容生图设置] 拉取模型失败:', error);
      notify(`拉取模型失败：${error.message || error}`);
    } finally {
      if (controls.fetchModelsBtn) controls.fetchModelsBtn.disabled = false;
    }
  }

  function bindOpenAICompatibleImageSettingsEvents() {
    if (!hasOpenAICompatibleImageControls()) return;

    const controls = getControlElements();

    controls.saveBtn?.addEventListener('click', saveOpenAICompatibleImageSettings);

    controls.fetchModelsBtn?.addEventListener('click', fetchOpenAICompatibleImageModels);

    controls.preset?.addEventListener('change', function () {
      applyPresetToOpenAICompatibleImageInputs(this.value);
    });

    controls.modelSelect?.addEventListener('change', function () {
      if (controls.modelInput && this.value) {
        controls.modelInput.value = this.value;
      }
    });

    const serviceSelect = getEl('image-generation-service-select');
    serviceSelect?.addEventListener('change', function () {
      if (this.value === 'openai-compatible') {
        populateOpenAICompatibleImagePresetSelect(controls.preset?.value || getSavedSettings().presetId);
      }
    });
  }

  function bindImageGenerationSaveMutexGuard() {
    if (window.__imageGenerationSaveMutexGuardBound) return;

    document.addEventListener(
      'click',
      function (event) {
        const saveBtn = event.target && event.target.closest && event.target.closest('#save-api-settings-btn');
        if (!saveBtn) return;

        if (!validateExclusiveImageGenerationSwitches()) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true
    );

    window.__imageGenerationSaveMutexGuardBound = true;
  }

  function patchShowScreenForOpenAICompatibleImageSettings() {
    if (typeof window.showScreen !== 'function' || window.__openAICompatImageShowScreenPatched) return;

    const originalShowScreen = window.showScreen;
    window.showScreen = function patchedShowScreen(screenId) {
      const result = originalShowScreen.apply(this, arguments);
      if (screenId === 'api-settings-screen') {
        setTimeout(loadOpenAICompatibleImageSettings, 0);
      }
      return result;
    };
    window.__openAICompatImageShowScreenPatched = true;
  }

  function initOpenAICompatibleImageSettings() {
    bindOpenAICompatibleImageSettingsEvents();
    bindImageGenerationSaveMutexGuard();
    loadOpenAICompatibleImageSettings();
    patchShowScreenForOpenAICompatibleImageSettings();
  }

  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(initOpenAICompatibleImageSettings, 0);
  });

  window.populateOpenAICompatibleImagePresetSelect = populateOpenAICompatibleImagePresetSelect;
  window.loadOpenAICompatibleImageSettings = loadOpenAICompatibleImageSettings;
  window.saveOpenAICompatibleImageSettings = saveOpenAICompatibleImageSettings;
  window.fetchOpenAICompatibleImageModels = fetchOpenAICompatibleImageModels;
  window.validateExclusiveImageGenerationSwitches = validateExclusiveImageGenerationSwitches;
  window.getOpenAICompatibleImageSize = getOpenAICompatibleImageSize;
  window.buildOpenAICompatibleImageGenerationUrl = buildOpenAICompatibleImageGenerationUrl;
  window.generateOpenAICompatibleImageFromPrompt = generateOpenAICompatibleImageFromPrompt;
})();
