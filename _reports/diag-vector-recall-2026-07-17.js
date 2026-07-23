// 330 项目 - 变量记忆召回诊断 v2
// 2026-07-17 - 自动用最近 user 消息作为 query, 还原刚才那次真实检索
// 用法: 跟 AI 聊完发现"一无所知" → 立刻打开 console → 粘贴运行
(function() {
  const chat = window.state?.currentChatId ? window.state.chats[window.state.currentChatId] : null;
  if (!chat) { console.error('❌ 未找到当前聊天 (window.state.currentChatId 为空)'); return; }
  const vmm = window.vectorMemoryManager;
  if (!vmm) { console.error('❌ vectorMemoryManager 未加载, 检查 script.js 里是否漏引这个文件'); return; }

  // 自动拿最近一条 user 消息作为 query (跟线上流程一致)
  const lastUserMsg = [...(chat.history || [])].reverse().find(m => m.role === 'user');
  const query = (lastUserMsg?.content || '').toString().slice(0, 200) || '你还记得我最喜欢什么吗';
  console.log('🔍 自动取最近 user 消息作为 query:', JSON.stringify(query));

  const vm = vmm.getVariableMemory(chat);
  console.log('\n=== 1. 变量记忆库概览 ===');
  console.log('聊天:', chat.name, '| fragments:', vm.fragments.length, '| topN:', vm.settings.topN);
  console.log('settings:', JSON.stringify({
    topN: vm.settings.topN,
    retrievalStrategy: vm.settings.retrievalStrategy,
    retrievalCacheEnabled: vm.settings.retrievalCacheEnabled,
    scoreWeights: vm.settings.scoreWeights
  }, null, 2));

  console.log('\n=== 2. embedding 健康度 ===');
  let 有 = 0, 缺 = 0, 维度异常 = 0;
  vm.fragments.forEach((f, i) => {
    if (!f.embedding) 缺++;
    else if (!Array.isArray(f.embedding) || f.embedding.length < 100) 维度异常++;
    else 有++;
  });
  console.log(`有 embedding: ${有} | 缺失: ${缺} | 维度异常: ${维度异常}`);
  if (缺 > 0) console.warn(`⚠️  ${缺} 条记忆没有 embedding, 这些全部只能靠 BM25 关键词检索, 语义召回 = 0`);

  console.log('\n=== 3. 模拟线上流程的 queryText (取 filteredHistory 末 5 条) ===');
  const fakeQuery = (chat.history || []).slice(-5).map(m => typeof m.content === 'string' ? m.content : '').join(' ').slice(0, 300);
  console.log('线上 queryText 拼出来大概是:', JSON.stringify(fakeQuery));
  console.log('(老消息 m.content 若是 JSON 数组字符串, 这里会是一坨 [{...}])');

  console.log('\n=== 4. 用你的真实 query 跑检索 ===');
  vmm.retrieveRelevant(chat, query, 10).then(results => {
    console.log(`返回 ${results.length} 条:`);
    if (results.length === 0) {
      console.error('❌ 0 条 → 要么 fragments 是空的, 要么全部 score ≤ 0.1 被过滤');
    } else {
      results.forEach((r, i) => {
        const f = r.fragment;
        const embStatus = f.embedding ? `emb✓(${f.embedding.length}维)` : 'emb✗';
        console.log(`  [${i+1}] score=${r.score.toFixed(3)} cat=${f.category||'?'} imp=${f.importance||5} ${embStatus} | ${f.content.slice(0, 60)}...`);
      });
    }

    console.log('\n=== 5. 线上 prompt 真实拼接 (buildMemoryContext) ===');
    return vmm.buildMemoryContext(chat, chat.settings?.memoryMode || 'diary', query);
  }).then(ctx => {
    console.log('---发到 AI 的记忆片段 (前 2000 字) ---');
    console.log(ctx.slice(0, 2000));
    console.log('---end---');
    if (ctx.includes('(暂无)')) {
      console.error('❌ 拼出来的内容是 "(暂无)", AI 确实没收到任何记忆');
    } else if (ctx.includes('向量回闪') || ctx.includes('回闪记忆')) {
      console.log('✅ 至少向量回闪/核心记忆这一段被注入了');
    }
  }).catch(e => console.error('诊断脚本异常:', e));
})();
