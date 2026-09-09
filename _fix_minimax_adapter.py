# -*- coding: utf-8 -*-
from pathlib import Path

ROOT = Path(__file__).resolve().parent

MODULES_REPLACEMENT = r'''  // 官网 Minimax 输出适配器：只在 baseURL 包含 api.minimaxi.com 时由调用处启用
  function normalizeOfficialMinimaxOutput(rawContent, userMessage = '') {
    console.log('[官网Minimax适配] rawContent', rawContent);

    // Minimax 思维链必须在任何解析/提取前移除。
    const normalizeText = (text) => String(text || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/\(\s*Timestamp\s*:\s*\d+\s*\)/gi, '')
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, '')
      .trim();

    const decodeJsonString = (text) => {
      const raw = String(text || '');
      try {
        return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`);
      } catch (e) {
        return raw
          .replace(/\\"/g, '"')
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t');
      }
    };

    const pushUniqueText = (list, seen, text) => {
      const cleaned = normalizeText(text)
        .replace(/^[\s,，;；:："'“”‘’\[\]{}]+|[\s,，;；:："'“”‘’\[\]{}]+$/g, '')
        .trim();
      if (!cleaned || seen.has(cleaned)) return;
      seen.add(cleaned);
      list.push(cleaned);
    };

    const cleanedContent = normalizeText(rawContent);
    const extractedTexts = [];
    const seen = new Set();
    const blockedTypes = new Set(['thought_chain', 'internal_state']);
    const blockedKeys = new Set(['thought_chain', 'internal_state', 'character_thoughts']);

    const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

    const tryParseJsonCandidates = () => {
      const candidates = [cleanedContent];

      const markdownMatch = cleanedContent.match(/```json\s*([\s\S]*?)\s*```/i);
      if (markdownMatch && markdownMatch[1]) candidates.push(markdownMatch[1].trim());

      const firstArray = cleanedContent.indexOf('[');
      const lastArray = cleanedContent.lastIndexOf(']');
      if (firstArray !== -1 && lastArray > firstArray) {
        candidates.push(cleanedContent.slice(firstArray, lastArray + 1));
      }

      const firstObject = cleanedContent.indexOf('{');
      const lastObject = cleanedContent.lastIndexOf('}');
      if (firstObject !== -1 && lastObject > firstObject) {
        candidates.push(cleanedContent.slice(firstObject, lastObject + 1));
      }

      for (const candidate of candidates) {
        try {
          return JSON.parse(candidate);
        } catch (e) {
          // 继续尝试下一个候选
        }
      }
      return null;
    };

    const collectTypedContent = (node, targetType) => {
      if (Array.isArray(node)) {
        for (const item of node) collectTypedContent(item, targetType);
        return;
      }
      if (!isPlainObject(node)) return;

      if (blockedTypes.has(node.type)) return;

      if (node.type === targetType && typeof node.content === 'string') {
        pushUniqueText(extractedTexts, seen, node.content);
        return;
      }

      for (const [key, value] of Object.entries(node)) {
        if (blockedKeys.has(key)) continue;
        collectTypedContent(value, targetType);
      }
    };

    const collectTopLevelSingleKeyText = (node) => {
      const items = Array.isArray(node) ? node : [node];

      for (const item of items) {
        if (!isPlainObject(item)) continue;
        if (blockedTypes.has(item.type)) continue;

        const keys = Object.keys(item);
        if (keys.length !== 1) continue;

        const key = keys[0];
        if (blockedKeys.has(key) || key === 'type' || key === 'content') continue;
        if (typeof item[key] === 'string') {
          pushUniqueText(extractedTexts, seen, item[key]);
        }
      }
    };

    const parsedJson = tryParseJsonCandidates();

    // 1. 先提取所有 type=text 的 content，并跳过 thought_chain/internal_state/character_thoughts
    if (parsedJson !== null) {
      collectTypedContent(parsedJson, 'text');
    }

    // JSON 不完整时的兜底正则：先移除明确的 thought_chain/internal_state 对象片段，避免跨对象误抓 content。
    const visibleContentOnly = cleanedContent
      .replace(/\{\s*["']type["']\s*:\s*["'](?:thought_chain|internal_state)["'][\s\S]*?\}\s*,?/gi, '')
      .replace(/["']character_thoughts["']\s*:\s*\{[\s\S]*?\}\s*,?/gi, '');

    const extractTypedContentByRegex = (targetType) => {
      const typedContentRe = new RegExp(
        `["']type["']\\s*:\\s*["']${targetType}["'][\\s\\S]*?["']content["']\\s*:\\s*("((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)')`,
        'gi'
      );
      let match;
      while ((match = typedContentRe.exec(visibleContentOnly)) !== null) {
        pushUniqueText(extractedTexts, seen, decodeJsonString(match[2] ?? match[3] ?? ''));
      }

      const contentTypedRe = new RegExp(
        `["']content["']\\s*:\\s*("((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)')[\\s\\S]*?["']type["']\\s*:\\s*["']${targetType}["']`,
        'gi'
      );
      while ((match = contentTypedRe.exec(visibleContentOnly)) !== null) {
        pushUniqueText(extractedTexts, seen, decodeJsonString(match[2] ?? match[3] ?? ''));
      }
    };

    if (extractedTexts.length === 0) {
      extractTypedContentByRegex('text');
    }

    // 2. 没有 text 时再提取 offline_text
    if (extractedTexts.length === 0) {
      if (parsedJson !== null) {
        collectTypedContent(parsedJson, 'offline_text');
      }
      if (extractedTexts.length === 0) {
        extractTypedContentByRegex('offline_text');
      }
    }

    // 3. 只有完全没有 text/offline_text 时，才提取顶层单键角色名对象
    if (extractedTexts.length === 0 && parsedJson !== null) {
      collectTopLevelSingleKeyText(parsedJson);
    }

    // JSON 解析失败时，保守提取“顶层形态”的单键对象；不会递归进入 character_thoughts。
    if (extractedTexts.length === 0 && parsedJson === null) {
      const singleKeyObjectRe = /\{\s*["']([^"']+)["']\s*:\s*("((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*\}/g;
      let match;
      while ((match = singleKeyObjectRe.exec(visibleContentOnly)) !== null) {
        const key = String(match[1] || '').trim();
        if (key && !blockedKeys.has(key) && key !== 'type' && key !== 'content') {
          pushUniqueText(extractedTexts, seen, decodeJsonString(match[3] ?? match[4] ?? ''));
        }
      }
    }

    // 4. 兜底：把清洗后的剩余内容当作普通自然语言，但仍不能显示 thought_chain/internal_state
    if (extractedTexts.length === 0 && !/(["']type["']\s*:\s*["'](?:thought_chain|internal_state)["']|["']character_thoughts["']\s*:)/i.test(cleanedContent)) {
      const fallbackText = cleanedContent
        .replace(/^\s*\[?\s*\{?\s*|\s*\}?\s*\]?\s*$/g, '')
        .trim();
      pushUniqueText(extractedTexts, seen, fallbackText);
    }

    const noSplitRequested = /不分行|不要拆|一段说完/.test(String(userMessage || ''));
    let finalTexts = extractedTexts;

    // 长文本拆分：仅当最终只有一段较长文本，且用户未要求不拆
    if (!noSplitRequested && finalTexts.length === 1 && finalTexts[0].length > 80) {
      const parts = (finalTexts[0].match(/[^。！？!?\n]+[。！？!?]?/g) || [])
        .map(part => part.trim())
        .filter(Boolean);

      if (parts.length > 1) {
        finalTexts = [];
        let current = '';
        for (const part of parts) {
          if (finalTexts.length >= 3) {
            current = current ? `${current}${part}` : part;
            continue;
          }
          if (!current) {
            current = part;
          } else if ((current + part).length <= 80) {
            current += part;
          } else {
            finalTexts.push(current);
            current = part;
          }
        }
        if (current) finalTexts.push(current);
        finalTexts = finalTexts.slice(0, 4);
      }
    }

    const finalSeen = new Set();
    finalTexts = finalTexts.filter(text => {
      const cleaned = normalizeText(text);
      if (!cleaned || finalSeen.has(cleaned)) return false;
      finalSeen.add(cleaned);
      return true;
    });

    const normalizedActions = finalTexts.map(content => ({ type: 'text', content }));
    console.log('[官网Minimax适配] extractedTexts', extractedTexts);
    console.log('[官网Minimax适配] normalizedActions', normalizedActions);

    return normalizedActions;
  }
'''

ONLINE_REPLACEMENT = MODULES_REPLACEMENT.replace('  // 官网 Minimax 输出适配器', '        // 官网 Minimax 输出适配器').replace('\n  function normalizeOfficialMinimaxOutput', '\n        normalizeOfficialMinimaxOutput').replace('\n  }', '\n        }')

def replace_between(path, start_marker, end_marker, replacement):
    file_path = ROOT / path
    text = file_path.read_text(encoding='utf-8')
    start = text.index(start_marker)
    end = text.index(end_marker, start)
    new_text = text[:start] + replacement + '\n\n' + text[end:]
    file_path.write_text(new_text, encoding='utf-8')

replace_between(
    'modules/ai-response.js',
    '  // 官网 Minimax 输出适配器：只在 baseURL 包含 api.minimaxi.com 时由调用处启用',
    '  function updateAssistantMessageContent',
    MODULES_REPLACEMENT
)

replace_between(
    'online-chat-manager.js',
    '        // 官网 Minimax 输出适配器：只在 baseURL 包含 api.minimaxi.com 时由调用处启用',
    '        // 解析AI角色的回复',
    ONLINE_REPLACEMENT
)

print('Minimax adapter patch applied to modules/ai-response.js and online-chat-manager.js')
