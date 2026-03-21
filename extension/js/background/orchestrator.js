/**
 * Sovereign Orchestrator - FFmpeg & Offscreen Management
 */
import { logger } from '../common/logger.js';
import { state } from './storage.js';

let pendingMergeRequest = null;

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

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ruleIdsToRemove,
    addRules: [{ id: ruleId, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }, { header: 'User-Agent', operation: 'set', value: ua }] }, condition }]
  });
  logger.info(`DNR Rules updated for: ${condition.urlFilter}${scopeToExtension ? ' [extension-scoped]' : ''}`);
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

export async function handleFfmpegMerge(data) {
  try {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (!hasDoc) {
      pendingMergeRequest = { ...data, _type: 'MERGE' };
      await createOffscreen();
    } else {
      sendMergeCommandToOffscreen(data);
    }
  } catch (e) {
    logger.error('FFmpeg merge handling failed', e);
  }
}

export async function handleProxyDownload(data) {
  try {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (!hasDoc) {
      pendingMergeRequest = { ...data, _type: 'PROXY' };
      await createOffscreen();
    } else {
      chrome.runtime.sendMessage({ 
        type: 'START_PROXY_DOWNLOAD', 
        url: data.url, 
        outputName: data.outputName, 
        itemId: data.itemId 
      }).catch(err => logger.error('Proxy Command failed', err));
    }
  } catch (e) {
    logger.error('Proxy download handling failed', e);
  }
}

export function sendMergeCommandToOffscreen(data) {
  if (!data) return;
  const msg = data.segments ? {
    type: 'FFMPEG_MERGE_SEGMENTS',
    segments: data.segments,
    outputName: data.outputName,
    referer: data.referer,
    ua: data.ua,
    manifestUrl: data.manifestUrl,
    encryption: data.encryption,
    mapUrl: data.mapUrl,
    itemId: data.itemId,
    concurrency: data.concurrency
  } : {
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
    concurrency: data.concurrency
  };
  chrome.runtime.sendMessage(msg).catch(err => logger.error('Command to Offscreen failed', err));
}

export function handleOffscreenReady() {
  if (pendingMergeRequest) {
    if (pendingMergeRequest._type === 'PROXY') {
      chrome.runtime.sendMessage({ 
        type: 'START_PROXY_DOWNLOAD', 
        url: pendingMergeRequest.url, 
        outputName: pendingMergeRequest.outputName, 
        itemId: pendingMergeRequest.itemId 
      }).catch(() => {});
    } else {
      sendMergeCommandToOffscreen(pendingMergeRequest);
    }
    pendingMergeRequest = null;
  }
}
