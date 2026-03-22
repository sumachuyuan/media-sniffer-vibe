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

  // 监听来自 popup 的按需提取请求
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'EXTRACT_TIKTOK') {
      if (!window.location.hostname.includes('tiktok.com')) {
        sendResponse({ success: false });
        return true;
      }
      const scriptIds = ['SIGI_STATE', '__UNIVERSAL_DATA_FOR_REHYDRATION__', 'RENDER_DATA'];
      let foundUrl = null;

      function findPlayAddr(obj, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 20) return null;
        if (obj.playAddr && typeof obj.playAddr === 'string') return obj.playAddr;
        if (obj.downloadAddr && typeof obj.downloadAddr === 'string') return obj.downloadAddr;
        for (const key in obj) {
          const res = findPlayAddr(obj[key], depth + 1);
          if (res) return res;
        }
        return null;
      }

      for (const id of scriptIds) {
        const script = document.getElementById(id);
        if (script && script.textContent) {
          try {
            const json = JSON.parse(script.textContent);
            foundUrl = findPlayAddr(json);
            if (foundUrl) break;
          } catch (e) {}
        }
      }

      if (foundUrl) {
        try {
          chrome.runtime.sendMessage({ type: 'MEDIA_DETECTED', url: foundUrl, title: document.title, isManualExtract: true });
        } catch(e) {}
        sendResponse({ success: true, url: foundUrl });
      } else {
        // Fallback: 如果直接没找到 playAddr，全量扫描作为最后的挣扎
        let regexBypass = false;
        for (const id of scriptIds) {
          const script = document.getElementById(id);
          if (script && script.textContent) {
            const match = script.textContent.match(/https?:\/\/[a-zA-Z0-9.-]+tiktokcdn[a-zA-Z0-9.\-/_?=~&%]*mime_type=video_mp4[a-zA-Z0-9.\-/_?=~&%]*/);
            if (match && match[0]) {
              try { chrome.runtime.sendMessage({ type: 'MEDIA_DETECTED', url: match[0], title: document.title, isManualExtract: true }); } catch(e) {}
              sendResponse({ success: true, url: match[0] });
              regexBypass = true;
              break;
            }
          }
        }
        if (!regexBypass) sendResponse({ success: false });
      }
    }
    return true;
  });

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
