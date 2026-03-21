/**
 * Sovereign Media Sniffer - Main Entry (v25.0.0 Modular)
 */
import { logger } from '../common/logger.js';
import { state, cleanTab, resetGlobalMergeStatus } from './storage.js';
import { 
  MEDIA_SIGNATURES, NOISE_KEYWORDS, isNoiseFragment, 
  extractGroupTag, detectMediaType, isValidMediaMime, isVerifiedMedia
} from './sniffer.js';
import { parseM3U8, parseMPD, parseHlsSegments, parseDashSegments } from './parser.js';
import {
  handleFfmpegMerge, handleProxyDownload,
  handleOffscreenReady, clearDnrRules, updateDnrRulesForFetch
} from './orchestrator.js';

// --- Helper: Add Media to Storage ---
async function addMedia(tabId, url, title, qualities = null, encryption = null, isSegmented = false, estimatedSize = 0) {
  if (!state.tabStorage.has(tabId)) state.tabStorage.set(tabId, []);
  let urls = state.tabStorage.get(tabId);
  
  const existing = urls.find(item => item.url === url);
  const urlLower = url.toLowerCase();
  if (!isSegmented && (urlLower.includes('.m3u8') || urlLower.includes('.mpd') || urlLower.includes('chunklist'))) {
    isSegmented = true;
  }

  if (existing) {
    let updated = false;
    if (!existing.qualities && qualities) { existing.qualities = qualities; updated = true; }
    if (!existing.encryption && encryption) { existing.encryption = encryption; updated = true; }
    if (!existing.isSegmented && isSegmented) { existing.isSegmented = isSegmented; updated = true; }
    if (estimatedSize > 0 && (!existing.estimatedSize || existing.estimatedSize === 0)) {
      existing.estimatedSize = estimatedSize;
      updated = true;
    }
    return;
  }

  logger.info(`New media detected: ${url}`, { isSegmented });

  urls.push({
    id: Date.now() + "_" + Math.floor(Math.random() * 1000000),
    url,
    timestamp: Date.now(),
    tabTitle: title || chrome.i18n.getMessage('targetPage'),
    qualities,
    mediaType: detectMediaType(url),
    groupTag: extractGroupTag(url),
    encryption,
    isSegmented,
    estimatedSize
  });

  if (urls.length > 50) urls.shift();
  chrome.action.setBadgeText({ tabId, text: urls.length.toString() }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#FFD700' }).catch(() => {});
}

// --- Network Listener ---
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    const { url, tabId } = details;
    if (tabId === -1) return;

    const urlLower = url.toLowerCase();
    if (MEDIA_SIGNATURES.some(sig => urlLower.includes(sig))) {
      if (NOISE_KEYWORDS.some(kw => url.includes(kw))) return;
      if (isNoiseFragment(url)) return;
      if (state.processingUrls.has(url)) return;

      state.processingUrls.add(url);
      let qualities = null, encryption = null, isSegmented = false, estimatedSize = 0;

      if (urlLower.includes('.m3u8') || urlLower.includes('chunklist')) {
        isSegmented = true;
        const result = await parseM3U8(url);
        if (result) { 
          qualities = result.qualities; 
          encryption = result.encryption;
          if (result.totalDuration && qualities && qualities[0].bandwidth !== 'unknown') {
            const bwKbps = parseInt(qualities[0].bandwidth);
            estimatedSize = (bwKbps * 1024 / 8) * result.totalDuration;
          }
        }
      } else if (urlLower.includes('.mpd')) {
        const result = await parseMPD(url);
        if (result) {
            qualities = result.qualities;
            isSegmented = true;
            if (result.totalDuration && qualities && qualities[0].bandwidth !== 'unknown') {
                const bwKbps = parseInt(qualities[0].bandwidth);
                estimatedSize = (bwKbps * 1024 / 8) * result.totalDuration;
            }
        }
      }

      chrome.tabs.get(tabId, (tab) => {
        if (!chrome.runtime.lastError && tab) addMedia(tabId, url, tab.title, qualities, encryption, isSegmented, estimatedSize);
      });
      state.processingUrls.delete(url);
    }
  },
  { urls: ["<all_urls>"] }
);

// --- Universal MIME Sniffer (Tier 2 Fallback) ---
chrome.webRequest.onResponseStarted.addListener(
  async (details) => {
    const { url, tabId, responseHeaders, type } = details;
    if (tabId === -1 || state.processingUrls.has(url)) return;

    // Skip common non-media types early
    const skipTypes = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'font', 'image'];
    if (skipTypes.includes(type)) return;

    // Extract Content-Type and Content-Length
    if (!responseHeaders) return;
    const contentTypeHeader = responseHeaders.find(h => h.name.toLowerCase() === 'content-type');
    const contentLengthHeader = responseHeaders.find(h => h.name.toLowerCase() === 'content-length');
    
    if (!contentTypeHeader) return;
    const contentType = contentTypeHeader.value;
    const contentLength = contentLengthHeader ? parseInt(contentLengthHeader.value) : 0;

    // Filter Noise
    if (NOISE_KEYWORDS.some(kw => url.includes(kw))) return;
    if (isNoiseFragment(url)) return;

    if (isValidMediaMime(contentType, url)) {
      const urlLower = url.toLowerCase();
      // Exemption: Manifests and verified media paths/params (like TikTok video streams) skip the size check.
      const isManifest = urlLower.includes('.m3u8') || urlLower.includes('.mpd') || contentType.includes('mpegurl') || contentType.includes('dash+xml');
      const isVerified = isVerifiedMedia(urlLower);
      
      // Logic: If it's a direct stream (not a manifest/verified stream), ignore if < 1MB (1048576 bytes) 
      // This is a universal way to filter out JSON/Telemetry blobs that might use octet-stream.
      if (!isManifest && !isVerified && contentLength > 0 && contentLength < 1048576) return;

      state.processingUrls.add(url);
      chrome.tabs.get(tabId, (tab) => {
        if (!chrome.runtime.lastError && tab) {
          addMedia(tabId, url, tab.title, null, null, isManifest, contentLength || 0);
        }
      });
      state.processingUrls.delete(url);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// --- Tab Lifecycle ---
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') cleanTab(tabId);
});
chrome.tabs.onRemoved.addListener(cleanTab);

// --- Message Central ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { type } = request;

  if (type === 'GET_URLS') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ urls: tabs[0] ? (state.tabStorage.get(tabs[0].id) || []) : [] });
    });
    return true;
  }

  if (type === 'GET_MERGE_STATUS') {
    sendResponse(state.globalMergeStatus);
    return true;
  }

  if (type === 'CLEAR_URLS') {
    if (state.globalMergeStatus.isMerging) chrome.runtime.sendMessage({ type: 'CANCEL_FFMPEG_MERGE' }).catch(() => {});
    resetGlobalMergeStatus();
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) cleanTab(tabs[0].id);
      sendResponse({ status: 'cleared' });
    });
    return true;
  }

  if (type === 'GET_SEGMENTS') {
    if (request.url.includes('.m3u8')) parseHlsSegments(request.url).then(sendResponse);
    else if (request.url.includes('.mpd')) parseDashSegments(request.url).then(sendResponse);
    else sendResponse({ segments: [], encryption: null, mapUrl: null });
    return true;
  }

  if (type === 'START_FFMPEG_MERGE') {
    state.globalMergeStatus = { 
      isMerging: true, 
      itemId: request.itemId, 
      url: request.manifestUrl || request.videoUrl, 
      title: request.outputName, // Added title for global tracking
      progress: 0, 
      stage: chrome.i18n.getMessage('initializing') 
    };
    const targetUrl = request.manifestUrl || request.videoUrl || '*';
    updateDnrRulesForFetch(request.referer, request.ua, targetUrl, true).then(() => handleFfmpegMerge(request));
    return true;
  }

  if (type === 'START_DIRECT_DOWNLOAD') {
    const isSensitive = request.url.includes('tiktok.com') || request.url.includes('douyinvod.com') || request.url.includes('bilibili.com');
    updateDnrRulesForFetch(request.referer, request.ua, request.url).then(() => {
        if (isSensitive) {
            handleProxyDownload({ ...request, outputName: request.filename });
        } else {
            chrome.downloads.download({ url: request.url, filename: `${request.filename}.mp4`, saveAs: true }, () => {
                setTimeout(clearDnrRules, 5000);
            });
        }
        sendResponse({ status: 'started' });
    });
    return true;
  }

  if (type === 'UPDATE_DNR_FOR_PREVIEW') {
    updateDnrRulesForFetch(request.referer, request.ua, request.url).then(() => {
      sendResponse({ status: 'applied' });
      // Clear rules after a safe buffer for preview start
      setTimeout(clearDnrRules, 10000);
    });
    return true;
  }

  if (type === 'CLEAR_DNR_RULES') {
    clearDnrRules().catch(logger.error);
    return true;
  }

  if (type === 'CANCEL_FFMPEG_MERGE') {
    // Offscreen already receives this message directly from popup via chrome.runtime.sendMessage.
    // Do NOT re-broadcast here — that would loop back into this same handler.
    state.globalMergeStatus.isMerging = false;
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    clearDnrRules().catch(logger.error);
    setTimeout(() => chrome.offscreen.closeDocument().catch(() => {}), 500);
    return true;
  }

  if (type === 'FFMPEG_READY') { handleOffscreenReady(); return true; }

  if (type === 'FFMPEG_PROGRESS') {
    const stage = chrome.i18n.getMessage(request.stage) || request.stage;
    Object.assign(state.globalMergeStatus, { progress: request.progress, stage, url: request.url, itemId: request.itemId, isMerging: true });
    if (request.outputName) state.globalMergeStatus.title = request.outputName;
    chrome.action.setBadgeText({ text: `${Math.round(request.progress)}%` }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#ffcc00' }).catch(() => {});
    chrome.runtime.sendMessage(request).catch(() => {});
    return true;
  }

  if (type === 'FFMPEG_COMPLETE' || type === 'FFMPEG_ERROR') {
    state.globalMergeStatus.isMerging = false;
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    clearDnrRules().catch(logger.error);
    chrome.runtime.sendMessage(request).catch(() => {});
    if (type === 'FFMPEG_COMPLETE') {
      // Close offscreen only after the download is registered so the browser has
      // captured the blob before the document (and its blob URLs) are destroyed.
      chrome.downloads.download(
        { url: request.blobUrl || request.dataUrl, filename: `${request.filename}.mp4`, saveAs: true },
        () => chrome.offscreen.closeDocument().catch(() => {})
      );
    } else {
      chrome.offscreen.closeDocument().catch(() => {});
    }
    return true;
  }

  if (type === 'DEBUG_LOG') { logger.debug(request.content); return true; }
});
