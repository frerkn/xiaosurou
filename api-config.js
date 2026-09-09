// Global API configuration for frontend-only modules.
// Netlify Functions are exposed under /.netlify/functions/{function-name}
(function () {
  window.API_CONFIG = window.API_CONFIG || {};
  window.API_CONFIG.fishAudioProxyUrl = '/.netlify/functions/fish-audio-tts';
})();
