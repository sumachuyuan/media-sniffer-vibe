/**
 * Sovereign Media Sniffer - Main Entry (v25.0.0 Modular)
 */
import { logger, DEBUG } from '../common/logger.js';
import { state, cleanTab, resetGlobalMergeStatus } from './storage.js';
import {
  MEDIA_SIGNATURES, NOISE_KEYWORDS, isNoiseFragment,
  extractGroupTag, detectMediaType, isValidMediaMime, isVerifiedMedia, normalizeUrl
} from './sniffer.js';
import { PLATFORM_RULES } from './platforms.js';
import { parseM3U8, parseMPD, parseHlsSegments, parseDashSegments } from './parser.js';
import {
  handleFfmpegMerge, handleProxyDownload, handleFfmpegRemux, handleAudioExtract,
  handleOffscreenReady, clearDnrRules, updateDnrRulesForFetch,
  dispatchToRecordOffscreen, handleRecordOffscreenReady, closeRecordOffscreen,
  getIsRecordActive,
} from './orchestrator.js';

// --- Helper: Add Media to Storage ---
function sanitizeTitle(title) {
  if (!title || title === 'Embedded Media' || title === chrome.i18n.getMessage('targetPage')) return title || chrome.i18n.getMessage('targetPage');
  const platforms = ['YouTube', 'Bilibili', '哔哩哔哩', '抖音', 'Douyin', 'TikTok', 'Instagram', 'Twitter', 'X', 'Feishu', '飞书'];
  let cleanTitle = title;
  const parts = cleanTitle.split(/ - | \| | _ | – /);
  if (parts.length > 1) {
    const bestPart = parts.sort((a, b) => b.length - a.length).find(p => !platforms.some(plat => p.toLowerCase().includes(plat.toLowerCase())));
    if (bestPart) cleanTitle = bestPart.trim();
    else cleanTitle = parts[0].trim();
  }
  return cleanTitle;
}

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
    tabTitle: sanitizeTitle(title),
    qualities,
    mediaType: detectMediaType(url),
    groupTag: extractGroupTag(url),
    encryption,
    isSegmented,
    estimatedSize
  });

  if (urls.length > 50) urls.shift();
  chrome.action.setBadgeText({ tabId, text: urls.length.toString() }).catch(() => { });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#FFD700' }).catch(() => { });
}

// --- Network Listener ---
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    const { tabId } = details;
    let { url } = details;
    if (tabId === -1) return;

    url = normalizeUrl(url);
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

      chrome.tabs.sendMessage(tabId, { type: 'GET_PURE_TITLE', url: url }, (response) => {
        if (chrome.runtime.lastError) {
          chrome.tabs.get(tabId, (tab) => {
            if (!chrome.runtime.lastError && tab) addMedia(tabId, url, tab.title, qualities, encryption, isSegmented, estimatedSize);
          });
          return;
        }
        const title = (response && response.title) ? response.title : null;
        if (title) {
          addMedia(tabId, url, title, qualities, encryption, isSegmented, estimatedSize);
        } else {
          chrome.tabs.get(tabId, (tab) => {
            if (!chrome.runtime.lastError && tab) addMedia(tabId, url, tab.title, qualities, encryption, isSegmented, estimatedSize);
          });
        }
      });
      state.processingUrls.delete(url);
    }
  },
  { urls: ["<all_urls>"] }
);

// --- Universal MIME Sniffer (Tier 2 Fallback) ---
chrome.webRequest.onResponseStarted.addListener(
  async (details) => {
    const { tabId, responseHeaders, type } = details;
    let { url } = details;
    if (tabId === -1 || state.processingUrls.has(url)) return;

    url = normalizeUrl(url);
    if (state.processingUrls.has(url)) return;

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
      chrome.tabs.sendMessage(tabId, { type: 'GET_PURE_TITLE', url: url }, (response) => {
        if (chrome.runtime.lastError) {
          chrome.tabs.get(tabId, (tab) => {
            if (!chrome.runtime.lastError && tab) addMedia(tabId, url, tab.title, null, null, isManifest, contentLength || 0);
          });
          return;
        }
        const title = (response && response.title) ? response.title : null;
        if (title) {
          addMedia(tabId, url, title, null, null, isManifest, contentLength || 0);
        } else {
          chrome.tabs.get(tabId, (tab) => {
            if (!chrome.runtime.lastError && tab) {
              addMedia(tabId, url, tab.title, null, null, isManifest, contentLength || 0);
            }
          });
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

  if (type === 'MEDIA_DETECTED') {
    const { url, title, isManualExtract } = request;
    const tabId = sender.tab ? sender.tab.id : -1;
    const senderUrl = sender.tab ? sender.tab.url : '';
    if (tabId !== -1 && url && isManualExtract && senderUrl.includes('tiktok.com')) {
      addMedia(tabId, url, title || (sender.tab ? sender.tab.title : null));
    }
  }

  if (type === 'GET_URLS') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ urls: tabs[0] ? (state.tabStorage.get(tabs[0].id) || []) : [] });
    });
    return true;
  }

  if (type === 'GET_MERGE_STATUS') {
    sendResponse(state.globalMergeStatus);
  }

  if (type === 'CLEAR_URLS') {
    if (state.globalMergeStatus.isMerging) chrome.runtime.sendMessage({ type: 'CANCEL_FFMPEG_MERGE' }).catch(() => { });
    resetGlobalMergeStatus();
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) cleanTab(tabs[0].id);
      sendResponse({ status: 'cleared' });
    });
    return true;
  }

  if (type === 'GET_SEGMENTS') {
    logger.info(`GET_SEGMENTS requested for: ${request.url}`);
    if (request.url.includes('.m3u8')) parseHlsSegments(request.url).then(res => {
        logger.info(`HLS Parse completed. Found ${res.segments?.length || 0} segments.`);
        sendResponse(res);
    });
    else if (request.url.includes('.mpd')) parseDashSegments(request.url).then(res => {
        logger.info(`DASH Parse completed. Found ${res.segments?.length || 0} segments.`);
        sendResponse(res);
    });
    else sendResponse({ segments: [], encryption: null, mapUrl: null });
    return true;
  }

  if (type === 'START_WEBM_REMUX') {
    // Phase 5: Post-recording WebM → MP4 container remux via FFmpeg.wasm (no re-encode).
    state.globalMergeStatus = {
      isMerging: true,
      itemId: null,
      url: request.outputName,
      title: `转封装: ${request.outputName}`,
      progress: 0,
      stage: '准备 MP4 转封装...',
    };
    handleFfmpegRemux(request);
    sendResponse({ status: 'queued' });
  }

  if (type === 'START_FFMPEG_MERGE') {
    logger.info(`START_FFMPEG_MERGE initiated for: ${request.outputName}`, { segments: request.segments?.length });
    state.globalMergeStatus = {
      isMerging: true,
      itemId: request.itemId,
      url: request.manifestUrl || request.videoUrl,
      title: request.outputName,
      progress: 0,
      stage: chrome.i18n.getMessage('initializing')
    };
    const targetUrl = request.manifestUrl || request.videoUrl || '*';
    updateDnrRulesForFetch(request.referer, request.ua, targetUrl, true).then(() => handleFfmpegMerge(request));
    sendResponse({ status: 'queued' });
  }

  if (type === 'START_DIRECT_DOWNLOAD') {
    const isSensitive = PLATFORM_RULES.some(r => r.proxyRequired && r.match(request.url.toLowerCase()));
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
  }

  if (type === 'CANCEL_FFMPEG_MERGE') {
    // Offscreen already receives this message directly from popup via chrome.runtime.sendMessage.
    // Do NOT re-broadcast here — that would loop back into this same handler.
    state.globalMergeStatus.isMerging = false;
    chrome.action.setBadgeText({ text: '' }).catch(() => { });
    clearDnrRules().catch(logger.error);
    setTimeout(() => chrome.offscreen.closeDocument().catch(() => { }), 500);
    sendResponse({ status: 'cancelled' });
  }

  // ---------------------------------------------------------------------------
  // Record Offscreen — Phase 1 Transferable prototype
  // ---------------------------------------------------------------------------
  if (type === 'GET_TAB_STREAM_ID') {
    // Phase 4: obtain a tabCapture stream ID so the offscreen document can call getUserMedia.
    // chrome.tabCapture.getMediaStreamId is only available in the service worker context.
    chrome.tabCapture.getMediaStreamId({ targetTabId: request.targetTabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ streamId });
      }
    });
    return true;
  }

  if (type === 'START_RECORD_TEST') {
    // fileHandle is NOT passed here — it is stored in IndexedDB by the popup
    // and retrieved directly by the offscreen document, bypassing IPC serialization.
    dispatchToRecordOffscreen({
      type: 'START_RECORD_TEST',
      streamId: request.streamId,
      quality: request.quality,
      isAudioOnly: request.isAudioOnly || false,
    });
    // Persist recording state so popup can restore UI after being reopened.
    chrome.storage.local.set({
      recordingState: {
        isRecording: true,
        startTime: Date.now(),
        filename: request.filename || null,
        quality: request.quality || '1080P',
      },
    }).catch(() => {});
    sendResponse({ status: 'dispatched' });
  }

  if (type === 'STOP_RECORD_TEST') {
    // Offscreen is already open — send directly
    chrome.runtime.sendMessage({ type: 'STOP_RECORD_TEST' }).catch(() => {});
    sendResponse({ status: 'dispatched' });
  }

  if (type === 'GET_RECORD_STATUS') {
    // Popup uses this for self-healing: if the background flag says no recording
    // is active, but storage still has isRecording:true (e.g. after a crash),
    // the popup can reset the stale state without user interaction.
    sendResponse({ isRecordActive: getIsRecordActive() });
  }

  if (type === 'RECORD_OFFSCREEN_READY') {
    handleRecordOffscreenReady();
    sendResponse({ ok: true });
  }

  // Forward stats / lifecycle events from offscreen → popup
  if (type === 'RECORD_STATS' || type === 'RECORD_STOPPED' || type === 'RECORD_ERROR' || type === 'RECORD_HW_CHECK') {
    chrome.runtime.sendMessage(request).catch(() => {});

    if (type === 'RECORD_STOPPED' || type === 'RECORD_ERROR') {
      // Clear persisted recording state IMMEDIATELY so popup does not show
      // stale reconnect UI on next open. Must not wait for any async chain.
      chrome.storage.local.set({ recordingState: { isRecording: false } }).catch(() => {});
    }

    // Do NOT close the record offscreen here. record/offscreen.js is still
    // running _storeRemuxBytes() asynchronously. Closing now would kill that
    // async work mid-flight. The offscreen is closed in RECORD_BLOB_READY /
    // RECORD_BLOB_FAILED once the IDB write has completed.

    sendResponse({ ok: true });
  }

  // record/offscreen.js sends RECORD_BLOB_READY after storing the WebM bytes
  // in IDB. Close the record offscreen, then forward to popup so it can enable
  // the export buttons. The user then chooses to save video or extract audio.
  if (type === 'RECORD_BLOB_READY') {
    logger.info('[Signal] Received BLOB_READY, triggering remux...');
    closeRecordOffscreen().then(() => {
      chrome.runtime.sendMessage({ type: 'RECORD_BLOB_READY', filename: request.filename }).catch(() => {});
    });
    sendResponse({ ok: true });
    return true;
  }

  if (type === 'START_AUDIO_EXTRACT') {
    state.globalMergeStatus = {
      isMerging: true,
      itemId: null,
      url: request.outputName,
      title: `提取音频: ${request.outputName}`,
      progress: 0,
      stage: '准备提取 MP3...',
    };
    handleAudioExtract(request);
    sendResponse({ status: 'queued' });
  }

  if (type === 'RECORD_BLOB_FAILED') {
    logger.warn(`Remux blob storage failed for ${request.filename}: ${request.error}`);
    closeRecordOffscreen();
    chrome.runtime.sendMessage({
      type: 'FFMPEG_ERROR',
      error: `录制文件读取失败，无法转封装: ${request.error}`,
      isRemux: true,
    }).catch(() => {});
    sendResponse({ ok: true });
  }
  // ---------------------------------------------------------------------------

  if (type === 'FFMPEG_READY') { handleOffscreenReady(); sendResponse({ status: 'ready' }); }

  if (type === 'FFMPEG_PROGRESS') {
    const stage = chrome.i18n.getMessage(request.stage) || request.stage;
    Object.assign(state.globalMergeStatus, { progress: request.progress, stage, url: request.url, itemId: request.itemId, isMerging: true });
    if (request.outputName) state.globalMergeStatus.title = request.outputName;
    chrome.action.setBadgeText({ text: `${Math.round(request.progress)}%` }).catch(() => { });
    chrome.action.setBadgeBackgroundColor({ color: '#ffcc00' }).catch(() => { });
    chrome.runtime.sendMessage(request).catch(() => { });
    sendResponse({ status: 'progress_updated' });
  }

  if (type === 'FFMPEG_COMPLETE' || type === 'FFMPEG_ERROR') {
    state.globalMergeStatus.isMerging = false;
    chrome.action.setBadgeText({ text: '' }).catch(() => { });
    clearDnrRules().catch(logger.error);
    chrome.runtime.sendMessage(request).catch(() => { });

    // In DEBUG mode, we keep the offscreen document open so the user can inspect logs.
    const closeOffscreen = () => {
      if (typeof DEBUG !== 'undefined' && DEBUG) {
        logger.info('DEBUG mode is ON: Keeping offscreen document open for log inspection.');
        return;
      }
      chrome.offscreen.closeDocument().catch(() => { });
    };

    if (type === 'FFMPEG_COMPLETE') {
      // Close offscreen only after the download is registered so the browser has
      // captured the blob before the document (and its blob URLs) are destroyed.
      chrome.downloads.download(
        { url: request.blobUrl || request.dataUrl, filename: request.filename, saveAs: true },
        closeOffscreen
      );
    } else {
      closeOffscreen();
    }
  }

  if (type === 'DEBUG_LOG') { 
    logger.debug(request.content); 
    sendResponse({ status: 'logged' });
  }
});
