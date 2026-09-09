// ============================================================
// 聊天图片识图：统一走识图 API，生成描述供后续对话使用（不降级保留原图进上下文）
// ============================================================

(function () {
  const DEFAULT_VISION_PROMPT =
    '请详细描述这张图片的内容，包括画面元素、文字信息、布局结构和关键细节。';

  const visionInflight = new Map();

  function getDefaultVisionPrompt() {
    return DEFAULT_VISION_PROMPT;
  }

  function getVisionPromptFromConfig() {
    const p = state.apiConfig && state.apiConfig.visionPrompt;
    if (p != null && String(p).trim()) return String(p).trim();
    return DEFAULT_VISION_PROMPT;
  }

  /** 专用识图配置优先，否则回退主 API（与识图区「留空使用主API」一致） */
  async function resolveVisionEndpoints() {
    if (typeof resolveApiSlotConfig === 'function') {
      const resolved = await resolveApiSlotConfig('vision');
      if (resolved && resolved.proxyUrl && resolved.apiKey && resolved.model) {
        return resolved;
      }
    }

    const ac = state.apiConfig || {};
    const vUrl = (ac.visionProxyUrl || '').trim();
    const vKey = (ac.visionApiKey || '').trim();
    const vModel = (ac.visionModel || '').trim();
    if (vUrl && vKey && vModel) {
      return { proxyUrl: vUrl, apiKey: vKey, model: vModel };
    }
    return {
      proxyUrl: (ac.proxyUrl || '').trim(),
      apiKey: (ac.apiKey || '').trim(),
      model: (ac.model || '').trim()
    };
  }

  /**
   * @param {string} imageUrl — data URL 或 http(s) URL
   * @returns {{ ok: boolean, description?: string, error?: string }}
   */
  async function describeImageWithVisionApi(imageUrl) {
    const { proxyUrl, apiKey, model } = await resolveVisionEndpoints();
    if (!proxyUrl || !apiKey || !model) {
      return {
        ok: false,
        error: '请先在 API 设置中配置识图 API（或完整配置主 API）：反代地址、密钥与模型。'
      };
    }
    if (!imageUrl || typeof imageUrl !== 'string') {
      return { ok: false, error: '无效的图片数据。' };
    }

    const visionPrompt = getVisionPromptFromConfig();
    const baseGemini =
      proxyUrl.includes('generativelanguage') || proxyUrl === GEMINI_API_URL;

    try {
      let description = '';
      if (baseGemini) {
        const base64Data = imageUrl.split(',')[1];
        const mimeTypeMatch = imageUrl.match(/^data:(.*);base64/);
        if (!mimeTypeMatch || !base64Data) {
          return {
            ok: false,
            error: 'Gemini 识图需要 data:image/*;base64 格式的图片。'
          };
        }
        const vPayload = {
          contents: [
            {
              parts: [
                { text: visionPrompt },
                { inline_data: { mime_type: mimeTypeMatch[1], data: base64Data } }
              ]
            }
          ]
        };
        const vResp = await fetch(
          `${proxyUrl}/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(vPayload)
          }
        );
        if (!vResp.ok) {
          let errMsg = `HTTP ${vResp.status}`;
          try {
            const errData = await vResp.json();
            errMsg =
              errData?.error?.message ||
              errData?.message ||
              JSON.stringify(errData);
          } catch (e) {
            errMsg += ` ${vResp.statusText || ''}`;
          }
          return { ok: false, error: errMsg };
        }
        const vData = await vResp.json();
        description = getGeminiResponseText(vData) || '';
      } else {
        const vPayload = {
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: visionPrompt },
                { type: 'image_url', image_url: { url: imageUrl } }
              ]
            }
          ],
          max_tokens: 1024
        };
        const normalizedProxyUrl = proxyUrl.replace(/\/+$/, '');
        const vResp = await fetch(`${normalizedProxyUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(vPayload)
        });
        if (!vResp.ok) {
          let errMsg = `HTTP ${vResp.status}`;
          try {
            const errData = await vResp.json();
            errMsg =
              errData?.error?.message ||
              errData?.message ||
              JSON.stringify(errData);
          } catch (e) {
            errMsg += ` ${vResp.statusText || ''}`;
          }
          return { ok: false, error: errMsg };
        }
        const vData = await vResp.json();
        description = vData.choices?.[0]?.message?.content || '';
      }

      const trimmed = (description || '').trim();
      if (!trimmed) {
        return { ok: false, error: '识图 API 返回了空描述。' };
      }
      return { ok: true, description: trimmed };
    } catch (e) {
      return {
        ok: false,
        error: e && e.message ? e.message : String(e)
      };
    }
  }

  async function updateVisionMessageState(chatId, timestamp, updater) {
    if (window.messageStore?.updateMessage) {
      return window.messageStore.updateMessage(chatId, timestamp, updater);
    }

    const chat = state.chats[chatId];
    if (!chat?.history) return null;

    const msg = chat.history.find((m) => Number(m.timestamp) === Number(timestamp));
    if (!msg) return null;

    const updated =
      typeof updater === 'function'
        ? updater(msg) || msg
        : Object.assign(msg, updater || {});

    await db.chats.put(chat);
    return updated;
  }

  async function getVisionMessage(chatId, timestamp) {
    if (window.messageStore?.getMessageByTimestamp) {
      return window.messageStore.getMessageByTimestamp(chatId, timestamp);
    }
    return (
      state.chats[chatId]?.history?.find(
        (m) => Number(m.timestamp) === Number(timestamp)
      ) || null
    );
  }

  async function executeVisionRecognition(chatId, timestamp) {
    const chat = state.chats[chatId];
    if (!chat) return;

    const msg = await getVisionMessage(chatId, timestamp);
    if (
      !msg ||
      !Array.isArray(msg.content) ||
      msg.content[0]?.type !== 'image_url'
    ) {
      return;
    }

    // 【防御性修复】如果消息已经识图完成，绝不重跑——既不删 description 也不重调 API。
    // 兜底处理 visionInflight 失效（finally 微任务 delete 与用户操作之间的微小窗口）
    // 或并发 ensureChatImagesVisionReady 调用导致的误触发。
    // 注意：手动 retry 路径（retryVisionRecognitionForChatMessage）会先把 status 重置为 'pending'
    // 再调到这里，所以不会被这个判断挡住。
    if (msg.imageVisionStatus === 'done' && msg.imageDescription) {
        return;
    }

    const imageUrl = msg.content[0].image_url && msg.content[0].image_url.url;
    if (!imageUrl) {
      await updateVisionMessageState(chatId, timestamp, (draft) => {
        draft.imageVisionStatus = 'failed';
        draft.imageVisionError = '缺少图片地址。';
        draft.imageProcessed = false;
        delete draft.imageDescription;
        return draft;
      });
      if (typeof window.refreshImageVisionUi === 'function') {
        window.refreshImageVisionUi(chatId, timestamp);
      }
      return;
    }

    // 【修复】只保留这一个 update：把 status 设为 pending，删 error，但**不删 description**
    // 原因：之前有两个连续 update，第一个无条件 `delete draft.imageDescription`，
    // 即使后面那个注释说"不再删"也救不回来——description 已经被第一个 update 删掉了。
    // 现在只剩一个：description 只有在 success / failed 路径里被显式覆盖。
    // 这保证如果代码路径"误触发"（例如 ensureChatImagesVisionReady 的 stale history 读到 pending），
    // 旧的 description 不会被短暂清掉，UI 不会闪"识别中..."，行 210 防御检查也不会被绕过。
    await updateVisionMessageState(chatId, timestamp, (draft) => {
      draft.imageVisionStatus = 'pending';
      draft.imageProcessed = false;
      delete draft.imageVisionError;
      // 保留 draft.imageDescription（旧值），等 fetch 回来再用 result.description 覆盖
      return draft;
    });
    if (typeof window.refreshImageVisionUi === 'function') {
      window.refreshImageVisionUi(chatId, timestamp);
    }

    const result = await describeImageWithVisionApi(imageUrl);
    const msgFresh = await getVisionMessage(chatId, timestamp);
    if (!msgFresh) return;

    if (result.ok && result.description) {
      await updateVisionMessageState(chatId, timestamp, (draft) => {
        draft.imageVisionStatus = 'done';
        draft.imageProcessed = true;
        draft.imageDescription = result.description;
        delete draft.imageVisionError;
        return draft;
      });
    } else {
      await updateVisionMessageState(chatId, timestamp, (draft) => {
        draft.imageVisionStatus = 'failed';
        draft.imageVisionError = result.error || '识图失败';
        draft.imageProcessed = false;
        delete draft.imageDescription;
        return draft;
      });
    }

    if (typeof window.refreshImageVisionUi === 'function') {
      window.refreshImageVisionUi(chatId, timestamp);
    }
  }

  function ensureVisionPromise(chatId, timestamp) {
    const key = `${chatId}:${timestamp}`;
    if (visionInflight.has(key)) return visionInflight.get(key);
    const p = executeVisionRecognition(chatId, timestamp).finally(() => {
      visionInflight.delete(key);
    });
    visionInflight.set(key, p);
    return p;
  }

  /**
   * 用户发送图片后立即调用；若已在进行则复用同一 Promise。
   */
  function runVisionRecognitionForChatMessage(chatId, timestamp) {
    return ensureVisionPromise(chatId, timestamp);
  }

  /**
   * 识图失败后允许直接复用原图重试。
   */
  async function retryVisionRecognitionForChatMessage(chatId, timestamp) {
    const msg = await getVisionMessage(chatId, timestamp);
    if (
      !msg ||
      !Array.isArray(msg.content) ||
      msg.content[0]?.type !== 'image_url'
    ) {
      return;
    }

    await updateVisionMessageState(chatId, timestamp, (draft) => {
      draft.imageVisionStatus = 'pending';
      draft.imageProcessed = false;
      delete draft.imageVisionError;
      delete draft.imageDescription;
      return draft;
    });

    if (typeof window.refreshImageVisionUi === 'function') {
      window.refreshImageVisionUi(chatId, timestamp);
    }

    return ensureVisionPromise(chatId, timestamp);
  }

  /**
   * 发起 AI 请求前：等待历史里所有未完成识图的图片处理结束（成功或失败）。
   */
  async function ensureChatImagesVisionReady(chat) {
    if (!chat || !chat.history) return;
    const pending = [];
    for (const msg of chat.history) {
      if (msg.role !== 'user') continue;
      if (!Array.isArray(msg.content) || msg.content[0]?.type !== 'image_url') {
        continue;
      }
      // 【修复】只信 imageVisionStatus 标志，不再用 imageProcessed + imageDescription 兜底
      // 旧逻辑的兜底在异常数据（imageProcessed=true 但 imageDescription=undefined）下
      // 会绕过 done 检查被 push 进去，配合上面删 description 的副作用导致"重复识图"。
      // 现在更严格：必须 status==='done' 且有 description（或 error）才算完成。
      const done =
        msg.imageVisionStatus === 'done' &&
        (msg.imageDescription || msg.imageVisionError);
      const failed = msg.imageVisionStatus === 'failed';
      if (done || failed) continue;
      pending.push(ensureVisionPromise(chat.id, msg.timestamp));
    }
    await Promise.all(pending);
  }

  window.getDefaultVisionPrompt = getDefaultVisionPrompt;
  window.describeImageWithVisionApi = describeImageWithVisionApi;
  window.runVisionRecognitionForChatMessage = runVisionRecognitionForChatMessage;
  window.retryVisionRecognitionForChatMessage = retryVisionRecognitionForChatMessage;
  window.ensureChatImagesVisionReady = ensureChatImagesVisionReady;
})();
