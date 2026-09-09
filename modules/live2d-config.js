// Live2D 模型元数据解析 — 读 model3.json, 输出跟糯米机 Live2DAvatarConfig 对齐的结构
// P1.5 第三步: 解析 motions/expressions/parameters, 给 P3 动作编辑器和 P2 AI 表情触发用
// 糯米参考: utils/builtinSullyLive2D.ts (actions 数组结构) + utils/live2dModelStore.ts (parseModel3Json)

(function (global) {
  'use strict';

  // 从 model3.json 解析出标准 Live2DAvatarConfig
  // 输入: model3Json (object) + modelPath (string, 用于相对路径)
  // 输出: { assetId, modelPath, originalName, actions, lipSyncParameterIds, texturePaths, parameterIds, fileSize }
  function parseModel3Json(model3Json, modelPath) {
    if (!model3Json || typeof model3Json !== 'object') {
      throw new Error('parseModel3Json: 需要 model3.json 对象');
    }
    const fileRefs = model3Json.FileReferences || model3Json.fileReferences || {};
    const baseDir = modelPath ? modelPath.substring(0, modelPath.lastIndexOf('/') + 1) : '';

    // 解析 Expressions (每个 .exp3.json 一个 action, kind: 'expression')
    const expressions = Array.isArray(fileRefs.Expressions) ? fileRefs.Expressions : [];
    const expressionActions = expressions.map((exp, i) => {
      const id = `expression-${i}`;
      const name = exp.Name || (exp.File ? exp.File.replace(/^.*\//, '').replace(/\.exp3\.json$/i, '') : id);
      return {
        id,
        kind: 'expression',
        name,
        expressionId: name,
        file: exp.File,
        source: 'model3',
        parameterIds: [],
        tags: [],
        permission: 'manual',  // 默认手动切换, AI 触发后续 P2 加
      };
    });

    // 解析 Motions (每个 motion group 一个或多个 actions, kind: 'motion')
    const motionsObj = fileRefs.Motions && typeof fileRefs.Motions === 'object' ? fileRefs.Motions : {};
    const motionActions = [];
    let motionIdx = 0;
    for (const [groupName, motionList] of Object.entries(motionsObj)) {
      if (!Array.isArray(motionList)) continue;
      for (const m of motionList) {
        if (!m || !m.File) continue;
        const name = m.Name || (m.File ? m.File.replace(/^.*\//, '').replace(/\.motion3\.json$/i, '') : `${groupName}-${motionIdx}`);
        motionActions.push({
          id: `motion-${motionIdx++}`,
          kind: 'motion',
          name,
          group: groupName,
          file: m.File,
          source: 'model3',
          tags: [],
          permission: 'manual',
        });
      }
    }

    // 提取 texturePaths (相对路径 -> blob:URL, 调用方提供 map 转换)
    const texturePaths = Array.isArray(fileRefs.Textures) ? fileRefs.Textures.map(p => baseDir + p) : [];

    // lipSyncParameterIds: 优先取 model3.json 的 Groups[].Name === 'LipSync' 的 Ids, 否则给个 fallback
    const groups = Array.isArray(model3Json.Groups) ? model3Json.Groups : [];
    const lipSyncGroup = groups.find(g => (g.Name || g.name) === 'LipSync');
    const lipSyncParameterIds = (lipSyncGroup && Array.isArray(lipSyncGroup.Ids) && lipSyncGroup.Ids.length > 0)
      ? lipSyncGroup.Ids.slice()
      : ['ParamMouthOpenY', 'ParamMouthForm', 'ParamMouthX'];  // 通用 fallback

    return {
      assetId: modelPath || 'unknown',
      modelPath: modelPath || '',
      originalName: model3Json.name || modelPath || '未命名',
      actions: [...expressionActions, ...motionActions],
      lipSyncParameterIds,
      texturePaths,
      parameterIds: [],  // 后续 P3 从 internalModel.coreModel.parameters 提取
    };
  }

  // 解析 LipSyncParameterIds from fileMap (不需要传 model3Json, 直接用 fallback)
  function getDefaultLipSyncParameterIds() {
    return ['ParamMouthOpenY', 'ParamMouthForm', 'ParamMouthX'];
  }

  global.Live2DConfig = {
    parseModel3Json,
    getDefaultLipSyncParameterIds,
  };
})(typeof window !== 'undefined' ? window : globalThis);
