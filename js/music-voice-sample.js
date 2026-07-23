// ============================================================
// music-voice-sample.js — 角色专属音色样本 IndexedDB 存储
// 功能：每个 chatId 对应一段音频 blob（用户上传的 5-60s 参考音频）
//       给 modules/ai-music.js 调 Cover API 时取
// 来源：参考 js/custom-music-cover.js（自定义封面的 IndexedDB 模式）
// ============================================================

(function () {
  const DB_NAME = 'music-voice-samples';
  const DB_VERSION = 1;
  const STORE_NAME = 'samples';

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'chatId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  // 取该 chatId 的音色样本
  // 返回 { chatId, blob, duration, uploadedAt } 或 null
  async function getVoiceSample(chatId) {
    if (!chatId) return null;
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(chatId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[MusicVoiceSample] getVoiceSample failed:', e);
      return null;
    }
  }

  // 存一段音频 blob
  // duration 是秒（UI 测出来的），uploadedAt 自动
  // 【2026-07-22 修】强制 blob mime=audio/mpeg——避免 IDB 反序列化丢 mime 后 Cover API 拒收
  //  File 对象可能有 audio/mpeg/audio/wav 等具体 mime，但 IDB 存读可能丢，强制包装最稳
  async function setVoiceSample(chatId, blob, duration) {
    if (!chatId || !blob) return false;
    const safeBlob = blob.type && blob.type.startsWith('audio/') && blob.type !== ''
      ? blob
      : new Blob([blob], { type: 'audio/mpeg' });
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const record = {
          chatId: chatId,
          blob: safeBlob,
          duration: Number(duration) || 0,
          uploadedAt: Date.now()
        };
        const req = store.put(record);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[MusicVoiceSample] setVoiceSample failed:', e);
      return false;
    }
  }

  // 删除该 chatId 的音色样本
  async function clearVoiceSample(chatId) {
    if (!chatId) return false;
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(chatId);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[MusicVoiceSample] clearVoiceSample failed:', e);
      return false;
    }
  }

  // 列出所有已上传样本的元信息（不含 blob）— UI 列表用
  async function listVoiceSamples() {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => {
          const list = (req.result || []).map(r => ({
            chatId: r.chatId,
            duration: r.duration,
            uploadedAt: r.uploadedAt,
            size: r.blob ? r.blob.size : 0
          }));
          resolve(list);
        };
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[MusicVoiceSample] listVoiceSamples failed:', e);
      return [];
    }
  }

  // 暴露 API
  window.MusicVoiceSample = {
    getVoiceSample: getVoiceSample,
    setVoiceSample: setVoiceSample,
    clearVoiceSample: clearVoiceSample,
    listVoiceSamples: listVoiceSamples
  };
})();
