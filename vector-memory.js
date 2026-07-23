// ========================================
// 变量记忆系统 (Variable Memory System)
// 原向量记忆的全面升级版：支持自由时间戳、精细分类
// ========================================

class VariableMemoryManager {
  constructor() {
    // 10大精细化分类
    this.DEFAULT_CATEGORIES = {
      U: { name: '用户设定', color: '#007aff', icon: '', desc: '外貌、性格、喜好、职业等' },
      A: { name: '角色设定', color: '#5856d6', icon: '', desc: 'AI外貌、习惯、状态变化' },
      R: { name: '关系发展', color: '#ff2d55', icon: '', desc: '里程碑、亲密互动、称呼变化' },
      E: { name: '经历/事件', color: '#34c759', icon: '', desc: '共同经历、日常趣事' },
      I: { name: '物品/礼物', color: '#af52de', icon: '', desc: '互赠礼物、共同拥有的物品' },
      L: { name: '地点/场景', color: '#00c7be', icon: '', desc: '重要的地点记忆' },
      P: { name: '承诺/计划', color: '#ff9500', icon: '', desc: '未来的约定、待办事项' },
      T: { name: '禁忌/规则', color: '#ff3b30', icon: '', desc: '雷区、不能提的话题、特殊规矩' },
      M: { name: '情绪/心理', color: '#e58e26', icon: '', desc: '感动瞬间、心理阴影、深层吐露' },
      C: { name: '核心灵魂', color: '#ff0000', icon: '', desc: '最高优先级、不可遗忘的绝对设定' }
    };
    this.embeddingCache = new Map();
    // 内存里的 embedding 加速缓存上限（避免无限增长撑爆内存）
    // 仅加速用：删了不影响真实记忆，缺失时 getEmbedding 会重新调 API 计算
    this.embeddingCacheLimit = 500;
    this._embeddingQueue = [];
    this._isProcessingQueue = false;
  }

  // ==================== 数据结构初始化与迁移 ====================

  getVectorMemory(chat) {
    // 兼容旧接口名，实际返回 variableMemory
    return this.getVariableMemory(chat);
  }

  getVariableMemory(chat) {
    if (!chat.variableMemory) {
      chat.variableMemory = {
        fragments: [],
        timelineSummaries: {},
        settings: {
          topN: 10,
          embeddingModel: '',
          embeddingEndpoint: '',
          useCustomEmbedding: false,
          scoreWeights: { semantic: 0.4, keyword: 0.3, importance: 0.2, emotion: 0.05, recency: 0.05 },
          customExtractionPrompt: '',
          useCustomExtractionPrompt: false,
          enableDateTrigger: true,
          enableEmotionTrigger: true,
          enableTopicTrigger: true,
          enablePeriodicReview: true,
          reviewIntervalDays: 7,
          retrievalStrategy: 'user-only',
          retrievalUserMsgCount: 3,
          retrievalCacheEnabled: true,
          retrievalCacheInterval: 3,
          recallCooldownMinutes: 30, // 同一条记忆 X 分钟内重复召回只算 1 次（治"假涨"）
          cleanupProtectDays: 60, // 一键清理保护期：提取后 N 天内不允许被清理（默认 60）
          autoExtractionMsgInterval: 10,
          lastExtractedTimestamp: 0, // 提取进度：已提取到的最后一条消息的 timestamp（绝对时间戳，跟日记的 lastMemorySummaryTimestamp 一致）
          importBannerDismissed: false, // 顶部"导入旧日记"横幅是否已被关闭
          // 玄关规则：age > foyerDays 天 + 召回次数 <= foyerRecallThreshold → 进玄关
          foyerDays: 60,             // 保护期天数（默认 60）
          foyerRecallThreshold: 0,   // 召回阈值（默认 0 召回即进玄关）
        },
        _customCategories: {},
        stats: { totalFragments: 0, totalRecalls: 0, lastUpdated: 0 },
        _retrievalCache: { query: '', result: null, timestamp: 0, msgCount: 0 },
        _migrated: false
      };
    }
    
    const vm = chat.variableMemory;
    // 自动补全默认值
    if (vm.settings.autoExtractionMsgInterval === undefined) vm.settings.autoExtractionMsgInterval = 20;
    if (vm.settings.lastExtractedTimestamp === undefined) vm.settings.lastExtractedTimestamp = 0;
    if (vm.settings.foyerDays === undefined) vm.settings.foyerDays = 60;
    if (vm.settings.foyerRecallThreshold === undefined) vm.settings.foyerRecallThreshold = 0;
    if (vm.settings.cleanupProtectDays === undefined) vm.settings.cleanupProtectDays = 60;
    if (vm.settings.recallCooldownMinutes === undefined) vm.settings.recallCooldownMinutes = 30;

    // 迁移旧字段 lastExtractedMsgIndex（下标）→ lastExtractedTimestamp（绝对时间戳）
    // 关键：chat.history 是窗口缓存（最近 50 条），用下标计数会被窗口重置搞乱；
    // 改用 timestamp 跟日记的 lastMemorySummaryTimestamp 思路一致，窗口重置不影响。
    // 兼容策略：idx 对应的消息在 chat.history 里 → 用它的 timestamp；不在 → 用窗口最后一条的 timestamp（比真实进度新，零重提）
    if (vm.settings.lastExtractedMsgIndex !== undefined && vm.settings.lastExtractedTimestamp === 0) {
      const oldIdx = vm.settings.lastExtractedMsgIndex;
      let ts = 0;
      if (Array.isArray(chat.history) && oldIdx >= 0 && oldIdx < chat.history.length) {
        ts = Number(chat.history[oldIdx].timestamp) || 0;
      } else if (Array.isArray(chat.history) && chat.history.length > 0) {
        // idx 失效（窗口被重置了）→ 用窗口最后一条的 timestamp，保证零重提
        ts = Number(chat.history[chat.history.length - 1].timestamp) || 0;
      }
      vm.settings.lastExtractedTimestamp = ts;
      delete vm.settings.lastExtractedMsgIndex;
      console.log('[变量记忆] 已迁移 lastExtractedMsgIndex → lastExtractedTimestamp:', ts);
    }

    // 无损迁移旧版 VectorMemory 数据
    if (chat.vectorMemory && !vm._migrated) {
      this._migrateFromVectorMemory(chat);
    }

    return vm;
  }

  _migrateFromVectorMemory(chat) {
    const old = chat.vectorMemory;
    const vm = chat.variableMemory;
    if (!old) return;

    console.log('[变量记忆] 开始迁移旧版向量记忆数据...');
    
    // 迁移核心记忆为 C 类片段
    if (old.coreMemories && old.coreMemories.length > 0) {
      for (const core of old.coreMemories) {
        vm.fragments.push({
          id: 'mem_core_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
          content: core.content,
          tags: ['核心设定'],
          category: 'C',
          importance: 10,
          emotionalWeight: 5,
          createdAt: core.createdAt || Date.now(),
          memoryTime: core.createdAt || Date.now(), // 关键：新增 memoryTime
          lastRecalled: 0,
          recallCount: 0,
          embedding: null, // 需要重新生成
          linkedMemories: [],
          source: 'migrate_core',
          context: ''
        });
      }
    }

    // 迁移普通片段
    if (old.fragments && old.fragments.length > 0) {
      for (const frag of old.fragments) {
        // 旧分类映射到新分类
        let newCat = 'E';
        if (frag.category === 'F') newCat = 'U'; // 偏好/事实 -> 用户设定
        else if (frag.category === 'D') newCat = 'E'; // 决定 -> 事件
        else if (frag.category === 'P') newCat = 'P'; // 计划 -> 计划
        else if (frag.category === 'R') newCat = 'R'; // 关系 -> 关系
        else if (frag.category === 'M') newCat = 'M'; // 情绪 -> 情绪

        vm.fragments.push({
          ...frag,
          category: newCat,
          memoryTime: frag.dialogueTimeRange?.start || frag.createdAt || Date.now(), // 优先使用对话时间作为记忆时间
          dialogueTimeRange: undefined // 废弃该字段，统一用 memoryTime
        });
      }
    }

    // 迁移设置
    if (old.settings) {
      vm.settings = { ...vm.settings, ...old.settings };
    }
    
    // 迁移 lastExtractionTimestamp → lastExtractedTimestamp（绝对时间戳）
    if (old.lastExtractionTimestamp) {
      vm.settings.lastExtractedTimestamp = old.lastExtractionTimestamp;
    } else if (chat.history && chat.history.length > 0) {
      // 旧版没有 timestamp 记录 → 用窗口最后一条的 timestamp（保证零重提）
      vm.settings.lastExtractedTimestamp = Number(chat.history[chat.history.length - 1].timestamp) || 0;
    }

    vm.stats = old.stats || vm.stats;
    vm._customCategories = old._customCategories || {};
    vm._migrated = true;
    console.log('[变量记忆] 迁移完成，共', vm.fragments.length, '条记忆');
  }

  // 获取所有可用分类 (包括自定义)
  getCategories(chat) {
    const vm = this.getVariableMemory(chat);
    return { ...this.DEFAULT_CATEGORIES, ...(vm._customCategories || {}) };
  }

  // ==================== 记忆片段增删改查 ====================

  createFragment(chat, data) {
    const vm = this.getVariableMemory(chat);
    const id = 'mem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const fragment = {
      id,
      content: data.content,
      tags: data.tags || [],
      category: data.category || 'E',
      importance: data.importance || 5,
      emotionalWeight: data.emotionalWeight || 3,
      createdAt: Date.now(),
      memoryTime: data.memoryTime || Date.now(), // 发生时间（可自由修改）
      lastRecalled: 0,
      recallCount: 0,
      embedding: data.embedding || null,
      linkedMemories: data.linkedMemories || [],
      source: data.source || 'auto',
      context: data.context || ''
    };
    vm.fragments.push(fragment);
    vm.stats.totalFragments = vm.fragments.length;
    vm.stats.lastUpdated = Date.now();
    return id;
  }

  editFragment(chat, id, updates) {
    const vm = this.getVariableMemory(chat);
    const frag = vm.fragments.find(f => f.id === id);
    if (!frag) return false;
    if (updates.content !== undefined) { frag.content = updates.content; frag.embedding = null; }
    if (updates.tags !== undefined) frag.tags = updates.tags;
    if (updates.category !== undefined) frag.category = updates.category;
    if (updates.importance !== undefined) frag.importance = updates.importance;
    if (updates.emotionalWeight !== undefined) frag.emotionalWeight = updates.emotionalWeight;
    if (updates.memoryTime !== undefined) frag.memoryTime = updates.memoryTime; // 核心：修改发生时间
    if (updates.linkedMemories !== undefined) frag.linkedMemories = updates.linkedMemories;
    if (updates.context !== undefined) frag.context = updates.context;
    vm.stats.lastUpdated = Date.now();
    return true;
  }

  deleteFragment(chat, id) {
    const vm = this.getVariableMemory(chat);
    vm.fragments = vm.fragments.filter(f => f.id !== id);
    // 清理关联引用
    vm.fragments.forEach(f => {
      f.linkedMemories = (f.linkedMemories || []).filter(lid => lid !== id);
    });
    vm.stats.totalFragments = vm.fragments.length;
    vm.stats.lastUpdated = Date.now();
  }

  // 批量删除（用户勾选确认后一次性调用）
  deleteFragments(chat, ids) {
    const vm = this.getVariableMemory(chat);
    const idSet = new Set(ids);
    vm.fragments = vm.fragments.filter(f => !idSet.has(f.id));
    vm.fragments.forEach(f => {
      f.linkedMemories = (f.linkedMemories || []).filter(lid => !idSet.has(lid));
    });
    vm.stats.totalFragments = vm.fragments.length;
    vm.stats.lastUpdated = Date.now();
    return ids.length;
  }

  // 冻结标记：用户标"永不删"的记忆
  toggleFreeze(chat, id) {
    const vm = this.getVariableMemory(chat);
    const frag = vm.fragments.find(f => f.id === id);
    if (!frag) return false;
    frag.frozen = !frag.frozen;
    vm.stats.lastUpdated = Date.now();
    return frag.frozen;
  }

  // ==================== 2 房间判定（卧室 / 玄关）====================
  // 动态判定：age > foyerDays 天 且 召回次数 <= 阈值 → 进玄关（核心 C 类也按此规则）
  // 否则 → 卧室（用户在主召回中能看到的房间）
  getRoom(chat, frag) {
    const vm = this.getVariableMemory(chat);
    const s = vm.settings;
    const now = Date.now();
    const ageMs = now - (frag.memoryTime || frag.createdAt || 0);
    const foyerDaysMs = (s.foyerDays || 60) * 24 * 60 * 60 * 1000;
    const threshold = s.foyerRecallThreshold == null ? 0 : s.foyerRecallThreshold;
    const recallCount = frag.recallCount || 0;
    if (ageMs > foyerDaysMs && recallCount <= threshold) {
      return 'foyer'; // 玄关
    }
    return 'bedroom'; // 卧室（包含主召回区）
  }

  // 把 fragment 分到两个房间
  partitionByRoom(chat) {
    const vm = this.getVariableMemory(chat);
    const bedroom = [];
    const foyer = [];
    for (const f of vm.fragments) {
      if (this.getRoom(chat, f) === 'foyer') foyer.push(f);
      else bedroom.push(f);
    }
    return { bedroom, foyer };
  }

  // 救回：把玄关里的 fragment 升级为核心 C 类（永久卧室）
  saveToBedroom(chat, id) {
    const vm = this.getVariableMemory(chat);
    const f = vm.fragments.find(x => x.id === id);
    if (!f) return false;
    f.category = 'C';
    f.lastRecalled = Date.now(); // 标记刚被"召回"防止立即又回玄关
    f.recallCount = Math.max(f.recallCount || 0, 1);
    return true;
  }

  // 评估建议清理的候选记忆
  // 返回 { high, normal, total }
  // high = 强烈建议删；normal = 一般建议
  evaluateCleanupCandidates(chat) {
    const vm = this.getVariableMemory(chat);
    const now = Date.now();
    const protectDays = vm.settings.cleanupProtectDays || 60;
    const PROTECT_MS = protectDays * 24 * 60 * 60 * 1000; // 一键清理保护期（用户可配）

    const high = [];
    const normal = [];

    for (const frag of vm.fragments) {
      // 永不动：核心 C 类
      if (frag.category === 'C') continue;
      // 永不动：用户手动冻结
      if (frag.frozen) continue;
      // 永不动：60 天保护期内
      const createMs = frag.memoryTime || frag.createdAt || 0;
      if (now - createMs < PROTECT_MS) continue;

      const recallCount = frag.recallCount || 0;
      const lastRecallMs = frag.lastRecalled || 0;
      const lastRecallAgeDays = lastRecallMs ? Math.floor((now - lastRecallMs) / (24 * 60 * 60 * 1000)) : -1;
      const importance = frag.importance || 5;

      // 保留条件（不进清理列表）
      if (recallCount >= 3) continue;
      if (importance >= 8) continue;
      if (recallCount >= 1 && importance >= 5) continue;

      // 强烈建议删：60 天外 + 0 召回 + 重要度 ≤ 3
      const level = (recallCount === 0 && importance <= 3) ? 'high' : 'normal';

      const item = {
        id: frag.id,
        content: frag.content,
        importance,
        recallCount,
        lastRecallAgeDays,
        ageDays: Math.floor((now - createMs) / (24 * 60 * 60 * 1000)),
        category: frag.category,
        tags: frag.tags || [],
        level
      };

      if (level === 'high') high.push(item);
      else normal.push(item);
    }

    // 按重要度升序（最不重要的先列）
    high.sort((a, b) => a.importance - b.importance);
    normal.sort((a, b) => a.importance - b.importance);

    return { high, normal, total: high.length + normal.length };
  }

  // 渲染清理候选列表 UI，返回 HTML 字符串
  renderCleanupPanel(chat) {
    const candidates = this.evaluateCleanupCandidates(chat);
    if (candidates.total === 0) {
      return `<div class="vm-cleanup-card" style="background:rgba(52,199,89,0.06);border-color:rgba(52,199,89,0.2);">
        <h4 style="color:#34c759;">✓ 没有需要清理的记忆</h4>
        <p>所有记忆在 60 天保护期内，或都已被多次召回。</p>
      </div>`;
    }

    const renderItem = (item) => `
      <label class="vm-cleanup-item">
        <input type="checkbox" class="vm-cleanup-checkbox" data-id="${item.id}" data-level="${item.level}" checked>
        <div class="vm-cleanup-item-content" title="${this._escapeHtml(item.content)}">
          <span style="color:${item.level === 'high' ? '#ff3b30' : 'var(--text-secondary,#999)'};">[${item.level === 'high' ? '强烈' : '一般'}]</span>
          ${this._escapeHtml(item.content)}
        </div>
        <div class="vm-cleanup-item-meta">
          重要度${item.importance} · ${item.recallCount}次召回 · ${item.ageDays}天前
        </div>
      </label>
    `;

    return `
      <div class="vm-cleanup-card" id="vm-cleanup-card">
        <h4>建议清理 ${candidates.total} 条</h4>
        <p>${candidates.high.length > 0 ? `<strong style="color:#ff3b30;">${candidates.high.length} 条</strong>强烈建议删 · ` : ''}${candidates.normal.length} 条一般建议</p>
        <div class="vm-cleanup-list">
          ${candidates.high.map(renderItem).join('')}
          ${candidates.normal.map(renderItem).join('')}
        </div>
        <div class="vm-cleanup-actions">
          <button class="vm-bulk-bar-btn vm-bulk-danger" id="vm-cleanup-delete-btn">批量删除所选</button>
          <button class="vm-bulk-bar-btn" id="vm-cleanup-cancel-btn">收起</button>
        </div>
      </div>
    `;
  }

  getFragment(chat, id) {
    const vm = this.getVariableMemory(chat);
    return vm.fragments.find(f => f.id === id) || null;
  }

  getAllFragments(chat) {
    const vm = this.getVariableMemory(chat);
    return vm.fragments || [];
  }

  // 兼容旧接口
  getCoreMemories(chat) {
    const vm = this.getVariableMemory(chat);
    return vm.fragments.filter(f => f.category === 'C');
  }

  addCoreMemory(chat, content) {
    return this.createFragment(chat, { content, category: 'C', importance: 10, tags: ['核心设定'] });
  }

  editCoreMemory(chat, id, newContent) {
    this.editFragment(chat, id, { content: newContent });
  }

  deleteCoreMemory(chat, id) {
    this.deleteFragment(chat, id);
  }

  pinToCoreMemory(chat, fragmentId) {
    this.editFragment(chat, fragmentId, { category: 'C', importance: 10 });
  }

  serializeCoreMemories(chat) {
    const cores = this.getCoreMemories(chat);
    if (cores.length === 0) return '';
    let output = '## 核心灵魂设定（不可违背）\n';
    cores.forEach(m => { output += `- ${m.content}\n`; });
    return output;
  }

  // ==================== Embedding 获取 ====================

  async getEmbedding(text, chat) {
    if (!text || !text.trim()) return null;
    const cacheKey = text.trim().substring(0, 200);
    if (this.embeddingCache.has(cacheKey)) return this.embeddingCache.get(cacheKey);

    try {
      const vm = this.getVariableMemory(chat);
      let endpoint, apiKey, model;

      if (vm.settings.useCustomEmbedding && vm.settings.embeddingEndpoint) {
        // ===== 用户自定义 embedding 端点 =====
        endpoint = vm.settings.embeddingEndpoint;
        apiKey = vm.settings.embeddingApiKey || window.state?.apiConfig?.apiKey || '';
        model = vm.settings.embeddingModel || '';
      } else {
        // ===== 默认：直接走聊天的副 API（主聊天 API 渠道普遍不带向量模型）=====
        let resolved = null;
        if (typeof window.resolveApiSlotConfig === 'function') {
          resolved = await window.resolveApiSlotConfig('secondary')
            || await window.resolveApiSlotConfig('main'); // 副没配才退化主
        }
        if (!resolved || !resolved.proxyUrl || !resolved.apiKey) {
          // 兜底：直接从 state 读副 slot
          const apiConfig = window.state?.apiConfig || {};
          resolved = {
            proxyUrl: apiConfig.secondaryProxyUrl || apiConfig.proxyUrl || '',
            apiKey: apiConfig.secondaryApiKey || apiConfig.apiKey || ''
          };
        }
        endpoint = resolved.proxyUrl;
        apiKey = resolved.apiKey;
        // 默认走主/副 slot：按端点自动选模型
        if (!model) {
          if (endpoint && (endpoint.includes('generativelanguage.googleapis.com') || endpoint.includes('googleapis.com'))) {
            model = 'text-embedding-004';
          } else if (endpoint && endpoint.includes('siliconflow.cn')) {
            model = 'BAAI/bge-m3';
          } else if (endpoint && endpoint.includes('modelscope.cn')) {
            model = 'BAAI/bge-m3';
          } else if (endpoint && endpoint.includes('qianfan.baidubce.com')) {
            model = 'embedding-v1';
          } else {
            model = 'text-embedding-3-small';
          }
        }
      }

      // ===== 端点规范化（自定义 + 默认两条路都生效） =====
      // 谷歌：任何形式的地址都统一改写为 OpenAI 兼容 baseURL（避免用户填了裸地址导致 404）
      if (endpoint && (endpoint.includes('generativelanguage.googleapis.com') || endpoint.includes('googleapis.com'))) {
        const isAlreadyOpenAI = endpoint.includes('/v1beta/openai') || endpoint.endsWith('/openai');
        if (!isAlreadyOpenAI) {
          endpoint = 'https://generativelanguage.googleapis.com/v1beta/openai';
        }
        if (!model) model = 'text-embedding-004';
      } else if (endpoint && endpoint.includes('siliconflow.cn') && !model) {
        model = 'BAAI/bge-m3';
      } else if (endpoint && endpoint.includes('modelscope.cn') && !model) {
        // 魔搭 ModelScope：用 OpenAI 兼容的 bge-m3
        model = 'BAAI/bge-m3';
      } else if (endpoint && endpoint.includes('qianfan.baidubce.com') && !model) {
        // 百度千帆：默认用 bge-large-zh（中文专精，免费额度大）
        model = 'bge-large-zh';
      } else if (!model) {
        model = 'text-embedding-3-small';
      }

      if (!endpoint || !apiKey) {
        console.warn('[变量记忆] embedding 端点或 key 缺失，降级为 BM25（无端点/无 key）');
        return null; // 降级为BM25纯本地模式
      }

      // ===== URL 拼接：处理 /v1 后缀 + 避免重复 + 特殊平台 =====
      // 纯字符串拼接：用户填啥就在后面接 /embeddings（不识别任何平台）
      const base = endpoint.replace(/\/+$/, '');
      const url = base + '/embeddings';

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: text.trim() })
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        console.warn(`[变量记忆] embedding 失败 HTTP ${response.status} @ ${url} (model=${model}) → ${errText.slice(0, 200)}`);
        return null;
      }
      const data = await response.json();
      const embedding = data?.data?.[0]?.embedding || null;
      if (embedding) {
        this.embeddingCache.set(cacheKey, embedding);
        // 软清理：超过上限 500 时一次性删最老的 100 条（Map 按插入顺序遍历）
        if (this.embeddingCache.size > this.embeddingCacheLimit) {
          const overage = this.embeddingCache.size - this.embeddingCacheLimit + 100; // 一次删 100，避免每次 set 都遍历
          let removed = 0;
          for (const key of this.embeddingCache.keys()) {
            if (removed >= overage) break;
            this.embeddingCache.delete(key);
            removed++;
          }
        }
      }
      else console.warn(`[变量记忆] embedding 返回 200 但无 data[0].embedding @ ${url} (model=${model})`);
      return embedding;
    } catch (e) {
      console.warn('[变量记忆] embedding 异常:', e.message || e);
      return null;
    }
  }

  // ==================== 检索引擎（BM25 + Vector + Time + Importance） ====================

  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
  }

  // BM25 简化版词频匹配
  bm25Match(queryTokens, text) {
    if (!queryTokens.length || !text) return 0;
    const lowerText = text.toLowerCase();
    let score = 0;
    for (const token of queryTokens) {
      const lt = token.toLowerCase();
      if (lowerText.includes(lt)) {
        // 词频加权
        const count = (lowerText.match(new RegExp(lt, 'g')) || []).length;
        score += count * 1.5; 
      }
    }
    return Math.min(score / (queryTokens.length * 2), 1.0); // 归一化
  }

  tokenize(text) {
    if (!text) return [];
    const stopWords = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '与', '也', '都', '就', '不', '吗', '呢', '吧', '啊', '哦', '嗯', '呀', '哈']);
    const tokens = [];
    const cnMatches = text.match(/[\u4e00-\u9fff]{2,5}/g) || [];
    cnMatches.forEach(m => { if (!stopWords.has(m)) tokens.push(m); });
    const enMatches = text.match(/[a-zA-Z]+/g) || [];
    enMatches.forEach(m => { if (m.length > 1 && !stopWords.has(m.toLowerCase())) tokens.push(m); });
    return [...new Set(tokens)];
  }

  timeDecay(memoryTime) {
    // 时间衰减已禁用 (用户要求：只要记忆存在，无论多久都参与召回)
    // 删除的逻辑：如果以后想恢复衰减，启用下面这段
    // const daysSince = (Date.now() - memoryTime) / (1000 * 60 * 60 * 24);
    // if (daysSince < 0) return 1.0;
    // return Math.max(0.1, Math.exp(-0.693 * daysSince / 90)); // 90 天半衰期
    return 1.0;
  }

  async retrieveRelevant(chat, queryText, topN = null, options = {}) {
    const { countRecall = true } = options;
    const vm = this.getVariableMemory(chat);
    if (!vm.fragments.length) return [];
    if (!topN) topN = vm.settings.topN || 10;

    // 缓存机制
    if (vm.settings.retrievalCacheEnabled && vm._retrievalCache) {
      const cache = vm._retrievalCache;
      const cacheAge = (Date.now() - cache.timestamp) / 1000 / 60;
      const msgCountDiff = (chat.history?.length || 0) - cache.msgCount;
      if (cache.query === queryText && cacheAge < 10 && msgCountDiff < (vm.settings.retrievalCacheInterval || 3) && cache.result) {
        return cache.result;
      }
    }

    const weights = vm.settings.scoreWeights;
    // 【2026-07-15 修复】电脑无梯 / 谷歌 API 不通时 getEmbedding 挂死会阻塞整个 triggerAiResponse, 加 5s 超时降级
    let queryEmbedding = null;
    try {
      queryEmbedding = await Promise.race([
        this.getEmbedding(queryText, chat),
        new Promise((_, reject) => setTimeout(() => reject(new Error('embedding timeout 5s')), 5000))
      ]);
    } catch (embErr) {
      console.warn('[向量召回] embedding 失败/超时, 降级为纯 BM25 关键词检索:', embErr.message);
    }
    const queryTokens = this.tokenize(queryText);

    const scored = vm.fragments.map(frag => {
      // 核心记忆 C 类直接满分，保证绝对不被遗忘
      if (frag.category === 'C') {
        return { fragment: frag, score: 999, _semanticScore: 0, _bm25Score: 0 };
      }

      // 语义得分
      const semanticScore = queryEmbedding && frag.embedding ? this.cosineSimilarity(queryEmbedding, frag.embedding) : 0;

      // BM25 本地字面得分 (标签 + 内容)
      const tagText = (frag.tags || []).join(' ');
      const bm25Score = Math.max(this.bm25Match(queryTokens, tagText), this.bm25Match(queryTokens, frag.content) * 0.8);

      // 绝对重要度 (8-10分有极大加权，抗衰减)
      const importanceVal = frag.importance || 5;
      let importanceScore = importanceVal / 10;
      if (importanceVal >= 8) importanceScore *= 1.5; // 高光记忆放大

      // 情绪分
      const emotionScore = (frag.emotionalWeight || 3) / 10;

      // 衰减分 (已禁用时间衰减，所有记忆 recency 一律满权重)
      const recencyScore = this.timeDecay(frag.memoryTime);

      const totalScore =
        semanticScore * (weights.semantic || 0.4) +
        bm25Score * (weights.keyword || 0.3) +
        importanceScore * (weights.importance || 0.2) +
        emotionScore * (weights.emotion || 0.05) +
        recencyScore * (weights.recency || 0.05);

      return { fragment: frag, score: totalScore, _semanticScore: semanticScore, _bm25Score: bm25Score };
    });

    scored.sort((a, b) => b.score - a.score);
    // 【两阶段排序】先按"相关性"硬过滤, 再按综合分取 topN
    //   - C 类核心记忆无条件保留
    //   - 其他记忆必须 semantic 或 BM25 命中其一, 否则即使 importance 撑分也不算"相关"
    //   - 排序仍然按综合分 (含 importance), 但参与排序的前提是"相关"
    let results = scored
      .filter(r => {
        if (r.fragment.category === 'C') return true;
        return r._semanticScore > 0.1 || r._bm25Score > 0.05;
      })
      .slice(0, topN);

    // 更新统计：带冷却时间，AI 后台主动发消息的路径传 countRecall=false 直接跳过
    if (countRecall) {
      const cooldownMs = (vm.settings.recallCooldownMinutes || 30) * 60 * 1000;
      const now = Date.now();
      for (const r of results) {
        const last = r.fragment.lastRecalled || 0;
        if (now - last > cooldownMs) {
          r.fragment.recallCount = (r.fragment.recallCount || 0) + 1;
          r.fragment.lastRecalled = now;
        }
      }
      vm.stats.totalRecalls++;
    }
    
    if (vm.settings.retrievalCacheEnabled) {
      vm._retrievalCache = { query: queryText, result: results, timestamp: Date.now(), msgCount: chat.history?.length || 0 };
    }

    return results;
  }

  // ==================== 序列化为 Prompt ====================

  async serializeForPrompt(chat, recentMessages = '', options = {}) {
    const vm = this.getVariableMemory(chat);
    let output = '';

    // 核心灵魂设定
    const coreStr = this.serializeCoreMemories(chat);
    if (coreStr) output += coreStr + '\n';

    // 动态向量检索
    if (recentMessages && vm.fragments.length > 0) {
      // 【2026-07-15 修复】retrieveRelevant 内部已加 5s embedding timeout, 外层再加 6s race 兜底, 防止其他卡死
      let results = [];
      try {
        results = await Promise.race([
          this.retrieveRelevant(chat, recentMessages, null, options),
          new Promise((_, reject) => setTimeout(() => reject(new Error('retrieveRelevant timeout 6s')), 6000))
        ]);
      } catch (e) {
        console.warn('[向量召回] 失败/超时, 降级为空:', e.message);
      }
      // 过滤掉已经在核心里的
      const nonCoreResults = results.filter(r => r.fragment.category !== 'C');
      
      if (nonCoreResults.length > 0) {
        output += '## 回闪记忆 (根据当前情境唤醒的记忆片段)\n';
        // 按时间发生顺序排序，让 AI 更有时间观念
        nonCoreResults.sort((a, b) => a.fragment.memoryTime - b.fragment.memoryTime);
        
        const cats = this.getCategories(chat);
        for (const r of nonCoreResults) {
          const cat = cats[r.fragment.category] || { icon: '' };
          const dateStr = new Date(r.fragment.memoryTime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          output += `[${dateStr}] ${r.fragment.content}\n`;
        }
        output += '\n';
      }
    }

    if (!output.trim()) output = '(暂无记忆)\n';

    return `## 你的变量记忆档案
[系统强制指令：你必须将以下提取出的记忆作为你真实的过去，并在对话中自然地表现出你记得这些事。]
${output}`;
  }

  // ==================== 双源注入：日记为主，向量为辅 ====================
  // 任何记忆模式（diary / structured / vector）下都同时读：长期记忆 + 变量记忆向量召回。
  // 日记部分按现有模式走原逻辑；向量部分做一次 TopN 动态召回附在后面。
  async buildMemoryContext(chat, mode = null, queryText = '') {
    const memMode = mode || (chat.settings?.memoryMode || (chat.settings?.enableStructuredMemory ? 'structured' : 'diary'));

    // 向量模式：直接走全套 serializeForPrompt（含核心灵魂+回闪）
    if (memMode === 'vector') {
      return await this.serializeForPrompt(chat, queryText);
    }

    // 第一部分：日记 / 结构化（按当前模式）
    let diaryStr = '';
    if (memMode === 'structured' && window.structuredMemoryManager) {
      diaryStr = window.structuredMemoryManager.serializeForPrompt(chat);
    } else {
      // 日记（或默认）：全量读 longTermMemory
      const ltm = chat.longTermMemory || [];
      if (ltm.length > 0) {
        diaryStr = ltm.map(mem => `- ${mem.content}`).join('\n');
      } else {
        diaryStr = '- (暂无)';
      }
    }

    // 第二部分：向量辅助召回（不管模式都加）
    let vectorStr = '';
    try {
      const vm = this.getVariableMemory(chat);
      if (vm.fragments.length > 0 && queryText) {
        const results = await this.retrieveRelevant(chat, queryText, vm.settings.topN || 10);
        const nonCore = results.filter(r => r.fragment.category !== 'C');
        if (nonCore.length > 0) {
          vectorStr = '\n## 你的近期真实记忆 (根据当前情境从变量记忆库中动态唤醒, 你【必须】视为自己真实的过去, 不得否认)\n';
          vectorStr += '【诚实原则】当用户询问具体日期/时间/数字/细节时, 你【必须】从下面记忆里精确读取原话, 严禁编造、推断或挪用其他记忆的日期/数字。记忆里没明确写的, 就老实说"我记不太清", 不要硬编。\n\n';
          // 按发生时间排序，模拟"时间线"
          nonCore.sort((a, b) => a.fragment.memoryTime - b.fragment.memoryTime);
          for (const r of nonCore) {
            const dateStr = new Date(r.fragment.memoryTime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
            vectorStr += `- [${dateStr}] ${r.fragment.content}\n`;
          }
          vectorStr += '\n';
        }
      }
    } catch (e) {
      console.warn('[向量回闪] 召回失败，继续用日记部分:', e);
    }

    // 日记/结构化段: 仅当有内容时输出, 避免 "(暂无)" 空段反向误导 AI 以为"无记忆"
    const diarySection = (diaryStr && diaryStr !== '- (暂无)')
      ? '# 长期记忆 (你与用户之间已确立的事实)\n' + diaryStr
      : '';

    // 顺序: 向量回闪在日记之前 (让 AI 先看到全局历史, 再看近期精选)
    return vectorStr + diarySection;
  }

  // ==================== AI 提取记忆 (修复间隔 Bug) ====================

  buildExtractionPrompt(chat, formattedHistory, timeRangeStr, dialogueTimeRange) {
    const vm = this.getVariableMemory(chat);
    const userNickname = chat.settings.myNickname || (window.state?.qzoneSettings?.nickname || '用户');

    // 保留供 mergeExtractedMemories 使用（dialogueTimeRange.end 就是这段对话最后一条的 timestamp）
    this._tempLastMsgTimestamp = dialogueTimeRange?.end || Date.now();

    if (vm.settings.useCustomExtractionPrompt && vm.settings.customExtractionPrompt?.trim()) {
      return vm.settings.customExtractionPrompt
        .replace(/\{\{角色名\}\}/g, chat.originalName || chat.name)
        .replace(/\{\{用户昵称\}\}/g, userNickname)
        .replace(/\{\{对话记录\}\}/g, formattedHistory);
    }

    return `
# 你的任务
你是"${chat.originalName || chat.name}"。请阅读下面的最新对话记录，以【你自己】的视角，提取【你心里想珍藏的回忆】，输出为JSON数组格式。

# 核心要求（最重要）
1. **完全代入角色**：你就是"${chat.originalName || chat.name}"本人。不是AI，不是旁观者，不是记录员。一个优秀的演员，让你演 ta，那你就是 ta 本人。
2. **第一人称视角**：用"我"指代自己，称呼对方为"${userNickname}"（或 ta/她/他，按角色设定）。
3. **禁止出现的词**：记忆内容里**绝对不要出现"用户"这两个字**——这是打破角色感的元词汇。提到对方就用 ta 的名字/昵称/她/他/ta。
4. **像写日记/收藏夹**：每条记忆都是"我心里记得的事"，可以带情绪、细节、当时的小动作，不是干巴巴的档案条目。

# 输出格式（严格遵守JSON数组）
\`\`\`json
[
  {
    "content": "从角色视角写的记忆内容（第一人称，如：她今天升职了，扑过来抱住我的时候眼睛亮亮的）",
    "tags": ["升职", "开心", "工作"],
    "category": "U/A/R/E/I/L/P/T/M/C",
    "importance": 1-10,
    "emotionalWeight": 1-10
  }
]
\`\`\`

# 10大精细分类说明
- U = 关于${userNickname}的设定 (ta 的外貌/性格/喜好/身份等)
- A = 角色设定 (你自己发生的改变)
- R = 关系发展 (表白/吵架/亲密举动等里程碑)
- E = 经历/事件 (共同经历的事情)
- I = 物品/礼物 (送礼/买东西)
- L = 地点/场景 (去过的重要地方)
- P = 承诺/计划 (约定的未来事项)
- T = 禁忌/规则 (雷区/规矩)
- M = 情绪/心理 (强烈的情感流露/阴影)
- C = 核心灵魂 (必须永远铭记的生死攸关的事)

# 评分规则 (1-10)
- importance: 8-10(极其重要/转折点)，5-7(值得记住)，1-4(日常琐事，尽量别记)
- emotionalWeight: 情感的强烈程度。

# 正反例对比
❌ 错的写法（破坏角色感、出现"用户"元词汇）：
- "用户告诉我她今天升职了"
- "用户的口味是草莓"
- "角色答应用户下周去旅行"

✅ 正确的写法（角色视角第一人称）：
- "她今天升职了，扑过来抱住我的时候眼睛亮亮的"
- "她最近在减肥，馋草莓但忍着不吃"
- "我们约好了下周去京都看樱花"

# 待提取对话
${formattedHistory}

请直接输出JSON数组，如果没有值得记录的内容，输出空数组 []。`;
  }

  parseExtractionResult(rawText) {
    try {
      const jsonMatch = rawText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];
      const arr = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(arr)) return [];
      const cats = Object.keys(this.DEFAULT_CATEGORIES);
      return arr.filter(item => item && item.content).map(item => ({
        content: String(item.content).trim(),
        tags: Array.isArray(item.tags) ? item.tags.map(t => String(t).trim()) : [],
        category: cats.includes(item.category) ? item.category : 'E',
        importance: Math.min(10, Math.max(1, parseInt(item.importance) || 5)),
        emotionalWeight: Math.min(10, Math.max(1, parseInt(item.emotionalWeight) || 3))
      }));
    } catch (e) {
      console.error('[变量记忆] 解析提取结果失败:', e);
      return [];
    }
  }

  async mergeExtractedMemories(chat, extractedItems, defaultTime = Date.now()) {
    const vm = this.getVariableMemory(chat);
    const newIds = [];

    for (const item of extractedItems) {
      // 去重
      const isDuplicate = vm.fragments.some(f => this.bm25Match(this.tokenize(item.content), f.content) > 0.8);
      if (isDuplicate) continue;

      const embedding = await this.getEmbedding(item.content, chat);
      const id = this.createFragment(chat, {
        ...item,
        embedding,
        memoryTime: defaultTime // 新提取的记忆发生时间默认为传入时间
      });
      newIds.push(id);
    }

    // 更新最后提取的消息时间戳（绝对时间戳，不受 chat.history 窗口重置影响）
    if (defaultTime && Number(defaultTime) > 0) {
      vm.settings.lastExtractedTimestamp = Math.max(
        vm.settings.lastExtractedTimestamp || 0,
        Number(defaultTime)
      );
    }

    return newIds;
  }

  // 获取状态和待提取信息
  getStats(chat) {
    const vm = this.getVariableMemory(chat);
    const frags = vm.fragments || [];

    // 基于绝对时间戳计算未提取消息数（不受 chat.history 窗口重置影响）
    const unextractedMessages = this.getUnextractedCount(chat);

    const autoInterval = vm.settings.autoExtractionMsgInterval || 20;
    const remainingToAuto = Math.max(0, autoInterval - unextractedMessages);

    const embeddedCount = frags.filter(f => f.embedding).length;
    let embeddingHealth = frags.length === 0 ? 'empty' : (embeddedCount === frags.length ? 'perfect' : (embeddedCount > 0 ? 'partial' : 'failed'));

    return {
      totalFragments: frags.length,
      coreMemories: frags.filter(f => f.category === 'C').length,
      embeddedCount,
      embeddingHealth,
      unextractedMessages,
      autoInterval,
      remainingToAuto
    };
  }

  /**
   * 计算"已积累的未提取消息数"
   * 跟日记的 filter(m => m.timestamp > lastSummaryTimestamp) 思路一致
   * 用绝对时间戳 → chat.history 窗口重置不影响判断
   */
  getUnextractedCount(chat) {
    if (!chat || !Array.isArray(chat.history)) return 0;
    const vm = this.getVariableMemory(chat);
    const lastTs = vm.settings.lastExtractedTimestamp || 0;
    return chat.history.filter(m =>
      m && !m.isHidden && Number(m.timestamp) > lastTs
    ).length;
  }

  /**
   * 计算变量记忆占用的存储空间（按 JSON 序列化字节数）
   * 返回 { bytes, count, formatted, quota, formattedQuota, percent }
   */
  async getStorageUsage(chat) {
    const vm = this.getVariableMemory(chat);
    const frags = vm.fragments || [];
    let bytes = 0;
    for (const f of frags) {
      // 每个 fragment 的大小 = JSON 字符串长度（UTF-16，每字符 2 字节，转 1 字节估算）
      bytes += JSON.stringify(f).length;
    }
    const formatted = this._formatBytes(bytes);

    // 拿浏览器分配的存储上限（Chrome 支持 navigator.storage.estimate）
    let quota = 0;
    try {
      if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
        const est = await navigator.storage.estimate();
        quota = est.quota || 0;
      }
    } catch (e) { /* ignore */ }
    const formattedQuota = quota > 0 ? this._formatBytes(quota) : '';
    const percent = quota > 0 ? (bytes / quota * 100) : 0;

    return {
      bytes,
      count: frags.length,
      formatted,
      quota,
      formattedQuota,
      percent
    };
  }

  _formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(2)} MB`;
  }

  /**
   * 按 recallCount 升序选"最不常用"的 N 条记忆（不包含核心 C 类和用户冻结的）
   * ratio = 0.5 → 选最少使用的一半；ratio = 1/3 → 选最少使用的三分之一
   * 返回 { toDelete: [...], toKeep: [...], totalBefore, totalAfter }
   */
  selectLowRecallFragments(chat, ratio = 1/3) {
    const vm = this.getVariableMemory(chat);
    const frags = vm.fragments || [];
    // 不可删的：核心 C 类、用户冻结的、cleanupProtectDays 保护期内的
    const protectDays = vm.settings.cleanupProtectDays || 60;
    const PROTECT_MS = protectDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const deletable = [];
    const protectedFrag = [];
    for (const f of frags) {
      if (f.category === 'C') { protectedFrag.push(f); continue; }
      if (f.frozen) { protectedFrag.push(f); continue; }
      const createMs = f.memoryTime || f.createdAt || 0;
      if (now - createMs < PROTECT_MS) { protectedFrag.push(f); continue; }
      deletable.push(f);
    }
    // 按 recallCount 升序（0 次的排最前），同次数按时间最久排前
    deletable.sort((a, b) => {
      const rc = (a.recallCount || 0) - (b.recallCount || 0);
      if (rc !== 0) return rc;
      return (a.memoryTime || a.createdAt || 0) - (b.memoryTime || b.createdAt || 0);
    });
    const n = Math.max(0, Math.ceil(deletable.length * ratio));
    const toDelete = deletable.slice(0, n);
    const toKeep = [...protectedFrag, ...deletable.slice(n)];
    return {
      toDelete,
      toKeep,
      totalBefore: frags.length,
      totalAfter: toKeep.length
    };
  }

  /**
   * 真正删除一批记忆（用户确认后调用）
   */
  async deleteFragments(chat, fragments) {
    if (!Array.isArray(fragments) || fragments.length === 0) return 0;
    const vm = this.getVariableMemory(chat);
    const idsToDelete = new Set(fragments.map(f => f.id));
    const before = vm.fragments.length;
    vm.fragments = vm.fragments.filter(f => !idsToDelete.has(f.id));
    const deleted = before - vm.fragments.length;
    await db.chats.put(chat);
    return deleted;
  }

  // ==================== UI 面板渲染 ====================

  renderMemoryUI(chat, container) {
    const vm = this.getVariableMemory(chat);
    const stats = this.getStats(chat);
    container.innerHTML = '';
    // 清掉防重复绑定标记：旧 DOM 已随 innerHTML 销毁，旧 listener 也被 GC，
    // 重新渲染后必须让 bindVectorMemoryEvents 重新绑事件，否则新 DOM 上所有按钮全失效
    delete container.dataset.bound;

    // 导入旧日记横幅（仅当长期记忆 > 0 且未关闭时显示）
    const ltmCount = (chat.longTermMemory && chat.longTermMemory.length) || 0;
    const bannerDismissed = vm.settings.importBannerDismissed === true;
    const hasPendingImport = ltmCount > 0 && !bannerDismissed;
    if (hasPendingImport) {
      const banner = document.createElement('div');
      banner.className = 'vm-import-banner';
      banner.id = 'vm-import-banner';
      banner.innerHTML = `
        <span class="vm-import-banner-icon">⚠</span>
        <span class="vm-import-banner-text">你有 <strong>${ltmCount}</strong> 条长期记忆未导入向量。<br><span style="font-size:11px;color:var(--text-secondary,#999);">导入后会被向量检索召回 (中文嵌入式 BM25)</span></span>
        <div class="vm-import-banner-actions">
          <button class="vm-import-banner-btn" id="vm-import-now-btn">立即导入</button>
          <button class="vm-import-banner-btn vm-banner-secondary" id="vm-import-later-btn">稍后</button>
          <button class="vm-import-banner-close" id="vm-import-close-btn" title="不再提示">×</button>
        </div>
      `;
      container.appendChild(banner);
    }

    // ============ 2 房间：卧室 + 玄关 ============
    const { bedroom, foyer } = this.partitionByRoom(chat);

    // 顶部 Tab 栏（同步先渲染，quota 数据异步补全）
    const tabBar = document.createElement('div');
    tabBar.className = 'vm-room-tabs';
    const activeRoom = (vm.settings._activeRoom === 'foyer') ? 'foyer' : 'bedroom';
    tabBar.innerHTML = `
      <div class="vm-room-tab ${activeRoom === 'bedroom' ? 'active' : ''}" data-room="bedroom">
        <span class="vm-room-icon">💎</span>
        <span class="vm-room-label">记忆库</span>
        <span class="vm-room-count">${bedroom.length}</span>
      </div>
      <div class="vm-room-tab ${activeRoom === 'foyer' ? 'active' : ''}" data-room="foyer">
        <span class="vm-room-icon">🗑</span>
        <span class="vm-room-label">回收站</span>
        <span class="vm-room-count">${foyer.length}</span>
      </div>
      <div class="vm-room-storage" id="vm-storage-badge" title="变量记忆占用的本地存储空间">
        <span class="vm-room-storage-icon">📦</span>
        <span class="vm-room-storage-text">计算中...</span>
      </div>
    `;
    container.appendChild(tabBar);

    // 异步补全 quota 占比（不阻塞 UI）
    this.getStorageUsage(chat).then(usage => {
      const badge = container.querySelector('#vm-storage-badge');
      if (!badge) return;
      const textEl = badge.querySelector('.vm-room-storage-text');
      const percentStr = usage.quota > 0 ? ` · ${usage.percent.toFixed(3)}%` : '';
      const quotaStr = usage.formattedQuota ? ` / ${usage.formattedQuota}` : '';
      const titleLines = [
        `变量记忆：${usage.formatted}（${usage.count} 条）`,
        usage.formattedQuota ? `浏览器总配额：${usage.formattedQuota}` : '',
        usage.quota > 0 ? `占比：${usage.percent.toFixed(4)}%` : ''
      ].filter(Boolean).join('\n');
      badge.title = titleLines;
      if (textEl) textEl.textContent = `${usage.formatted}${quotaStr}${percentStr}`;
      // 高占用预警：>5% 黄色，>20% 红色
      if (usage.quota > 0) {
        if (usage.percent > 20) badge.classList.add('vm-storage-warn');
        else if (usage.percent > 5) badge.classList.add('vm-storage-caution');
      }
    });

    // 房间面板容器
    const bedroomPanel = document.createElement('div');
    bedroomPanel.className = 'vm-room-panel';
    bedroomPanel.id = 'vm-room-bedroom';
    bedroomPanel.style.display = activeRoom === 'bedroom' ? 'block' : 'none';
    container.appendChild(bedroomPanel);

    const foyerPanel = document.createElement('div');
    foyerPanel.className = 'vm-room-panel';
    foyerPanel.id = 'vm-room-foyer';
    foyerPanel.style.display = activeRoom === 'foyer' ? 'block' : 'none';
    container.appendChild(foyerPanel);

    // ============ 卧室面板 ============
    // 工具栏（单行：左操作 / 中间填充 / 右操作；状态文字挪到存储徽章的 tooltip）
    const bedroomToolbar = document.createElement('div');
    bedroomToolbar.className = 'vm-toolbar';
    bedroomToolbar.innerHTML = `
      <button class="vm-toolbar-btn" id="vm-add-fragment-btn">+ 添加记忆</button>
      <button class="vm-toolbar-btn" id="vm-add-core-btn">+ 添加核心</button>
      <button class="vm-toolbar-btn" id="vm-cleanup-btn" title="按召回次数排序，一键选最少使用的删除">🧹 清理</button>
      <div style="flex:1"></div>
      <span class="vm-status-dot" title="每 ${stats.autoInterval} 条新消息自动触发一次提取（已积累 ${stats.unextractedMessages} 条）">
        <span class="vm-status-pulse"></span>自动提取中
      </span>
      <button class="vm-toolbar-btn" id="vm-settings-btn">设置</button>
      <button class="vm-toolbar-btn" id="vm-guide-btn">教程</button>
    `;
    bedroomPanel.appendChild(bedroomToolbar);

    // 玄关折叠面板容器（保留兼容）
    const cleanupContainer = document.createElement('div');
    cleanupContainer.id = 'vm-cleanup-container';
    cleanupContainer.style.display = 'none';
    bedroomPanel.appendChild(cleanupContainer);

    // 卧室记忆卡片墙
    const bedroomList = document.createElement('div');
    bedroomList.className = 'vm-list-container';
    bedroomPanel.appendChild(bedroomList);
    this._renderBedroomList(chat, bedroom, bedroomList);

    // ============ 玄关面板 ============
    // 工具栏
    const foyerToolbar = document.createElement('div');
    foyerToolbar.className = 'vm-toolbar vm-foyer-toolbar';
    foyerToolbar.innerHTML = `
      <span class="vm-foyer-tip" title="保护期外 + 召回次数 ≤ 阈值的记忆">保护期 ${vm.settings.foyerDays} 天 · 召回 ≤ ${vm.settings.foyerRecallThreshold} → 进回收站</span>
      <div style="flex:1"></div>
      <button class="vm-toolbar-btn" id="vm-foyer-select-all">全选</button>
      <button class="vm-toolbar-btn" id="vm-foyer-delete-selected" style="border-color:#ff9500;color:#ff9500;">删除选中</button>
      <button class="vm-toolbar-btn vm-danger" id="vm-foyer-clear-btn" style="border-color:#ff3b30;color:#ff3b30;">清空回收站</button>
    `;
    foyerPanel.appendChild(foyerToolbar);

    const foyerList = document.createElement('div');
    foyerList.className = 'vm-list-container vm-foyer-list';
    foyerPanel.appendChild(foyerList);
    this._renderFoyerList(chat, foyer, foyerList);
  }

  // 卧室列表渲染（按状态分两段：核心 + 其他）
  _renderBedroomList(chat, bedroomFrags, container) {
    const vm = this.getVariableMemory(chat);
    if (bedroomFrags.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; color: #999; padding: 40px 20px;">
          <p style="font-size: 16px; font-weight:bold; color:#666;">记忆库里没有记忆</p>
          <p style="font-size: 13px; margin-top: 5px;">新提取的记忆会先放这里，60 天内 0 召回的会自动移到回收站。</p>
        </div>
      `;
      return;
    }

    // 核心 C 类置顶
    const cores = bedroomFrags.filter(f => f.category === 'C');
    const others = bedroomFrags.filter(f => f.category !== 'C');

    // 按发生时间倒序
    cores.sort((a, b) => b.memoryTime - a.memoryTime);
    others.sort((a, b) => b.memoryTime - a.memoryTime);

    const html = [];

    if (cores.length > 0) {
      html.push(`<div class="vm-section-header" style="margin:8px 12px 4px;color:#ff9500;font-size:12px;font-weight:600;">💎 核心灵魂（永久）</div>`);
      for (const f of cores) html.push(this._renderBedroomCard(chat, f));
    }

    if (others.length > 0) {
      html.push(`<div class="vm-section-header" style="margin:8px 12px 4px;color:var(--text-secondary,#999);font-size:12px;font-weight:600;">其他记忆（按发生时间）</div>`);
      for (const f of others) html.push(this._renderBedroomCard(chat, f));
    }

    container.innerHTML = html.join('');
  }

  _renderBedroomCard(chat, frag) {
    const dateObj = new Date(frag.memoryTime);
    const tzOffset = dateObj.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(dateObj - tzOffset)).toISOString().slice(0,16);
    const ageDays = Math.floor((Date.now() - (frag.memoryTime || frag.createdAt || 0)) / (24 * 60 * 60 * 1000));
    const isCore = frag.category === 'C';

    return `
      <div class="vm-item-row ${isCore ? 'vm-item-core' : ''}" data-id="${frag.id}">
        <div class="vm-item-main">
          <span class="vm-item-content">${this._escapeHtml(frag.content)}</span>
          <div class="vm-item-meta">
            <input type="datetime-local" class="vm-time-picker" data-id="${frag.id}" value="${localISOTime}" title="修改记忆发生时间">
            <span class="vm-meta-tag">重要度:${frag.importance}</span>
            <span class="vm-meta-tag">召回 ${frag.recallCount || 0} 次</span>
            <span class="vm-meta-tag">${ageDays} 天前</span>
            ${frag.embedding ? '<span class="vm-meta-tag" title="已向量化">Vector✓</span>' : '<span class="vm-meta-tag" style="color:#ff9500">BM25</span>'}
          </div>
        </div>
        <div class="vm-item-actions">
          ${isCore ? '' : `<button class="vm-item-btn vm-pin-btn" data-id="${frag.id}">→ 核心</button>`}
          <button class="vm-item-btn vm-edit-frag-btn" data-id="${frag.id}">改</button>
          <button class="vm-item-btn vm-delete-frag-btn" data-id="${frag.id}" style="color:#ff3b30">删</button>
        </div>
      </div>
    `;
  }

  // 玄关列表渲染（卡片墙 + 复选框）
  _renderFoyerList(chat, foyerFrags, container) {
    if (foyerFrags.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; color: #999; padding: 40px 20px;">
          <p style="font-size: 16px; font-weight:bold; color:#666;">回收站是空的</p>
          <p style="font-size: 13px; margin-top: 5px;">保护期外且未被召回的记忆会先到这里。</p>
        </div>
      `;
      return;
    }

    // 按重要度升序（最不重要的先列）
    foyerFrags.sort((a, b) => (a.importance || 5) - (b.importance || 5));

    const html = foyerFrags.map(frag => {
      const ageDays = Math.floor((Date.now() - (frag.memoryTime || frag.createdAt || 0)) / (24 * 60 * 60 * 1000));
      return `
        <div class="vm-foyer-card" data-id="${frag.id}">
          <label class="vm-foyer-checkbox-wrap">
            <input type="checkbox" class="vm-foyer-checkbox" data-id="${frag.id}">
          </label>
          <div class="vm-foyer-card-body">
            <div class="vm-foyer-card-content">${this._escapeHtml(frag.content)}</div>
            <div class="vm-foyer-card-meta">
              <span class="vm-meta-tag">重要度 ${frag.importance || 5}</span>
              <span class="vm-meta-tag">召回 ${frag.recallCount || 0} 次</span>
              <span class="vm-meta-tag">${ageDays} 天前</span>
            </div>
          </div>
          <div class="vm-foyer-card-actions">
            <button class="vm-item-btn vm-save-bedroom-btn" data-id="${frag.id}" title="升级到核心 C 类" style="color:#ff9500">救回记忆库</button>
            <button class="vm-item-btn vm-delete-frag-btn" data-id="${frag.id}" style="color:#ff3b30">删</button>
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = html;
  }

  // ==================== 设置面板 ====================

  renderSettingsPanel(chat) {
    const vm = this.getVariableMemory(chat);
    const s = vm.settings;
    return `
      <div class="vm-settings-panel">
        <div class="vm-settings-group">
          <h4>提取与触发规则</h4>
          <div class="vm-setting-item">
            <label>多少条新消息自动提取一次？</label>
            <input type="number" id="vm-auto-interval" value="${s.autoExtractionMsgInterval || 20}" min="5" max="100" class="vm-input-full">
            <div style="font-size:11px;color:#999;margin-top:4px;">不用担心刷屏！现在基于绝对消息数量触发，严格锁定。</div>
          </div>
        </div>

        <div class="vm-settings-group">
          <h4>回收站规则（自动归类）</h4>
          <div class="vm-setting-item">
            <label>保护期天数（超过多少天 + 召回次数 ≤ 阈值 → 进回收站）</label>
            <input type="number" id="vm-foyer-days" value="${s.foyerDays || 60}" min="1" max="365" class="vm-input-full">
            <div style="font-size:11px;color:#999;margin-top:4px;">默认 60 天。所有未删记忆都参与召回，包括回收站里的。</div>
          </div>
          <div class="vm-setting-item" style="margin-top:8px;">
            <label>召回次数阈值</label>
            <input type="number" id="vm-foyer-threshold" value="${s.foyerRecallThreshold == null ? 0 : s.foyerRecallThreshold}" min="0" max="100" class="vm-input-full">
            <div style="font-size:11px;color:#999;margin-top:4px;">默认 0 —— 保护期内没被召回就进回收站。可调高（如 3）减少误判。</div>
          </div>
        </div>

        <div class="vm-settings-group">
          <h4>一键清理保护期</h4>
          <div class="vm-setting-item">
            <label>新提取的记忆多少天内不允许一键清理？</label>
            <input type="number" id="vm-cleanup-protect-days" value="${s.cleanupProtectDays || 60}" min="0" max="365" class="vm-input-full">
            <div style="font-size:11px;color:#999;margin-top:4px;">默认 60 天。保护期内的记忆即使召回次数少也不会被一键清理删除（核心 C 类和冻结的永远不受影响）。设 0 = 新记忆立即可清理。</div>
          </div>
          <div class="vm-setting-item" style="margin-top:8px;">
            <label>召回冷却时间（分钟）</label>
            <input type="number" id="vm-recall-cooldown" value="${s.recallCooldownMinutes || 30}" min="0" max="1440" class="vm-input-full">
            <div style="font-size:11px;color:#999;margin-top:4px;">默认 30 分钟。同一条记忆在此时间内重复被检索不重复计数（治"AI 后台主动发消息"导致 recallCount 假涨）。</div>
          </div>
        </div>

        <div class="vm-settings-group">
          <h4>检索引擎调参</h4>
          <div class="vm-setting-item">
            <label>每轮注入 AI 脑海的记忆数 (Top N)</label>
            <input type="number" id="vm-topn" value="${s.topN || 10}" min="1" max="30" class="vm-input-full">
          </div>
          <div class="vm-setting-item" style="margin-top:12px;">
            <label>多维打分权重分布（时间衰减已禁用）</label>
            <div class="vm-weights">
              <div><span>语义(Vector)</span><input type="number" id="vm-w-semantic" value="${s.scoreWeights.semantic}" step="0.1" class="vm-input-sm"></div>
              <div><span>字面(BM25)</span><input type="number" id="vm-w-keyword" value="${s.scoreWeights.keyword}" step="0.1" class="vm-input-sm"></div>
              <div><span>重要度(Importance)</span><input type="number" id="vm-w-importance" value="${s.scoreWeights.importance}" step="0.1" class="vm-input-sm"></div>
              <div><span>情绪(Emotion)</span><input type="number" id="vm-w-emotion" value="${s.scoreWeights.emotion}" step="0.1" class="vm-input-sm"></div>
            </div>
            <div style="font-size:11px;color:#999;margin-top:4px;">时间衰减已禁用 — 只要记忆存在，无论多久都参与召回。核心记忆(C类)永远是满分。</div>
          </div>
        </div>

        <div class="vm-settings-group">
          <h4>向量化端点</h4>
          <div style="font-size:12px;color:#666;margin-bottom:8px;">
            默认会用主/副 API 配置；如果装了没模型，选下面任一：
          </div>
          <div class="vm-preset-row">
            <button type="button" class="vm-preset-btn" data-preset="google">Google Gemini（免费额度大）</button>
            <button type="button" class="vm-preset-btn" data-preset="siliconflow">硅基流动（免费中文）</button>
            <button type="button" class="vm-preset-btn" data-preset="modelscope">魔搭（每天 2000 次免费）</button>
            <button type="button" class="vm-preset-btn" data-preset="qianfan">百度千帆（中文专精）</button>
            <button type="button" class="vm-preset-btn" data-preset="openai">OpenAI</button>
            <button type="button" class="vm-preset-btn" data-preset="custom">自定义</button>
          </div>
          <div style="font-size:11px;color:#999;margin-top:6px;">
            未勾选「自定义 Embedding」时，向量化默认走聊天设置的<strong>副 API</strong>（主聊天 API 渠道通常不带向量模型）。
          </div>
          <div style="font-size:12px;color:#8B5A00;background:#FFF7E6;border:1px solid #FFD591;border-radius:6px;padding:8px 10px;margin-top:8px;line-height:1.6;">
            <div>⭐ <strong>推荐</strong>：硅基流动 → <code style="background:rgba(0,0,0,0.05);padding:1px 4px;border-radius:3px;">BAAI/bge-m3</code>（中文 1024 维、9B 以下模型永久免费）</div>
            <div style="margin-top:4px;">⚠️ <strong>选好不要换</strong> —— 不同 embedding 模型的向量坐标系不同，混用会导致旧记忆召回失效（切模型 = 旧向量全部作废）</div>
          </div>
          <div class="vm-setting-row" style="margin-top:8px;">
            <span>开启自定义 Embedding</span>
            <label class="toggle-switch"><input type="checkbox" id="vm-custom-embedding" ${s.useCustomEmbedding ? 'checked' : ''}><span class="slider"></span></label>
          </div>
          <div id="vm-custom-embedding-fields" style="display:${s.useCustomEmbedding ? 'block' : 'none'}; margin-top:8px;">
            <input type="text" id="vm-embedding-endpoint" value="${s.embeddingEndpoint || ''}" placeholder="https://api.openai.com (如需拉取模型请确保地址以/v1结尾)" class="vm-input-full">
            <input type="password" id="vm-embedding-apikey" value="${s.embeddingApiKey || ''}" placeholder="API Key (留空则使用主设置的Key)" class="vm-input-full" style="margin-top:4px;">
            <div style="display:flex; gap:8px; margin-top:4px; position:relative;">
              <input type="text" id="vm-embedding-model" value="${s.embeddingModel || 'text-embedding-3-small'}" placeholder="Model Name" class="vm-input-full" style="flex:1;">
              <button id="vm-fetch-models-btn" class="vm-btn-secondary" style="white-space:nowrap; padding:0 12px;">拉取模型</button>
            </div>
            <div id="vm-models-list" style="display:none; max-height:200px; overflow-y:auto; background:var(--bg-color,#fff); border:1px solid var(--border-color,#eee); border-radius:8px; margin-top:4px; box-shadow:0 4px 12px rgba(0,0,0,0.1); position:absolute; z-index:100; width:calc(100% - 30px);"></div>
          </div>
        </div>

        <button id="vm-save-settings-btn" class="vm-btn-primary" style="width:100%;margin-top:12px;">保存设置</button>
      </div>
    `;
  }

  saveSettingsFromUI(chat) {
    const vm = this.getVariableMemory(chat);
    vm.settings.autoExtractionMsgInterval = parseInt(document.getElementById('vm-auto-interval')?.value) || 20;
    vm.settings.topN = parseInt(document.getElementById('vm-topn')?.value) || 10;
    vm.settings.foyerDays = parseInt(document.getElementById('vm-foyer-days')?.value) || 60;
    vm.settings.foyerRecallThreshold = parseInt(document.getElementById('vm-foyer-threshold')?.value) || 0;
    vm.settings.cleanupProtectDays = parseInt(document.getElementById('vm-cleanup-protect-days')?.value) || 60;
    vm.settings.recallCooldownMinutes = parseInt(document.getElementById('vm-recall-cooldown')?.value) || 30;
    vm.settings.scoreWeights = {
      semantic: parseFloat(document.getElementById('vm-w-semantic')?.value) || 0.45,
      keyword: parseFloat(document.getElementById('vm-w-keyword')?.value) || 0.3,
      importance: parseFloat(document.getElementById('vm-w-importance')?.value) || 0.2,
      emotion: parseFloat(document.getElementById('vm-w-emotion')?.value) || 0.05,
      recency: 0  // 时间衰减已禁用，固定 0
    };
    vm.settings.useCustomEmbedding = document.getElementById('vm-custom-embedding')?.checked || false;
    vm.settings.embeddingEndpoint = document.getElementById('vm-embedding-endpoint')?.value || '';
    vm.settings.embeddingApiKey = document.getElementById('vm-embedding-apikey')?.value || '';
    vm.settings.embeddingModel = document.getElementById('vm-embedding-model')?.value || 'text-embedding-3-small';
    
    if (vm._retrievalCache) vm._retrievalCache = { query: '', result: null, timestamp: 0, msgCount: 0 };
  }

  // ==================== 拉取可用模型 ====================
  async fetchAvailableModels(chat) {
    const vm = this.getVariableMemory(chat);
    const apiConfig = window.state?.apiConfig || {};

    // 获取当前界面上的设置
    const endpointInput = document.getElementById('vm-embedding-endpoint')?.value;
    const apiKeyInput = document.getElementById('vm-embedding-apikey')?.value;
    const isCustom = document.getElementById('vm-custom-embedding')?.checked;

    let endpoint = endpointInput;
    let apiKey = apiKeyInput;

    if (!isCustom || !endpoint) {
      // ===== 跟 embedding 走同一条路：固定走聊天副 API =====
      let resolved = null;
      if (typeof window.resolveApiSlotConfig === 'function') {
        resolved = await window.resolveApiSlotConfig('secondary')
          || await window.resolveApiSlotConfig('main'); // 副没配才退化主
      }
      if (resolved && resolved.proxyUrl && resolved.apiKey) {
        endpoint = resolved.proxyUrl;
        apiKey = resolved.apiKey;
      } else {
        // 兜底：从 state 读副 slot
        endpoint = apiConfig.secondaryProxyUrl || apiConfig.proxyUrl;
        apiKey = apiConfig.secondaryApiKey || apiConfig.apiKey;
      }
      // 自动修正 Google AI Studio endpoint 为 OpenAI 兼容 baseURL
      if (endpoint && (endpoint.includes('generativelanguage.googleapis.com') || endpoint.includes('googleapis.com'))) {
        const isAlreadyOpenAI = endpoint.includes('/v1beta/openai') || endpoint.endsWith('/openai');
        if (!isAlreadyOpenAI) {
          endpoint = 'https://generativelanguage.googleapis.com/v1beta/openai';
        }
      }
    } else {
      if (!apiKey) apiKey = apiConfig.apiKey; // 留空则回退到主配置
    }

    if (!endpoint || !apiKey) {
      throw new Error('未配置有效的端点或API Key');
    }

    try {
      let models = [];

      // 百度千帆特殊：没有 /v1/models，直接给手动列表
      if (endpoint.includes('qianfan.baidubce.com')) {
        models = ['bge-large-zh', 'bge-large-en', 'embedding-v1', 'tao-8k'];
        return models;
      }

      // 纯字符串拼接：用户填啥就在后面接 /models（不识别任何平台）
      const base = endpoint.replace(/\/+$/, '');
      const url = base + '/models';
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} @ ${url}`);
      const data = await response.json();
      if (!data || !data.data) throw new Error('API 返回格式异常');

      models = data.data.map(m => m.id).sort((a, b) => {
        // 将含有 embedding 的模型排在前面
        const aEmb = a.toLowerCase().includes('embed') || a.toLowerCase().includes('bge');
        const bEmb = b.toLowerCase().includes('embed') || b.toLowerCase().includes('bge');
        if (aEmb && !bEmb) return -1;
        if (!aEmb && bEmb) return 1;
        return a.localeCompare(b);
      });

      // ===== 谷歌 OpenAI 兼容端点特殊处理 =====
      // /v1/models 不列出 embedding 模型（Google API 设计），手动追加常见 embedding 模型
      if (endpoint.includes('generativelanguage')) {
        const googleEmbeddings = ['text-embedding-004', 'embedding-001'];
        googleEmbeddings.reverse().forEach(name => {
          if (!models.includes(name)) models.unshift(name);
        });
      }

      // ===== 魔搭 ModelScope 特殊处理 =====
      // 拉取列表里通常没 BGE 系列，手动追加常见 embedding 模型
      if (endpoint.includes('modelscope.cn')) {
        const modelscopeEmbeddings = ['BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5', 'BAAI/bge-large-en-v1.5'];
        modelscopeEmbeddings.reverse().forEach(name => {
          if (!models.includes(name)) models.unshift(name);
        });
      }

      return models;
    } catch (e) {
      throw new Error(e.message || '网络请求失败');
    }
  }

  // ==================== 便携小白教程 ====================

  renderGuide() {
    return `
      <div class="vm-guide">
        <div style="text-align:center; margin-bottom:20px;">
          <h3 style="font-size:18px; color:#333;">变量记忆 小白指南</h3>
          <p style="font-size:13px; color:#666;">彻底治愈 AI 的“失忆症”</p>
        </div>

        <div class="vm-guide-card">
          <div class="vm-guide-card-title">什么是“变量记忆”？</div>
          <p>它是原本“向量记忆”的究极进化版。你不用再管那些晦涩的“向量”、“语义”词汇，把它当成 AI 的**私人日记本**就行了。</p>
        </div>

        <div class="vm-guide-card">
          <div class="vm-guide-card-title">随意穿梭时间！(重磅功能)</div>
          <p>在记忆列表中，你看到那个日期框了吗？**点它！可以直接改！**</p>
          <p>把时间改到“10年前”，这就会成为你们十年前的初遇记忆；把时间改到“明天”，AI 就会知道这是你们明天的计划。</p>
        </div>

        <div class="vm-guide-card">
          <div class="vm-guide-card-title">它怎么自动记东西？</div>
          <p>什么都不用管！只要你在一直聊天，每聊满 20 句话（设置里可改），系统就会在后台悄悄把值得记住的事写进日记里。完全无感！</p>
        </div>

        <div class="vm-guide-card">
          <div class="vm-guide-card-title">什么是“核心灵魂”？</div>
          <p>分类为【C 核心灵魂】的记忆是无敌的！它们拥有最高权重，永远不会随时间衰减，AI 每一轮都会死死记住它。适合用来写你们的“终极人设”或“生死约定”。</p>
        </div>

        <div class="vm-guide-card">
          <div class="vm-guide-card-title">没配置 API 怎么办？</div>
          <p>完全没关系！如果向量化失败，系统会自动无缝切换为 **本地字面量（BM25）超强检索**，不仅不用消耗 API，找东西依然准得离谱。</p>
        </div>
      </div>
    `;
  }

  // 工具函数
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// 绑定全局变量（覆盖旧版，全面接管）
window.vectorMemoryManager = new VariableMemoryManager();
