// ============================================================
// system-settings-home.js
// 系统设置首页 - 赛博科技风卡片式导航
// ============================================================

(function() {
  'use strict';

  // 系统设置卡片配置
  const SYSTEM_SETTINGS_CARDS = [
    {
      id: 'ui-tools',
      title: '界面与工具',
      subtitle: '语言、调试、安全渲染与悬浮球',
      icon: 'monitor',
      highlighted: false
    },
    {
      id: 'main-api',
      title: '主 API 与模型',
      subtitle: '聊天模型、预设、地址与参数',
      icon: 'cpu',
      highlighted: true
    },
    {
      id: 'background-activity',
      title: '后台活动与主动消息',
      subtitle: '主动消息、后台活动、保活与通知',
      icon: 'activity',
      highlighted: false
    },
    {
      id: 'voice-call',
      title: '语音与通话',
      subtitle: '语音识别、语音消息与通话',
      icon: 'mic',
      highlighted: false
    },
    {
      id: 'image-vision',
      title: '图片与生图',
      subtitle: '识图、生图与图片服务',
      icon: 'image',
      highlighted: false
    },
    {
      id: 'couple-space',
      title: '情侣空间与内容',
      subtitle: '情侣空间与提示词',
      icon: 'heart',
      highlighted: false
    },
    {
      id: 'ai-behavior',
      title: 'AI 行为与性能',
      subtitle: '心声、提示词与渲染性能',
      icon: 'gauge',
      highlighted: false
    },
    {
      id: 'data-storage',
      title: '数据与存储',
      subtitle: '备份、云服务与本地数据',
      icon: 'database',
      highlighted: false
    },
    {
      // 2026-07-08 v0.0.78 新增：外卖点单（麦当劳 MCP + 瑞幸 MCP）
      // 卸载：删这一段 + 'mcp-takeout' 映射 + takeout 图标即 100% 回滚
      id: 'mcp-takeout',
      title: '外卖点单',
      subtitle: '麦当劳 / 瑞幸 AI 真下单',
      icon: 'takeout',
      highlighted: false
    }
  ];

  // SVG 图标库
  const ICONS = {
    monitor: '<path d="M20 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
    activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
    gauge: '<path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/><circle cx="12" cy="12" r="3"/><path d="M12 9l2 3"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
    // 2026-07-08 v0.0.78 新增：外卖点单图标（购物袋 + 杯 - 暗示食 / 饮）
    takeout: '<path d="M3 9h18l-2 11H5L3 9z" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 9V6a4 4 0 0 1 8 0v3" stroke-linecap="round"/>',
    arrowRight: '<polyline points="9 18 15 12 9 6"/>',
    arrowLeft: '<polyline points="15 18 9 12 15 6"/>'
  };

  /**
   * 渲染系统设置首页
   */
  function renderSystemSettingsHome() {
    const container = document.getElementById('system-settings-home-container');
    if (!container) {
      console.error('[SystemSettingsHome] 容器元素未找到');
      return;
    }

    // 构建 HTML
    let html = '';

    // 返回按钮
    html += `
      <div class="sys-settings-back-btn" onclick="showScreen('home-screen')">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
          ${ICONS.arrowLeft}
        </svg>
      </div>
    `;

    // 卡片容器
    html += '<div class="sys-settings-cards-container">';

    // 生成卡片
    SYSTEM_SETTINGS_CARDS.forEach(card => {
      const highlightedClass = card.highlighted ? ' highlighted' : '';
      html += `
        <div class="sys-settings-card${highlightedClass}" data-card-id="${card.id}">
          <div class="sys-settings-card-icon">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
              ${ICONS[card.icon] || ''}
            </svg>
          </div>
          <div class="sys-settings-card-content">
            <div class="sys-settings-card-title">${card.title}</div>
            <div class="sys-settings-card-subtitle">${card.subtitle}</div>
          </div>
          <div class="sys-settings-card-arrow">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
              ${ICONS.arrowRight}
            </svg>
          </div>
        </div>
      `;
    });

    html += '</div>';

    container.innerHTML = html;

    // 绑定卡片点击事件
    bindCardClickEvents();
  }

  /**
   * 绑定卡片点击事件
   */
  function bindCardClickEvents() {
    const cards = document.querySelectorAll('.sys-settings-card');
    cards.forEach(card => {
      card.addEventListener('click', function() {
        const cardId = this.getAttribute('data-card-id');
        handleCardClick(cardId);
      });
    });
  }

  /**
   * 处理卡片点击
   */
  function handleCardClick(cardId) {
    console.log('[SystemSettingsHome] Card clicked:', cardId);

    // 卡片 ID 与目标锚点映射
    // 日常使用框锚点：sec-bg-activity（后台活动）、sec-voice-msg（语音播报 TTS）、sec-image-gen（生图功能）
    // 旧 API 锚点 sec-bg-activity-api / sec-asr / sec-vision 保留不删
    const cardToSection = {
      'ui-tools': 'sec-language',
      'main-api': 'sec-api-preset',
      'background-activity': 'sec-bg-activity',
      'voice-call': 'sec-voice-msg',
      'image-vision': 'sec-image-gen',
      'couple-space': 'sec-couple-space',
      'ai-behavior': 'sec-ai-behavior',
      'data-storage': 'sec-cloud-storage',
      // 2026-07-08 v0.0.78 新增
      'mcp-takeout': 'sec-mcp-takeout'
    };

    // 获取目标锚点
    const targetSection = cardToSection[cardId];
    if (!targetSection) {
      console.warn('[SystemSettingsHome] Unknown card ID:', cardId);
      return;
    }

    // 先切换到 API 设置页面
    showScreen('api-settings-screen');

    // 等待页面渲染完成后滚动到目标位置
    setTimeout(() => {
      const targetElement = document.querySelector(`[data-section="${targetSection}"]`);
      if (targetElement) {
        targetElement.scrollIntoView({ block: 'start', behavior: 'smooth' });
        console.log('[SystemSettingsHome] Scrolled to section:', targetSection);
      } else {
        console.warn('[SystemSettingsHome] Target section not found:', targetSection);
      }
    }, 80);
  }

  // 暴露到全局
  window.renderSystemSettingsHome = renderSystemSettingsHome;

  console.log('[SystemSettingsHome] 模块加载完成');
})();
