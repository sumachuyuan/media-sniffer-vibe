/**
 * Sovereign Orchestrator - FFmpeg & Offscreen Management
 */
import { logger, DEBUG } from '../common/logger.js';

// Command to dispatch to the FFmpeg offscreen document once it signals ready.
let pendingOffscreenCommand = null;

// Tracks which type of offscreen is currently open so dispatchToOffscreen
// can detect a stale record.html before sending FFmpeg commands.
// 'ffmpeg' | 'record' | null
let _activeOffscreenType = null;

// ---------------------------------------------------------------------------
// Record offscreen state
// Tracks whether the persistent recording offscreen (record.html) is active.
// Chrome only allows ONE offscreen document per extension at a time, so FFmpeg
// and recording cannot run simultaneously.
// ---------------------------------------------------------------------------
let isRecordOffscreenActive = false;
let pendingRecordCommand = null;

export async function updateDnrRulesForFetch(referer, ua, urlFilter = '*', scopeToExtension = false) {
  const ruleId = 1001;
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const ruleIdsToRemove = rules.map(r => r.id).filter(id => id === ruleId);

  const condition = {
    urlFilter,
    resourceTypes: ['xmlhttprequest', 'other', 'main_frame', 'sub_frame', 'media']
  };

  // Optimization: If a specific URL is provided, try to scope the filter to its origin
  if (urlFilter && urlFilter !== '*') {
    try {
      const u = new URL(urlFilter);
      condition.urlFilter = `${u.protocol}//${u.host}/*`;
    } catch (e) { /* keep original filter */ }
  }

  // When the filter is relatively broad, restrict to extension-initiated requests only
  // (offscreen document fetch calls) so user's normal browsing is never affected.
  if (scopeToExtension) {
    condition.initiatorDomains = [chrome.runtime.id];
  }

  const rule = { id: ruleId, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }, { header: 'User-Agent', operation: 'set', value: ua }] }, condition };
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ruleIdsToRemove,
    addRules: [rule]
  });
  logger.info(`DNR Rules updated for: ${condition.urlFilter}${scopeToExtension ? ' [extension-scoped]' : ''}`, { referer });
}

export async function clearDnrRules() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const ruleIdsToRemove = rules.map(r => r.id).filter(id => id === 1001);
  if (ruleIdsToRemove.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ruleIdsToRemove });
    logger.info('DNR Rules cleared.');
  }
}

export async function closeRecordOffscreen() {
  if (await chrome.offscreen.hasDocument()) {
    if (_activeOffscreenType === 'record') {
      await chrome.offscreen.closeDocument().catch(() => {});
    }
  }
  isRecordOffscreenActive = false;
  _activeOffscreenType = null;
  pendingRecordCommand = null;
  logger.info('Record offscreen state reset');
}

export async function closeAnyOffscreen() {
  if (await chrome.offscreen.hasDocument()) {
    if (typeof DEBUG !== 'undefined' && DEBUG) {
      logger.info('DEBUG mode is ON: [Orchestrator] Logic reset, keeping offscreen document alive.');
      // Force reset isRunning state inside the offscreen page if it's still there
      chrome.runtime.sendMessage({ type: 'CLEAR_RECORD_STORAGE' }).catch(() => {});
    } else {
      await chrome.offscreen.closeDocument().catch(() => {});
    }
  }
  isRecordOffscreenActive = false;
  _isFfmpegBusy = false;
  _activeOffscreenType = null;
  pendingOffscreenCommand = null;
  pendingRecordCommand = null;
  logger.info('Global Offscreen state reset');
}

export async function createOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'FFmpeg.wasm requires a DOM environment.'
  });
  _activeOffscreenType = 'ffmpeg';
  logger.info('[Orchestrator] FFmpeg Offscreen created successfully.');
}

// Build the ready-to-send offscreen command from a merge request payload.
function buildMergeCommand(data) {
  if (data.segments) {
    return {
      type: 'FFMPEG_MERGE_SEGMENTS',
      segments: data.segments,
      outputName: data.outputName,
      referer: data.referer,
      ua: data.ua,
      manifestUrl: data.manifestUrl,
      encryption: data.encryption,
      mapUrl: data.mapUrl,
      itemId: data.itemId,
      concurrency: data.concurrency,
    };
  }
  return {
    type: 'FFMPEG_MERGE',
    videoUrl: data.videoUrl,
    audioUrl: data.audioUrl,
    outputName: data.outputName,
    referer: data.referer,
    ua: data.ua,
    manifestUrl: data.manifestUrl || data.videoUrl,
    encryption: data.encryption,
    mapUrl: data.mapUrl,
    itemId: data.itemId,
    concurrency: data.concurrency,
  };
}

async function dispatchToOffscreen(command) {
  logger.info('[Orchestrator] Dispatching command to Offscreen:', command.type);
  // Guard: record offscreen is active — sending an FFmpeg command to it would
  // be silently ignored and the user would be stuck. Fail fast instead.
  if (isRecordOffscreenActive) {
    logger.warn('Cannot dispatch FFmpeg command: Record offscreen is active');
    chrome.runtime.sendMessage({
      type: 'FFMPEG_ERROR',
      error: '录屏进行中，无法同时下载。请先停止录屏。',
      itemId: command.itemId,
    }).catch(() => {});
    return;
  }

  if (_isFfmpegBusy) {
    logger.warn(`Cannot dispatch ${command.type}: FFmpeg is busy`);
    chrome.runtime.sendMessage({
      type: 'FFMPEG_ERROR',
      error: chrome.i18n.getMessage('ffmpegBusy'),
      isRemux: command.type === 'START_WEBM_REMUX',
      isAudioExtract: command.type === 'START_AUDIO_EXTRACT',
    }).catch(() => {});
    return;
  }

  // Lock FFmpeg resource before proceeding
  _isFfmpegBusy = true;

  try {
    if (await chrome.offscreen.hasDocument()) {
      if (_activeOffscreenType !== 'ffmpeg') {
        // hasDocument() is true but we're not tracking an FFmpeg offscreen —
        // this is a stale record.html that hasn't finished closing yet.
        // Force-close it before creating the correct document.
        logger.warn(`dispatchToOffscreen: unexpected offscreen type "${_activeOffscreenType}", force-closing before creating FFmpeg offscreen`);
        _activeOffscreenType = null;
        await chrome.offscreen.closeDocument().catch(() => {});
        pendingOffscreenCommand = command;
        await createOffscreen();
      } else {
        chrome.runtime.sendMessage(command).catch(err => logger.error('Command to Offscreen failed', err));
      }
    } else {
      pendingOffscreenCommand = command;
      await createOffscreen();
    }
  } catch (e) {
    logger.error('dispatchToOffscreen failed', e);
  }
}

export function handleFfmpegMerge(data) {
  return dispatchToOffscreen(buildMergeCommand(data));
}

export function handleProxyDownload(data) {
  return dispatchToOffscreen({
    type: 'START_PROXY_DOWNLOAD',
    url: data.url,
    outputName: data.outputName,
    itemId: data.itemId,
  });
}

/** Called by background/main.js when FFMPEG_COMPLETE or FFMPEG_ERROR is received. */
export function handleFfmpegDone() {
  _isFfmpegBusy = false;
}

/**
 * Remux a recorded .webm file to .mp4 via FFmpeg (container-copy, no re-encode).
 * fileHandle must be the FileSystemFileHandle from the recording session.
 */
export function handleFfmpegRemux(data) {
  // fileHandle is retrieved from IndexedDB inside the offscreen document.
  return dispatchToOffscreen({
    type: 'START_WEBM_REMUX',
    outputName: data.outputName,
  });
}

export function handleAudioExtract(data) {
  return dispatchToOffscreen({
    type: 'START_AUDIO_EXTRACT',
    outputName: data.outputName,
  });
}

export function handleOffscreenReady() {
  if (!pendingOffscreenCommand) return;
  chrome.runtime.sendMessage({ ...pendingOffscreenCommand, _isBackgroundProxy: true }).catch(() => {});
  pendingOffscreenCommand = null;
}

// Tracks whether a regular FFmpeg job (HLS merge / proxy download) is running.
// Used to block WEBM_REMUX and AUDIO_EXTRACT when FFmpeg is already busy.
let _isFfmpegBusy = false;

// ---------------------------------------------------------------------------
// Record Offscreen Management
// ---------------------------------------------------------------------------

/**
 * Creates the persistent record.html offscreen document.
 * Returns false if another offscreen (FFmpeg) is already open and busy.
 */
export async function createRecordOffscreen() {
  if (await chrome.offscreen.hasDocument()) {
    if (_activeOffscreenType === 'ffmpeg') {
      logger.warn('Cannot create record offscreen: FFmpeg merge is already active');
      return false;
    }
    // If it's a stale record offscreen, force-recreate it to ensure fresh state
    logger.info('[Orchestrator] Stale record offscreen detected, force-recreating.');
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  
  isRecordOffscreenActive = true;
  _activeOffscreenType = 'record';
  await chrome.offscreen.createDocument({
    url: 'record.html',
    reasons: ['WORKERS'],
    justification: 'Screen recording requires a persistent DOM environment for MediaStreamTrackProcessor and Web Worker coordination.',
  });
  return true;
}

/**
 * Sends a command to the record offscreen, creating it first if needed.
 * If record.html is already open the command is sent directly.
 */
export async function dispatchToRecordOffscreen(command) {
  try {
    // Phase 4: obtain a tabCapture stream ID so the offscreen document can call getUserMedia.
    if (command.type === 'START_RECORD_TEST') {
      // Handled by popup directly. Background broadcast here was causing async races.
    }
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) {
      // If a document exists, but our internal type is null, it's a desync. Try to heal it.
      if (!_activeOffscreenType) {
        logger.warn('offscreen exists but type is NULL. Assuming legacy or stale record offscreen.');
      }
      
      if (_activeOffscreenType === 'record' || (!_activeOffscreenType && command.type === 'START_RECORD_TEST')) {
        // Reuse or heal state to 'record'
        _activeOffscreenType = 'record';
        isRecordOffscreenActive = true;
        chrome.runtime.sendMessage({ ...command, _isBackgroundProxy: true }).catch(err => logger.error('Record offscreen command failed', err));
      } else {
        // Conflicts with another type (e.g. 'ffmpeg')
        logger.warn(`dispatchToRecordOffscreen: Type conflict (Current: ${_activeOffscreenType}), force-recreating.`);
        await chrome.offscreen.closeDocument().catch(() => {});
        _activeOffscreenType = null;
        isRecordOffscreenActive = false;
        pendingRecordCommand = command;
        await createRecordOffscreen();
      }
    } else {
      pendingRecordCommand = command;
      await createRecordOffscreen();
    }
  } catch (e) {
    logger.error('dispatchToRecordOffscreen failed', e);
  }
}

/**
 * Called when record.html signals RECORD_OFFSCREEN_READY.
 * Flushes any pending command that was queued during document creation.
 */
/**
 * Force-close any active offscreen document and reset all state variables.
 */
export async function closeOffscreen() {
  logger.info(`[Orchestrator] closeOffscreen() called. Closing current ${(_activeOffscreenType || 'unknown')} offscreen.`);
  _activeOffscreenType    = null;
  _isFfmpegBusy           = false;
  isRecordOffscreenActive = false;
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
      logger.info('[Orchestrator] Offscreen document closed.');
    }
  } catch (err) {
    logger.debug('[Orchestrator] closeDocument ignored:', err.message);
  }
}

export function handleRecordOffscreenReady() {
  if (!pendingRecordCommand) return;
  chrome.runtime.sendMessage(pendingRecordCommand).catch(() => {});
  pendingRecordCommand = null;
}

/**
 * Returns true only when the record offscreen is genuinely alive.
 * Used by the GET_RECORD_STATUS handler for popup self-healing.
 */
export function getIsRecordActive() {
  return isRecordOffscreenActive;
}
