// _reports/diag-online-app-skyblue.js
// 用法：在浏览器打开 index.html → 进联机（连接）APP → 打开 DevTools Console → 粘贴本脚本整段运行
// 用途：核对 online-app-skyblue.css 是否生效（背景色 / 卡片 / 按钮 / 输入框 / z-index 安全）

(() => {
  'use strict';

  const out = (label, val) => console.log(`[diag] ${label}:`, val);

  // === 0. CSS 是否加载到 ===
  const cssLoaded = [...document.styleSheets].some(s => {
    try { return (s.href || '').includes('online-app-skyblue.css'); } catch (e) { return false; }
  });
  out('online-app-skyblue.css 已加载', cssLoaded);

  // === 1. 三个 view 整体底色 ===
  const screen = document.getElementById('online-app-screen');
  if (screen) {
    const cs = getComputedStyle(screen);
    out('online-app-screen backgroundColor', cs.backgroundColor);
    out('online-app-screen color', cs.color);
  } else {
    out('online-app-screen', '❌ 找不到');
  }

  // === 2. list-view 状态栏 + 列表项 ===
  const statusBar = document.getElementById('online-app-status-bar');
  if (statusBar) {
    out('status-bar background', getComputedStyle(statusBar).backgroundColor);
    out('status-bar color', getComputedStyle(statusBar).color);
  }
  const listItem = document.querySelector('#online-app-chat-list .online-chat-list-item');
  if (listItem) {
    const cs = getComputedStyle(listItem);
    out('chat-list-item background', cs.backgroundColor);
    out('chat-list-item color', cs.color);
    out('chat-list-item zIndex（⚠️ 必须是 auto，不能动）', cs.zIndex);
    out('chat-list-item position（⚠️ 必须是 static）', cs.position);
    out('chat-list-item transform（⚠️ 必须是 none）', cs.transform);
  } else {
    out('chat-list-item', '⚠️ 当前没渲染（正常 — 还没好友）');
  }

  // === 3. chat-view 输入区 ===
  const input = document.getElementById('online-app-chat-input');
  if (input) {
    out('chat-input background', getComputedStyle(input).backgroundColor);
    out('chat-input borderColor', getComputedStyle(input).borderColor);
  }

  // === 4. settings-view 卡片 ===
  const section = document.querySelector('#online-app-settings-view .settings-section');
  if (section) {
    const cs = getComputedStyle(section);
    out('settings-section background', cs.backgroundColor);
    out('settings-section borderColor', cs.borderColor);
    out('settings-section borderRadius', cs.borderRadius);
  }

  // === 4.1 settings-view 文本输入框 ===
  const sidInput = document.getElementById('online-app-my-id');
  if (sidInput) {
    const cs = getComputedStyle(sidInput);
    out('my-id input background', cs.backgroundColor);
    out('my-id input borderColor', cs.borderColor);
  }

  // === 4.2 settings-view 头像预览 ===
  const avatar = document.getElementById('online-app-avatar-preview');
  if (avatar) {
    const cs = getComputedStyle(avatar);
    out('avatar borderColor', cs.borderColor);
    out('avatar backgroundColor', cs.backgroundColor);
  }

  // === 4.3 settings-view 主操作按钮 ===
  const fullBtn = document.querySelector('#online-app-settings-view .settings-full-btn');
  if (fullBtn) {
    const cs = getComputedStyle(fullBtn);
    out('settings-full-btn background', cs.backgroundColor);
    out('settings-full-btn color', cs.color);
    out('settings-full-btn borderRadius', cs.borderRadius);
  }

  // === 4.4 教程区域（帮助与教程块）===
  const helpBlock = document.querySelector('#online-app-settings-view div[style*="background: #f8f9fa"]');
  if (helpBlock) {
    out('教程块 background（应为 #DCEAF5）', getComputedStyle(helpBlock).backgroundColor);
  }

  // === 5. 五个 modal 的 modal-content 背景（任挑一个，visible 的）===
  // modal 默认 .visible 才显示。我们模拟点击设置→找几个能点开的：
  // 用 getComputedStyle 即使 hidden 也能读 background（display:none 也能读 styleSheet 来的样式继承关系）
  const modalIds = ['online-friends-modal','friend-requests-modal','search-friend-modal','create-group-modal','group-info-modal'];
  modalIds.forEach(id => {
    const m = document.getElementById(id);
    if (!m) { out(id, '❌ 找不到 DOM'); return; }
    const content = m.querySelector('.modal-content');
    if (!content) { out(id+'.modal-content', '❌ 找不到'); return; }
    const cs = getComputedStyle(content);
    out(`${id} .modal-content background`, cs.backgroundColor);
    out(`${id} .modal-content borderColor`, cs.borderColor);
    out(`${id} .modal-content borderRadius`, cs.borderRadius);
  });

  // === 6. 任意一个 modal 的 header ===
  const anyModalHeader = document.querySelector('#online-friends-modal .modal-header');
  if (anyModalHeader) {
    const cs = getComputedStyle(anyModalHeader);
    out('modal-header background', cs.backgroundColor);
    out('modal-header border-bottom', cs.borderBottomColor);
  }

  // === 7. 浮动球 / 浮动球菜单 的 z-index 仍是高位 ===
  // 确保我们没把 chat-list-item 顶到浮动球上面
  const ball = document.getElementById('floating-ball');
  if (ball) {
    out('floating-ball zIndex', getComputedStyle(ball).zIndex);
  }
  const ballMenu = document.getElementById('floating-ball-menu');
  if (ballMenu) {
    out('floating-ball-menu zIndex', getComputedStyle(ballMenu).zIndex);
  }

  // === 8. 验收建议：手动检查清单 ===
  console.log('\n========== 手动验收清单 ==========');
  console.log('1) 进"联机"→ 顶部 status bar 是浅蓝卡（#DCEAF5）');
  console.log('2) 进"联机设置"→ 整体深蓝底、设置卡片浅蓝、输入框凹陷');
  console.log('3) 顶部 header 是深蓝 + 青色返回箭头 + 青色 ⚙/+');
  console.log('4) 联机设置页打开时"启用真人联机"开关能切、按钮不卡');
  console.log('5) 悬浮球和悬浮球菜单不会被联机聊天列表项遮挡（hover 仍能用）');
  console.log('6) 进 chat-view：发条消息，气泡是蓝色 / 浅蓝卡（不死白）');
  console.log('7) 打开"创建群聊"modal：背景浅蓝卡、输入框凹陷、关闭按钮青色');
  console.log('8) 打开"群信息"modal：所有按钮是 #5DADE2 蓝调，红色"移除"按钮保持警示感');
})();
