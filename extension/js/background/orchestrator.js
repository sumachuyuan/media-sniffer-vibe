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

export async function closeAnyOffscreen() {
  if (await chrome.offscreen.hasDocument()) {
    if (typeof DEBUG !== 'undefined' && DEBUG) {
      logger.info('DEBUG mode is ON: [Orchestrator] Logic reset, keeping offscreen document alive.');
      // Force reset isRunning state inside the offscreen page if it's still there
      chrome.runtime.sendMessage({ type: 'CLEAR_RECORD_STORAGE' }).catch(() => { });
    } else {
      await chrome.offscreen.closeDocument().catch(() => { });
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
  // Preemption: If the record offscreen is active, it must be closed before
  // an FFmpeg command can be sent to a new 'ffmpeg' offscreen document.
  if (isRecordOffscreenActive) {
    logger.warn('[Orchestrator] Record offscreen is active during FFmpeg dispatch. Preempting and closing for download.');
    await closeOffscreen();
  }

  if (_isFfmpegBusy) {
    logger.warn(`Cannot dispatch ${command.type}: FFmpeg is busy`);
    chrome.runtime.sendMessage({
      type: 'FFMPEG_ERROR',
      error: chrome.i18n.getMessage('ffmpegBusy'),
      isRemux: command.type === 'START_WEBM_REMUX',
      isAudioExtract: command.type === 'START_AUDIO_EXTRACT',
    }).catch(() => { });
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
        await chrome.offscreen.closeDocument().catch(() => { });
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
  chrome.runtime.sendMessage({ ...pendingOffscreenCommand, _isBackgroundProxy: true }).catch(() => { });
  pendingOffscreenCommand = null;
}

// Tracks whether a regular FFmpeg job (HLS merge / proxy download) is running.
// Used to block WEBM_REMUX and AUDIO_EXTRACT when FFmpeg is already busy.
let _isFfmpegBusy = false;

// ---------------------------------------------------------------------------
// Record Offscreen Management
// ---------------------------------------------------------------------------

// Tracks whether an offscreen document creation is currently in flight.
// Prevents race conditions between "Pre-warm" and "Start Record" calls.
let _isCreating = false;

/**
 * Creates the persistent record.html offscreen document.
 * Returns false if another offscreen (FFmpeg) is already open and busy.
 */
export async function createRecordOffscreen() {
  if (_isCreating) {
    logger.info('[Orchestrator] createRecordOffscreen: Creation already in flight. Waiting...');
    return true; // Another call is already handling this
  }
  _isCreating = true;
  try {
    if (await chrome.offscreen.hasDocument()) {
      if (_activeOffscreenType === 'ffmpeg') {
        logger.warn('Cannot create record offscreen: FFmpeg merge is already active');
        return false;
      }
      // If a valid record offscreen is already active, nothing to do.
      if (_activeOffscreenType === 'record' && isRecordOffscreenActive) {
        logger.info('[Orchestrator] createRecordOffscreen: Valid record offscreen already active, skipping recreation.');
        return true;
      }
      // Stale: type is unknown (SW restart) or the record offscreen is inactive.
      // Stop its capture before force-recreating so Chrome releases the tab
      // capture lock immediately instead of holding it for >250 ms after closeDocument().
      logger.info('[Orchestrator] Stale record offscreen detected, stopping capture before force-recreating.');
      chrome.runtime.sendMessage({ type: 'CLEAR_RECORD_STORAGE' }).catch(() => { });
      // Give the stale offscreen ~150 ms to stop tracks (actual stop is <10 ms).
      await new Promise(r => setTimeout(r, 150));
      await chrome.offscreen.closeDocument().catch(() => { });
      // Short post-close settle — capture lock is already released since tracks
      // were stopped before the document was killed.
      await new Promise(r => setTimeout(r, 100));
    }

    isRecordOffscreenActive = true;
    _activeOffscreenType = 'record';
    await chrome.offscreen.createDocument({
      url: 'record.html',
      reasons: ['WORKERS'],
      justification: 'Screen recording requires a persistent DOM environment for MediaStreamTrackProcessor and Web Worker coordination.',
    });
    return true;
  } finally {
    _isCreating = false;
  }
}

/**
 * Self-healing: Detects an existing offscreen document on SW startup
 * and tries to align our internal state or kill it if stale.
 */
export async function adoptExistingOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) {
      if (!_activeOffscreenType) {
        logger.warn('[Orchestrator] SW restarted: stale offscreen detected. Force-closing for a fresh start.');
        await chrome.offscreen.closeDocument().catch(() => { });
        isRecordOffscreenActive = false;
        _isFfmpegBusy = false;
      }
    }
  } catch (err) {
    logger.debug('[Orchestrator] adoptExistingOffscreen ignored:', err.message);
  }
}

/**
 * Sends a command to the record offscreen, creating it first if needed.
 *
 * Always uses the pendingRecordCommand + RECORD_OFFSCREEN_READY handshake rather
 * than a fire-and-forget direct send.  This closes the race where
 * chrome.offscreen.createDocument() resolves before record.html's onMessage
 * listener is registered, causing a direct send to silently drop the message.
 *
 * When the document already exists, we ask it to re-confirm readiness via
 * REQUEST_RECORD_READY.  If that fails (page still loading), the fallback is
 * the natural RECORD_OFFSCREEN_READY emitted at the end of offscreen.js init.
 */
export async function dispatchToRecordOffscreen(command) {
  try {
    const hasDoc = await chrome.offscreen.hasDocument();

    if (hasDoc && _activeOffscreenType === 'record') {
      // Document exists and is the correct type.
      // Queue the command first, then ping record.html to re-send READY.
      // If the ping fails (document still loading), the natural READY fired at
      // the end of offscreen.js init will flush pendingRecordCommand instead.
      pendingRecordCommand = command;
      chrome.runtime.sendMessage({ type: 'REQUEST_RECORD_READY', _isBackgroundProxy: true })
        .catch(() => {
          logger.info('[Orchestrator] REQUEST_RECORD_READY not yet answered — waiting for natural READY signal.');
        });
    } else if (hasDoc) {
      // Conflict: FFmpeg is active or type is NULL (after SW restart)
      logger.warn(`dispatchToRecordOffscreen: Type conflict (Current: ${_activeOffscreenType}). Force-closing and recreating.`);
      await closeOffscreen();
      pendingRecordCommand = command;
      await createRecordOffscreen();
    } else {
      // No document yet: create and queue
      pendingRecordCommand = command;
      await createRecordOffscreen();
    }
  } catch (e) {
    logger.error('dispatchToRecordOffscreen failed', e);
  }
}

/**
 * Force-close any active offscreen document and reset all state variables.
 * @param {string} [type] Optional. If provided, only closes if matches _activeOffscreenType.
 */
export async function closeOffscreen(type) {
  if (type && _activeOffscreenType !== type) {
    logger.debug(`[Orchestrator] closeOffscreen ignored: type mismatch (Requested: ${type}, Active: ${_activeOffscreenType})`);
    return;
  }

  logger.info(`[Orchestrator] closeOffscreen() called. Closing current ${(_activeOffscreenType || 'unknown')} offscreen.`);
  // Clear state flags AFTER the document is actually closed.
  // Clearing them synchronously before the async closeDocument() creates a race window
  // where dispatchToRecordOffscreen sees (_activeOffscreenType=null + hasDocument=true)
  // and misdiagnoses a type conflict, triggering an unnecessary force-recreate cycle.
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
      logger.info('[Orchestrator] Offscreen document closed.');
    }
  } catch (err) {
    logger.debug('[Orchestrator] closeDocument ignored:', err.message);
  }
  _activeOffscreenType = null;
  _isFfmpegBusy = false;
  isRecordOffscreenActive = false;
}

/**
 * Specifically closes the record offscreen. 
 * Used for targeted cleanup that won't kill an active FFmpeg session.
 */
export async function closeRecordOffscreen() {
  await closeOffscreen('record');
}

export function handleRecordOffscreenReady() {
  if (!pendingRecordCommand) return;
  chrome.runtime.sendMessage({ ...pendingRecordCommand, _isBackgroundProxy: true }).catch(() => { });
  pendingRecordCommand = null;
}

/**
 * Returns true only when the record offscreen is genuinely alive.
 * Used by the GET_RECORD_STATUS handler for popup self-healing.
 */
export function getIsRecordActive() {
  return isRecordOffscreenActive;
}
