/**
 * Sovereign Orchestrator - FFmpeg & Offscreen Management
 */
import { logger } from '../common/logger.js';

// Command to dispatch to the FFmpeg offscreen document once it signals ready.
let pendingOffscreenCommand = null;

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

export async function createOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'FFmpeg.wasm requires a DOM environment.'
  });
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

  try {
    if (await chrome.offscreen.hasDocument()) {
      chrome.runtime.sendMessage(command).catch(err => logger.error('Command to Offscreen failed', err));
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

/**
 * Remux a recorded .webm file to .mp4 via FFmpeg (container-copy, no re-encode).
 * fileHandle must be the FileSystemFileHandle from the recording session.
 */
export function handleFfmpegRemux(data) {
  // fileHandle is retrieved from IndexedDB inside the offscreen document.
  return dispatchToOffscreen({
    type: 'WEBM_REMUX',
    outputName: data.outputName,
  });
}

export function handleOffscreenReady() {
  if (!pendingOffscreenCommand) return;
  chrome.runtime.sendMessage(pendingOffscreenCommand).catch(() => {});
  pendingOffscreenCommand = null;
}

// ---------------------------------------------------------------------------
// Record Offscreen Management
// ---------------------------------------------------------------------------

/**
 * Creates the persistent record.html offscreen document.
 * Returns false if another offscreen (FFmpeg) is already open.
 */
export async function createRecordOffscreen() {
  if (await chrome.offscreen.hasDocument()) {
    logger.warn('Cannot create record offscreen: another offscreen document is already active');
    return false;
  }
  isRecordOffscreenActive = true;
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
    if (await chrome.offscreen.hasDocument()) {
      if (!isRecordOffscreenActive) {
        logger.warn('Offscreen exists but is not the record offscreen — ignoring');
        return;
      }
      chrome.runtime.sendMessage(command).catch(err => logger.error('Record offscreen command failed', err));
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
export function handleRecordOffscreenReady() {
  if (!pendingRecordCommand) return;
  chrome.runtime.sendMessage(pendingRecordCommand).catch(() => {});
  pendingRecordCommand = null;
}

/**
 * Closes the record offscreen document and resets state.
 */
export async function closeRecordOffscreen() {
  isRecordOffscreenActive = false;
  pendingRecordCommand = null;
  await chrome.offscreen.closeDocument().catch(() => {});
  logger.info('Record offscreen closed');
}
