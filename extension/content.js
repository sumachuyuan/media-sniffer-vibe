/**
 * Sovereign Media Sniffer - Content Script
 * 
 * 作用：在网页（及 iframe）中直接嗅探渲染后的媒体标签。
 */

(function() {
  const MEDIA_EXTENSIONS = ['.m3u8', '.mp4', '.mpd', '.webm', '.ogg'];

  function getPureTitle() {
    const tabTitle = document.title;
    
    // 1. Try Meta Tags (OG / Twitter)
    const metaTitle = document.querySelector('meta[property="og:title"]')?.content || 
                      document.querySelector('meta[name="twitter:title"]')?.content ||
                      document.querySelector('meta[property="twitter:title"]')?.content;
    
    if (metaTitle && (tabTitle.includes(metaTitle) || metaTitle.includes(tabTitle))) {
      return metaTitle.trim();
    }
    
    // 2. Try H1
    const h1 = document.querySelector('h1')?.innerText?.trim();
    if (h1 && tabTitle.includes(h1) && h1.length > 3) {
      return h1;
    }
    
    // 3. Sanitized Tab Title (Fallback)
    const platforms = ['YouTube', 'Bilibili', '哔哩哔哩', '抖音', 'Douyin', 'TikTok', 'Instagram', 'Twitter', 'X', 'Feishu', '飞书'];
    let cleanTitle = tabTitle;
    
    const parts = cleanTitle.split(/ - | \| | _ | – /);
    if (parts.length > 1) {
      const bestPart = parts.sort((a, b) => b.length - a.length).find(p => !platforms.some(plat => p.toLowerCase().includes(plat.toLowerCase())));
      if (bestPart) cleanTitle = bestPart.trim();
      else cleanTitle = parts[0].trim();
    }
    
    return cleanTitle;
  }

  function getContextualTitle(url) {
    if (!url) return getPureTitle();
    
    const mediaElements = document.querySelectorAll('video, audio');
    let targetEl = null;

    for (const el of mediaElements) {
      const elSrc = el.src || el.currentSrc;
      if (elSrc && elSrc.length > 5 && (url.includes(elSrc) || elSrc.includes(url))) {
        targetEl = el;
        break;
      }
      const sources = el.querySelectorAll('source');
      for (const s of sources) {
        const sSrc = s.src || s.getAttribute('src');
        if (sSrc && sSrc.length > 5 && (url.includes(sSrc) || sSrc.includes(url))) {
          targetEl = el;
          break;
        }
      }
      if (targetEl) break;
    }

    if (!targetEl) return getPureTitle();

    let curr = targetEl;
    let depth = 0;
    const candidates = [];

    while (curr && curr !== document.body && depth < 6) {
      const siblings = Array.from(curr.parentElement.children);
      for (const sib of siblings) {
        if (sib === curr || sib.offsetParent === null) continue; // Skip hidden
        
        const text = sib.innerText?.trim();
        if (!text || text.length < 3 || text.length > 150) continue;

        const isHeader = ['H1', 'H2', 'H3', 'H4'].includes(sib.tagName);
        const hasTitleClass = /title|name|subject|header|caption/i.test(sib.className + " " + sib.id);
        
        if (isHeader || hasTitleClass) {
          candidates.push({ text, score: (isHeader ? 15 : 8) - depth });
        }
      }
      curr = curr.parentElement;
      depth++;
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0].text;
      // Cross-verify: If candidate is part of tab title, it's very likely correct
      if (document.title.toLowerCase().includes(best.toLowerCase())) return best;
      // If no match with tab title, only trust if it's a high-score header
      if (candidates[0].score > 10) return best;
    }

    return getPureTitle();
  }

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
              title: getPureTitle() || 'Embedded Media'
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
    if (request.type === 'GET_PURE_TITLE') {
      sendResponse({ title: getContextualTitle(request.url) });
      return true;
    }
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
          chrome.runtime.sendMessage({ type: 'MEDIA_DETECTED', url: foundUrl, title: getPureTitle(), isManualExtract: true });
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
              try { chrome.runtime.sendMessage({ type: 'MEDIA_DETECTED', url: match[0], title: getPureTitle(), isManualExtract: true }); } catch(e) {}
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
