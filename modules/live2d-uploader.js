// Live2D 模型上传器 — ZIP / 文件夹 / 单文件 三种入口
// P1.5 第一步: 解析用户上传的模型, 校验 model3.json 引用完整性, 返回标准结构给 storage
// JSZip 已通过 index.html 的 <script> 加载 (cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js)

(function (global) {
  'use strict';

  // 校验失败错误类 — UI 拿到这个 error 可以用 missingFiles 列表告诉用户缺啥
  class Live2DMissingFilesError extends Error {
    constructor(modelPath, missingFiles, packageFileCount) {
      const names = missingFiles.slice(0, 3).map(f => f.resolvedPath).join(', ');
      super(`模型 ${modelPath} 引用不完整: 缺 ${names}${missingFiles.length > 3 ? ` 等 ${missingFiles.length} 个文件` : ''}`);
      this.name = 'Live2DMissingFilesError';
      this.code = 'LIVE2D_MISSING_REFERENCES';
      this.modelPath = modelPath;
      this.missingFiles = missingFiles;
      this.packageFileCount = packageFileCount;
    }
  }

  // 把 model3.json 里的引用 (Moc/Textures/Physics/DisplayInfo/Motions/Expressions) 转成完整文件路径
  // 按"先找 model3.json 同目录" + "再找同名前缀子目录" (Cubism 4 习惯, 例如 绮剧伒浼埖.8192/texture_00.png)
  function resolveModelPaths(model3Path, refs) {
    const baseDir = model3Path.substring(0, model3Path.lastIndexOf('/') + 1);
    const out = { baseDir, references: {} };
    if (refs.Moc) out.references.Moc = baseDir + refs.Moc;
    if (refs.DisplayInfo) out.references.DisplayInfo = baseDir + refs.DisplayInfo;
    if (refs.Physics) out.references.Physics = baseDir + refs.Physics;
    if (refs.Pose) out.references.Pose = baseDir + refs.Pose;
    if (Array.isArray(refs.Textures)) {
      out.references.Textures = refs.Textures.map(p => baseDir + p);
    }
    if (refs.Motions && typeof refs.Motions === 'object') {
      out.references.Motions = [];
      for (const group of Object.values(refs.Motions)) {
        if (Array.isArray(group)) {
          for (const m of group) {
            if (m && m.File) out.references.Motions.push(baseDir + m.File);
          }
        }
      }
    }
    if (Array.isArray(refs.Expressions)) {
      out.references.Expressions = refs.Expressions
        .filter(e => e && e.File)
        .map(e => baseDir + e.File);
    }
    return out;
  }

  // 校验 model3.json 引用完整性 — 列出缺失文件
  function validateReferences(resolved, fileList) {
    const missing = [];
    function check(relPath) {
      if (!fileList.has(relPath)) {
        missing.push({ resolvedPath: relPath, referencedBy: 'model3.json' });
      }
    }
    if (resolved.references.Moc) check(resolved.references.Moc);
    if (resolved.references.DisplayInfo) check(resolved.references.DisplayInfo);
    if (resolved.references.Physics) check(resolved.references.Physics);
    if (Array.isArray(resolved.references.Textures)) {
      resolved.references.Textures.forEach(check);
    }
    return missing;
  }

  // 从 ZIP 或文件列表中找 model3.json 路径
  function findModel3JsonPath(files) {
    for (const path of files.keys()) {
      if (path.toLowerCase().endsWith('.model3.json')) return path;
    }
    return null;
  }

  // ZIP 上传 — file 是 File 对象 (来自 <input type="file" accept=".zip">)
  async function uploadZip(file) {
    if (!file) throw new Error('请选择一个 ZIP 文件');
    if (typeof JSZip === 'undefined') throw new Error('未加载 JSZip 库, 请检查 index.html');
    if (!/\.zip$/i.test(file.name)) throw new Error('文件不是 ZIP 格式');

    const zip = await JSZip.loadAsync(file);
    const files = new Map();  // path -> Blob
    for (const [filename, zipEntry] of Object.entries(zip.files)) {
      // 跳过目录 / macOS 隐藏文件 / Windows 缩略图
      if (zipEntry.dir) continue;
      if (filename.includes('__MACOSX') || filename.startsWith('.')) continue;
      const lowerName = filename.toLowerCase();
      // 只保留 Live2D 相关文件
      if (!/\.(model3\.json|moc3|cdi3\.json|physics3\.json|pose3\.json|exp3\.json|json|png|jpg|jpeg|mtn|moc)$/i.test(lowerName)) continue;
      const blob = await zipEntry.async('blob');
      // 统一用正斜杠路径
      const normalized = filename.replace(/\\/g, '/');
      files.set(normalized, blob);
    }
    if (files.size === 0) throw new Error('ZIP 内未找到任何 Live2D 文件');

    const modelPath = findModel3JsonPath(files);
    if (!modelPath) throw new Error('ZIP 内未找到 model3.json 文件');

    const modelJson = JSON.parse(await files.get(modelPath).text());
    const refs = (modelJson.FileReferences || modelJson.fileReferences) || {};
    const resolved = resolveModelPaths(modelPath, refs);
    const missing = validateReferences(resolved, files);
    if (missing.length > 0) {
      throw new Live2DMissingFilesError(modelPath, missing, files.size);
    }

    return {
      files,
      modelPath,
      name: file.name.replace(/\.zip$/i, ''),
      config: { refs },
    };
  }

  // 文件夹上传 — files 是 FileList (来自 <input webkitdirectory>)
  // file.webkitRelativePath 形如 "MyModel/小狼.model3.json" 或 "MyModel/小狼.8192/texture_00.png"
  async function uploadFolder(fileList) {
    if (!fileList || fileList.length === 0) throw new Error('请选择文件夹');
    const files = new Map();
    let rootDir = null;
    for (const file of fileList) {
      const rel = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
      // 第一个文件的目录作为 model 根目录
      if (!rootDir) {
        const idx = rel.indexOf('/');
        if (idx >= 0) rootDir = rel.substring(0, idx);
        else rootDir = rel;  // 选了一个单文件, 当作 root
      }
      // 跳过隐藏文件
      if (rel.includes('__MACOSX') || /\/\./.test(rel)) continue;
      files.set(rel, file);
    }
    if (files.size === 0) throw new Error('文件夹为空或没有可用文件');

    const modelPath = findModel3JsonPath(files);
    if (!modelPath) throw new Error('文件夹内未找到 model3.json');

    const file = files.get(modelPath);
    const modelJson = JSON.parse(await file.text());
    const refs = (modelJson.FileReferences || modelJson.fileReferences) || {};
    const resolved = resolveModelPaths(modelPath, refs);
    const missing = validateReferences(resolved, files);
    if (missing.length > 0) {
      throw new Live2DMissingFilesError(modelPath, missing, files.size);
    }

    return {
      files,
      modelPath,
      name: rootDir || '未命名模型',
      config: { refs },
    };
  }

  // 单 model3.json + 配套文件 (从 drag/drop 多文件入口)
  async function uploadModel3WithSiblings(fileList) {
    if (!fileList || fileList.length === 0) throw new Error('请拖入文件');
    const files = new Map();
    for (const file of fileList) {
      // 优先用 webkitRelativePath (drag/drop 通常没有, 用 name)
      const rel = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
      files.set(rel, file);
    }
    const modelPath = findModel3JsonPath(files);
    if (!modelPath) throw new Error('文件列表中未找到 model3.json');

    const file = files.get(modelPath);
    const modelJson = JSON.parse(await file.text());
    const refs = (modelJson.FileReferences || modelJson.fileReferences) || {};
    const resolved = resolveModelPaths(modelPath, refs);
    const missing = validateReferences(resolved, files);
    if (missing.length > 0) {
      throw new Live2DMissingFilesError(modelPath, missing, files.size);
    }

    // 名字: 取 modelPath 第一层目录
    const firstSlash = modelPath.indexOf('/');
    const name = firstSlash >= 0 ? modelPath.substring(0, firstSlash) : modelPath.replace(/\.model3\.json$/i, '');

    return {
      files,
      modelPath,
      name,
      config: { refs },
    };
  }

  global.Live2DUploader = {
    Live2DMissingFilesError,
    uploadZip,
    uploadFolder,
    uploadModel3WithSiblings,
  };
})(typeof window !== 'undefined' ? window : globalThis);
