// ============================================================
// proactive-wake-ui.js — AI 主动消息管理 UI
// v0.1.85 粉白色系
//
// 入口: chat-list 顶部 banner, 点开进管理页面
// 页面: 玩法说明 + 订阅状态 + 任务列表 + 创建表单
// ============================================================

(function() {
  'use strict';

  // ===== 粉白色系配色 =====
  const COLORS = {
    primary: '#FF8FA3',        // 主粉
    primaryDark: '#E56B82',    // hover 加深
    light: '#FFB6C1',          // 浅粉
    bgWarm: '#FDF6F8',         // 暖白
    bgWhite: '#FFFFFF',        // 白
    textDark: '#5C4A52',       // 暗紫文字
    textMid: '#8B7280',        // 中灰粉
    border: '#FFE4E9',         // 边框粉
    success: '#7BC89C',        // 绿色（已订阅）
    warning: '#F5A88B',        // 橙（提示）
    shadow: '0 2px 8px rgba(255, 143, 163, 0.15)'
  };

  // ===== 创建 banner 元素 (插入到 chat-list 顶部) =====
  function createBanner() {
    const banner = document.createElement('div');
    banner.id = 'proactive-wake-banner';
    banner.className = 'pw-banner';
    banner.innerHTML = `
      <div class="pw-banner-inner">
        <div class="pw-banner-icon">🌸</div>
        <div class="pw-banner-text">
          <div class="pw-banner-title">AI 主动消息</div>
          <div class="pw-banner-status">检测中...</div>
        </div>
        <div class="pw-banner-arrow">›</div>
      </div>
    `;
    banner.addEventListener('click', openManager);
    return banner;
  }

  // ===== 更新 banner 状态 =====
  async function updateBanner() {
    const banner = document.getElementById('proactive-wake-banner');
    if (!banner) return;

    const statusEl = banner.querySelector('.pw-banner-status');
    if (!window.ProactiveWake) {
      statusEl.textContent = '模块未加载';
      return;
    }

    try {
      const status = await window.ProactiveWake.getSubscriptionStatus();
      if (!status.supported) {
        statusEl.textContent = '❌ 浏览器不支持推送';
        banner.classList.add('pw-banner-disabled');
      } else if (Notification.permission === 'denied') {
        statusEl.textContent = '⚠️ 通知权限被拒（iOS 设置 → Safari → 网站通知）';
        banner.classList.add('pw-banner-warning');
      } else if (status.subscribed) {
        statusEl.textContent = '✅ 已启用';
        banner.classList.add('pw-banner-active');
      } else {
        statusEl.textContent = '未启用 · 点此开启';
        banner.classList.add('pw-banner-inactive');
      }
    } catch (e) {
      statusEl.textContent = `❌ 错误: ${e.message}`;
    }
  }

  // ===== 打开管理页面 =====
  function openManager() {
    // 如果已经打开, 不重复创建
    if (document.getElementById('pw-manager-page')) {
      return;
    }

    const page = document.createElement('div');
    page.id = 'pw-manager-page';
    page.className = 'pw-page';
    page.innerHTML = `
      <div class="pw-header">
        <button class="pw-back-btn" id="pw-back-btn">‹</button>
        <div class="pw-header-title">🌸 AI 主动消息</div>
        <div class="pw-header-spacer"></div>
      </div>

      <div class="pw-content">
        <!-- 玩法说明卡片 -->
        <div class="pw-card pw-card-tutorial">
          <div class="pw-card-title">📖 玩法说明</div>
          <div class="pw-card-body">
            <p><b>AI 主动消息</b>：让角色在你不聊天的时候，也能主动给你发消息。像是真人微信里，对方突然想起你、给你发一条问候。</p>
            <p><b>怎么用</b>（3 种方式）：</p>
            <ol>
              <li>点下面的 <b>"开启推送"</b> 按钮，授权通知权限</li>
              <li><b>手动创建</b>：创建定时任务（固定消息 自己写 / AI 生成 让 LLM 自动想话题）</li>
              <li><b>🤖 AI 自主决定（v0.1.86+）</b>：跟 AI 聊天时，AI 按人设自主决定要不要给你设个提醒/问候——你不用手动操作，AI 自己看着办</li>
              <li>选 <b>投递方式</b>：📱应用内（默认） / 🔔系统推送（杀后台 + 锁屏能收到）</li>
              <li>角色级 <b>[启用主动消息]</b> 开关：关掉某角色，两个渠道都不发（防刷屏）</li>
            </ol>
            <p><b>频率控制</b>：</p>
            <ul>
              <li><b>AI 设提醒冷却</b>（默认 30 分钟，可调 0-120）：同一角色聊完天后 X 分钟内 AI 不能重复设提醒，防刷屏</li>
              <li><b>睡眠时间</b>（23:00-08:00 硬约束）：AI 不会在这段时间推消息，只在 chat history 留个"想发但怕吵醒你"的小气泡</li>
            </ul>
            <p><b>⚠️ iPhone 重要提示</b>：</p>
            <ul>
              <li>必须先把 PWA <b>加到主屏幕</b></li>
              <li>iOS 设置 → <b>Safari</b> → 高级 → <b>网站通知</b> → 打开</li>
              <li>推送只在 <b>杀后台 + 锁屏</b> 时才真正触发（iOS 限制）</li>
            </ul>
            <p><b>频率建议</b>：每天 1-3 条，不要刷屏</p>
          </div>
        </div>

        <!-- 订阅状态卡片 -->
        <div class="pw-card">
          <div class="pw-card-title">🔔 推送状态</div>
          <div class="pw-card-body">
            <div class="pw-status-row">
              <span>通知权限：</span>
              <b id="pw-permission-status">检测中...</b>
            </div>
            <div class="pw-status-row">
              <span>订阅状态：</span>
              <b id="pw-subscription-status">检测中...</b>
            </div>
            <div class="pw-button-row">
              <button class="pw-btn pw-btn-primary" id="pw-subscribe-btn">🔔 开启推送</button>
              <button class="pw-btn pw-btn-secondary" id="pw-unsubscribe-btn" style="display:none;">关闭推送</button>
              <button class="pw-btn pw-btn-secondary" id="pw-test-push-btn">🧪 测试推送</button>
            </div>
          </div>
        </div>

        <!-- 冷却时间设置卡片 -->
        <div class="pw-card">
          <div class="pw-card-title">⏱ AI 设提醒冷却（防刷屏）</div>
          <div class="pw-card-body">
            <div class="pw-status-row" style="align-items:center;">
              <span>同一角色聊天结束后</span>
              <div class="pw-cooldown-input">
                <input type="number" id="pw-cooldown-input" min="0" max="120" step="1" value="30" style="width:60px;text-align:center;">
                <span>分钟内, AI 不能重复设主动消息提醒</span>
              </div>
            </div>
            <div class="settings-desc" style="font-size:12px;color:#8B7280;margin-top:6px;">
              0 = 不限流 (AI 可能刷屏). 默认 30 分钟. 改完即生效.
            </div>
          </div>
        </div>

        <!-- 投递方式选择 (v0.1.90+) -->
        <div class="pw-card">
          <div class="pw-card-title">📡 投递方式（用户自选）</div>
          <div class="pw-card-body">
            <div class="pw-radio-group">
              <label class="pw-radio-row">
                <input type="radio" name="pw-delivery-mode" value="app">
                <div class="pw-radio-content">
                  <div class="pw-radio-title">📱 应用内（默认）</div>
                  <div class="pw-radio-desc">只在 chat 里插入 AI 消息，<b>无系统通知</b>。<br>PWA 开着才能用，杀后台失效（不依赖 push-server）。</div>
                </div>
              </label>
              <label class="pw-radio-row">
                <input type="radio" name="pw-delivery-mode" value="push">
                <div class="pw-radio-content">
                  <div class="pw-radio-title">🔔 系统推送</div>
                  <div class="pw-radio-desc">弹系统通知，<b>杀后台 + 锁屏都能收到</b>。<br>需先在上面"通知 → 启用服务器推送"配好服务器地址。<br>PWA 活着也走 push-server（不需要等杀后台）。</div>
                </div>
              </label>
            </div>
            <div class="settings-desc" style="font-size:12px;color:#8B7280;margin-top:6px;">
              💡 这是<b>渠道选择</b>，只管"用什么发"；角色能不能主动发由角色设置里的 <b>[启用主动消息]</b> 开关控制。
            </div>
          </div>
        </div>

        <!-- 任务列表卡片 -->
        <div class="pw-card">
          <div class="pw-card-title">📋 已创建任务 <span id="pw-task-count" class="pw-task-count"></span></div>
          <div class="pw-card-body">
            <div id="pw-task-list" class="pw-task-list">
              <div class="pw-empty">加载中...</div>
            </div>
            <div class="pw-button-row">
              <button class="pw-btn pw-btn-primary" id="pw-create-task-btn">+ 创建新任务</button>
              <button class="pw-btn pw-btn-secondary" id="pw-refresh-tasks-btn">🔄 刷新</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 创建任务弹窗 -->
      <div id="pw-create-modal" class="pw-modal" style="display:none;">
        <div class="pw-modal-content">
          <div class="pw-modal-header">
            <div class="pw-modal-title">创建新任务</div>
            <button class="pw-modal-close" id="pw-modal-close">×</button>
          </div>
          <div class="pw-modal-body">
            <div class="pw-form-row">
              <label>选择角色</label>
              <select id="pw-form-chat"></select>
            </div>
            <div class="pw-form-row">
              <label>任务类型</label>
              <select id="pw-form-type">
                <option value="fixed">固定消息（自己写内容）</option>
                <option value="ai-decided">AI 自由发挥（LLM 决定话题）</option>
              </select>
            </div>
            <div class="pw-form-row" id="pw-form-message-row">
              <label>消息内容</label>
              <textarea id="pw-form-message" placeholder="例：晚上好呀，今天忙不忙？"></textarea>
            </div>
            <div class="pw-form-row" id="pw-form-prompt-row" style="display:none;">
              <label>给 AI 的提示词</label>
              <textarea id="pw-form-prompt" placeholder="例：想问问用户今天吃了什么好吃的"></textarea>
            </div>
            <div class="pw-form-row">
              <label>发送时间</label>
              <select id="pw-form-recurrence">
                <option value="none">只发一次（1 分钟后）</option>
                <option value="daily">每天一次</option>
                <option value="weekly">每周一次</option>
                <option value="ai-decided">AI 决定（最自然）</option>
              </select>
            </div>
          </div>
          <div class="pw-modal-footer">
            <button class="pw-btn pw-btn-secondary" id="pw-modal-cancel">取消</button>
            <button class="pw-btn pw-btn-primary" id="pw-modal-submit">创建</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(page);

    // 绑定事件
    document.getElementById('pw-back-btn').addEventListener('click', closeManager);
    document.getElementById('pw-subscribe-btn').addEventListener('click', handleSubscribe);
    document.getElementById('pw-unsubscribe-btn').addEventListener('click', handleUnsubscribe);
    document.getElementById('pw-test-push-btn').addEventListener('click', handleTestPush);
    document.getElementById('pw-create-task-btn').addEventListener('click', openCreateModal);
    document.getElementById('pw-refresh-tasks-btn').addEventListener('click', loadTaskList);
    document.getElementById('pw-modal-close').addEventListener('click', closeCreateModal);
    document.getElementById('pw-modal-cancel').addEventListener('click', closeCreateModal);
    document.getElementById('pw-modal-submit').addEventListener('click', handleCreateTask);
    document.getElementById('pw-form-type').addEventListener('change', (e) => {
      const type = e.target.value;
      document.getElementById('pw-form-message-row').style.display = type === 'fixed' ? '' : 'none';
      document.getElementById('pw-form-prompt-row').style.display = type === 'ai-decided' ? '' : 'none';
    });

    // 加载数据
    loadSubscriptionStatus();
    loadCooldownSetting();
    loadDeliveryMode();
    loadTaskList();
  }

  // ===== 关闭管理页面 =====
  function closeManager() {
    const page = document.getElementById('pw-manager-page');
    if (page) page.remove();
    updateBanner();  // 关闭后刷新 banner 状态
  }

  // ===== 加载订阅状态 =====
  async function loadSubscriptionStatus() {
    const permEl = document.getElementById('pw-permission-status');
    const subEl = document.getElementById('pw-subscription-status');
    const subBtn = document.getElementById('pw-subscribe-btn');
    const unsubBtn = document.getElementById('pw-unsubscribe-btn');

    try {
      const status = await window.ProactiveWake.getSubscriptionStatus();
      if (!status.supported) {
        permEl.textContent = '❌ 不支持';
        subEl.textContent = status.reason || '浏览器不支持';
        subBtn.style.display = 'none';
        return;
      }
      permEl.textContent = status.permission === 'granted' ? '✅ 已授权' :
                            status.permission === 'denied' ? '❌ 被拒' : '⚠️ 未授权';
      subEl.textContent = status.subscribed ? '✅ 已订阅' : '❌ 未订阅';

      if (status.subscribed) {
        subBtn.style.display = 'none';
        unsubBtn.style.display = '';
      } else {
        subBtn.style.display = '';
        unsubBtn.style.display = 'none';
      }
    } catch (e) {
      permEl.textContent = `错误: ${e.message}`;
    }
  }

  // ===== 加载冷却设置 =====
  function loadCooldownSetting() {
    const input = document.getElementById('pw-cooldown-input');
    if (!input) return;
    const current = window.state?.globalSettings?.proactiveCooldownMinutes;
    input.value = (typeof current === 'number' && current >= 0) ? current : 30;

    // 实时保存 (改完即生效, 不需要保存按钮)
    input.addEventListener('change', () => {
      let val = parseInt(input.value, 10);
      if (isNaN(val) || val < 0) val = 0;
      if (val > 120) val = 120;
      input.value = val;
      if (!window.state.globalSettings) window.state.globalSettings = {};
      window.state.globalSettings.proactiveCooldownMinutes = val;
      // 持久化到 localStorage
      try {
        localStorage.setItem('globalSettings', JSON.stringify(window.state.globalSettings));
      } catch (e) {
        console.warn('[proactive-wake-ui] 保存 globalSettings 失败:', e.message);
      }
      console.log('[proactive-wake-ui] 冷却时间已更新为', val, '分钟');
    });
  }

  // ===== 加载投递方式设置 (v0.1.91+) =====
  // 渠道选择: app = 应用内 (默认) / push = 系统推送
  // 注: 跟角色级总开关 (chat.settings.proactiveEnabled) 是两个独立维度
  function loadDeliveryMode() {
    const radios = document.querySelectorAll('input[name="pw-delivery-mode"]');
    if (radios.length === 0) return;
    let current = window.state?.globalSettings?.proactiveDeliveryMode || 'app';
    // 老数据兼容: 之前默认是 'app', 老的 'both' 自动降级到 'push' (用户主动选的) 或者 'app'
    if (current !== 'app' && current !== 'push') current = 'app';
    radios.forEach(radio => {
      if (radio.value === current) {
        radio.checked = true;
      } else {
        radio.checked = false;
      }
    });
    // 同步 chat 设置页的角色级开关 (如果已打开)
    syncOldProactiveSwitch(current);

    // 实时保存 (change 触发)
    radios.forEach(radio => {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        const mode = radio.value;
        if (mode !== 'app' && mode !== 'push') return;  // 非法值忽略
        if (!window.state.globalSettings) window.state.globalSettings = {};
        window.state.globalSettings.proactiveDeliveryMode = mode;
        // 持久化
        try {
          localStorage.setItem('globalSettings', JSON.stringify(window.state.globalSettings));
        } catch (e) {
          console.warn('[proactive-wake-ui] 保存投递方式失败:', e.message);
        }
        // 立即重启老功能 scheduler (mode 变了)
        try {
          if (typeof window.stopProactiveScheduler === 'function') window.stopProactiveScheduler();
          if (mode === 'app') {
            if (typeof window.startProactiveScheduler === 'function') {
              window.startProactiveScheduler();
              console.log(`[proactive-wake-ui] 投递模式 = 应用内, scheduler 已启动`);
            }
          } else {
            console.log(`[proactive-wake-ui] 投递模式 = 系统推送, scheduler 已停止 (推送任务改由 push-server 接管)`);
          }
        } catch (e) {
          console.warn('[proactive-wake-ui] 重启 scheduler 失败:', e.message);
        }
        // 同步 chat 设置页的角色级开关 + hint
        syncOldProactiveSwitch(mode);
        // 弹提示
        const tip = mode === 'app'
          ? '✅ 已切换到应用内 (只在 chat 插消息, 无系统通知, PWA 开着才能用)'
          : '✅ 已切换到系统推送 (杀后台 + 锁屏都能收到, 需先配服务器地址)';
        if (typeof showToast === 'function') showToast(tip);
        else alert(tip);
      });
    });
  }

  // ===== 同步 chat 设置页的角色级 "启用主动消息" 开关 (v0.1.91+) =====
  // 设计: 角色级开关 = 总开关 (能不能发), 全局 mode = 渠道选择 (用什么发), 两个独立维度
  // 因此角色级开关在 chat 设置页永远可用, 这里只显示"当前投递模式"的信息提示
  // ★ v0.1.92 修死循环: syncOldProactiveSwitch 改 oldHint.innerHTML → 触发 mutation → observer 再跑 → 死循环
  // 修法: 临时 disconnect observer, 改完 reconnect
  function syncOldProactiveSwitch(mode) {
    const oldHint = document.getElementById('char-proactive-mode-hint');
    if (!oldHint) return;  // chat 设置页没打开, 跳过 (下次开时会通过 MutationObserver 同步)

    // ★ 防死循环: 临时 disconnect observer
    const observer = window._pwChatSettingsObserver;
    if (observer) {
      observer.disconnect();
    }

    try {
      if (mode === 'push') {
        oldHint.innerHTML = '📡 <b>当前投递方式：系统推送</b>（杀后台/锁屏也能收到）<br>关掉 [启用主动消息] → 不会推送。要切换投递方式请去 [设置 → 通知 → 🌸 AI 主动消息]。';
        oldHint.style.display = '';
      } else if (mode === 'app') {
        oldHint.innerHTML = '📱 <b>当前投递方式：应用内</b>（PWA 开着时有效, 杀后台失效）<br>关掉 [启用主动消息] → 不会推送。要切换投递方式请去 [设置 → 通知 → 🌸 AI 主动消息]。';
        oldHint.style.display = '';
      } else {
        oldHint.style.display = 'none';
      }
    } finally {
      // 改完 reconnect observer
      if (observer) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    }
  }

  // ===== MutationObserver: chat 设置页打开时自动同步角色级开关 (v0.1.90+) =====
  // 因为 chat 设置页可能 user 没打开时 loadDeliveryMode 跑, 元素不存在
  // 等 chat 设置页打开时, 元素出现, 立刻按当前 mode 同步状态
  function setupChatSettingsSyncObserver() {
    if (typeof MutationObserver === 'undefined') return;
    if (window._pwChatSettingsObserver) return;  // 只挂一次
    const observer = new MutationObserver(() => {
      const oldSwitch = document.getElementById('char-proactive-enabled-switch');
      if (oldSwitch) {
        const mode = window.state?.globalSettings?.proactiveDeliveryMode || 'app';
        syncOldProactiveSwitch(mode);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window._pwChatSettingsObserver = observer;
    console.log('[proactive-wake-ui] ✅ chat 设置页同步观察器已挂载');
  }

  // ===== 处理订阅 =====
  async function handleSubscribe() {
    const btn = document.getElementById('pw-subscribe-btn');
    btn.disabled = true;
    btn.textContent = '处理中...';
    try {
      await window.ProactiveWake.subscribe();
      alert('✅ 推送已开启！现在可以创建定时任务了。');
      await loadSubscriptionStatus();
      await loadTaskList();
    } catch (e) {
      alert(`❌ 订阅失败：${e.message}\n\n如果是 iPhone，请先：\n1. iOS 设置 → Safari → 高级 → 网站通知 → 打开\n2. 把 PWA 加到主屏幕`);
    } finally {
      btn.disabled = false;
      btn.textContent = '🔔 开启推送';
    }
  }

  // ===== 处理取消订阅 =====
  async function handleUnsubscribe() {
    if (!confirm('确定要关闭推送吗？已创建的任务也会停止发送。')) return;
    try {
      await window.ProactiveWake.unsubscribe();
      await loadSubscriptionStatus();
    } catch (e) {
      alert(`❌ 关闭失败: ${e.message}`);
    }
  }

  // ===== 处理测试推送 =====
  async function handleTestPush() {
    const btn = document.getElementById('pw-test-push-btn');
    btn.disabled = true;
    btn.textContent = '发送中...';
    try {
      await window.ProactiveWake.sendTestPush();
      alert('✅ 测试推送已发送！请检查手机通知。');
    } catch (e) {
      alert(`❌ 测试推送失败: ${e.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '🧪 测试推送';
    }
  }

  // ===== 加载任务列表 =====
  async function loadTaskList() {
    const listEl = document.getElementById('pw-task-list');
    const countEl = document.getElementById('pw-task-count');
    if (!listEl) return;

    listEl.innerHTML = '<div class="pw-empty">加载中...</div>';

    try {
      const tasks = await window.ProactiveWake.listTasks();
      countEl.textContent = `(${tasks.length})`;

      if (tasks.length === 0) {
        listEl.innerHTML = '<div class="pw-empty">还没有任务，点下面"+ 创建新任务"试试</div>';
        return;
      }

      listEl.innerHTML = '';
      tasks.forEach(task => {
        const card = document.createElement('div');
        card.className = 'pw-task-item';
        const nextTime = task.next_send_at ? new Date(task.next_send_at).toLocaleString('zh-CN', { hour12: false }) : '已发送';
        const statusBadge = task.status === 'pending' ? '⏰ 待发送' :
                           task.status === 'sent' ? '✅ 已发送' :
                           task.status === 'failed' ? '❌ 失败' : task.status;
        const recurrenceLabel = {none: '只发一次', daily: '每天', weekly: '每周', 'ai-decided': 'AI 决定'}[task.recurrence_type] || task.recurrence_type;
        const messagePreview = task.user_message ? task.user_message.substring(0, 30) : (task.user_prompt ? `AI 提示: ${task.user_prompt.substring(0, 20)}` : '(无内容)');
        // 任务来源标签: user_message 有值 = 用户手动创建, 否则 = AI 自动创建
        const sourceBadge = task.user_message ? '<span class="pw-source-badge pw-source-user">👤 手动</span>' : '<span class="pw-source-badge pw-source-ai">🤖 AI</span>';

        card.innerHTML = `
          <div class="pw-task-item-header">
            <div class="pw-task-item-name">💬 ${escapeHtml(task.contact_name)}</div>
            <div class="pw-task-item-status pw-task-status-${task.status}">${statusBadge}</div>
          </div>
          <div class="pw-task-item-body">
            <div class="pw-task-item-preview">${escapeHtml(messagePreview)}</div>
            <div class="pw-task-item-meta">
              <span>⏰ ${nextTime}</span>
              <span>🔁 ${recurrenceLabel}</span>
              <span>📝 ${task.message_type}</span>
              ${sourceBadge}
            </div>
            ${task.failure_reason ? `<div class="pw-task-item-error">⚠️ ${escapeHtml(task.failure_reason)}</div>` : ''}
          </div>
          <button class="pw-task-delete-btn" data-task-id="${task.id}">删除</button>
        `;

        card.querySelector('.pw-task-delete-btn').addEventListener('click', () => handleDeleteTask(task.id));
        listEl.appendChild(card);
      });
    } catch (e) {
      listEl.innerHTML = `<div class="pw-empty pw-empty-error">❌ 加载失败: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ===== 处理删除任务 =====
  async function handleDeleteTask(taskId) {
    if (!confirm('确定要删除这个任务吗？')) return;
    try {
      await window.ProactiveWake.deleteTask(taskId);
      await loadTaskList();
    } catch (e) {
      alert(`❌ 删除失败: ${e.message}`);
    }
  }

  // ===== 打开创建任务弹窗 =====
  function openCreateModal() {
    // 填充角色选择
    const select = document.getElementById('pw-form-chat');
    select.innerHTML = '<option value="">-- 选择当前聊天角色 --</option>';
    const state = window.state;
    if (state?.chats) {
      Object.values(state.chats).forEach(chat => {
        const opt = document.createElement('option');
        opt.value = chat.id;
        opt.textContent = chat.name || '未命名角色';
        if (chat.id === state.activeChatId) opt.selected = true;
        select.appendChild(opt);
      });
    }

    document.getElementById('pw-create-modal').style.display = 'flex';
  }

  // ===== 关闭创建任务弹窗 =====
  function closeCreateModal() {
    document.getElementById('pw-create-modal').style.display = 'none';
  }

  // ===== 处理创建任务 =====
  async function handleCreateTask() {
    const chatId = document.getElementById('pw-form-chat').value;
    const type = document.getElementById('pw-form-type').value;
    const message = document.getElementById('pw-form-message').value.trim();
    const prompt = document.getElementById('pw-form-prompt').value.trim();
    const recurrence = document.getElementById('pw-form-recurrence').value;

    const submitBtn = document.getElementById('pw-modal-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = '创建中...';

    try {
      if (type === 'fixed') {
        if (!message) {
          alert('请输入消息内容');
          return;
        }
        await window.ProactiveWake.createFixedTask({
          userMessage: message,
          chatId: chatId || null,
          recurrenceType: recurrence
        });
      } else {
        // ai-decided 模式: 如果是 ai-decided recurrence, 用 createTask (调 LLM 决定时间)
        // 如果是 none/daily/weekly, 用 createFixedTask 但 userMessage=null (前端 LLM 生成内容)
        if (recurrence === 'ai-decided') {
          await window.ProactiveWake.createTask({
            userPrompt: prompt || '跟用户聊聊天',
            chatId: chatId || null,
            recurrenceType: 'ai-decided'
          });
        } else {
          // 循环 + AI 内容: 创建任务不带 userMessage, 让前端 LLM 生成
          await window.ProactiveWake.createFixedTask({
            userMessage: null,
            userPrompt: prompt || '跟用户聊聊天',
            chatId: chatId || null,
            recurrenceType: recurrence
          });
        }
      }
      closeCreateModal();
      await loadTaskList();
      alert('✅ 任务已创建！');
    } catch (e) {
      alert(`❌ 创建失败: ${e.message}`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '创建';
    }
  }

  // ===== HTML escape =====
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ===== 初始化 (不再自动插 banner, 等设置页按钮触发) =====
  function init() {
    console.log('[proactive-wake-ui] 模块加载, 等设置页按钮触发 openManager()');
  }

  // 提供 showBanner() 给想用的人 (默认不调)
  function showBanner() {
    const chatList = document.getElementById('chat-list') ||
                      document.querySelector('.chat-list') ||
                      document.querySelector('[id*="chat-list"]');
    if (!chatList) {
      console.warn('[proactive-wake-ui] 找不到 chat-list 容器, banner 显示失败');
      return false;
    }
    if (document.getElementById('proactive-wake-banner')) return true;
    const banner = createBanner();
    chatList.insertBefore(banner, chatList.firstChild);
    updateBanner();
    return true;
  }

  // 立即初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      init();
      setupChatSettingsSyncObserver();
    });
  } else {
    init();
    setupChatSettingsSyncObserver();
  }

  // 暴露 API
  window.ProactiveWakeUI = {
    openManager,
    closeManager,
    updateBanner
  };
})();
