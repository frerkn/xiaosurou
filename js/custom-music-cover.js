/**
 * 自定义音乐封面 (新增 0.0.37)
 *
 * 行为:
 * - 启动时: 如果 localStorage 有自定义封面, 应用到 #music-player-cover
 * - 点击 cover: 弹出文件选择, 上传后存到 localStorage
 * - 播放时: playSong() 会用 track.cover 覆盖 src, 自定义封面自动失效
 * - 暂停后: 自动恢复显示自定义封面
 *
 * 不动 music-player.js, 独立模块
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'music_custom_cover';
  const MAX_SIZE_MB = 3;  // dataURL 存 localStorage 限制

  function getCustomCover() {
    try {
      return localStorage.getItem(STORAGE_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function setCustomCover(dataUrl) {
    try {
      if (dataUrl) {
        localStorage.setItem(STORAGE_KEY, dataUrl);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
      return true;
    } catch (e) {
      // localStorage 满了 (5-10MB 限制)
      console.error('[MusicCustomCover] 保存失败:', e);
      if (global.showCustomAlert) {
        global.showCustomAlert('保存失败', 'localStorage 空间不足, 请先用图片工具压缩到 2MB 以内再上传');
      }
      return false;
    }
  }

  function clearCustomCover() {
    setCustomCover(null);
  }

  // 应用自定义封面到 #music-player-cover
  function applyCustomCover() {
    const coverEl = document.getElementById('music-player-cover');
    if (!coverEl) return;
    const custom = getCustomCover();
    if (custom) {
      coverEl.src = custom;
      coverEl.classList.add('has-custom-cover');
    } else {
      coverEl.classList.remove('has-custom-cover');
    }
  }

  // 上传文件 -> 读 dataURL -> 存 + set
  function handleFileSelect(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      if (global.showCustomAlert) {
        global.showCustomAlert('格式错误', '请选择图片文件 (jpg/png/webp/gif)');
      }
      return;
    }
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      if (global.showCustomAlert) {
        global.showCustomAlert('图片太大', `当前 ${(file.size / 1024 / 1024).toFixed(1)}MB, 建议先用图片工具压缩到 ${MAX_SIZE_MB}MB 以内再上传`);
      }
      return;
    }

    const reader = new FileReader();
    reader.onload = function (ev) {
      const dataUrl = ev.target.result;
      const ok = setCustomCover(dataUrl);
      if (ok) {
        const coverEl = document.getElementById('music-player-cover');
        if (coverEl) {
          coverEl.src = dataUrl;
          coverEl.classList.add('has-custom-cover');
        }
        // 提示成功 (用 toast 而不是 alert 避免打断)
        if (global.showCustomAlert) {
          global.showCustomAlert('已保存', '自定义封面已设置, 暂停时会自动显示');
        }
      }
    };
    reader.onerror = function () {
      if (global.showCustomAlert) {
        global.showCustomAlert('读取失败', '文件读取失败, 请重试');
      }
    };
    reader.readAsDataURL(file);
  }

  function init() {
    const coverEl = document.getElementById('music-player-cover');
    if (!coverEl) return false;

    // 启动时: 应用自定义封面
    applyCustomCover();

    // 标记可点击 + tooltip
    coverEl.classList.add('custom-cover-clickable');
    coverEl.title = '点击上传自定义封面';

    // click 触发上传
    coverEl.addEventListener('click', function (e) {
      // 如果有歌在播, 给出提示但仍允许上传 (用户明确点 cover 就是要换)
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      input.addEventListener('change', function () {
        const file = input.files && input.files[0];
        handleFileSelect(file);
        // 清理临时 input
        document.body.removeChild(input);
      });
      // cancel 也要清理
      input.addEventListener('cancel', function () {
        if (input.parentNode) document.body.removeChild(input);
      });
      document.body.appendChild(input);
      input.click();
    });

    // 提供长按 (或右键) 清除功能
    let longPressTimer = null;
    coverEl.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      const custom = getCustomCover();
      if (!custom) {
        if (global.showCustomAlert) {
          global.showCustomAlert('提示', '当前没有自定义封面');
        }
        return;
      }
      if (global.showChoiceModal) {
        global.showChoiceModal('封面操作', [
          { text: '清除自定义封面', value: 'clear' },
          { text: '取消', value: 'cancel' }
        ]).then((choice) => {
          if (choice === 'clear') {
            clearCustomCover();
            applyCustomCover();
            // 恢复 placeholder
            const audioPlayer = document.getElementById('audio-player') || global.audioPlayer;
            if (audioPlayer && !audioPlayer.src) {
              coverEl.src = 'https://s3plus.meituan.net/opapisdk/op_ticket_885190757_1757748720126_qdqqd_1jt5sv.jpeg';
            }
            if (global.showCustomAlert) {
              global.showCustomAlert('已清除', '自定义封面已移除');
            }
          }
        });
      }
    });

    return true;
  }

  // 暴露到 window
  global.MusicCustomCover = {
    getCustomCover,
    setCustomCover,
    clearCustomCover,
    applyCustomCover,
    init,
  };

  // DOM ready 后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (!init()) setTimeout(init, 50);
    });
  } else {
    if (!init()) setTimeout(init, 50);
  }
})(window);
