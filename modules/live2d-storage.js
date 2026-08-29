// Live2D 模型 IndexedDB 存储 — 朋友 A 上传的模型只有 A 浏览器能看 (跟 330 现有 IDB 模式一致)
// P1.5 第二步: 接收 uploader 返回的 {files, modelPath, name, config}, 存到 IDB
// 复用 330 现有 db 全局对象 (init-and-state.js 已经初始化)

(function (global) {
  'use strict';

  // 330 现有 IDB 命名约定: store 名 = 'live2d_models'
  // key: modelId (字符串, 调用方生成, 用 crypto.randomUUID)
  // value: { id, name, modelPath, addedAt, files: [{path, blob}], config: {refs} }

  async function saveModel(modelData) {
    // modelData = { files: Map<path, Blob>, modelPath, name, config }
    if (!modelData || !modelData.files || !modelData.modelPath) {
      throw new Error('saveModel: modelData/files/modelPath 不能为空');
    }
    if (!global.db) {
      throw new Error('saveModel: 330 db 未初始化 (init-and-state.js)');
    }
    const id = (global.crypto && global.crypto.randomUUID)
      ? global.crypto.randomUUID()
      : 'l2d_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);

    // Map 转数组 (IDB 不能存 Map)
    const filesArr = [];
    for (const [path, blob] of modelData.files.entries()) {
      filesArr.push({ path, blob });
    }

    const record = {
      id,
      name: modelData.name || '未命名模型',
      modelPath: modelData.modelPath,
      addedAt: Date.now(),
      files: filesArr,
      config: modelData.config || {},
    };
    await global.db.live2d_models.put(record);
    return id;
  }

  async function listModels() {
    if (!global.db) return [];
    const all = await global.db.live2d_models.toArray();
    return all
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      .map(m => ({
        id: m.id,
        name: m.name,
        modelPath: m.modelPath,
        addedAt: m.addedAt,
        fileCount: (m.files || []).length,
      }));
  }

  async function getModel(id) {
    if (!global.db) return null;
    const rec = await global.db.live2d_models.get(id);
    if (!rec) return null;
    // 数组转回 Map (uploader 期望 Map)
    const filesMap = new Map();
    for (const f of (rec.files || [])) filesMap.set(f.path, f.blob);
    return {
      id: rec.id,
      name: rec.name,
      modelPath: rec.modelPath,
      addedAt: rec.addedAt,
      files: filesMap,
      config: rec.config || {},
    };
  }

  async function deleteModel(id) {
    if (!global.db) return false;
    await global.db.live2d_models.delete(id);
    return true;
  }

  async function getActiveModelId() {
    // 存到 localStorage (跨 session 记住用户上次选的模型)
    try { return localStorage.getItem('live2d.activeModelId') || null; } catch (e) { return null; }
  }

  async function setActiveModelId(id) {
    try { localStorage.setItem('live2d.activeModelId', id || ''); } catch (e) {}
  }

  global.Live2DStorage = {
    saveModel,
    listModels,
    getModel,
    deleteModel,
    getActiveModelId,
    setActiveModelId,
  };
})(typeof window !== 'undefined' ? window : globalThis);
