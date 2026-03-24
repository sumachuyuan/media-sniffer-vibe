/**
 * Sovereign Popup Main Entry (v25.1.0 Feature Complete)
 */
import { ui } from './ui.js';
import { sanitizeFilename, copyToClipboard } from './utils.js';
import { createUrlItem, renderPromo, renderCompanion } from './renderer.js';
import { i18n } from './i18n.js';

const t = (key, subs) => i18n.t(key, subs);

// ---------------------------------------------------------------------------
// IndexedDB helper — stores FileSystemFileHandle so it can be retrieved by
// the offscreen document without losing its prototype chain over IPC.
// ---------------------------------------------------------------------------
const _IDB = { name: 'vibeRecordDB', store: 'handles', key: 'currentFileHandle' };
function _openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_IDB.name, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(_IDB.store);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}
async function _storeFileHandle(handle) {
  const db = await _openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_IDB.store, 'readwrite');
    tx.objectStore(_IDB.store).put(handle, _IDB.key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

let state = {
    mergingUrl: null,
    mergingProgress: 0,
    mergingStage: '',
    ua: navigator.userAgent,
    concurrency: 3, // Default
    recordFileHandle: null,  // retained after recording for remux
    recordFilename: null,
    recordingStartTime: null,
};

// Phase 6: timer + I/O recovery state
let _recordingTimerInterval = null;
let _prevBitrateReduced = false;

function formatElapsed(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
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

    // 1. Initial Render & Status Sync
    renderUrls();
    syncMergeStatus();

    // 2. Event Listeners
    document.getElementById('clearBtn').onclick = () => {
        if (state.mergingUrl) chrome.runtime.sendMessage({ type: 'CANCEL_FFMPEG_MERGE', url: state.mergingUrl });
        resetUI();
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
    const startBtn   = document.getElementById('record-start-btn');
    const stopBtn    = document.getElementById('record-stop-btn');
    const statsEl    = document.getElementById('record-stats');
    const dotEl      = document.getElementById('record-indicator');
    const qualityEl  = document.getElementById('record-quality');
    const macosNotice = document.getElementById('record-macos-notice');

    // Show macOS audio notice on macOS
    if (navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Mac')) {
      if (macosNotice) macosNotice.style.display = 'block';
    }

    startBtn.onclick = async () => {
      // Step 1: Get the active tab ID for tabCapture.
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) {
        statsEl.style.display = 'block';
        statsEl.innerHTML = `<span style="color:#f44">错误: 无法获取当前标签页</span>`;
        return;
      }

      // Step 2: Request a stream ID from the background (tabCapture API).
      let streamId;
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'GET_TAB_STREAM_ID', targetTabId: tabId });
        if (!resp?.streamId) throw new Error(resp?.error || '无法获取标签页流 ID');
        streamId = resp.streamId;
      } catch (err) {
        statsEl.style.display = 'block';
        statsEl.innerHTML = `<span style="color:#f44">错误: ${err.message}</span>`;
        return;
      }

      // Step 3: Show save file picker (must happen after awaits — still within user gesture context
      // for Chrome extension popup pages, which retain activation across async calls).
      let fileHandle;
      try {
        const ts = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
        fileHandle = await window.showSaveFilePicker({
          suggestedName: `vibe_recording_${ts}.webm`,
          types: [{ description: 'WebM Video', accept: { 'video/webm': ['.webm'] } }],
        });
      } catch (err) {
        if (err.name === 'AbortError') return; // User cancelled — no toast
        ui.showToast(`文件选择失败: ${err.message}`, 'error');
        return;
      }

      const quality = qualityEl?.value || '1080P';
      state.recordFileHandle = fileHandle;
      state.recordFilename = null; // cleared until RECORD_STOPPED

      // Store fileHandle in IndexedDB so the offscreen document can retrieve it
      // without losing its prototype chain through chrome.runtime.sendMessage IPC.
      await _storeFileHandle(fileHandle);
      chrome.runtime.sendMessage({ type: 'START_RECORD_TEST', streamId, quality, filename: fileHandle.name });
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
      statsEl.style.display = 'block';
      statsEl.innerHTML =
        `录制文件: <b style="color:#aaa">${fileHandle.name}</b>` +
        `&nbsp;&nbsp;<span style="color:#555">${quality}</span>` +
        `&nbsp; 等待编码器...`;
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
      if (qualityEl) { qualityEl.disabled = false; qualityEl.style.opacity = '1'; }
    };

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
    chrome.runtime.sendMessage({ type: 'GET_RECORD_STATUS' }, (statusResp) => {
        const backendActive = statusResp?.isRecordActive ?? false;
        chrome.storage.local.get('recordingState', (result) => {
            const rs = result?.recordingState;
            if (!rs?.isRecording) return;

            if (!backendActive) {
                // Stale state detected — background has no live recording offscreen.
                chrome.storage.local.set({ recordingState: { isRecording: false } }).catch(() => {});
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
            if (dotEl) { dotEl.style.background = '#ff5252'; dotEl.style.boxShadow = '0 0 6px #ff5252'; }
            if (statsEl) {
                statsEl.style.display = 'block';
                statsEl.innerHTML = `<span style="color:#ff5252">⬤ 录制中…</span>&nbsp;&nbsp;<span style="color:#555">${rs.quality || ''}</span>`;
            }
            // Start local timer ticking from persisted startTime
            if (rs.startTime) startRecordingTimer(rs.startTime);
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

            sorted.forEach(item => list.appendChild(createUrlItem(item, currentTab, state, searchTerm)));
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
      const modeLabel = m.mode === 'HW' ? 'GPU 硬编' : '软件编码';
      statsEl.style.display = 'block';
      statsEl.innerHTML =
        `编码器就绪 &nbsp;` +
        `<b style="color:${modeColor};padding:1px 5px;border:1px solid ${modeColor};border-radius:3px;font-size:8px;">${modeLabel}</b>` +
        `&nbsp;&nbsp;<span style="color:#555">${m.codec}</span>`;
      return;
    }
    if (m.type === 'RECORD_STATS') {
      const s = m.stats;
      const statsEl = document.getElementById('record-stats');
      if (!statsEl) return;
      const modeColor = s.encoderMode === 'HW' ? '#00e676' : '#ffb300';
      const modeLabel = s.encoderMode === 'HW' ? 'GPU 硬编' : '软件编码';
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
        ui.showToast('I/O 已恢复，码率已还原');
      }
      _prevBitrateReduced = !!s.bitrateReduced;

      const elapsedStr = formatElapsed(s.elapsed || 0);
      // Sync timer element with worker's authoritative elapsed value
      const timerEl = document.getElementById('record-timer');
      if (timerEl && timerEl.style.display !== 'none') timerEl.textContent = elapsedStr;

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
      const statsEl    = document.getElementById('record-stats');
      const startBtn   = document.getElementById('record-start-btn');
      const qualityEl  = document.getElementById('record-quality');
      const dotEl      = document.getElementById('record-indicator');
      if (statsEl) statsEl.innerHTML +=
        `<br><span style="color:#29b6f6">文件已写入: <b>${m.filename || '—'}</b></span>` +
        `<br><span style="color:#ff5252">已停止 — 共传输 <b>${m.totalFrames}</b> 帧给编码器</span>` +
        `<br><span style="color:#ffa726">⏳ 正在自动转封装为 MP4...</span>`;
      if (startBtn) { startBtn.disabled = false; startBtn.style.opacity = '1'; }
      if (qualityEl) { qualityEl.disabled = false; qualityEl.style.opacity = '1'; }
      if (dotEl)    { dotEl.style.background = '#444'; dotEl.style.boxShadow = 'none'; }
      if (m.filename) state.recordFilename = m.filename;
      return;
    }
    if (m.type === 'RECORD_ERROR') {
      stopRecordingTimer();
      _prevBitrateReduced = false;
      const statsEl   = document.getElementById('record-stats');
      const startBtn  = document.getElementById('record-start-btn');
      const stopBtn   = document.getElementById('record-stop-btn');
      const qualityEl = document.getElementById('record-quality');
      const dotEl     = document.getElementById('record-indicator');
      if (statsEl) { statsEl.style.display = 'block'; statsEl.innerHTML = `<span style="color:#ff5252">错误: ${m.error}</span>`; }
      if (startBtn) { startBtn.disabled = false; startBtn.style.opacity = '1'; }
      if (stopBtn)  { stopBtn.disabled = true; stopBtn.style.cursor = 'not-allowed'; }
      if (qualityEl) { qualityEl.disabled = false; qualityEl.style.opacity = '1'; }
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
    } else if (m.type === 'FFMPEG_COMPLETE' || m.type === 'FFMPEG_ERROR') {
        const isProxy = m.isProxy;
        const isRemux = m.isRemux;
        if (m.type === 'FFMPEG_COMPLETE') {
            ui.showToast(isRemux ? 'MP4 转封装完成，文件已保存' : t(isProxy ? 'toastDownloadComplete' : 'toastMergeComplete'));
        } else {
            ui.showToast(isRemux ? `MP4 转封装失败: ${m.error}` : t(isProxy ? 'error' : 'mergeError', [m.error]), 'error');
        }
        resetUI();
        if (!isRemux) setTimeout(renderUrls, 2500);
    }
}
