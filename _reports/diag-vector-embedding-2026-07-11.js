// 用法：把这段代码复制到浏览器 console 跑一次
// 看下面每一段 console 输出的结果，贴回来

(async () => {
  console.log('===== 1) state.apiConfig 缓存（启动时同步的，可能过时）=====');
  console.log('主 API:', window.state?.apiConfig?.proxyUrl);
  console.log('主 key 前 8 位:', (window.state?.apiConfig?.apiKey || '').slice(0, 8));
  console.log('主 model:', window.state?.apiConfig?.model);
  console.log('副 API:', window.state?.apiConfig?.secondaryProxyUrl);
  console.log('副 key 前 8 位:', (window.state?.apiConfig?.secondaryApiKey || '').slice(0, 8));
  console.log('副 model:', window.state?.apiConfig?.secondaryModel);

  console.log('\n===== 2) resolveApiSlotConfig 实时解析（推荐看这个）=====');
  if (typeof window.resolveApiSlotConfig === 'function') {
    const main = await window.resolveApiSlotConfig('main');
    const sec = await window.resolveApiSlotConfig('secondary');
    console.log('主 slot:', main?.proxyUrl, '| preset=' + main?.presetId);
    console.log('副 slot:', sec?.proxyUrl, '| preset=' + sec?.presetId);
  } else {
    console.log('❌ resolveApiSlotConfig 不存在');
  }

  console.log('\n===== 3) 当前 chat 的 embedding 设置 =====');
  const chat = window.state?.chats?.[window.state?.activeChatId];
  const vm = window.vectorMemoryManager?.getVariableMemory(chat);
  console.log('useCustomEmbedding:', vm?.settings?.useCustomEmbedding);
  console.log('embeddingEndpoint:', vm?.settings?.embeddingEndpoint);
  console.log('embeddingModel:', vm?.settings?.embeddingModel);
  console.log('embeddingApiKey 前 8 位:', (vm?.settings?.embeddingApiKey || '').slice(0, 8));

  console.log('\n===== 4) 直接测一次 embedding 调用（用主副 slot 各自试）=====');
  if (typeof window.resolveApiSlotConfig === 'function') {
    for (const slotName of ['main', 'secondary']) {
      const c = await window.resolveApiSlotConfig(slotName);
      if (!c?.proxyUrl || !c?.apiKey) {
        console.log(`[${slotName}] 跳过（无端点或无 key）`);
        continue;
      }
      const base = c.proxyUrl.replace(/\/+$/, '');
      const url = base.endsWith('/v1') || base.endsWith('/v1beta/openai') || base.endsWith('/openai')
        ? base + '/embeddings'
        : base + '/v1/embeddings';
      const isGoogle = c.proxyUrl.includes('generativelanguage');
      const isSilicon = c.proxyUrl.includes('siliconflow.cn');
      const model = isGoogle ? 'text-embedding-004' : isSilicon ? 'BAAI/bge-m3' : 'text-embedding-3-small';
      console.log(`[${slotName}] 试调 ${url} (model=${model})`);
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${c.apiKey}` },
          body: JSON.stringify({ model, input: '测试 embedding' })
        });
        const text = await r.text();
        console.log(`  HTTP ${r.status}: ${text.slice(0, 300)}`);
      } catch (e) {
        console.log(`  异常: ${e.message}`);
      }
    }
  }

  console.log('\n===== 5) 直接测 chat completions 提取（模拟 executeVectorExtraction）=====');
  if (typeof window.resolveApiSlotConfig === 'function') {
    const sec = await window.resolveApiSlotConfig('secondary');
    if (sec?.proxyUrl) {
      const isNative = sec.proxyUrl.includes('generativelanguage') && !sec.proxyUrl.includes('/v1beta/openai') && !sec.proxyUrl.endsWith('/openai');
      const url = isNative
        ? `https://generativelanguage.googleapis.com/v1beta/models/${sec.model || 'gemini-1.5-flash'}:generateContent?key=${sec.apiKey}`
        : (sec.proxyUrl.endsWith('/v1') ? `${sec.proxyUrl}/chat/completions` : `${sec.proxyUrl}/v1/chat/completions`);
      console.log(`[副 API chat] ${url} (isNative=${isNative})`);
      try {
        const r = await fetch(url, isNative ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: '说 ok' }] }] })
        } : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sec.apiKey}` },
          body: JSON.stringify({ model: sec.model, messages: [{ role: 'user', content: '说 ok' }] })
        });
        const text = await r.text();
        console.log(`  HTTP ${r.status}: ${text.slice(0, 300)}`);
      } catch (e) {
        console.log(`  异常: ${e.message}`);
      }
    }
  }

  console.log('\n===== 诊断完成，把上面所有 console 输出贴回来 =====');
})();
