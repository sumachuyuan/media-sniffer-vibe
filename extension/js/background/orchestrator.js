/**
 * Sovereign Orchestrator - FFmpeg & Offscreen Management
 */
import { logger } from '../common/logger.js';

// Command to dispatch to the offscreen document once it signals ready.
let pendingOffscreenCommand = null;

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

export function handleOffscreenReady() {
  if (!pendingOffscreenCommand) return;
  chrome.runtime.sendMessage(pendingOffscreenCommand).catch(() => {});
  pendingOffscreenCommand = null;
}
