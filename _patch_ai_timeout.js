const fs = require('fs');

function read(path) {
  return fs.readFileSync(path, 'utf8');
}
function write(path, content) {
  fs.writeFileSync(path, content, 'utf8');
}
function replaceOnce(content, search, replacement, label) {
  if (!content.includes(search)) {
    throw new Error(`Missing search block: ${label}`);
  }
  return content.replace(search, replacement);
}
function replaceRegex(content, regex, replacement, label) {
  const pattern = typeof regex === 'string' ? new RegExp(regex) : regex;
  if (!pattern.test(content)) {
    throw new Error(`Missing regex block: ${label}`);
  }
  return content.replace(pattern, replacement);
}

let ai = read('modules/ai-response.js');

const helper = `
  const AI_FIRST_CHUNK_TIMEOUT_MS = 30000;
  const AI_TOTAL_TIMEOUT_MS = 120000;
  const AI_TIMEOUT_MESSAGE = 'AI 请求超时，已自动停止生成';
  const AI_ABORT_MESSAGE = '用户停止生成';
  const AI_GENERATING_STATUSES = new Set(['generating', 'pending', 'streaming', 'loading']);

  let currentAiGenerationController = null;
  let currentAiGenerationState = null;

  function aiRuntimeLog(event, payload = {}) {
    try {
      window.runtimeDiag?.log?.(event, payload);
    } catch (error) {
      console.warn('[AI诊断日志失败]', event, error);
    }
  }

  function setGlobalAiGenerationFlags(active) {
    window.isGenerating = !!active;
    window.inFlight = !!active;
    window.streaming = !!active;
    window.generating = !!active;
    if (window.state) {
      window.state.isGenerating = !!active;
      window.state.inFlight = !!active;
      window.state.streaming = !!active;
      window.state.generating = !!active;
    }
  }

  function getStopGenerationButton() {
    return document.getElementById('stop-api-call-btn');
  }

  function updateStopGenerationButtonVisibility() {
    const stopBtn = getStopGenerationButton();
    if (!stopBtn) return;
    const shouldShow = !!(
      window.isGenerating ||
      window.inFlight ||
      window.streaming ||
      window.generating ||
      window.state?.isGenerating ||
      window.state?.inFlight ||
      window.state?.streaming ||
      window.state?.generating ||
      currentAiGenerationController
    );
    stopBtn.style.display = shouldShow ? 'flex' : 'none';
    stopBtn.classList.toggle('active', shouldShow);
  }

  function restoreAiInputControls() {
    [
      '#chat-message-input',
      '#message-input',
      '#wait-reply-btn',
      '#send-message-btn',
      '#send-btn',
      '#ai-reply-btn'
    ].forEach(selector => {
      const el = document.querySelector(selector);
      if (el && 'disabled' in el) el.disabled = false;
    });
  }

  function clearAiGenerationTimers(requestState) {
    if (!requestState) return;
    if (requestState.firstChunkTimer) {
      clearTimeout(requestState.firstChunkTimer);
      requestState.firstChunkTimer = null;
    }
    if (requestState.totalTimer) {
      clearTimeout(requestState.totalTimer);
      requestState.totalTimer = null;
    }
  }

  function markFirstAiChunk(requestState = currentAiGenerationState) {
    if (!requestState || requestState.firstChunkReceived) return;
    requestState.firstChunkReceived = true;
    if (requestState.firstChunkTimer) {
      clearTimeout(requestState.firstChunkTimer);
      requestState.firstChunkTimer = null;
    }
    aiRuntimeLog('AI_REQUEST_FIRST_CHUNK', { chatId: requestState.chatId });
  }

  function beginAiGenerationRequest(chatId) {
    if (currentAiGenerationController) {
      console.warn('[AI请求] 发现未结束请求，已先中止旧请求');
      aiRuntimeLog('AI_REQUEST_ABORT', { chatId, reason: 'abort_previous_inflight' });
      try {
        currentAiGenerationController.abort();
      } catch (error) {
        console.warn('[AI请求] 中止旧请求失败:', error);
      }
      cleanupAiGenerationState(currentAiGenerationState, { skipMessageStatus: true });
    }

    const controller = new AbortController();
    const requestState = {
      chatId,
      controller,
      firstChunkReceived: false,
      timedOut: false,
      timeoutType: '',
      userAborted: false,
      completed: false,
      success: false,
      errorMessage: '',
      assistantMessage: null,
      firstChunkTimer: null,
      totalTimer: null
    };

    controller.signal.addEventListener('abort', () => {
      aiRuntimeLog('AI_REQUEST_ABORT', {
        chatId,
        reason: requestState.timedOut ? requestState.timeoutType : (requestState.userAborted ? 'user' : 'abort')
      });
    }, { once: true });

    requestState.firstChunkTimer = setTimeout(() => {
      if (requestState.completed || requestState.firstChunkReceived || controller.signal.aborted) return;
      requestState.timedOut = true;
      requestState.timeoutType = 'first_chunk';
      requestState.errorMessage = AI_TIMEOUT_MESSAGE;
      aiRuntimeLog('AI_REQUEST_TIMEOUT_FIRST_CHUNK', { chatId, timeoutMs: AI_FIRST_CHUNK_TIMEOUT_MS });
      controller.abort();
    }, AI_FIRST_CHUNK_TIMEOUT_MS);

    requestState.totalTimer = setTimeout(() => {
      if (requestState.completed || controller.signal.aborted) return;
      requestState.timedOut = true;
      requestState.timeoutType = 'total';
      requestState.errorMessage = AI_TIMEOUT_MESSAGE;
      aiRuntimeLog('AI_REQUEST_TIMEOUT_TOTAL', { chatId, timeoutMs: AI_TOTAL_TIMEOUT_MS });
      controller.abort();
    }, AI_TOTAL_TIMEOUT_MS);

    currentAiGenerationController = controller;
    currentAiGenerationState = requestState;
    setGlobalAiGenerationFlags(true);
    updateStopGenerationButtonVisibility();
    aiRuntimeLog('AI_REQUEST_START', { chatId });
    return requestState;
  }

  function getCurrentAiSignal() {
    return currentAiGenerationController?.signal;
  }

  function withCurrentAiSignal(options = {}) {
    const signal = getCurrentAiSignal();
    return signal ? { ...options, signal } : options;
  }

  function stopCurrentAiGeneration() {
    if (!currentAiGenerationController) return;
    if (currentAiGenerationState) {
      currentAiGenerationState.userAborted = true;
      currentAiGenerationState.errorMessage = AI_ABORT_MESSAGE;
    }
    currentAiGenerationController.abort();
  }

  function installStopGenerationHandler() {
    const stopBtn = getStopGenerationButton();
    if (!stopBtn || stopBtn.dataset.aiAbortBound === 'true') return;
    stopBtn.dataset.aiAbortBound = 'true';
    stopBtn.addEventListener('click', stopCurrentAiGeneration);
  }

  function markAssistantMessageFinal(requestState, status, errorText) {
    const msg = requestState?.assistantMessage;
    if (!msg) return;
    const msgStatus = msg.status || (msg.isStreaming ? 'streaming' : '');
    if (!msgStatus || AI_GENERATING_STATUSES.has(msgStatus) || msg.isStreaming || msg.isTemporary) {
      msg.status = status;
      msg.error = errorText;
      msg.isStreaming = false;
      msg.isTemporary = false;
    }
  }

  function cleanupAiGenerationState(requestState, options = {}) {
    if (requestState) {
      requestState.completed = true;
      clearAiGenerationTimers(requestState);
    }
    if (!options.skipMessageStatus && requestState && !requestState.success) {
      if (requestState.userAborted) {
        markAssistantMessageFinal(requestState, 'stopped', AI_ABORT_MESSAGE);
      } else if (requestState.timedOut) {
        markAssistantMessageFinal(requestState, 'failed', AI_TIMEOUT_MESSAGE);
      } else {
        markAssistantMessageFinal(requestState, 'failed', requestState.errorMessage || 'AI 回复生成失败');
      }
    }
    if (!requestState || currentAiGenerationController === requestState.controller) {
      currentAiGenerationController = null;
      currentAiGenerationState = null;
    }
    setGlobalAiGenerationFlags(false);
    restoreAiInputControls();
    updateStopGenerationButtonVisibility();
    aiRuntimeLog('AI_GENERATION_STATE_RESET', { chatId: requestState?.chatId });
    aiRuntimeLog('AI_REQUEST_FINALLY', { chatId: requestState?.chatId });
  }

  window.stopCurrentAiGeneration = stopCurrentAiGeneration;
  window.updateStopGenerationButtonVisibility = updateStopGenerationButtonVisibility;
  window.getCurrentAiGenerationController = () => currentAiGenerationController;

`;

if (!ai.includes('const AI_FIRST_CHUNK_TIMEOUT_MS = 30000;')) {
  ai = ai.replace(/(\/\/ ============================================================\r?\n)/, `$1${helper}`);
}

ai = replaceOnce(ai,
`  async function fetchStreamingResponse(url, options, onDelta) {
    const response = await fetch(url, options);`,
`  async function fetchStreamingResponse(url, options, onDelta, hooks = {}) {
    const response = await fetch(url, options);
    hooks.onFirstChunk?.(response);`,
'fetchStreamingResponse signature');
ai = replaceOnce(ai,
`      const text = await response.text();
      onDelta(text);`,
`      const text = await response.text();
      hooks.onFirstChunk?.(text);
      onDelta(text);`,
'non-body first chunk');
ai = replaceOnce(ai,
`      if (done) break;
      buffer += decoder.decode(value, { stream: true });`,
`      if (done) break;
      hooks.onFirstChunk?.(value);
      buffer += decoder.decode(value, { stream: true });`,
'reader first chunk');

ai = replaceOnce(ai,
`  async function triggerAiResponse() {
    if (!state.activeChatId) return;
    const chatId = state.activeChatId;
    const chat = state.chats[state.activeChatId];`,
`  async function triggerAiResponse() {
    installStopGenerationHandler();
    if (!state.activeChatId) return;
    const chatId = state.activeChatId;
    const chat = state.chats[state.activeChatId];
    const aiRequestState = beginAiGenerationRequest(chatId);`,
'trigger begin controller');

ai = ai.replace(/await fetch\(geminiConfig\.url, geminiConfig\.data\)/g, 'await fetch(geminiConfig.url, withCurrentAiSignal(geminiConfig.data))');

ai = replaceRegex(ai,
`response = await fetch\\(geminiConfig\\.url, \\{\\s*\\.\\.\\.geminiConfig\\.data,\\s*signal: currentApiController\\.signal\\s*\\}\\);`,
`response = await fetch(geminiConfig.url, withCurrentAiSignal(geminiConfig.data));
          markFirstAiChunk(aiRequestState);`,
'main gemini fetch');

ai = replaceRegex(ai,
/\s*\/\/[^\n\r]*AbortController[\s\S]*?const stopBtn = document\.getElementById\('stop-api-call-btn'\);\s*if \(stopBtn\) \{\s*stopBtn\.style\.display = 'flex';\s*stopBtn\.classList\.add\('active'\);\s*\}/,
`
      const currentApiController = currentAiGenerationController;
      const stopBtn = getStopGenerationButton();
      updateStopGenerationButtonVisibility();`,
'remove old controller block');

ai = replaceOnce(ai,
`      let response;
      let responseJsonData = null;
      let aiResponseContent = '';
      let placeholderMessage = null;`,
`      let response;
      let responseJsonData = null;
      let aiResponseContent = '';
      let placeholderMessage = null;
      const markRequestFirstChunk = () => markFirstAiChunk(aiRequestState);`,
'main vars mark function');

ai = replaceOnce(ai,
`              isStreaming: true,
              isTemporary: true
            };`,
`              isStreaming: true,
              isTemporary: true,
              status: 'streaming'
            };
            aiRequestState.assistantMessage = placeholderMessage;`,
'placeholder status');

ai = replaceRegex(ai,
/(\}, \(chunk\) => \{\s*)(console\.log\([^\r\n]*chunk[^\r\n]*\);\s*placeholderMessage\.content \+= chunk;)/,
`$1                markRequestFirstChunk();
                $2`,
'stream chunk first');
ai = replaceOnce(ai,
`              });
            } catch (streamError) {`,
`              }, { onFirstChunk: markRequestFirstChunk });
            } catch (streamError) {`,
'stream hooks');

ai = replaceRegex(ai,
/\}\s*catch \(networkError\) \{[\s\S]*?\} finally \{\s*currentApiController = null;\s*clearTimeout\(timeoutId\);[^\n\r]*\s*if \(stopBtn\) \{\s*stopBtn\.style\.display = 'none';\s*stopBtn\.classList\.remove\('active'\);\s*\}\s*\}/,
`} catch (networkError) {
        if (networkError.name === 'AbortError') {
          if (aiRequestState.timedOut) {
            aiRequestState.errorMessage = AI_TIMEOUT_MESSAGE;
            throw new Error(AI_TIMEOUT_MESSAGE);
          }
          if (aiRequestState.userAborted) {
            aiRequestState.errorMessage = AI_ABORT_MESSAGE;
            console.log('API调用已被用户取消');
            throw new Error(AI_ABORT_MESSAGE);
          }
        }
        aiRequestState.errorMessage = \`网络请求失败: \${networkError.message}\`;
        aiRuntimeLog('AI_REQUEST_ERROR', { chatId, message: networkError.message, name: networkError.name });
        throw new Error(\`网络请求失败: \${networkError.message}\`);
      } finally {
        updateStopGenerationButtonVisibility();
      }`,
'network catch finally');

ai = replaceOnce(ai,
`      if (!aiResponseContent) {
        if (!response.ok) {`,
`      if (response) {
        markRequestFirstChunk();
      }

      if (!aiResponseContent) {
        if (!response) {
          throw new Error(aiRequestState.errorMessage || 'AI 请求未返回响应');
        }
        if (!response.ok) {`,
'response guard');

ai = replaceOnce(ai,
`        try {
          responseJsonData = await response.json();`,
`        try {
          markRequestFirstChunk();
          responseJsonData = await response.json();`,
'json first chunk');
ai = replaceOnce(ai,
`          const responseText = await response.text();`,
`          markRequestFirstChunk();
          const responseText = await response.text();`,
'text first chunk');

ai = replaceOnce(ai,
`      window.runtimeDiag?.markEnd('AI_REQUEST', 'AI_REQUEST_DONE', {
        chatId,
        status: response ? response.status : 'streaming',
        hasResponse: !!aiResponseContent
      });`,
`      aiRequestState.success = true;
      window.runtimeDiag?.markEnd('AI_REQUEST', 'AI_REQUEST_DONE', {
        chatId,
        status: response ? response.status : 'streaming',
        hasResponse: !!aiResponseContent
      });`,
'success flag');

ai = replaceOnce(ai,
`    } finally {
      window.runtimeDiag?.log('AI_REQUEST_FINALLY', { chatId });
      setAvatarActingState(chatId, false);`,
`    } finally {
      cleanupAiGenerationState(aiRequestState);
      setAvatarActingState(chatId, false);`,
'outer finally');

write('modules/ai-response.js', ai);

let chatInterface = read('modules/chat-interface.js');
const staleHelper = `
  async function recoverStaleAiGenerationMessages(chat) {
    if (!chat || !Array.isArray(chat.history)) return;
    const staleStatuses = new Set(['generating', 'pending', 'streaming', 'loading']);
    const cutoff = Date.now() - 5 * 60 * 1000;
    let changed = false;

    for (const msg of chat.history) {
      if (!msg || msg.role !== 'assistant') continue;
      const status = msg.status || (msg.isStreaming ? 'streaming' : '');
      if (!staleStatuses.has(status)) continue;
      const ts = Number(msg.timestamp || 0);
      if (!ts || ts > cutoff) continue;
      msg.status = 'failed';
      msg.error = '上次生成异常中断，已自动恢复';
      msg.isStreaming = false;
      msg.isTemporary = false;
      changed = true;
      try {
        window.runtimeDiag?.log?.('AI_STALE_GENERATION_RECOVERED', { chatId: chat.id, messageTimestamp: msg.timestamp, status });
      } catch (error) {
        console.warn('[AI诊断日志失败] AI_STALE_GENERATION_RECOVERED', error);
      }
    }

    if (changed) {
      try {
        await db.chats.put(chat);
      } catch (error) {
        console.warn('[AI状态恢复] 保存陈旧生成消息状态失败:', error);
      }
    }
  }

`;
if (!chatInterface.includes('recoverStaleAiGenerationMessages')) {
  chatInterface = replaceOnce(chatInterface, `  async function renderChatInterface(chatId) {`, `${staleHelper}  async function renderChatInterface(chatId) {`, 'insert stale helper');
  chatInterface = replaceOnce(chatInterface,
`      if (!chat) {
        window.runtimeDiag?.markEnd('RENDER_CHAT', 'RENDER_CHAT_DONE', { chatId, skipped: true });
        return;
      }

    exitSelectionMode();`,
`      if (!chat) {
        window.runtimeDiag?.markEnd('RENDER_CHAT', 'RENDER_CHAT_DONE', { chatId, skipped: true });
        return;
      }

      await recoverStaleAiGenerationMessages(chat);

    exitSelectionMode();`,
'call stale recovery');
}
write('modules/chat-interface.js', chatInterface);

let sw = read('sw.js');
sw = sw.replace(/const CACHE_VERSION = 'v0\\.0\\.\\d+';/, `const CACHE_VERSION = 'v0.0.40';`);
write('sw.js', sw);
