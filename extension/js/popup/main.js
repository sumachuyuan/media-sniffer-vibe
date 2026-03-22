/**
 * Sovereign Popup Main Entry (v25.1.0 Feature Complete)
 */
import { ui } from './ui.js';
import { sanitizeFilename, copyToClipboard } from './utils.js';
import { createUrlItem, renderPromo, renderCompanion } from './renderer.js';
import { i18n } from './i18n.js';

const t = (key, subs) => i18n.t(key, subs);

let state = {
    mergingUrl: null,
    mergingProgress: 0,
    mergingStage: '',
    ua: navigator.userAgent,
    concurrency: 3 // Default
};

document.addEventListener('DOMContentLoaded', async () => {
    // 0. Initialize i18n
    await i18n.init();

    // On-Demand Extraction for TikTok
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0] && tabs[0].url && tabs[0].url.includes('tiktok.com')) {
        try {
            await chrome.tabs.sendMessage(tabs[0].id, { type: 'EXTRACT_TIKTOK' });
            await new Promise(r => setTimeout(r, 150)); // Give background a moment to process
        } catch (e) {}
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

    document.getElementById('global-cancel-btn').onclick = () => {
        if (state.mergingUrl) {
            chrome.runtime.sendMessage({ type: 'CANCEL_FFMPEG_MERGE', url: state.mergingUrl });
            resetUI();
            renderUrls();
        }
    };

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

            let displayUrls = response.urls.filter(u => u.tabTitle.toLowerCase().includes(searchTerm) || u.url.toLowerCase().includes(searchTerm));
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

            sorted.forEach(item => list.appendChild(createUrlItem(item, currentTab, state)));
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
    document.querySelectorAll('.play-btn').forEach(btn => btn.onclick = () => startEmbeddedPreview(btn.dataset.url, btn.dataset.id));
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

function startEmbeddedPreview(url, uid) {
    const container = document.getElementById(`preview-container-${uid}`);
    if (!container) return;

    // 1. If same, toggle off
    if (window.activePreviewUid === uid) {
        teardownActiveHls();
        container.style.display = 'none'; container.innerHTML = ''; window.activePreviewUid = null;
        chrome.runtime.sendMessage({ type: 'CLEAR_DNR_RULES' }).catch(() => {});
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
        <div class="preview-header" style="display:flex; justify-content:flex-end; padding:4px;">
            <div class="preview-close" style="cursor:pointer; color:var(--gold-primary); font-size:10px; font-weight:800;">${t('close')}</div>
        </div>
        <video controls autoplay class="preview-video" style="width:100%; max-height:240px; background:#000;"></video>
    `;

    container.querySelector('.preview-close').onclick = () => {
        teardownActiveHls();
        container.style.display = 'none'; container.innerHTML = ''; window.activePreviewUid = null;
        chrome.runtime.sendMessage({ type: 'CLEAR_DNR_RULES' }).catch(() => {});
    };

    const video = container.querySelector('video');

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
        if (m.type === 'FFMPEG_COMPLETE') {
            ui.showToast(t(isProxy ? 'toastDownloadComplete' : 'toastMergeComplete'));
        } else {
            ui.showToast(t(isProxy ? 'error' : 'mergeError', [m.error]), 'error');
        }
        resetUI();
        setTimeout(renderUrls, 2500);
    }
}
