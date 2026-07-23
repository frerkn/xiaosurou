// 330 项目 - 拦截 fetch 抓 AI 真正收到的 system prompt
// 2026-07-17 v1 - 一次性 hook, 跑一次只能看一条 AI 请求
// 用法: 粘贴到 console → 立刻发一条消息 → 看打印的 system 全文
(function() {
  if (window._diagSystemPromptHooked) {
    console.warn('⚠️  已经在 hook 状态, 直接发消息即可');
    return;
  }
  window._diagSystemPromptHooked = true;

  const origFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    // 只拦 /chat/completions 类请求 (主/副 API 都是这个路径)
    if (init?.method === 'POST' && init?.body && /\/chat\/completions|\/v1\/messages/i.test(url)) {
      try {
        const body = JSON.parse(init.body);
        const sysMsg = body.messages?.find(m => m.role === 'system');
        if (sysMsg) {
          const content = typeof sysMsg.content === 'string' ? sysMsg.content : JSON.stringify(sysMsg.content);
          console.log('\n🔍 ====== AI 真正收到的 system prompt (前 6000 字) ======');
          console.log('请求 URL:', url);
          console.log('总长度:', content.length, '字');
          console.log('---');
          console.log(content.slice(0, 6000));
          console.log('---');
          // 关键: 标出"记忆段"在哪 + 包含哪些 fragment
          const memIdx = content.indexOf('你的近期真实记忆');
          const ltmIdx = content.indexOf('长期记忆');
          if (memIdx >= 0) {
            const end = content.indexOf('---', memIdx);
            console.log(`\n✅ 找到"你的近期真实记忆"段 @ 位置 ${memIdx}, 长度 ${end > 0 ? end - memIdx : '?'} 字`);
            // 抽出"记忆段"单独看
            console.log('---记忆段独立打印 (前 2000 字)---');
            console.log(content.slice(memIdx, Math.min(end > 0 ? end : memIdx + 2000, memIdx + 2000)));
            console.log('---end---');
          } else {
            console.warn('❌ prompt 里【没有】"你的近期真实记忆" 段! 记忆没塞进去');
          }
          if (ltmIdx >= 0) {
            const snippet = content.slice(ltmIdx, ltmIdx + 500);
            console.log('\n📋 长期记忆段前 500 字:', snippet);
          } else {
            console.log('\nℹ️  prompt 里没有"长期记忆"段 (说明 diaryStr 是 (暂无), 已被新逻辑跳过)');
          }
        }
      } catch (e) { /* ignore parse error */ }
    }
    return origFetch(input, init);
  };
  console.log('✅ fetch hook 已挂载, 现在发一条消息, 我会打印 AI 真正收到的 system prompt');
  // 5 分钟自动卸载, 避免永久污染
  setTimeout(() => { window.fetch = origFetch; window._diagSystemPromptHooked = false; console.log('⏱️ 5 分钟到, hook 自动卸载'); }, 5 * 60 * 1000);
})();
