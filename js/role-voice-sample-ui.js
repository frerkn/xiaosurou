// ============================================================
// role-voice-sample-ui.js — 角色设置页「专属音色样本」子区块
// 功能：每个 chatId 关联一段 5-60s 的 mp3/wav/m4a (≤10MB) 参考音频
//       供 modules/ai-music.js 的 Cover 模式调用
// 暴露：window.RoleVoiceSampleUI.openForChat(chatId, containerEl)
//       window.RoleVoiceSampleUI.refresh(chatId) — 外部刷新用
// ============================================================

(function () {
  const MIN_DURATION = 5;   // 秒
  const MAX_DURATION = 60;  // 秒
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB

  // ---------- 工具：格式化时长 ----------
  function formatDuration(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    if (sec < 60) return sec + ' 秒';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ' 分 ' + s + ' 秒';
  }

  function formatSize(bytes) {
    bytes = Number(bytes) || 0;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  // ---------- 工具：showToast 兜底 ----------
  function toast(text) {
    if (typeof window.showToast === 'function') {
      window.showToast(text);
    } else {
      console.log('[RoleVoiceSampleUI]', text);
    }
  }

  function alertFallback(title, msg) {
    if (typeof window.showCustomAlert === 'function') {
      window.showCustomAlert(title, msg);
    } else {
      alert(title + '\n' + msg);
    }
  }

  // ---------- 工具：读文件时长（用 audio 元素的 loadedmetadata） ----------
  function readAudioDuration(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      let resolved = false;
      const cleanup = () => {
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
      };
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        if (resolved) return;
        resolved = true;
        const d = audio.duration;
        cleanup();
        if (isFinite(d) && d > 0) resolve(d);
        else reject(new Error('无法读取音频时长'));
      };
      audio.onerror = () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new Error('音频文件无法解码'));
      };
      // 一些浏览器 Infinity 时不会触发 loadedmetadata，强制再读
      audio.src = url;
    });
  }

  // ---------- 工具：渲染容器（空态 / 已上传态） ----------
  function renderEmpty(container, chatId) {
    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.padding = '12px 15px';
    wrap.innerHTML = `
      <div style="font-size:12px; color:var(--text-secondary, #8e8e93); margin-bottom:8px;">
        上传一段 ${MIN_DURATION}-${MAX_DURATION} 秒的角色声音样本（mp3/wav/m4a，≤10MB），
        AI 唱歌时可以用 Cover 模式模仿这个音色。
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        <input type="file" id="role-voice-sample-input" accept="audio/*" hidden>
        <button type="button" class="settings-mini-btn" id="role-voice-sample-upload-btn">📁 选择音频文件</button>
        <span id="role-voice-sample-status" style="font-size:12px; color:var(--text-secondary, #8e8e93);"></span>
      </div>
    `;
    container.appendChild(wrap);

    const fileInput = wrap.querySelector('#role-voice-sample-input');
    const uploadBtn = wrap.querySelector('#role-voice-sample-upload-btn');
    const statusEl = wrap.querySelector('#role-voice-sample-status');

    uploadBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      statusEl.textContent = '正在校验...';
      statusEl.style.color = 'var(--text-secondary, #8e8e93)';

      // 大小校验
      if (file.size > MAX_SIZE) {
        statusEl.textContent = '';
        alertFallback('文件过大', '音频文件不能超过 10MB');
        e.target.value = '';
        return;
      }

      // 时长校验
      let duration = 0;
      try {
        duration = await readAudioDuration(file);
      } catch (err) {
        statusEl.textContent = '';
        alertFallback('无法读取音频', '请确认文件是有效的 mp3 / wav / m4a');
        e.target.value = '';
        return;
      }
      if (duration < MIN_DURATION || duration > MAX_DURATION) {
        statusEl.textContent = '';
        alertFallback('时长不符', '音频时长需在 ' + MIN_DURATION + '-' + MAX_DURATION + ' 秒之间（当前 ' + formatDuration(duration) + '）');
        e.target.value = '';
        return;
      }

      // 写入 IndexedDB
      statusEl.textContent = '正在保存...';
      const ok = await window.MusicVoiceSample.setVoiceSample(chatId, file, duration);
      statusEl.textContent = '';
      e.target.value = '';
      if (ok) {
        toast('专属音色样本已上传');
        await openForChat(chatId, container);
      } else {
        alertFallback('保存失败', '请重试');
      }
    });
  }

  function renderUploaded(container, chatId, sample) {
    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.padding = '12px 15px';
    const uploadedAtStr = sample.uploadedAt ? new Date(sample.uploadedAt).toLocaleString('zh-CN') : '—';
    wrap.innerHTML = `
      <div style="font-size:13px; color:var(--text-color, #333); margin-bottom:8px;">
        ✅ 已上传专属音色样本
      </div>
      <div style="font-size:12px; color:var(--text-secondary, #8e8e93); margin-bottom:10px; line-height:1.6;">
        时长：<b>${formatDuration(sample.duration)}</b>　|　
        大小：<b>${formatSize(sample.blob ? sample.blob.size : 0)}</b>　|　
        上传于：${uploadedAtStr}
      </div>
      <div style="display:flex; gap:8px;">
        <button type="button" class="settings-mini-btn" id="role-voice-sample-play-btn">▶ 试听</button>
        <input type="file" id="role-voice-sample-input" accept="audio/*" hidden>
        <button type="button" class="settings-mini-btn" id="role-voice-sample-replace-btn">🔄 更换</button>
        <button type="button" class="settings-mini-btn" id="role-voice-sample-delete-btn">🗑 删除</button>
      </div>
    `;
    container.appendChild(wrap);

    const playBtn = wrap.querySelector('#role-voice-sample-play-btn');
    const replaceBtn = wrap.querySelector('#role-voice-sample-replace-btn');
    const deleteBtn = wrap.querySelector('#role-voice-sample-delete-btn');
    const fileInput = wrap.querySelector('#role-voice-sample-input');

    let playUrl = null;
    let playAudio = null;
    if (sample.blob) {
      playUrl = URL.createObjectURL(sample.blob);
    }

    playBtn.addEventListener('click', () => {
      if (!playUrl) return;
      if (playAudio) {
        try { playAudio.pause(); } catch (e) { /* ignore */ }
      }
      playAudio = new Audio(playUrl);
      playAudio.play().catch(err => {
        console.error('[RoleVoiceSampleUI] play failed', err);
        toast('试听失败');
      });
      playAudio.onended = () => {
        playAudio = null;
      };
    });

    replaceBtn.addEventListener('click', () => fileInput.click());

    deleteBtn.addEventListener('click', async () => {
      const ok = await window.MusicVoiceSample.clearVoiceSample(chatId);
      if (ok) {
        if (playAudio) {
          try { playAudio.pause(); } catch (e) { /* ignore */ }
        }
        if (playUrl) {
          try { URL.revokeObjectURL(playUrl); } catch (e) { /* ignore */ }
          playUrl = null;
        }
        toast('已删除专属音色样本');
        await openForChat(chatId, container);
      } else {
        alertFallback('删除失败', '请重试');
      }
    });

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > MAX_SIZE) {
        alertFallback('文件过大', '音频文件不能超过 10MB');
        e.target.value = '';
        return;
      }
      let duration = 0;
      try {
        duration = await readAudioDuration(file);
      } catch (err) {
        alertFallback('无法读取音频', '请确认文件是有效的 mp3 / wav / m4a');
        e.target.value = '';
        return;
      }
      if (duration < MIN_DURATION || duration > MAX_DURATION) {
        alertFallback('时长不符', '音频时长需在 ' + MIN_DURATION + '-' + MAX_DURATION + ' 秒之间（当前 ' + formatDuration(duration) + '）');
        e.target.value = '';
        return;
      }
      const ok = await window.MusicVoiceSample.setVoiceSample(chatId, file, duration);
      e.target.value = '';
      if (ok) {
        if (playAudio) {
          try { playAudio.pause(); } catch (e) { /* ignore */ }
        }
        if (playUrl) {
          try { URL.revokeObjectURL(playUrl); } catch (e) { /* ignore */ }
          playUrl = null;
        }
        toast('已更换专属音色样本');
        await openForChat(chatId, container);
      } else {
        alertFallback('保存失败', '请重试');
      }
    });
  }

  // ---------- 主入口 ----------
  async function openForChat(chatId, container) {
    if (!chatId) {
      console.warn('[RoleVoiceSampleUI] openForChat: missing chatId');
      return;
    }
    if (!container) {
      console.warn('[RoleVoiceSampleUI] openForChat: missing container');
      return;
    }
    if (!window.MusicVoiceSample) {
      container.innerHTML = '<div style="padding:12px 15px; font-size:12px; color:#999;">音乐模块未加载，请刷新页面</div>';
      return;
    }
    container.innerHTML = '<div style="padding:12px 15px; font-size:12px; color:#999;">正在加载...</div>';
    try {
      const sample = await window.MusicVoiceSample.getVoiceSample(chatId);
      if (sample && sample.blob) {
        renderUploaded(container, chatId, sample);
      } else {
        renderEmpty(container, chatId);
      }
    } catch (err) {
      console.error('[RoleVoiceSampleUI] load failed', err);
      container.innerHTML = '<div style="padding:12px 15px; font-size:12px; color:#ff3b30;">加载失败，请重试</div>';
    }
  }

  async function refresh(chatId) {
    const container = document.getElementById('role-voice-sample-section');
    if (!container) return;
    await openForChat(chatId, container);
  }

  window.RoleVoiceSampleUI = {
    openForChat: openForChat,
    refresh: refresh
  };
})();
