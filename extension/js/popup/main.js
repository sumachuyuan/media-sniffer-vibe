/**
 * Sovereign Popup Main Entry (v25.1.0 Feature Complete)
 */
import { ui } from './ui.js';
import { logger } from '../common/logger.js';
import { sanitizeFilename, copyToClipboard } from './utils.js';
import { createUrlItem, renderPromo, renderCompanion } from './renderer.js';
import { i18n } from './i18n.js';
import { saveFileHandle, loadFileHandle, loadRemuxOutput } from '../record/storage.js';

const t = (key, subs) => i18n.t(key, subs);

let _pendingRecordWritable = null; // Phase 9: Active writable during user gesture
let _isProcessingFinalWrite = false; // Phase 10: De-duplication lock for dual broadcast signals

let state = {
    mergingUrl: null,
    mergingProgress: 0,
    mergingStage: '',
    ua: navigator.userAgent,
    concurrency: 3,
    lastRecordIsAudioOnly: false,
    recordFilename: null,
    recordingStartTime: null,
    isAudioOnly: false,
};

// Phase 6: timer + I/O recovery state
let _recordingTimerInterval = null;
let _prevBitrateReduced = false;

// Phase 8: track which export operation is in progress for button progress display
let _isRemuxing = false;
let _isAudioExtracting = false;

function formatElapsed(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function startRecordingTimer(startTime) {
    stopRecordingTimer();
    state.recordingStartTime = startTime;
    const timerEl = document.getElementById('record-timer');
    if (timerEl) timerEl.style.display = 'inline-block';
    _recordingTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - state.recordingStartTime) / 1000);
        const el = document.getElementById('record-timer');
        if (el) el.textContent = formatElapsed(elapsed);
    }, 1000);
}

function stopRecordingTimer() {
    if (_recordingTimerInterval) {
        clearInterval(_recordingTimerInterval);
        _recordingTimerInterval = null;
    }
    state.recordingStartTime = null;
    const timerEl = document.getElementById('record-timer');
    if (timerEl) timerEl.style.display = 'none';
}

document.addEventListener('DOMContentLoaded', async () => {
    // 0. Initialize i18n
    await i18n.init();

    // On-Demand Extraction for TikTok
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0] && tabs[0].url && tabs[0].url.includes('tiktok.com')) {
        try {
            await chrome.tabs.sendMessage(tabs[0].id, { type: 'EXTRACT_TIKTOK' });
            await new Promise(r => setTimeout(r, 150)); // Give background a moment to process
        } catch (e) { }
    }

    // Phase 9.9.2: Proactively warm up the record offscreen to prevent focus-steal on 'Start' click.
    // Delaying slightly to allow initial popup render to settle.
    setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'PRE_WARM_RECORD_OFFSCREEN' }).catch(() => {});
    }, 200);

    // 1. Initial Render & Status Sync
    renderUrls();
    syncMergeStatus();

    // 2. Event Listeners
    document.getElementById('clearBtn').onclick = () => {
        // --- Stop any in-flight tasks ---
        if (state.mergingUrl) chrome.runtime.sendMessage({ type: 'CANCEL_FFMPEG_MERGE', url: state.mergingUrl });
        // Terminate recording worker before clearing IDB so the offscreen does not
        // race against clearSession() with a consolidation write still in flight.
        chrome.runtime.sendMessage({ type: 'STOP_RECORD_TEST' });
        resetUI();

        // --- Recording panel: physical UI reset ---
        // 1. Kill timer and hide it
        stopRecordingTimer();

        // 2. Reset indicator dot to idle grey
        const dotEl = document.getElementById('record-indicator');
        if (dotEl) {
            dotEl.style.background = '#444';
            dotEl.style.boxShadow = 'none';
            dotEl.classList.remove('record-indicator-breathing');
        }

        // 3. Restore start-btn; hide stop-btn; re-enable quality selector and audio-only toggle
        const startBtnEl = document.getElementById('record-start-btn');
        const stopBtnEl  = document.getElementById('record-stop-btn');
        const qualityEl  = document.getElementById('record-quality');
        const audioOnlyEl = document.getElementById('record-audio-only');
        if (startBtnEl) { startBtnEl.disabled = false; startBtnEl.style.opacity = '1'; }
        if (stopBtnEl)  { stopBtnEl.style.display = 'none'; }
        if (qualityEl)  { qualityEl.disabled = false; qualityEl.style.opacity = '1'; qualityEl.style.display = ''; }
        if (audioOnlyEl) { audioOnlyEl.disabled = false; }

        // 4. Hide stats panel and export buttons; clear in-memory filename
        state.recordFilename = null;
        const statsEl = document.getElementById('record-stats');
        if (statsEl) statsEl.style.display = 'none';
        const saveVideoBtnEl = document.getElementById('record-save-video-btn');
        const extractAudioBtnEl = document.getElementById('record-extract-audio-btn');

        if (startBtnEl) { startBtnEl.disabled = false; startBtnEl.style.opacity = '1'; }
        if (stopBtnEl) { stopBtnEl.style.display = 'none'; stopBtnEl.disabled = true; } // Hide stop btn
        if (qualityEl) { qualityEl.disabled = false; qualityEl.style.opacity = '1'; }
        if (audioOnlyEl) audioOnlyEl.disabled = false;
        if (statsEl) statsEl.style.display = 'none';
        if (saveVideoBtnEl) saveVideoBtnEl.style.display = 'none';
        if (extractAudioBtnEl) extractAudioBtnEl.style.display = 'none';

        // 3. Clear persistence
        chrome.storage.local.set({ recordingState: { isRecording: false, isReady: false, isConsolidating: false } }).catch(() => {});
        
        // 4. Global Data Erasure
        chrome.runtime.sendMessage({ type: 'CLEAR_RECORD_STORAGE' });
        chrome.runtime.sendMessage({ type: 'CLEAR_URLS' }, () => {
            ui.showToast(t('toastListCleared'));
            renderUrls();
        });
    };

    const langBtn = document.getElementById('langToggle');
    langBtn.title = t('langToggleTooltip');
    langBtn.onclick = async () => {
        const result = await chrome.storage.local.get('preferredLanguage');
        const current = result.preferredLanguage || (chrome.i18n.getUILanguage().includes('zh') ? 'zh_CN' : 'en');
        const next = (current === 'zh_CN') ? 'en' : 'zh_CN';
        await chrome.storage.local.set({ 'preferredLanguage': next });
        location.reload();
    };

    const perfBtn = document.getElementById('perfToggle');
    const result = await chrome.storage.local.get('performanceMode');
    let isHighPerf = result.performanceMode !== false; // Default to true
    state.concurrency = isHighPerf ? 5 : 1;
    perfBtn.style.color = isHighPerf ? 'var(--gold-primary)' : '#555';
    perfBtn.style.borderColor = isHighPerf ? 'var(--gold-primary)' : 'rgba(255,255,255,0.1)';
    perfBtn.title = t('perfToggleTooltip');

    perfBtn.onclick = async () => {
        isHighPerf = !isHighPerf;
        state.concurrency = isHighPerf ? 5 : 1;
        await chrome.storage.local.set({ 'performanceMode': isHighPerf });
        perfBtn.style.color = isHighPerf ? 'var(--gold-primary)' : '#555';
        perfBtn.style.borderColor = isHighPerf ? 'var(--gold-primary)' : 'rgba(255,255,255,0.1)';
        ui.showToast(isHighPerf ? t('toastHighPerfOn') : t('toastHighPerfOff'), 'default');
    };

    document.getElementById('searchBar').oninput = () => renderUrls();

    // --- Phase 4: Real tab capture + audio + resolution ---
    const startBtn        = document.getElementById('record-start-btn');
    const stopBtn         = document.getElementById('record-stop-btn');
    const statsEl         = document.getElementById('record-stats');
    const dotEl           = document.getElementById('record-indicator');
    const qualityEl       = document.getElementById('record-quality');
    const macosNotice     = document.getElementById('record-macos-notice');
    const audioOnlyEl     = document.getElementById('record-audio-only');
    const saveVideoBtn    = document.getElementById('record-save-video-btn');
    const extractAudioBtn = document.getElementById('record-extract-audio-btn');

    // Show macOS audio notice on macOS
    const _isMacOS = navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Mac');
    if (_isMacOS && macosNotice) macosNotice.style.display = 'block';

    // Phase 8: audio-only toggle — hide quality selector and macOS notice when active
    audioOnlyEl?.addEventListener('change', () => {
      const on = audioOnlyEl.checked;
      if (qualityEl) qualityEl.style.display = on ? 'none' : '';
      if (macosNotice) macosNotice.style.display = (on || !_isMacOS) ? 'none' : 'block';
      // Store user preference for NEXT recording
      chrome.storage.local.set({ 'recordAudioOnlyPref': on }).catch(() => {});
    });

    // Persist quality selection across popup opens
    qualityEl?.addEventListener('change', () => {
      chrome.storage.local.set({ 'recordQualityPref': qualityEl.value }).catch(() => {});
    });

    // Step 0: Pre-fetch tab ID to ensure user gesture context in startBtn.onclick
    let activeTabId = null;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        activeTabId = tabs[0]?.id;
    });

    startBtn.onclick = async () => {
      if (startBtn.disabled) return;
      startBtn.disabled = true;
      startBtn.style.opacity = '0.4';

      // Phase 9.9.2: Direct start. Offscreen should already be pre-warmed.
      _startRecordingFlow(activeTabId);
    };

    const _startRecordingFlow = (tabId) => {
      startBtn.disabled = true;
      startBtn.style.opacity = '0.4';
      if (qualityEl) { qualityEl.disabled = true; qualityEl.style.opacity = '0.4'; }
      if (audioOnlyEl) audioOnlyEl.disabled = true;

      // Phase 8.4: Reset UI elements from previous recording session
      if (saveVideoBtn) saveVideoBtn.style.display = 'none';
      if (extractAudioBtn) extractAudioBtn.style.display = 'none';
      if (stopBtn) {
        stopBtn.style.display = 'inline-block';
        stopBtn.disabled = true;
        stopBtn.style.cursor = 'not-allowed';
      }
      if (statsEl) {
        statsEl.style.display = 'block';
        statsEl.innerHTML = `<span style="color:#00e676">${t('recordWaitingStats')}</span>`;
      }

      // Phase 9: Silent start — no showSaveFilePicker here.
      const ts = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
      const suggestedName = `vibe_recording_${ts}.webm`;

      const isAudioOnly = audioOnlyEl?.checked || false;
      const quality = isAudioOnly ? '1080P' : (qualityEl?.value || '1080P');

      state.recordFileHandle = null; // No handle yet
      state.recordFilename = suggestedName;
      state.isAudioOnly = isAudioOnly;

      // Phase 8.2: Clear any stale "ready" state before starting a new recording
      chrome.storage.local.set({ recordingState: { isRecording: true, isReady: false } }).catch(() => {});

      // Phase 9: Start record — background SW will call getMediaStreamId internally
      // so the streamId is usable by the offscreen document.
      chrome.runtime.sendMessage({ type: 'START_RECORD_TEST', targetTabId: tabId, quality, filename: suggestedName, isAudioOnly });
      startRecordingTimer(Date.now());
      startBtn.disabled = true;
      startBtn.style.opacity = '0.4';
      if (qualityEl) { qualityEl.disabled = true; qualityEl.style.opacity = '0.4'; }
      stopBtn.disabled = false;
      stopBtn.style.cursor = 'pointer';
      stopBtn.style.color = '#ff5252';
      stopBtn.style.borderColor = 'rgba(255,60,60,0.3)';
      stopBtn.style.background = 'rgba(255,60,60,0.08)';
      dotEl.style.background = '#ff5252';
      dotEl.style.boxShadow = '0 0 6px #ff5252';
      dotEl.classList.add('record-indicator-breathing');
      statsEl.style.display = 'block';
      statsEl.innerHTML =
        t('recordWaitingEncoder') +
        `&nbsp;&nbsp;<span style="color:#555">${quality}</span>`;
    };

    stopBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: 'STOP_RECORD_TEST' });
      stopRecordingTimer();
      stopBtn.disabled = true;
      stopBtn.style.cursor = 'not-allowed';
      stopBtn.style.color = '#444';
      stopBtn.style.borderColor = 'rgba(255,255,255,0.08)';
      stopBtn.style.background = 'rgba(255,255,255,0.03)';
      dotEl.style.background = '#888';
      dotEl.style.boxShadow = 'none';
      dotEl.classList.remove('record-indicator-breathing');
      if (qualityEl) { qualityEl.disabled = false; qualityEl.style.opacity = '1'; }
    };

    // Phase 8: export button handlers (shown after RECORD_STOPPED, enabled after RECORD_BLOB_READY)
    if (saveVideoBtn) {
      saveVideoBtn.onclick = async () => {
        if (saveVideoBtn.disabled) return;
        
        // Phase 9: Deferred File Picker for MP4
        try {
          const ts = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
          const handle = await window.showSaveFilePicker({
            suggestedName: `vibe_recording_${ts}.mp4`,
            types: [{ description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } }],
          });
          await saveFileHandle(handle);
          // Phase 9: Request writable IMMEDIATELY while we still have user gesture active.
          // This bypasses the SecurityError if conversion takes > 5-10 seconds.
          _pendingRecordWritable = await handle.createWritable();
        } catch (err) {
          if (err.name === 'AbortError') return;
          ui.showToast(`${t('error')}: ${err.message}`, 'error');
          return;
        }

        _isRemuxing = true;
        saveVideoBtn.disabled = true;
        saveVideoBtn.style.opacity = '0.5';
        saveVideoBtn.textContent = t('recordSaveVideo') + '...';
        chrome.runtime.sendMessage({
          type: 'START_WEBM_REMUX',
          outputName: state.recordFilename || 'recording.mp4'
        });
      };
    }

    if (extractAudioBtn) {
      extractAudioBtn.onclick = async () => {
        if (extractAudioBtn.disabled) return;

        // Phase 9: Deferred File Picker for MP3
        try {
          const ts = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
          const handle = await window.showSaveFilePicker({
            suggestedName: `vibe_recording_${ts}.mp3`,
            types: [{ description: 'MP3 Audio', accept: { 'audio/mpeg': ['.mp3'] } }],
          });
          await saveFileHandle(handle);
          // Phase 9: Secure the lock on the file BEFORE long-running FFmpeg starts.
          _pendingRecordWritable = await handle.createWritable();
        } catch (err) {
          if (err.name === 'AbortError') return;
          ui.showToast(`${t('error')}: ${err.message}`, 'error');
          return;
        }

        _isAudioExtracting = true;
        extractAudioBtn.disabled = true;
        extractAudioBtn.style.opacity = '0.5';
        extractAudioBtn.textContent = t('recordExtracting');
        chrome.runtime.sendMessage({
          type: 'START_AUDIO_EXTRACT',
          outputName: state.recordFilename || 'recording.mp3'
        });
      };
    }

    document.getElementById('global-cancel-btn').onclick = () => {
        if (state.mergingUrl) {
            chrome.runtime.sendMessage({ type: 'CANCEL_FFMPEG_MERGE', url: state.mergingUrl });
            resetUI();
            renderUrls();
        }
    };

    // Phase 6: Reconnect — restore UI if recording was active when popup was closed/reopened.
    // Self-healing: ask the background whether the record offscreen is actually alive before
    // trusting the persisted isRecording flag. If the background reports no active recording
    // but storage still says true (crash / race), reset the stale flag immediately.
    // Phase 9.8: Pre-warm the record offscreen document as soon as the popup opens.
    // This eliminates the async delay of creating the document AFTER the user clicks "Start",
    // which often causes the synchronous tabCapture gesture context to expire in Mv3.
    chrome.runtime.sendMessage({ type: 'PRE_WARM_RECORD_OFFSCREEN' });

    chrome.runtime.sendMessage({ type: 'GET_RECORD_STATUS' }, (resp) => {
        const backendActive = resp?.isRecordActive ?? false;
        chrome.storage.local.get(['recordingState', 'recordLastHeartbeat'], (result) => {
            const rs = result?.recordingState;
            if (!rs?.isRecording && !rs?.isConsolidating && !rs?.isReady) return;

            if (rs?.isRecording) {
                // Heartbeat check: if the last heartbeat is >15 s stale the offscreen
                // has crashed. Reset state and clean up IDB so the UI recovers cleanly.
                const lastHb = result?.recordLastHeartbeat ?? 0;
                const heartbeatStale = lastHb > 0 && (Date.now() - lastHb) > 15000;
                if (!backendActive || heartbeatStale) {
                    // Stale / crashed state — reset everything.
                    chrome.storage.local.set({ recordingState: { isRecording: false, isConsolidating: false }, recordLastHeartbeat: 0 }).catch(() => {});
                    chrome.runtime.sendMessage({ type: 'CLEAR_RECORD_STORAGE' });
                    return;
                }

                // Recording is genuinely in progress — restore UI to active state
                if (startBtn) { startBtn.disabled = true; startBtn.style.opacity = '0.4'; }
                if (stopBtn) {
                    stopBtn.disabled = false;
                    stopBtn.style.cursor = 'pointer';
                    stopBtn.style.color = '#ff5252';
                    stopBtn.style.borderColor = 'rgba(255,60,60,0.3)';
                    stopBtn.style.background = 'rgba(255,60,60,0.08)';
                }
                if (qualityEl) { qualityEl.disabled = true; qualityEl.style.opacity = '0.4'; }
                if (dotEl) { 
                    dotEl.style.background = '#ff5252'; 
                    dotEl.style.boxShadow = '0 0 6px #ff5252'; 
                    dotEl.classList.add('record-indicator-breathing');
                }
                if (statsEl) {
                    statsEl.style.display = 'block';
                    statsEl.innerHTML = `<span style="color:#00e676">${t('recordWaitingStats')}</span>`;
                }
                // Start local timer ticking from persisted startTime
                if (rs.startTime) startRecordingTimer(rs.startTime);
                if (audioOnlyEl) audioOnlyEl.disabled = true;
                return;
            }

            // IDB consolidation in progress (recording stopped, write not yet confirmed).
            // Show a "writing..." notice; export buttons remain disabled.
            if (rs?.isConsolidating) {
                if (startBtn) { startBtn.disabled = true; startBtn.style.opacity = '0.4'; }
                if (stopBtn)  stopBtn.style.display = 'none';
                if (qualityEl) { qualityEl.disabled = true; qualityEl.style.opacity = '0.4'; }
                if (dotEl) { 
                    dotEl.style.background = '#444'; 
                    dotEl.style.boxShadow = 'none'; 
                    dotEl.classList.remove('record-indicator-breathing');
                }
                if (statsEl) {
                    statsEl.style.display = 'block';
                    statsEl.innerHTML = `<span style="color:#ffa726">${t('recordWaitingWrite')}</span>`;
                }
                return;
            }

            // If not recording, but a result is ready (e.g. popup closed after stop)
            if (rs?.isReady && rs.filename) {
                state.recordFilename = rs.filename;
                state.lastRecordIsAudioOnly = !!rs.isAudioOnly;

                if (startBtn) { startBtn.disabled = false; startBtn.style.opacity = '1'; }
                if (qualityEl) { qualityEl.disabled = false; qualityEl.style.opacity = '1'; }
                if (dotEl) { 
                    dotEl.style.background = '#444'; 
                    dotEl.style.boxShadow = 'none'; 
                    dotEl.classList.remove('record-indicator-breathing');
                }
                
                if (stopBtn) stopBtn.style.display = 'none';
                if (saveVideoBtn) {
                    saveVideoBtn.style.display = state.lastRecordIsAudioOnly ? 'none' : 'inline-block';
                    saveVideoBtn.disabled = false;
                    saveVideoBtn.style.opacity = '1';
                    saveVideoBtn.style.cursor = 'pointer';
                }
                if (extractAudioBtn) {
                    extractAudioBtn.style.display = 'inline-block';
                    extractAudioBtn.disabled = false;
                    extractAudioBtn.style.opacity = '1';
                    extractAudioBtn.style.cursor = 'pointer';
                }
                if (statsEl) {
                    statsEl.style.display = 'block';
                    const tsMessage = rs.stoppedAt ? `<br><span style="color:#555;font-size:10px;">${new Date(rs.stoppedAt).toLocaleTimeString()}</span>` : '';
                    statsEl.innerHTML = `<span style="color:#29b6f6">${t('recordFileWritten', [rs.filename])}</span>` +
                                       `<br><span style="color:#ffa726">${t('recordDataReady')}</span>` + tsMessage;
                }
            }
        });
        
        // Phase 8.5: Independently restore toggle + quality preferences for NEXT recording
        chrome.storage.local.get(['recordAudioOnlyPref', 'recordQualityPref'], (res) => {
            const on = !!res?.recordAudioOnlyPref;
            if (audioOnlyEl) {
                audioOnlyEl.checked = on;
                if (qualityEl) qualityEl.style.display = on ? 'none' : '';
                if (macosNotice) macosNotice.style.display = (on || !_isMacOS) ? 'none' : 'block';
            }
            if (qualityEl && res?.recordQualityPref) {
                qualityEl.value = res.recordQualityPref;
            }
        });
    });

    chrome.runtime.onMessage.addListener(handleRuntimeMessages);
});

function resetUI() {
    state.mergingUrl = null;
    state.mergingProgress = 0;
    state.mergingStage = '';
    ui.hideMergeBanner();
}

function syncMergeStatus() {
    chrome.runtime.sendMessage({ type: 'GET_MERGE_STATUS' }, (status) => {
        if (status?.isMerging) {
            state.mergingUrl = status.url;
            state.mergingProgress = status.progress || 0;
            state.mergingStage = status.stage || '';
            ui.updateMergeBanner(state.mergingProgress, state.mergingStage, status.title);
            renderUrls();
        }
    });
}

function renderUrls() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const currentTab = tabs[0];
        if (!currentTab) return;
        if (!currentTab?.url) return;
        let hostname = '';
        try {
            hostname = new URL(currentTab.url).hostname.toLowerCase();
        } catch (e) {
            return; // Not a valid web URL
        }
        const searchInput = document.getElementById('searchBar');
        const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
        chrome.runtime.sendMessage({ type: 'GET_URLS' }, (response) => {
            const list = document.getElementById('urlList');
            if (!list) return;
            list.innerHTML = '';

            let platformName = t('platformPageUrl');
            if (hostname.includes('youtube')) platformName = 'YouTube';
            else if (hostname.includes('bilibili')) platformName = 'Bilibili';
            else if (hostname.includes('douyin')) platformName = 'Douyin';
            else if (hostname.includes('tiktok')) platformName = 'TikTok';

            const isUniversalSupported = platformName !== t('platformPageUrl') && !hostname.includes('douyin') && !hostname.includes('tiktok');
            if (isUniversalSupported) {
                list.appendChild(renderPromo(platformName, currentTab, state.ua));
            }

            if (!response?.urls?.length) {
                if (!isUniversalSupported) list.innerHTML = `<div class="empty-state">${t('noMedia')}</div>`;
                return;
            }

            let displayUrls = response.urls.filter(u => u.tabTitle.toLowerCase().includes(searchTerm));
            if (platformName !== t('platformPageUrl') && !searchTerm) {
                if (platformName === 'YouTube') displayUrls = displayUrls.filter(u => !u.url.includes('googlevideo.com'));
                else if (platformName === 'Bilibili') displayUrls = displayUrls.filter(u => !u.url.includes('.m4s') && !u.url.includes('.m4f') && !u.url.includes('.webmask'));
            }

            const sorted = displayUrls.reverse();

            // Pairing - Skip only for TikTok (Unified streams take priority)
            const skipPairing = hostname.includes('tiktok');
            const videoUrls = sorted.filter(u => u.mediaType === 'video');
            const audioUrls = sorted.filter(u => u.mediaType === 'audio');
            if (videoUrls.length > 0 && audioUrls.length > 0 && !state.mergingUrl && !skipPairing) {
                const v = videoUrls[0], a = audioUrls.find(au => au.groupTag === v.groupTag) || audioUrls[0];
                list.appendChild(renderCompanion(v, a, currentTab, state, (v, a) => {
                    state.mergingUrl = v.url;
                    ui.updateMergeBanner(2, t('scanning'));
                    renderUrls();
                    chrome.runtime.sendMessage({ type: 'START_FFMPEG_MERGE', videoUrl: v.url, audioUrl: a.url, outputName: sanitizeFilename(v.tabTitle || currentTab.title), referer: currentTab.url, ua: state.ua, itemId: v.id, manifestUrl: v.url, concurrency: state.concurrency });
                }));
            }

            sorted.forEach((item, index) => {
                const itemEl = createUrlItem(item, currentTab, state, searchTerm);
                itemEl.style.animationDelay = `${index * 0.05}s`;
                list.appendChild(itemEl);
            });
            bindEvents(currentTab);
        });
    });
}

function bindEvents(tab) {
    document.querySelectorAll('.native-merge').forEach(btn => {
        btn.onclick = () => {
            if (state.mergingUrl) return;

            const estimatedSize = parseInt(btn.dataset.estimatedSize || '0');
            if (estimatedSize > 1.5 * 1024 * 1024 * 1024) {
                const sizeGB = (estimatedSize / (1024 * 1024 * 1024)).toFixed(1) + 'GB';
                if (!window.confirm(t('confirmNativeMerge', [sizeGB]))) return;
            }

            state.mergingUrl = btn.dataset.url;
            ui.updateMergeBanner(2, t('scanning'));
            renderUrls();
            chrome.runtime.sendMessage({ type: 'GET_SEGMENTS', url: state.mergingUrl }, (data) => {
                if (data?.segments?.length > 0) {
                    chrome.runtime.sendMessage({ type: 'START_FFMPEG_MERGE', segments: data.segments, outputName: btn.dataset.filename, referer: tab.url, ua: state.ua, itemId: btn.dataset.id, manifestUrl: state.mergingUrl, encryption: data.encryption, mapUrl: data.mapUrl, concurrency: state.concurrency });
                } else { ui.showToast(t('toastScanFailed'), 'error'); resetUI(); renderUrls(); }
            });
        };
    });
    document.querySelectorAll('.copy-cli').forEach(btn => {
        btn.onclick = () => {
            const url = btn.dataset.url;
            const isYT = url.includes('googlevideo.com') || url.includes('youtube.com');
            const remoteFlag = isYT ? ' --remote-components ejs:github' : '';
            copyToClipboard(`yt-dlp${remoteFlag} --referer "${tab.url}" --user-agent "${state.ua}" -o "${btn.dataset.filename}.%(ext)s" "${url}"`, () => ui.showToast(t('toastCommandCopied')));
        };
    });
    document.querySelectorAll('.copy-btn').forEach(btn => btn.onclick = () => copyToClipboard(btn.dataset.url, () => ui.showToast(t('toastUrlCopied'))));
    document.querySelectorAll('.direct-download').forEach(btn => {
        btn.onclick = () => {
            ui.showToast(t('toastDownloadStarted'), 'ffmpeg');
            chrome.runtime.sendMessage({ type: 'START_DIRECT_DOWNLOAD', url: btn.dataset.url, filename: btn.dataset.filename, referer: tab.url, ua: state.ua });
        };
    });
    document.querySelectorAll('.cancel-merge').forEach(btn => btn.onclick = () => {
        chrome.runtime.sendMessage({ type: 'CANCEL_FFMPEG_MERGE', url: btn.dataset.url });
        resetUI(); renderUrls();
    });
    document.querySelectorAll('.play-btn').forEach(btn => btn.onclick = () => startEmbeddedPreview(btn.dataset.url, btn.dataset.id, btn.dataset.title, btn.dataset.mediaType));
    document.querySelectorAll('.quality-tag').forEach(tag => {
        tag.onclick = (e) => {
            e.stopPropagation();
            if (state.mergingUrl) return;
            const masterUrl = tag.dataset.url, qUrl = tag.dataset.qualityUrl, fname = tag.dataset.filename, res = tag.dataset.res;
            ui.showToast(t('targeting', [res]), 'ffmpeg');
            chrome.runtime.sendMessage({ type: 'GET_SEGMENTS', url: qUrl }, (data) => {
                if (data?.segments?.length > 0) {
                    state.mergingUrl = masterUrl;
                    ui.updateMergeBanner(5, t('initializing'));
                    renderUrls();
                    chrome.runtime.sendMessage({ type: 'START_FFMPEG_MERGE', segments: data.segments, outputName: `${fname}_${res}P`, referer: tab.url, ua: state.ua, manifestUrl: masterUrl, encryption: data.encryption, mapUrl: data.mapUrl, concurrency: state.concurrency });
                }
            });
        };
    });
}

function teardownActiveHls() {
    if (window.activeHls) {
        window.activeHls.destroy();
        window.activeHls = null;
    }
}

function startEmbeddedPreview(url, uid, title = 'Snapshot', mediaType = 'unknown') {
    const container = document.getElementById(`preview-container-${uid}`);
    if (!container) return;

    // 0. Detect if audio-only stream (Only videos show snapshot)
    const isAudio = mediaType === 'audio' ||
        url.toLowerCase().includes('.mp3') ||
        url.toLowerCase().includes('.aac') ||
        url.toLowerCase().includes('.m4a') ||
        url.toLowerCase().includes('.ogg') ||
        url.toLowerCase().includes('.wav');

    // 1. If same, toggle off
    if (window.activePreviewUid === uid) {
        teardownActiveHls();
        container.style.display = 'none'; container.innerHTML = ''; window.activePreviewUid = null;
        chrome.runtime.sendMessage({ type: 'CLEAR_DNR_RULES' }).catch(() => { });
        return;
    }

    // 2. Clear previous active if different
    if (window.activePreviewUid) {
        teardownActiveHls();
        const prev = document.getElementById(`preview-container-${window.activePreviewUid}`);
        if (prev) { prev.style.display = 'none'; prev.innerHTML = ''; }
    }

    // 3. Setup new
    container.style.display = 'block';
    container.innerHTML = `
        <div class="preview-header" style="display:flex; justify-content:flex-end; padding:8px 12px; gap:12px; border-bottom:1px solid rgba(255,255,255,0.05); align-items:center;">
            ${!isAudio ? `<div class="preview-snapshot">${t('snapshot')}</div>` : ''}
            <div class="preview-close">${t('close')}</div>
        </div>
        <video controls autoplay class="preview-video" style="width:100%; max-height:240px; background:#000; display:block;"></video>
    `;

    // Add hover effects via JS for simplicity in this dynamic injection
    container.querySelectorAll('.preview-snapshot, .preview-close').forEach(el => {
        el.onmouseover = () => el.style.opacity = '1';
        el.onmouseout = () => el.style.opacity = '0.8';
    });

    container.querySelector('.preview-close').onclick = () => {
        teardownActiveHls();
        container.style.display = 'none'; container.innerHTML = ''; window.activePreviewUid = null;
        chrome.runtime.sendMessage({ type: 'CLEAR_DNR_RULES' }).catch(() => { });
    };

    const video = container.querySelector('video');
    const snapshotBtn = container.querySelector('.preview-snapshot');

    if (snapshotBtn) {
        snapshotBtn.onclick = () => {
            if (!video.videoWidth) {
                ui.showToast(t('error'), 'error');
                return;
            }
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);
            canvas.toBlob(blob => {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const fileName = `${title.replace(/[/\\?%*:|"<>]/g, '-')}_Snapshot_${timestamp}.png`;
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = fileName;
                a.click();
                ui.showToast(t('complete'));
            }, 'image/png');
        };
    }


    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        const loadMedia = () => {
            if (url.toLowerCase().includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
                const hls = new Hls(); hls.loadSource(url); hls.attachMedia(video);
                window.activeHls = hls;
            } else { video.src = url; }
        };

        if (tab) {
            chrome.runtime.sendMessage({ type: 'UPDATE_DNR_FOR_PREVIEW', referer: tab.url, ua: state.ua, url: url }, () => loadMedia());
        } else {
            loadMedia();
        }
    });

    window.activePreviewUid = uid;
}

function handleRuntimeMessages(m) {
    // --- Phase 2: WebCodecs encoding stats ---
    if (m.type === 'RECORD_HW_CHECK') {
      const statsEl = document.getElementById('record-stats');
      if (!statsEl) return;
      const modeColor = m.mode === 'HW' ? '#00e676' : '#ffb300';
      const modeLabel = m.mode === 'HW' ? t('recordGpuHw') : t('recordSoftSw');
      statsEl.style.display = 'block';
      statsEl.innerHTML =
        `${t('recordEncoderReady')} &nbsp;` +
        `<b style="color:${modeColor};padding:1px 5px;border:1px solid ${modeColor};border-radius:3px;font-size:8px;">${modeLabel}</b>` +
        `&nbsp;&nbsp;<span style="color:#555">${m.codec}</span>`;
      return;
    }
    if (m.type === 'RECORD_STATS') {
      const s = m.stats;
      const statsEl = document.getElementById('record-stats');
      if (!statsEl) return;

      const elapsedStr = formatElapsed(s.elapsed || 0);
      // Sync timer element with worker's authoritative elapsed value
      const timerEl = document.getElementById('record-timer');
      if (timerEl && timerEl.style.display !== 'none') timerEl.textContent = elapsedStr;

      // Phase 8: audio-only mode — show compact audio-only stats
      if (state.isAudioOnly) {
        const finalLine = s.final
          ? `<br><span style="color:#aaa">总录音: <b>${s.writtenMB} MB</b></span>`
          : '';
        statsEl.innerHTML =
          `audio: <b style="color:#ab47bc">${s.audioEncodedCount || 0} pkts</b>` +
          `&nbsp;&nbsp;written: <b style="color:#29b6f6">${s.writtenMB} MB</b>` +
          `<br>elapsed: <b style="color:#aaa">${elapsedStr}</b>` +
          finalLine;
        return;
      }

      const modeColor = s.encoderMode === 'HW' ? '#00e676' : '#ffb300';
      const modeLabel = s.encoderMode === 'HW' ? t('recordGpuHw') : t('recordSoftSw');
      const audioLine = s.hasAudio
        ? `&nbsp;&nbsp;audio: <b style="color:#ab47bc">${s.audioEncodedCount || 0} pkts</b>`
        : '';
      const pendingMB = parseFloat(s.pendingMB || 0);
      const bufColor = s.bitrateReduced ? '#f44336' : (pendingMB > 10 ? '#ffb300' : '#555');
      const bufLine = pendingMB > 0.1
        ? `&nbsp;&nbsp;buf: <b style="color:${bufColor}">${s.pendingMB} MB${s.bitrateReduced ? ' ⚠' : ''}</b>`
        : '';
      // I/O recovery toast: bitrateReduced true→false
      if (_prevBitrateReduced && !s.bitrateReduced) {
        ui.showToast(t('recordIoRecovered'));
      }
      _prevBitrateReduced = !!s.bitrateReduced;

      const finalLine = s.final
        ? `<br><span style="color:#aaa">总编码: <b>${s.totalEncodedMB} MB</b></span>`
        : '';
      statsEl.innerHTML =
        `frames: <b style="color:#00e676">${s.frameCount}</b>` +
        `&nbsp;&nbsp;encoded: <b style="color:#00e676">${s.encodedCount}</b>` +
        `&nbsp;&nbsp;keys: <b style="color:#aaa">${s.keyframeCount}</b>` +
        audioLine +
        `<br>fps: <b style="color:#00e676">${s.instantFps}</b> (avg ${s.avgFps})` +
        `&nbsp;&nbsp;bitrate: <b style="color:${s.bitrateReduced ? '#f44336' : '#ffb300'}">${s.bitrateKbps} kbps${s.bitrateReduced ? ' ↓' : ''}</b>` +
        `<br>written: <b style="color:#29b6f6">${s.writtenMB} MB</b>` +
        bufLine +
        `&nbsp;&nbsp;res: <b style="color:#aaa">${s.resolution}</b>` +
        `&nbsp;&nbsp;mode: <b style="color:${modeColor}">${modeLabel}</b>` +
        `<br>elapsed: <b style="color:#aaa">${elapsedStr}</b>` +
        finalLine;
      return;
    }
    if (m.type === 'RECORD_STOPPED') {
      stopRecordingTimer();
      _prevBitrateReduced = false;
      const statsEl         = document.getElementById('record-stats');
      const startBtn        = document.getElementById('record-start-btn');
      const stopBtnEl       = document.getElementById('record-stop-btn');
      const qualityEl       = document.getElementById('record-quality');
      const dotEl           = document.getElementById('record-indicator');
      const saveVideoBtnEl  = document.getElementById('record-save-video-btn');
      const extractAudioBtnEl = document.getElementById('record-extract-audio-btn');
      const audioOnlyEl     = document.getElementById('record-audio-only');
      if (statsEl) statsEl.innerHTML =
        `<br><span style="color:#29b6f6">${t('recordFileWritten', [m.filename || '—'])}</span>` +
        `<br><span style="color:#ff5252">${t('recordStoppedTotal', [m.totalFrames])}</span>` +
        `<br><span style="color:#ffa726">${t('recordWaitingWrite')}</span>`;
      if (startBtn) { startBtn.disabled = false; startBtn.style.opacity = '1'; }
      if (qualityEl) { qualityEl.disabled = false; qualityEl.style.opacity = '1'; }
      if (dotEl)    { dotEl.style.background = '#444'; dotEl.style.boxShadow = 'none'; }
      if (m.filename) state.recordFilename = m.filename;
      state.lastRecordIsAudioOnly = !!m.isAudioOnly;

      // Phase 8: swap stop button for export buttons (disabled until IDB write completes)
      if (stopBtnEl) stopBtnEl.style.display = 'none';
      if (saveVideoBtnEl) {
        saveVideoBtnEl.style.display = state.lastRecordIsAudioOnly ? 'none' : 'inline-block';
        saveVideoBtnEl.disabled = true;
        saveVideoBtnEl.style.opacity = '0.3';
        saveVideoBtnEl.style.cursor = 'not-allowed';
      }
      if (extractAudioBtnEl) {
        extractAudioBtnEl.style.display = 'inline-block';
        extractAudioBtnEl.disabled = true;
        extractAudioBtnEl.style.opacity = '0.3';
        extractAudioBtnEl.style.cursor = 'not-allowed';
      }
      if (audioOnlyEl) {
        // Do NOT overwrite audioOnlyEl.checked based on result mode!
        // The toggle should remain at user's desired preference for NEXT and stay interactive.
        audioOnlyEl.disabled = false; 
      }
      return;
    }
    if (m.type === 'RECORD_BLOB_READY') {
      // IDB write confirmed — enable export buttons
      const saveVideoBtnEl    = document.getElementById('record-save-video-btn');
      const extractAudioBtnEl = document.getElementById('record-extract-audio-btn');
      const statsEl           = document.getElementById('record-stats');
      if (m.filename) state.recordFilename = m.filename;
      if (saveVideoBtnEl) {
        saveVideoBtnEl.disabled = false;
        saveVideoBtnEl.style.opacity = '1';
        saveVideoBtnEl.style.cursor = 'pointer';
      }
      if (extractAudioBtnEl) {
        extractAudioBtnEl.disabled = false;
        extractAudioBtnEl.style.opacity = '1';
        extractAudioBtnEl.style.cursor = 'pointer';
      }
      if (statsEl) statsEl.innerHTML +=
        `<br><span style="color:#ffa726">${t('recordDataReady')}</span>`;
      return;
    }
    if (m.type === 'RECORD_ERROR') {
      stopRecordingTimer();
      _prevBitrateReduced = false;
      const statsEl   = document.getElementById('record-stats');
      const startBtn  = document.getElementById('record-start-btn');
      const stopBtnEl = document.getElementById('record-stop-btn');
      const qualityEl = document.getElementById('record-quality');
      const dotEl     = document.getElementById('record-indicator');
      const saveVideoBtnEl    = document.getElementById('record-save-video-btn');
      const extractAudioBtnEl = document.getElementById('record-extract-audio-btn');
      const audioOnlyEl       = document.getElementById('record-audio-only');
      if (statsEl) { statsEl.style.display = 'block'; statsEl.innerHTML = `<span style="color:#ff5252">${t('error')}: ${m.error}</span>`; }
      if (startBtn) { startBtn.disabled = false; startBtn.style.opacity = '1'; }
      // Restore stop btn, hide export buttons
      if (stopBtnEl) { stopBtnEl.style.display = ''; stopBtnEl.disabled = true; stopBtnEl.style.cursor = 'not-allowed'; }
      if (saveVideoBtnEl) saveVideoBtnEl.style.display = 'none';
      if (extractAudioBtnEl) extractAudioBtnEl.style.display = 'none';
      if (qualityEl) { qualityEl.disabled = false; qualityEl.style.opacity = '1'; }
      if (audioOnlyEl) audioOnlyEl.disabled = false;
      if (dotEl)    { dotEl.style.background = '#f44'; dotEl.style.boxShadow = 'none'; }
      return;
    }

    if (m.type === 'FFMPEG_PROGRESS') {
        if (m.url && !state.mergingUrl) { state.mergingUrl = m.url; renderUrls(); }
        state.mergingProgress = m.progress;
        state.mergingStage = m.stage || '';
        ui.updateMergeBanner(m.progress, m.stage, m.outputName || state.mergingUrl);

        if (m.itemId) {
            const bar = document.getElementById(`pb-bar-${m.itemId}`);
            const stage = document.getElementById(`pb-stage-${m.itemId}`);
            const pct = document.getElementById(`pb-pct-${m.itemId}`);
            const box = document.getElementById(`pb-box-${m.itemId}`);
            if (box) box.style.display = 'block';
            if (bar) bar.style.width = `${m.progress}%`;
            if (stage) stage.textContent = m.stage || t('merging');
            if (pct) pct.textContent = `${Math.round(m.progress)}%`;
        }
        // Phase 8: update export button text with live progress percentage
        if (_isAudioExtracting) {
            const btn = document.getElementById('record-extract-audio-btn');
            if (btn) btn.textContent = t('recordExtractAudio') + ' ' + Math.round(m.progress) + '%';
        } else if (_isRemuxing) {
            const btn = document.getElementById('record-save-video-btn');
            if (btn) btn.textContent = t('recordSaveVideo') + ' ' + Math.round(m.progress) + '%';
        }
    } else    if (m.type === 'FFMPEG_COMPLETE' || m.type === 'FFMPEG_ERROR') {
        const isProxy = m.isProxy;
        const isRemux = m.isRemux;
        const isAudioExtract = m.isAudioExtract;
        
        if (m.type === 'FFMPEG_COMPLETE' && m.useIDBOutput) {
            if (_isProcessingFinalWrite) {
                logger.warn('[Popup] FFMPEG_COMPLETE received but a write operation is already in progress. Ignoring duplicate signal.');
                return;
            }
            _isProcessingFinalWrite = true;

            // Phase 9: Handle the final write from the Popup context
            (async () => {
                logger.info('[Popup] FFMPEG_COMPLETE received (useIDBOutput=true). Starting final write sequence...');
                let buffer = null;
                try {
                    buffer = await loadRemuxOutput();
                    if (!buffer) {
                        logger.error('[Popup] FATAL: loadRemuxOutput returned null. IDB Key might be missing.');
                        throw new Error('提取到的导出数据为空');
                    }
                    logger.info(`[Popup] Successfully loaded ${buffer.byteLength} bytes from IDB.`);

                    let writable = _pendingRecordWritable;
                    if (!writable) {
                        logger.warn('[Popup] _pendingRecordWritable is lost (popup likely closed during transcode). Attempting handle recovery...');
                        const handle = await loadFileHandle();
                        if (!handle) throw new Error('未找到文件保存句柄 (请在导出期间保持弹窗开启)');
                        
                        // Permission check: if video remuxing takes too long, browser might revoke write permission
                        if (handle.queryPermission) {
                            const perm = await handle.queryPermission({ mode: 'readwrite' });
                            if (perm !== 'granted') {
                                logger.warn('[Popup] Write permission lost, requesting again...');
                                // Note: window-based requestPermission MUST be within user gesture, 
                                // so if this fails, we ask the user to re-click.
                            }
                        }

                        logger.info('[Popup] Recovering writable from stored handle...');
                        writable = await handle.createWritable();
                    }

                logger.info('[Popup] Initiating binary write...');
                await writable.write(buffer);
                logger.info('[Popup] Data written. Finalizing file...');
                await writable.close();
                _pendingRecordWritable = null;

                logger.info('[Popup] File system operation SUCCESS.');
                ui.showToast(t(isAudioExtract ? 'recordAudioComplete' : 'recordRemuxComplete'), 'success');
            } catch (err) {
                logger.warn('[Popup] 磁盘直接写入失败，启动 Blob 下载保底方案...', err);
                if (!buffer) {
                    logger.error('[Popup] 无法执行 Blob 下载：缓存数据 (buffer) 为空');
                    ui.showToast(t('error') + ': 数据提取失败', 'error');
                    return;
                }
                const blob = new Blob([buffer], { type: isAudioExtract ? 'audio/mpeg' : 'video/mp4' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = m.filename || (isAudioExtract ? 'vibe_recording.mp3' : 'vibe_recording.mp4');
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                ui.showToast(t(isAudioExtract ? 'recordAudioComplete' : 'recordRemuxComplete'), 'success');
            } finally {
                _isProcessingFinalWrite = false;
                _restoreExportButtons();
                // Phase 9: Final physical UI teardown after async write completes
                state.mergingUrl = null;
                state.mergingProgress = 0;
                ui.hideMergeBanner();
                chrome.runtime.sendMessage({ type: 'RESET_GLOBAL_MERGE' }).catch(() => {});
            }
        })();
        return;
    }

        if (m.type === 'FFMPEG_COMPLETE') {
            if (isAudioExtract) ui.showToast(t('recordAudioComplete'));
            else if (isRemux)   ui.showToast(t('recordRemuxComplete'));
            else                ui.showToast(t(isProxy ? 'toastDownloadComplete' : 'toastMergeComplete'));
        } else {
            if (_pendingRecordWritable) {
                _pendingRecordWritable.close().catch(() => {});
                _pendingRecordWritable = null;
            }
            if (isAudioExtract) ui.showToast(t('recordAudioFailed', [m.error]), 'error');
            else if (isRemux)   ui.showToast(t('recordRemuxFailed', [m.error]), 'error');
            else                ui.showToast(t(isProxy ? 'error' : 'mergeError', [m.error]), 'error');
        }
        // Restore export buttons to clickable state after operation completes
        if (isRemux || isAudioExtract) {
            _restoreExportButtons();
            // Force reset background progress state so it doesn't stay at 95%
            chrome.runtime.sendMessage({ type: 'RESET_GLOBAL_MERGE' }).catch(() => {});
            
            // Phase 8.1: Support multiple continuous exports by keeping the record panel visible.
            // Reset only the temporary merge/export state variables.
            state.mergingUrl = null;
            state.mergingProgress = 0;
            state.mergingStage = '';
            ui.hideMergeBanner();
        } else {
            resetUI();
            setTimeout(renderUrls, 2500);
        }
    }
}

function _restoreExportButtons() {
    const saveVideoBtnEl    = document.getElementById('record-save-video-btn');
    const extractAudioBtnEl = document.getElementById('record-extract-audio-btn');
    if (saveVideoBtnEl && saveVideoBtnEl.style.display !== 'none') {
        saveVideoBtnEl.disabled = false;
        saveVideoBtnEl.style.opacity = '1';
        saveVideoBtnEl.style.cursor = 'pointer';
        saveVideoBtnEl.textContent = t('recordSaveVideo');
    }
    if (extractAudioBtnEl && extractAudioBtnEl.style.display !== 'none') {
        extractAudioBtnEl.disabled = false;
        extractAudioBtnEl.style.opacity = '1';
        extractAudioBtnEl.style.cursor = 'pointer';
        extractAudioBtnEl.textContent = t('recordExtractAudio');
    }
    _isRemuxing = false;
    _isAudioExtracting = false;
}
