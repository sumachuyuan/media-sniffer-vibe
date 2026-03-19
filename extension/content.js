/**
 * Sovereign Media Sniffer - Content Script
 * 
 * 作用：在网页（及 iframe）中直接嗅探渲染后的媒体标签。
 */

(function() {
  const MEDIA_EXTENSIONS = ['.m3u8', '.mp4', '.mpd', '.webm', '.ogg'];

  function checkMedia() {
    const mediaElements = document.querySelectorAll('video, audio, source');
    mediaElements.forEach(el => {
      let src = el.src || (el.currentSrc);
      
      // 处理 <source> 标签
      if (!src && el.tagName === 'SOURCE') {
        src = el.getAttribute('src');
      }

      if (src && src.startsWith('http')) {
        // 安全检查：防止 Extension context invalidated 报错
        if (chrome.runtime && chrome.runtime.id) {
          try {
            chrome.runtime.sendMessage({
              type: 'MEDIA_DETECTED',
              url: src,
              title: document.title || 'Embedded Media'
            });
          } catch (e) {
            // 上下文失效，静默退出
          }
        }
      }
    });

    // 扫描 DPlayer / AliPlayer 等常用的全局变量或 DOM 特征（如果需要更高级的提取，可以在这里扩展）
  }

  // 初始检查
  checkMedia();

  // 监听 DOM 变化以捕获动态加载的视频
  const observer = new MutationObserver((mutations) => {
    checkMedia();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

})();
