/**
 * Sovereign Storage & State Management
 */
import { logger } from '../common/logger.js';

export const state = {
  tabStorage: new Map(),
  activeDownloads: new Map(),
  globalMergeStatus: {
    isMerging: false,
    itemId: null,
    url: null,
    progress: 0,
    stage: null
  },
  parsingCache: new Map(),
  processingUrls: new Set(),
  recordState: {
    isRecording: false,
    isConsolidating: false,
    isReady: false
  },
  activeTabId: null
};

const PARSE_CACHE_TTL = 30000;

export function getCachedResult(url) {
  const cached = state.parsingCache.get(url);
  if (cached && (Date.now() - cached.timestamp < PARSE_CACHE_TTL)) {
    return cached.data;
  }
  return null;
}

export function setCachedResult(url, data) {
  state.parsingCache.set(url, { data, timestamp: Date.now() });
  if (state.parsingCache.size > 200) {
    const firstKey = state.parsingCache.keys().next().value;
    state.parsingCache.delete(firstKey);
  }
}

export function cleanTab(tabId) {
  if (state.tabStorage.has(tabId)) {
    state.tabStorage.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    logger.info(`Cleaned tab ${tabId}`);
  }
}

/**
 * Nuclear Reset: Clears all tracked media across all tabs, 
 * flushes the global parsing cache, and resets the record state.
 */
export function clearAllData() {
  state.tabStorage.clear();
  state.parsingCache.clear();
  state.processingUrls.clear();
  state.activeDownloads.clear();
  state.recordState = { isRecording: false, isConsolidating: false, isReady: false };
  
  // Clear all badges
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
  logger.info('Global storage reset complete');
}

export function resetGlobalMergeStatus() {
  state.globalMergeStatus = { isMerging: false, itemId: null, url: null, progress: 0, stage: null };
}
