// ============================================================
// Gemini 主 API Key 自动轮询 (第一阶段: 配置 + 状态基础)
// ------------------------------------------------------------
// 本阶段只搭架子，不接入任何实际 Gemini 请求。
//   1. 池配置读写 (localStorage.geminiMainKeyPool, 永不含 Key)
//   2. 预设过滤 (只接受 Gemini 预设, 同 URL)
//   3. 轮询 acquire() 基础实现 (A→B→C, 跳过 cooldown)
//   4. 状态回报 reportStatus() (200/429/503/401/403)
//   5. UI 渲染 + 事件绑定
//
// 第二阶段才让 main slot 的 Gemini 请求真正调用 acquire()。
// 本阶段不修改 getRandomValue / toGeminiRequestData / 任何 fetch。
// ============================================================

(function () {
  'use strict';

  // 严格禁止: 任何日志/错误/状态展示都不得打印完整 API Key
  const STORAGE_KEY = 'geminiMainKeyPool';

  const DEFAULT_CONFIG = Object.freeze({
    enabled: false,
    presetIds: [],
    model: '',
    proxyUrl: '',
    currentIndex: 0,
    keyStates: {}
  });

  function getDb() {
    return window.db;
  }

  // 掩码: 6 头 + ... + 4 尾 (12 字符以上时)
  // 短 Key 也只显示头尾, 永不显示完整
  function maskKey(key) {
    if (!key || typeof key !== 'string') return '';
    if (key.length <= 10) {
      return key.slice(0, 1) + '****' + key.slice(-2);
    }
    return key.slice(0, 6) + '...' + key.slice(-4);
  }

  // ---------------------- 配置读写 ----------------------

  function loadConfig() {
    let cfg;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) cfg = JSON.parse(raw);
    } catch (e) {
      // 解析失败, 用默认
      cfg = null;
    }
    if (!cfg || typeof cfg !== 'object') cfg = {};

    // 浅合并默认值, 丢弃未知字段
    const safe = {
      enabled: cfg.enabled === true,
      presetIds: Array.isArray(cfg.presetIds) ? cfg.presetIds.filter(id => Number.isInteger(id)) : [],
      model: typeof cfg.model === 'string' ? cfg.model : '',
      proxyUrl: typeof cfg.proxyUrl === 'string' ? cfg.proxyUrl : '',
      currentIndex: Number.isInteger(cfg.currentIndex) && cfg.currentIndex >= 0 ? cfg.currentIndex : 0,
      keyStates: (cfg.keyStates && typeof cfg.keyStates === 'object') ? cfg.keyStates : {}
    };
    return safe;
  }

  function saveConfig(config) {
    // 二次保险: 只存白名单字段, 任何带 apiKey 字段的对象直接被剥离
    const safe = {
      enabled: !!config.enabled,
      presetIds: Array.isArray(config.presetIds)
        ? config.presetIds.filter(id => Number.isInteger(id))
        : [],
      model: typeof config.model === 'string' ? config.model : '',
      proxyUrl: typeof config.proxyUrl === 'string' ? config.proxyUrl : '',
      currentIndex: Number.isInteger(config.currentIndex) && config.currentIndex >= 0
        ? config.currentIndex
        : 0,
      keyStates: (config.keyStates && typeof config.keyStates === 'object' && !Array.isArray(config.keyStates))
        ? config.keyStates
        : {}
    };
    // 绝不含 apiKey / proxyKey 等敏感字段 — 直接 JSON.stringify 也不会带
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  }

  function getConfig() {
    return loadConfig();
  }

  // ---------------------- 状态计算 ----------------------

  // 状态: 'available' | 'cooldown' | 'invalid'
  // cooldownUntil: 绝对时间戳 (ms), 0 表示无冷却
  function isKeyAvailable(state, now) {
    if (!state) return true;
    if (state.status === 'invalid' || state.status === 'disabled') return false;
    if (state.cooldownUntil && state.cooldownUntil > now) return false;
    return true;
  }

  function findNextAvailableIndex(presetIds, startIndex, keyStates, now) {
    if (!presetIds.length) return -1;
    for (let i = 0; i < presetIds.length; i++) {
      const idx = (startIndex + i) % presetIds.length;
      if (isKeyAvailable(keyStates[presetIds[idx]], now)) {
        return idx;
      }
    }
    return -1;
  }

  function parseRetryDelay(s) {
    if (!s) return 0;
    const m = String(s).match(/^(\d+(?:\.\d+)?)(s|m|h)$/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    if (m[2] === 's') return n;
    if (m[2] === 'm') return n * 60;
    if (m[2] === 'h') return n * 3600;
    return 0;
  }

  // ---------------------- acquire (本阶段不接入请求, 仅实现) ----------------------

  // 过滤已删除/URL 不一致的预设, 并自动维护 cfg.presetIds
  // 内部用, 不直接暴露
  async function filterValidPresetIds(cfg) {
    const db = getDb();
    if (!db) return [];
    const valid = [];
    for (const id of cfg.presetIds) {
      const preset = await db.apiPresets.get(id);
      if (!preset) continue;
      if (!(preset.proxyUrl || '').trim() || !(preset.apiKey || '').trim()) continue;
      if (cfg.proxyUrl && (preset.proxyUrl || '').trim() !== cfg.proxyUrl.trim()) continue;
      valid.push(id);
    }
    return valid;
  }

  // 返回: { presetId, apiKey, proxyUrl, model } | null
  // 注意: apiKey 是程序内部返回值, 调用方负责不打印
  async function acquire() {
    const cfg = loadConfig();
    if (!cfg.enabled) return null;
    if (!cfg.presetIds.length) return null;

    const validIds = await filterValidPresetIds(cfg);
    if (!validIds.length) {
      // 池空了, 自动关闭
      cfg.enabled = false;
      cfg.presetIds = [];
      cfg.currentIndex = 0;
      saveConfig(cfg);
      return null;
    }

    // 同步清掉已删除的 ID
    if (validIds.length !== cfg.presetIds.length) {
      cfg.presetIds = validIds;
    }

    const now = Date.now();
    const idx = findNextAvailableIndex(validIds, cfg.currentIndex, cfg.keyStates, now);
    if (idx < 0) return null;

    const presetId = validIds[idx];
    const db = getDb();
    const preset = await db.apiPresets.get(presetId);
    if (!preset || !(preset.apiKey || '').trim()) return null;

    // 推进游标到下一个
    cfg.currentIndex = (idx + 1) % validIds.length;
    saveConfig(cfg);

    return {
      presetId: presetId,
      apiKey: preset.apiKey,
      proxyUrl: preset.proxyUrl,
      model: cfg.model || preset.model || ''
    };
  }

  // 暴露给第二阶段用: 获取当前所有勾选的、真实存在的预设 ID
  // 用途: UI 提示 / 调试 / 第二阶段初始化校验
  async function getAvailablePresetIds() {
    const cfg = loadConfig();
    return await filterValidPresetIds(cfg);
  }

  // ---------------------- reportStatus ----------------------

  function reportStatus(presetId, statusCode, errorBody) {
    if (!Number.isInteger(presetId)) return;
    const cfg = loadConfig();
    if (!cfg.presetIds.includes(presetId)) return;

    const now = Date.now();
    const state = (cfg.keyStates && cfg.keyStates[presetId]) || { status: 'available', cooldownUntil: 0 };

    if (statusCode >= 200 && statusCode < 300) {
      state.status = 'available';
      state.cooldownUntil = 0;
    } else if (statusCode === 429) {
      state.status = 'cooldown';
      // 默认 60s, 用 Retry-After / RetryInfo 覆盖
      let cooldownSec = 60;
      if (errorBody && typeof errorBody === 'object') {
        if (Array.isArray(errorBody.details)) {
          const retry = errorBody.details.find(d => typeof d === 'object' && d['@type'] && d['@type'].includes('RetryInfo'));
          if (retry && retry.retryDelay) {
            const sec = parseRetryDelay(retry.retryDelay);
            if (sec > 0) cooldownSec = sec;
          }
        }
        if (errorBody.status === 'RESOURCE_EXHAUSTED') {
          // 区分 RPD/RPM/TPM 第二阶段再做
        }
      }
      state.cooldownUntil = now + cooldownSec * 1000;
    } else if (statusCode === 503) {
      state.status = 'cooldown';
      state.cooldownUntil = now + 30 * 1000;
    } else if (statusCode === 401 || statusCode === 403) {
      state.status = 'invalid';
      state.cooldownUntil = 0;
    } else {
      // 未知错误: 不改变状态, 避免误杀
    }

    cfg.keyStates = cfg.keyStates || {};
    cfg.keyStates[presetId] = state;
    saveConfig(cfg);
  }

  function resetStatus(presetId) {
    const cfg = loadConfig();
    if (Number.isInteger(presetId)) {
      if (cfg.keyStates) delete cfg.keyStates[presetId];
    } else {
      cfg.keyStates = {};
      cfg.currentIndex = 0;
    }
    saveConfig(cfg);
  }

  // ---------------------- UI 渲染 ----------------------

  function statusBadge(state) {
    const now = Date.now();
    if (state && (state.status === 'invalid' || state.status === 'disabled')) {
      return { icon: '⚠️', text: 'Key 无效', color: '#d32f2f' };
    }
    if (state && state.status === 'cooldown' && state.cooldownUntil && state.cooldownUntil > now) {
      const sec = Math.ceil((state.cooldownUntil - now) / 1000);
      return { icon: '🟡', text: '冷却中 (剩 ' + sec + 's)', color: '#f57c00' };
    }
    return { icon: '🟢', text: '可用', color: '#34c759' };
  }

  function isGeminiPreset(preset) {
    if (!preset || !preset.proxyUrl) return false;
    return preset.proxyUrl.indexOf('generativelanguage.googleapis.com') >= 0
        || preset.proxyUrl.indexOf('googleapis.com') >= 0;
  }

  async function renderPoolSummary() {
    const summaryEl = document.getElementById('gemini-pool-current-summary');
    if (!summaryEl) return;

    const cfg = loadConfig();
    const db = getDb();
    if (!db) {
      summaryEl.textContent = '数据库未就绪';
      return;
    }

    const selectedIds = (cfg.presetIds || []).filter(Number.isInteger);
    if (!selectedIds.length) {
      summaryEl.textContent = '当前未选择任何预设';
      summaryEl.style.color = '#888';
      return;
    }

    const presets = await db.apiPresets.bulkGet(selectedIds);
    const valid = presets.filter(Boolean);
    const urls = new Set(valid.map(p => (p.proxyUrl || '').trim()).filter(Boolean));

    let text = '当前已选 ' + valid.length + ' 个预设';
    if (urls.size === 1) {
      text += ' · 共用 URL: ' + Array.from(urls)[0];
    } else if (urls.size > 1) {
      text += ' · ⚠️ 检测到 ' + urls.size + ' 个不同 URL, 请检查';
    }

    summaryEl.textContent = text;
    summaryEl.style.color = urls.size > 1 ? '#d32f2f' : '#666';
  }

  // ---------------------- 弹窗 ----------------------

  async function openPoolSelectorModal() {
    const overlay = document.getElementById('gemini-pool-modal-overlay');
    if (!overlay) return;

    const db = getDb();
    const body = document.getElementById('gemini-pool-modal-body');
    const urlInfo = document.getElementById('gemini-pool-modal-url-info');
    const warnEl = document.getElementById('gemini-pool-modal-warn');
    if (!body || !urlInfo || !warnEl) return;

    if (!db) {
      urlInfo.textContent = '数据库未就绪';
      body.textContent = '';
      overlay.style.display = 'flex';
      return;
    }

    const allPresets = await db.apiPresets.toArray();
    const geminiPresets = allPresets.filter(isGeminiPreset);

    if (!geminiPresets.length) {
      urlInfo.textContent = '当前没有 Gemini 预设。请先在「API 预设管理」中创建 Gemini 预设。';
      body.textContent = '';
      overlay.style.display = 'flex';
      return;
    }

    const cfg = loadConfig();
    const selectedSet = new Set((cfg.presetIds || []).map(Number));

    urlInfo.textContent = '共 ' + geminiPresets.length + ' 个 Gemini 预设可选。已选 ' + selectedSet.size + ' 个。';
    body.textContent = '';

    for (const preset of geminiPresets) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = 'gp-modal-preset-' + preset.id;
      cb.value = String(preset.id);
      cb.dataset.proxyUrl = preset.proxyUrl || '';
      cb.checked = selectedSet.has(preset.id);
      cb.style.cssText = 'width:18px;height:18px;accent-color:#007aff;flex-shrink:0;margin-top:6px;cursor:pointer;';
      cb.addEventListener('change', () => onModalCheckboxChange());

      const labelWrap = document.createElement('label');
      labelWrap.htmlFor = cb.id;
      labelWrap.style.cssText = 'display:flex; flex-direction:column; gap:2px; cursor:pointer; flex:1; min-width:0;';

      const nameRow = document.createElement('div');
      nameRow.style.cssText = 'display:flex; align-items:center; gap:8px; flex-wrap:wrap;';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = preset.name;
      nameSpan.style.cssText = 'font-weight:500; color:#222;';
      nameRow.appendChild(nameSpan);

      const state = (cfg.keyStates && cfg.keyStates[preset.id]) || null;
      const badge = statusBadge(state);
      const statusSpan = document.createElement('span');
      statusSpan.textContent = badge.icon + ' ' + badge.text;
      statusSpan.style.cssText = 'font-size:12px; color:' + badge.color + ';';
      nameRow.appendChild(statusSpan);

      labelWrap.appendChild(nameRow);

      const keyRow = document.createElement('div');
      keyRow.style.cssText = 'font-size:11px; color:#888; font-family:monospace;';
      keyRow.textContent = 'Key: ' + maskKey(preset.apiKey);
      labelWrap.appendChild(keyRow);

      const urlRow = document.createElement('div');
      urlRow.style.cssText = 'font-size:10px; color:#aaa; word-break:break-all;';
      urlRow.textContent = (preset.proxyUrl || '').trim();
      labelWrap.appendChild(urlRow);

      const item = document.createElement('div');
      item.style.cssText = 'display:flex; align-items:flex-start; gap:10px; padding:8px; border:1px solid #eee; border-radius:6px; margin-bottom:6px; background:#fafafa;';
      item.appendChild(cb);
      item.appendChild(labelWrap);

      body.appendChild(item);
    }

    overlay.style.display = 'flex';
    updateModalWarn();
  }

  function closePoolSelectorModal() {
    const overlay = document.getElementById('gemini-pool-modal-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  function onModalCheckboxChange() {
    updateModalWarn();
  }

  function updateModalWarn() {
    const body = document.getElementById('gemini-pool-modal-body');
    const warnEl = document.getElementById('gemini-pool-modal-warn');
    const confirmBtn = document.getElementById('gemini-pool-modal-confirm');
    if (!body || !warnEl) return;

    const checked = body.querySelectorAll('input[type="checkbox"]:checked');
    const urls = new Set();
    for (const cb of checked) {
      if (cb.dataset.proxyUrl) urls.add(cb.dataset.proxyUrl.trim());
    }

    if (urls.size > 1) {
      warnEl.textContent = '⚠️ 检测到所选预设包含 ' + urls.size + ' 个不同 API 地址, 确定按钮已禁用';
      warnEl.style.color = '#d32f2f';
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.style.opacity = '0.5';
        confirmBtn.style.cursor = 'not-allowed';
      }
    } else {
      warnEl.textContent = '';
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.style.opacity = '';
        confirmBtn.style.cursor = '';
      }
    }
  }

  function getModalSelectedIds() {
    const body = document.getElementById('gemini-pool-modal-body');
    if (!body) return [];
    const checked = body.querySelectorAll('input[type="checkbox"]:checked');
    return Array.from(checked).map(cb => parseInt(cb.value, 10)).filter(Number.isInteger);
  }

  function getModalSelectedUrls() {
    const body = document.getElementById('gemini-pool-modal-body');
    if (!body) return [];
    const checked = body.querySelectorAll('input[type="checkbox"]:checked');
    const urls = new Set();
    for (const cb of checked) {
      if (cb.dataset.proxyUrl) urls.add(cb.dataset.proxyUrl.trim());
    }
    return Array.from(urls);
  }

  async function confirmModalSelection() {
    const selected = getModalSelectedIds();
    const urls = getModalSelectedUrls();

    if (urls.length > 1) {
      showMsg('所选预设包含不同的 API 地址，无法加入同一个轮询池。', 'error');
      return false;
    }

    const cfg = loadConfig();
    const enabledEl = document.getElementById('gemini-pool-enabled');
    const modelEl = document.getElementById('gemini-pool-model');

    // 软提示: 启用但 <2 个预设
    if (enabledEl && enabledEl.checked && selected.length < 2) {
      showMsg('轮询至少建议选择 2 个 Gemini 预设。已保存，但暂不生效。', 'info');
    } else {
      showMsg('预设已更新', 'success');
    }

    const newCfg = {
      enabled: cfg.enabled,
      presetIds: selected,
      model: (modelEl && modelEl.value.trim()) || cfg.model || '',
      proxyUrl: urls.length === 1 ? urls[0] : '',
      currentIndex: 0,
      keyStates: cfg.keyStates || {}
    };
    saveConfig(newCfg);
    closePoolSelectorModal();
    await renderPoolSummary();
    return true;
  }

  function saveCurrentConfig() {
    const cfg = loadConfig();
    const enabledEl = document.getElementById('gemini-pool-enabled');
    const modelEl = document.getElementById('gemini-pool-model');

    if (enabledEl && enabledEl.checked && cfg.presetIds.length < 2) {
      showMsg('轮询至少建议选择 2 个 Gemini 预设。已保存，但暂不生效。', 'info');
    } else {
      showMsg('轮询设置已保存', 'success');
    }

    const newCfg = {
      enabled: !!(enabledEl && enabledEl.checked),
      presetIds: cfg.presetIds,
      model: (modelEl && modelEl.value.trim()) || cfg.model || '',
      proxyUrl: cfg.proxyUrl,
      currentIndex: cfg.currentIndex || 0,
      keyStates: cfg.keyStates || {}
    };
    saveConfig(newCfg);
  }

  function showMsg(msg, type) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg, type || 'info');
    } else {
      console.log('[GeminiKeyPool]', msg);
    }
  }

  // ---------------------- 拉取 Gemini 模型列表 ----------------------

  async function fetchGeminiModels() {
    const cfg = loadConfig();
    if (!cfg.presetIds.length) {
      showMsg('请先选择至少一个 Gemini 预设', 'info');
      return;
    }
    const db = getDb();
    const preset = await db.apiPresets.get(cfg.presetIds[0]);
    if (!preset) {
      showMsg('找不到选中的预设', 'error');
      return;
    }
    if (!preset.proxyUrl || !preset.apiKey) {
      showMsg('预设缺少 API 地址或 Key', 'error');
      return;
    }

    const statusEl = document.getElementById('gemini-pool-model-fetch-status');
    const selectEl = document.getElementById('gemini-pool-model-select');
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.style.color = '#888';
      statusEl.textContent = '正在拉取模型...';
    }

    try {
      const base = preset.proxyUrl.replace(/\/+$/, '');
      // 走原生 Gemini 端点 (与项目其它位置一致)
      const fetchUrl = base.indexOf('/v1beta/models') >= 0
        ? base
        : base + '/v1beta/models';

      const resp = await fetch(fetchUrl, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-cache',
        credentials: 'omit',
        headers: { 'x-goog-api-key': preset.apiKey }
      });

      if (!resp.ok) {
        if (statusEl) {
          statusEl.style.color = '#d32f2f';
          statusEl.textContent = '拉取失败 HTTP ' + resp.status + '（仍可手动输入模型）';
        }
        return;
      }

      const data = await resp.json();
      // Gemini 原生: { models: [{ name: "models/xxx", ... }] }
      // OpenAI 兼容 (v1beta/openai): { data: [{ id: "xxx" }] }
      let models = [];
      if (Array.isArray(data.models)) {
        models = data.models.map(m => (m && m.name) ? String(m.name).replace(/^models\//, '') : null).filter(Boolean);
      } else if (Array.isArray(data.data)) {
        models = data.data.map(m => (m && m.id) ? String(m.id) : null).filter(Boolean);
      }

      if (selectEl) {
        selectEl.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = models.length ? '请选择模型' : '未拉到模型, 请手动输入';
        selectEl.appendChild(placeholder);
        for (const m of models) {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          selectEl.appendChild(opt);
        }
      }
      if (statusEl) {
        statusEl.style.color = models.length ? '#34c759' : '#f57c00';
        statusEl.textContent = models.length
          ? ('已拉取 ' + models.length + ' 个模型')
          : '该地址未返回模型列表, 请手动输入';
      }
    } catch (err) {
      // err 不含 Key, 但仍然不打印整个 err 对象
      if (statusEl) {
        statusEl.style.color = '#d32f2f';
        statusEl.textContent = '拉取失败: ' + (err && err.message ? err.message : '网络错误');
      }
    }
  }

  // ---------------------- 事件绑定 ----------------------

  function bindUI() {
    const enabledEl = document.getElementById('gemini-pool-enabled');
    if (enabledEl) {
      enabledEl.addEventListener('change', () => {
        // 仅 UI 切换, 保存需点保存按钮
      });
    }

    const modelSelectEl = document.getElementById('gemini-pool-model-select');
    const modelInputEl = document.getElementById('gemini-pool-model');
    if (modelSelectEl && modelInputEl) {
      modelSelectEl.addEventListener('change', () => {
        if (modelSelectEl.value) modelInputEl.value = modelSelectEl.value;
      });
    }

    const fetchBtn = document.getElementById('gemini-pool-fetch-models-btn');
    if (fetchBtn) {
      fetchBtn.addEventListener('click', () => {
        fetchGeminiModels();
      });
    }

    const saveBtn = document.getElementById('gemini-pool-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        saveCurrentConfig();
      });
    }

    const resetBtn = document.getElementById('gemini-pool-reset-status-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        resetStatus();
        showMsg('已重置轮询状态', 'success');
        renderPoolSummary();
      });
    }

    // 选择预设按钮 -> 打开弹窗
    const selectBtn = document.getElementById('gemini-pool-select-btn');
    if (selectBtn) {
      selectBtn.addEventListener('click', () => {
        openPoolSelectorModal();
      });
    }

    // 弹窗关闭/取消/确认
    const modalOverlay = document.getElementById('gemini-pool-modal-overlay');
    const modalClose = document.getElementById('gemini-pool-modal-close');
    const modalCancel = document.getElementById('gemini-pool-modal-cancel');
    const modalConfirm = document.getElementById('gemini-pool-modal-confirm');

    if (modalClose) modalClose.addEventListener('click', closePoolSelectorModal);
    if (modalCancel) modalCancel.addEventListener('click', closePoolSelectorModal);
    if (modalConfirm) modalConfirm.addEventListener('click', () => { confirmModalSelection(); });
    if (modalOverlay) {
      modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closePoolSelectorModal();
      });
    }
  }

  async function refreshUI() {
    const cfg = loadConfig();
    const enabledEl = document.getElementById('gemini-pool-enabled');
    if (enabledEl) enabledEl.checked = !!cfg.enabled;
    const modelEl = document.getElementById('gemini-pool-model');
    if (modelEl) modelEl.value = cfg.model || '';
    await renderPoolSummary();
  }

  // 监听 api-settings-screen 显示时刷新
  function observeScreen() {
    const target = document.getElementById('api-settings-screen');
    if (!target || !window.MutationObserver) return;
    const obs = new MutationObserver(() => {
      if (target.classList.contains('active')) {
        refreshUI();
      }
    });
    obs.observe(target, { attributes: true, attributeFilter: ['class'] });
  }

  // ---------------------- 暴露 API ----------------------

  window.GeminiMainKeyPool = {
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    getConfig: getConfig,
    getAvailablePresetIds: getAvailablePresetIds,
    acquire: acquire,
    reportStatus: reportStatus,
    resetStatus: resetStatus,
    maskKey: maskKey,
    refreshUI: refreshUI
  };

  // DOMContentLoaded: 绑定 + 首次渲染
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      bindUI();
      observeScreen();
      refreshUI();
    });
  } else {
    bindUI();
    observeScreen();
    refreshUI();
  }

})();
