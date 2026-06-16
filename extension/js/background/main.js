/**
 * Sovereign Media Sniffer - Main Entry (v25.2.0 Stabilized)
 */
import { logger, DEBUG } from '../common/logger.js';
import {
  state,
  resetGlobalMergeStatus,
  cleanTab,
  clearAllData,
} from './storage.js';
import {
  MEDIA_SIGNATURES, NOISE_KEYWORDS, isNoiseFragment,
  extractGroupTag, detectMediaType, isValidMediaMime, isVerifiedMedia, normalizeUrl
} from './sniffer.js';
import { PLATFORM_RULES } from './platforms.js';
import { parseM3U8, parseMPD, parseHlsSegments, parseDashSegments } from './parser.js';
import {
  handleFfmpegMerge, handleProxyDownload, handleFfmpegRemux, handleAudioExtract,
  handleFfmpegDone, handleOffscreenReady, clearDnrRules, updateDnrRulesForFetch,
  dispatchToRecordOffscreen, handleRecordOffscreenReady, closeRecordOffscreen,
  getIsRecordActive, createRecordOffscreen, closeOffscreen, adoptExistingOffscreen,
  setCapturing, getIsCapturing,
} from './orchestrator.js';

// Phase 9.9: Self-healing at Service Worker startup.
// Detects and clears any stale offscreen document after an idle restart.
adoptExistingOffscreen();

// ---------------------------------------------------------------------------
// Export watchdog state — protects against popup closure during disk write
// ---------------------------------------------------------------------------
// When Track A (popup-side write) begins, we start a 2-second polling watchdog.
// If the popup disappears before EXPORT_SUCCESS arrives, the watchdog fires
// Track B (SW-side background download) to guarantee file delivery.
let _exportWatcherId = null;  // setInterval handle
let _exportPendingReq = null;  // saved FFMPEG_COMPLETE request for fallback
let _exportPickerOpenedAt = null;  // timestamp when popup opened the Save File Picker

function _stopExportWatchdog() {
  if (_exportWatcherId !== null) {
    clearInterval(_exportWatcherId);
    _exportWatcherId = null;
    _exportPendingReq = null;
    _exportPickerOpenedAt = null;
    logger.info('[Watchdog] Export watchdog stopped.');
  }
}

// Shared Track B logic: ask offscreen for a Blob URL, SW calls chrome.downloads.download.
// Extracted so both the initial popup-closed path and the watchdog fallback use one code path.
function _triggerBackgroundDownload(req) {
  logger.info(`[Signal] SW background download starting for: ${req.filename}`);
  chrome.runtime.sendMessage(
    { type: 'PREPARE_BLOB_URL', isAudioExtract: !!req.isAudioExtract },
    (response) => {
      if (chrome.runtime.lastError || !response?.blobUrl) {
        logger.error(`[Signal] PREPARE_BLOB_URL failed: ${chrome.runtime.lastError?.message || 'no response'}`);
        state.globalMergeStatus.isMerging = false;
        closeOffscreen('ffmpeg');
        return;
      }
      const { blobUrl } = response;
      logger.info(`[Signal] Blob URL received. SW calling chrome.downloads.download for: ${req.filename}`);
      chrome.downloads.download(
        { url: blobUrl, filename: req.filename, saveAs: false },
        (downloadId) => {
          state.globalMergeStatus.isMerging = false;
          if (chrome.runtime.lastError || downloadId === undefined) {
            logger.error(`[Signal] chrome.downloads.download failed: ${chrome.runtime.lastError?.message}`);
            chrome.runtime.sendMessage({ type: 'REVOKE_BLOB_URL', blobUrl }).catch(() => { });
            closeOffscreen('ffmpeg');
            return;
          }
          // Track B succeeded — clear the export marker so popup buttons unlock on next open.
          chrome.storage.local.remove('pendingExportTask').catch(() => { });
          logger.info(`[Signal] Download registered (id=${downloadId}). Holding offscreen 3s...`);
          setTimeout(() => {
            URL.revokeObjectURL(blobUrl);
            chrome.runtime.sendMessage({ type: 'OFFSCREEN_CLEANUP_REQ' }).catch(() => { });
            closeOffscreen('ffmpeg');
          }, 3000);
        }
      );
    }
  );
}

// ---------------------------------------------------------------------------
// Recording state helper — single write path for chrome.storage.local
// ---------------------------------------------------------------------------
/**
 * Merge `patch` into the persisted `recordingState` object.
 * Using a merge (rather than full replace) ensures fields set by previous
 * events (e.g. filename, isAudioOnly) are preserved across lifecycle transitions.
 */
function _setRecordState(patch) {
  chrome.storage.local.get('recordingState', (res) => {
    const prev = res?.recordingState || {};
    chrome.storage.local.set({ recordingState: { ...prev, ...patch } }).catch(() => { });
  });
}

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

async function addMedia(tabId, rawUrl, title, qualities = null, encryption = null, isSegmented = false, estimatedSize = 0) {
  const url = normalizeUrl(rawUrl);
  const urlLower = url.toLowerCase();

  if (!state.tabStorage.has(tabId)) state.tabStorage.set(tabId, []);
  let urls = state.tabStorage.get(tabId);

  // 1. Generate a "Fingerprint" for robust deduplication.
  const getFingerprint = (u) => {
    try {
      const urlObj = new URL(u);
      const path = urlObj.pathname.toLowerCase();
      const mediaExts = ['.mp3', '.mp4', '.wav', '.aac', '.flac', '.opus', '.webm', '.ts', '.m4a', '.m4v'];

      if (mediaExts.some(ext => path.endsWith(ext))) {
        // For standard extensions, path is enough, ignore all query params.
        return urlObj.protocol + "//" + urlObj.host + urlObj.pathname.toLowerCase();
      }

      // For extension-less URLs, aggressively strip known dynamic noise params.
      urlObj.hash = '';
      const noiseParams = ['token', 'sign', 'sig', 'signature', 'timestamp', 'expire', 'expires', '_t', 'ts', 'time', 't', '_', 'auth', 'key', 'nonce', 'uuid', 'req_id', 'session_id', 'l', 'qs', 'btag'];
      for (const p of noiseParams) {
        urlObj.searchParams.delete(p);
      }
      return urlObj.toString().toLowerCase();
    } catch (e) { }
    return u.toLowerCase();
  };
  const fingerprint = getFingerprint(url);

  // 1.5. Generate a "Path Fingerprint" to catch CDN/Redirect domain shifts.
  const getPathFingerprint = (u) => {
    try {
      const urlObj = new URL(u);
      urlObj.hash = '';
      const noiseParams = ['token', 'sign', 'sig', 'signature', 'timestamp', 'expire', 'expires', '_t', 'ts', 'time', 't', '_', 'auth', 'key', 'nonce', 'uuid', 'req_id', 'session_id', 'l', 'qs', 'btag'];
      for (const p of noiseParams) {
        urlObj.searchParams.delete(p);
      }
      const pathAndSearch = urlObj.pathname.toLowerCase() + urlObj.search.toLowerCase();
      return pathAndSearch.length > 8 ? pathAndSearch : u.toLowerCase();
    } catch (e) { }
    return u.toLowerCase();
  };
  const pathFingerprint = getPathFingerprint(url);

  // 2. Check for duplicates using raw normalized URL, Fingerprint, and Exact File Size
  const urlObjForCheck = new URL(url);
  const existing = urls.find(item => {
    const itemLower = item.url.toLowerCase();

    // Exact URL match or Fingerprint match
    if (itemLower === urlLower) return true;
    if (getFingerprint(itemLower) === fingerprint) return true;

    // Cross-Domain CDN/Redirect match
    if (getPathFingerprint(itemLower) === pathFingerprint) return true;

    // Size-based deduplication: If exact same host and exact same positive file size (>10KB), it's the same media.
    if (estimatedSize > 10240 && item.estimatedSize === estimatedSize) {
      try {
        const itemObj = new URL(item.url);
        if (itemObj.host === urlObjForCheck.host) {
          return true;
        }
      } catch (e) { }
    }

    return false;
  });

  if (!isSegmented && (urlLower.includes('.m3u8') || urlLower.includes('.mpd') || urlLower.includes('chunklist'))) {
    isSegmented = true;
  }

  if (existing) {
    let updated = false;
    // Keep the most informative qualities/encryption
    if (!existing.qualities && qualities) { existing.qualities = qualities; updated = true; }
    if (!existing.encryption && encryption) { existing.encryption = encryption; updated = true; }
    if (!existing.isSegmented && isSegmented) { existing.isSegmented = isSegmented; updated = true; }
    if (estimatedSize > 0 && (!existing.estimatedSize || existing.estimatedSize === 0)) {
      existing.estimatedSize = estimatedSize;
      updated = true;
    }
    // Optimization: if current title is better (e.g. from DOM scanning), update it
    const newTabTitle = sanitizeTitle(title);
    if (newTabTitle && newTabTitle !== 'Unknown' && (!existing.tabTitle || existing.tabTitle === 'Unknown' || newTabTitle.length > existing.tabTitle.length)) {
      existing.tabTitle = newTabTitle;
    }
    if (updated) {
      const uniqueUrls = new Set(urls.map(u => u.url.toLowerCase()));
      chrome.action.setBadgeText({ tabId, text: uniqueUrls.size.toString() }).catch(() => { });
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

  if (urls.length > 200) urls.shift(); // Increased from 50 to 200 to handle SPA scrolling smoothly

  // Calculate unique count directly from the array to ensure badge-list consistency
  const uniqueUrls = new Set(urls.map(u => u.url.toLowerCase()));
  const badgeText = uniqueUrls.size > 0 ? uniqueUrls.size.toString() : '';

  chrome.action.setBadgeText({ tabId, text: badgeText }).catch(() => { });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#FFD700' }).catch(() => { });
}

// --- Network Listener ---
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    let { tabId, url } = details;
    // Crucial Fix: Service Worker requests (like TikTok video fetch) have tabId === -1
    // We map them to the currently active tab just like Cat-Catch does.
    if (tabId === -1) {
      if (state.activeTabId) tabId = state.activeTabId;
      else {
        // Cold start fallback: Service worker just woke up, activeTabId not yet populated
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs && tabs[0]) {
            state.activeTabId = tabs[0].id;
            tabId = tabs[0].id;
          } else {
            return;
          }
        } catch (e) { return; }
      }
    }

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
        // Always ensure the lock is cleared, even if there's an error
        setTimeout(() => state.processingUrls.delete(url), 2000); // Keep lock for 2s to be safe

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
    }
  },
  { urls: ["<all_urls>"] }
);

// --- Universal MIME Sniffer (Tier 2 Fallback) ---
chrome.webRequest.onResponseStarted.addListener(
  async (details) => {
    const { responseHeaders, type } = details;
    let { tabId, url } = details;

    if (tabId === -1) {
      if (state.activeTabId) tabId = state.activeTabId;
      else {
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs && tabs[0]) {
            state.activeTabId = tabs[0].id;
            tabId = tabs[0].id;
          } else {
            return;
          }
        } catch (e) { return; }
      }
    }

    if (state.processingUrls.has(url)) return;

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
      const contentTypeLower = contentType.toLowerCase();
      // Exemption: Manifests and verified media paths/params (like TikTok video streams) skip the size check.
      const isManifest = urlLower.includes('.m3u8') || urlLower.includes('.mpd') || contentTypeLower.includes('mpegurl') || contentTypeLower.includes('dash+xml');
      const isVerified = isVerifiedMedia(urlLower);

      // Logic: If it's a direct stream (not a manifest/verified stream), ignore if < 1MB (1048576 bytes) 
      // This is a universal way to filter out JSON/Telemetry blobs that might use octet-stream.
      if (!isManifest && !isVerified && contentLength > 0 && contentLength < 102400) return;

      state.processingUrls.add(url);
      chrome.tabs.sendMessage(tabId, { type: 'GET_PURE_TITLE', url: url }, (response) => {
        setTimeout(() => state.processingUrls.delete(url), 2000); // Always release the lock

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
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// --- Tab Lifecycle (Cat-Catch pattern) ---
chrome.webNavigation.onCommitted.addListener((details) => {
  // Only clear tab data on genuine main-frame navigations, ignoring subframes and pushState/SPA routing
  if (details.frameId === 0 && !details.transitionQualifiers?.includes('client_redirect')) {
    const isFullReload = ['reload', 'link', 'typed', 'generated', 'auto_bookmark'].includes(details.transitionType);
    if (isFullReload) {
      cleanTab(details.tabId);
    }
  }
});

chrome.tabs.onRemoved.addListener(cleanTab);

// --- Message Central ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    const { type } = request;

    if (type === 'MEDIA_DETECTED') {
      const { url, title } = request;
      const tabId = sender.tab ? sender.tab.id : -1;

      // Critical fix: Also apply the processing lock to DOM-based detections
      if (tabId !== -1 && url && !state.processingUrls.has(url)) {
        addMedia(tabId, url, title || (sender.tab ? sender.tab.title : null));
      }
    }

    if (type === 'GET_URLS') {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        sendResponse({ urls: tabs[0] ? (state.tabStorage.get(tabs[0].id) || []) : [] });
      });
    }

    if (type === 'GET_MERGE_STATUS') {
      sendResponse(state.globalMergeStatus);
    }

    if (type === 'RESET_GLOBAL_MERGE') {
      resetGlobalMergeStatus();
      closeOffscreen();
      sendResponse({ ok: true });
    }

    if (type === 'CLEAR_URLS') {
      if (state.globalMergeStatus.isMerging) chrome.runtime.sendMessage({ type: 'CANCEL_FFMPEG_MERGE' }).catch(() => { });
      resetGlobalMergeStatus();
      closeOffscreen();
      clearAllData();
      sendResponse({ status: 'cleared' });
    }

    if (type === 'CLEAR_RECORD_STORAGE') {
      // Forward IDB clear request to the persistent record offscreen.
      // Must use 'CLEAR_RECORD_STORAGE' to match the handler in record/offscreen.js.
      dispatchToRecordOffscreen({ type: 'CLEAR_RECORD_STORAGE' });
      sendResponse({ ok: true });
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
    }

    // ── Single-instance guard ──────────────────────────────────────────────────
    // Reject any new FFmpeg/download task if one is already in progress.
    // Prevents concurrent writes, queue-jumping, and IDB data corruption.
    if (state.globalMergeStatus.isMerging &&
      (type === 'START_FFMPEG_MERGE' ||
        type === 'START_DIRECT_DOWNLOAD' ||
        type === 'START_WEBM_REMUX' ||
        type === 'START_AUDIO_EXTRACT')) {
      logger.warn(`[SW] ${type} rejected — task already in progress (isMerging=true).`);
      sendResponse({ error: 'BUSY' });
      return;
    }

    if (type === 'START_WEBM_REMUX') {
      // Pre-clear: if capture has already stopped but the record offscreen is still alive
      // (IDB consolidation), close it now so FFmpeg can take the single offscreen slot.
      if (!getIsCapturing() && getIsRecordActive()) {
        logger.info('[SW] START_WEBM_REMUX: pre-clearing lingering record offscreen.');
        await closeRecordOffscreen();
      }
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
      // Gate: reject only if active capture is running.
      if (getIsCapturing()) {
        logger.warn('[SW] START_FFMPEG_MERGE rejected — recording is actively capturing.');
        sendResponse({ error: '正在录制中，请先停止录制再发起合并' });
        return;
      }
      // Pre-clear: if a record offscreen is alive but idle/consolidating, close it to make room for FFmpeg.
      if (getIsRecordActive()) {
        logger.info('[SW] START_FFMPEG_MERGE: pre-clearing lingering record offscreen.');
        await closeRecordOffscreen();
      }
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
    }

    if (type === 'UPDATE_DNR_FOR_PREVIEW') {
      updateDnrRulesForFetch(request.referer, request.ua, request.url).then(() => {
        sendResponse({ status: 'applied' });
        // Safety net: auto-clear after 5 min in case page unload cleanup fails
        setTimeout(clearDnrRules, 5 * 60 * 1000);
      });
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
    // Record Offscreen — Phase 9.8 Pre-warm & Authorization Hardening
    // ---------------------------------------------------------------------------
    if (type === 'PRE_WARM_RECORD_OFFSCREEN') {
      // Phase 9.8: Ensure the record offscreen exists BEFORE getMediaStreamId is called.
      // This allows the document to be "hot" and ready to receive the streamId immediately
      // without crossing a heavy async boundary after the user gesture.
      await createRecordOffscreen();
      sendResponse({ status: 'warmed' });
      return;
    }

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
    }

    if (type === 'START_RECORD_TEST') {
      if (request._isBackgroundProxy) { sendResponse({ ok: false }); return; }

      // getMediaStreamId MUST be called from the SW context (not from the popup).
      chrome.tabCapture.getMediaStreamId({ targetTabId: request.targetTabId }, (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          const err = chrome.runtime.lastError?.message || '无法获取标签页捕获 ID';
          logger.error(`[Record] getMediaStreamId failed: ${err}`);
          _setRecordState({ isRecording: false, isConsolidating: false, isReady: false });
          chrome.runtime.sendMessage({ type: 'RECORD_ERROR', error: err }).catch(() => { });
          sendResponse({ error: err }); // CRITICAL: Acknowledge the original request
          return;
        }

        setCapturing(true);
        dispatchToRecordOffscreen({
          type: 'START_RECORD_TEST',
          streamId,
          quality: request.quality,
          isAudioOnly: request.isAudioOnly || false,
          filename: request.filename,
        });

        _setRecordState({
          isRecording: true,
          isConsolidating: false,
          isReady: false,
          startTime: Date.now(),
          filename: request.filename || null,
          quality: request.quality || '1080P',
        });
      });
      // Acknowledge immediately to let popup transaction complete.
      sendResponse({ ok: true });
    }

    if (type === 'STOP_RECORD_TEST') {
      // Offscreen is already open — send directly
      chrome.runtime.sendMessage({ type: 'STOP_RECORD_TEST' }).catch(() => { });
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
      chrome.runtime.sendMessage(request).catch(() => { });

      if (type === 'RECORD_STOPPED') {
        // Capture frames have stopped — FFmpeg dispatch is now safe once IDB consolidates.
        setCapturing(false);
        // isConsolidating = true: popup shows "正在写入..." until RECORD_BLOB_READY arrives.
        _setRecordState({
          isRecording: false,
          isConsolidating: true,
          isReady: false,
          filename: request.filename,
          isAudioOnly: !!request.isAudioOnly,
          stoppedAt: Date.now(),
        });
      }
      if (type === 'RECORD_ERROR') {
        setCapturing(false);
        _setRecordState({ isRecording: false, isConsolidating: false, isReady: false });
        closeRecordOffscreen();
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
      logger.info('[Signal] Received BLOB_READY, storage confirmed.');
      // Transition out of isConsolidating before notifying the popup.
      _setRecordState({ isConsolidating: false, isReady: true });
      closeRecordOffscreen().then(() => {
        chrome.runtime.sendMessage({ type: 'RECORD_BLOB_READY', filename: request.filename }).catch(() => { });
      });
      sendResponse({ ok: true });
    }

    if (type === 'START_AUDIO_EXTRACT') {
      // Pre-clear: same as START_WEBM_REMUX — close lingering record offscreen if safe.
      if (!getIsCapturing() && getIsRecordActive()) {
        logger.info('[SW] START_AUDIO_EXTRACT: pre-clearing lingering record offscreen.');
        await closeRecordOffscreen();
      }
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
      _setRecordState({ isRecording: false, isConsolidating: false, isReady: false });
      closeRecordOffscreen();
      chrome.runtime.sendMessage({
        type: 'FFMPEG_ERROR',
        error: `录制文件读取失败，无法转封装: ${request.error}`,
        isRemux: true,
      }).catch(() => { });
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
      // Only broadcast to popup if one is currently open — avoids "no channel" error spam
      const _progressContexts = await chrome.runtime.getContexts({ contextTypes: ['POPUP'] });
      if (_progressContexts.length > 0) {
        chrome.runtime.sendMessage(request).catch(() => { });
      }
      sendResponse({ status: 'progress_updated' });
    }

    if (type === 'FFMPEG_COMPLETE' || type === 'FFMPEG_ERROR') {
      // Note: isMerging is set to false conditionally below — the popup-closed background
      // download path keeps it true until chrome.downloads.download confirms registration.
      handleFfmpegDone();
      chrome.action.setBadgeText({ text: '' }).catch(() => { });
      clearDnrRules().catch(logger.error);

      if (type === 'FFMPEG_COMPLETE') {
        if (request.useIDBOutput) {
          // ─── Adaptive Dual-Track Export ───────────────────────────────────────────
          // MV3: getViews() is unavailable in Service Workers; use getContexts() instead.
          const _completeContexts = await chrome.runtime.getContexts({ contextTypes: ['POPUP'] });
          const hasActivePopup = _completeContexts.length > 0;

          if (hasActivePopup) {
            // ── Track A: Popup is open ─────────────────────────────────────────────
            // Forward FFMPEG_COMPLETE so popup can write via FileSystemFileHandle.
            // isMerging stays TRUE until EXPORT_SUCCESS confirms the write completed.
            // Offscreen stays alive as a fallback in case popup closes mid-write.
            logger.info('[Signal] Popup ACTIVE — arming write watchdog (popup receives FFMPEG_COMPLETE directly from offscreen).');

            // Save request for potential Track B fallback
            _exportPendingReq = { filename: request.filename, isAudioExtract: !!request.isAudioExtract };

            // Watchdog: poll every 2s. If popup disappears before EXPORT_SUCCESS,
            // switch to Track B. If the file picker was opened very recently (<5s),
            // apply a grace delay to avoid racing with an in-progress disk write.
            _exportWatcherId = setInterval(async () => {
              const _watchdogContexts = await chrome.runtime.getContexts({ contextTypes: ['POPUP'] });
              if (_watchdogContexts.length === 0) {
                logger.warn('[Watchdog] Popup closed during write! Switching to SW background download.');
                const pendingReq = _exportPendingReq;
                const pickerOpenedAt = _exportPickerOpenedAt;
                _stopExportWatchdog(); // clears all state
                if (!pendingReq) return;
                const elapsed = pickerOpenedAt ? (Date.now() - pickerOpenedAt) : Infinity;
                if (elapsed < 5000) {
                  const delay = 5000 - elapsed;
                  logger.info(`[Watchdog] Picker opened ${elapsed}ms ago — waiting ${delay}ms grace before fallback.`);
                  setTimeout(() => _triggerBackgroundDownload(pendingReq), delay);
                } else {
                  _triggerBackgroundDownload(pendingReq);
                }
              }
            }, 2000);

          } else {
            // ── Track B: Popup is closed ───────────────────────────────────────────
            // isMerging stays true until download is registered (see _triggerBackgroundDownload).
            logger.info('[Signal] Popup INACTIVE — going straight to SW background download.');
            _triggerBackgroundDownload({ filename: request.filename, isAudioExtract: !!request.isAudioExtract });
          }

        } else {
          // ─── Legacy FFmpeg flow (blobUrl already in offscreen Blob store) ─────────
          // blobUrl is invalidated the moment closeDocument() fires — download first.
          state.globalMergeStatus.isMerging = false;
          const _legacyContexts = await chrome.runtime.getContexts({ contextTypes: ['POPUP'] });
          const hasActivePopup = _legacyContexts.length > 0;
          logger.info(`[Signal] Legacy download: file=${request.filename}, saveAs=${hasActivePopup} (popup ${hasActivePopup ? 'open' : 'closed'})`);
          chrome.runtime.sendMessage(request).catch(() => { });
          chrome.downloads.download(
            { url: request.blobUrl || request.dataUrl, filename: request.filename, saveAs: hasActivePopup },
            () => closeOffscreen('ffmpeg'), // Close AFTER download registry takes ownership of the Blob URL
          );
        }
      } else {
        // ─── FFMPEG_ERROR ─────────────────────────────────────────────────────────
        state.globalMergeStatus.isMerging = false;
        closeOffscreen('ffmpeg');
        chrome.runtime.sendMessage(request).catch(() => { });
      }
    }

    if (type === 'EXPORT_SUCCESS') {
      // Popup successfully completed writable.close() — stop watchdog and release lock.
      logger.info('[Signal] EXPORT_SUCCESS received. Disk write confirmed. Stopping watchdog and closing offscreen.');
      _stopExportWatchdog();
      chrome.storage.local.remove('pendingExportTask').catch(() => { }); // belt-and-suspenders cleanup
      state.globalMergeStatus.isMerging = false;
      closeOffscreen('ffmpeg');
      sendResponse({ ok: true });
    }

    if (type === 'EXPORT_PICKER_OPENED') {
      // Popup opened the Save File Picker — record the timestamp for watchdog grace period.
      _exportPickerOpenedAt = Date.now();
      logger.info('[Watchdog] EXPORT_PICKER_OPENED received. 5s grace period armed.');
      sendResponse({ ok: true });
    }

    if (type === 'OFFSCREEN_CLEANUP_REQ') {
      logger.info('[Orchestrator] Received background cleanup request. Closing offscreen.');
      closeOffscreen('ffmpeg');
      sendResponse({ ok: true });
    }

    if (type === 'OFFSCREEN_HEARTBEAT') {
      // Receiving any message resets the MV3 SW idle timer.
      // This handler is intentionally a no-op — just being reached is sufficient.
      logger.debug(`[SW] Heartbeat from offscreen (task: ${request.task || 'unknown'}). SW remains active.`);
      sendResponse({ ok: true });
    }

    if (type === 'DEBUG_LOG') {
      logger.debug(request.content);
      sendResponse({ status: 'logged' });
    }
  })();
  return true; // Keep message channel open for async sendResponse
});
