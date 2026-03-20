/**
 * Sovereign Popup Renderer - Logic for building the URL list
 */
import { ui } from './ui.js';
import { sanitizeFilename, escapeHtml } from './utils.js';
import { i18n } from './i18n.js';

const t = (key, subs) => i18n.t(key, subs);

export function createUrlItem(item, tab, state) {
    const div = document.createElement('div');
    div.className = 'url-item';
    const displayTitle = (item.tabTitle && item.tabTitle !== 'null') ? item.tabTitle : (tab.title || 'Unknown');
    const filename = sanitizeFilename(displayTitle);
    const time = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const urlLower = item.url.toLowerCase();

    let protocol = 'EXT', protocolColor = '#444';
    const isDirectFile = urlLower.includes('.mp4') || urlLower.includes('.mp3') || urlLower.includes('.m4a') || urlLower.includes('.wav') || urlLower.includes('.aac') || urlLower.includes('douyinvod.com') || urlLower.includes('/video/tos/') || urlLower.includes('tiktokv.com');
    
    if (urlLower.includes('.m3u8')) protocol = 'M3U8', protocolColor = 'var(--gold-primary)';
    else if (isDirectFile) {
        if (urlLower.includes('.mp3')) protocol = 'MP3', protocolColor = '#ff44aa';
        else if (urlLower.includes('.m4a') || urlLower.includes('.wav') || urlLower.includes('.aac')) protocol = 'AUDIO', protocolColor = '#8855ff';
        else protocol = 'MP4', protocolColor = '#00aaff';
    }
    else if (urlLower.includes('.mpd')) protocol = 'MPD', protocolColor = '#ff5500';

    let typeBadge = '';
    if (item.mediaType === 'video') typeBadge = `<span class="badge-video">${t('video')}</span>`;
    else if (item.mediaType === 'audio') typeBadge = `<span class="badge-audio">${t('audio')}</span>`;

    let qualityHtml = '';
    if (item.qualities) {
        qualityHtml = `
            <div class="quality-list">
                ${item.qualities.map(q => `
                    <span class="quality-tag" 
                        data-url="${item.url}" 
                        data-quality-url="${q.url}" 
                        data-filename="${filename}" 
                        data-res="${q.resolution.split('x')[1]}">
                        ${q.resolution.split('x')[1]}P
                    </span>
                `).join('')}
            </div>
        `;
    }

    let actionHtml = state.mergingUrl === item.url
        ? `<button class="cancel-merge" data-url="${item.url}">${t('cancelMerge')}</button>`
        : state.mergingUrl ? `<div class="task-lock">${t('taskLock')}</div>`
        : `
            <button class="copy-cli" data-url="${item.url}" data-filename="${filename}" title="${t('copyCmdTooltip')}">${t('copyCmd')}</button>
            ${item.isSegmented ? `
                <button class="native-merge" 
                    data-url="${item.url}" 
                    data-filename="${filename}" 
                    data-id="${item.id}" 
                    data-estimated-size="${item.estimatedSize || 0}"
                    data-encryption="${item.encryption ? escapeHtml(JSON.stringify(item.encryption)) : ''}">
                    ${t('nativeMerge')}
                </button>
            ` : ''}
            ${(isDirectFile) ? `<button class="direct-download" data-url="${item.url}" data-filename="${filename}">${t('directDownload')}</button>` : ''}
            <button class="play-btn" data-url="${item.url}" data-id="${item.id}">${t('play')}</button>
            <button class="copy-btn" data-url="${item.url}" title="${t('copyUrlTooltip')}">${t('url')}</button>
        `;

    let sizeWarningHtml = '';
    if (item.estimatedSize && item.estimatedSize > 1024 * 1024 * 1024) {
        const sizeGB = (item.estimatedSize / (1024 * 1024 * 1024)).toFixed(1) + 'GB';
        const isCritical = item.estimatedSize > 1.5 * 1024 * 1024 * 1024;
        const icon = isCritical ? '🛑' : '⚠️';
        const msg = isCritical ? t('sizeCritical', [sizeGB]) : t('sizeWarning', [sizeGB]);
        sizeWarningHtml = `<div class="size-warning-banner" title="${msg}" style="color: ${isCritical ? '#ff5252' : 'var(--gold-primary)'}; font-size: 10px; margin-top: 4px;">${icon} ${msg}</div>`;
    }

    div.innerHTML = `
        <div class="item-header">
            <span class="protocol-tag" style="background: ${protocolColor}">${protocol}</span>
            <span class="item-title">${escapeHtml(displayTitle)}</span>
            ${typeBadge}
            ${item.encryption ? `<span class="encrypted-tag">${t('encrypted')}</span>` : ''}
        </div>
        <div class="item-meta">${t('captured')}: ${time}</div>
        ${sizeWarningHtml}
        ${qualityHtml}
        <div class="actions">${actionHtml}</div>
        <div class="progress-box" id="pb-box-${item.id}" style="display:${state.mergingUrl === item.url ? 'block' : 'none'}">
            <div class="progress-track">
                <div class="progress-bar" id="pb-bar-${item.id}" style="width:${state.mergingUrl === item.url ? state.mergingProgress : 0}%"></div>
            </div>
            <div class="progress-text">
                <span id="pb-stage-${item.id}">${state.mergingUrl === item.url ? (state.mergingStage || t('scanning') + '...') : t('scanning') + '...'}</span>
                <span id="pb-pct-${item.id}">${state.mergingUrl === item.url ? state.mergingProgress + '%' : '0%'}</span>
            </div>
        </div>
        <div class="inline-preview" id="preview-container-${item.id}" style="display:none"></div>
    `;
    return div;
}

export function renderPromo(platformName, currentTab, ua) {
    const div = document.createElement('div');
    div.className = 'url-item platform-promo';
    div.innerHTML = `
        <div class="promo-header">
            <span class="promo-icon">🛡️</span>
            <span class="promo-label">${t('universal')}: ${platformName}</span>
        </div>
        <div class="promo-desc">${t('promoDesc')}</div>
        <button id="copyMajorBtn" class="gold-btn" title="${t('copyCmdTooltip')}">${t('copyCmd')}</button>
    `;
    div.querySelector('#copyMajorBtn').onclick = () => {
        const isYT = currentTab.url.includes('youtube.com') || currentTab.url.includes('googlevideo.com');
        const remoteFlag = isYT ? ' --remote-components ejs:github' : '';
        const cmd = `yt-dlp${remoteFlag} --cookies-from-browser chrome --referer "${currentTab.url}" --user-agent "${ua}" --impersonate chrome --concurrent-fragments 5 --no-mtime --merge-output-format mp4 -o "${sanitizeFilename(currentTab.title)}.%(ext)s" "${currentTab.url}"`;
        navigator.clipboard.writeText(cmd).then(() => ui.showToast(t('toastCommandCopied')));
    };
    return div;
}

export function renderCompanion(v, a, currentTab, state, onMerge) {
    const div = document.createElement('div');
    div.className = 'url-item companion-card';
    div.innerHTML = `
        <div class="companion-header">${t('companionHeader')}</div>
        <div class="companion-actions">
            <button id="compMerge" class="gold-btn">${t('nativeMerge')}</button>
            <button id="compCopy" class="outline-btn" title="${t('copyCmdTooltip')}">${t('copyCmd')}</button>
        </div>
        <div id="companion-progress" style="display:none">
            <div class="progress-track"><div id="pb-bar-${v.id}" class="progress-bar"></div></div>
            <div class="companion-status-row" style="display:flex; justify-content:space-between;">
                <span id="pb-stage-${v.id}" class="companion-status">${t('initializing')}...</span>
                <span id="pb-pct-${v.id}" class="companion-status">0%</span>
            </div>
            <button id="companion-cancel" class="cancel-merge" data-url="${v.url}">${t('cancelMerge')}</button>
        </div>
    `;
    div.querySelector('#compMerge').onclick = () => {
        if (state.mergingUrl) return;
        div.querySelector('.companion-actions').style.display = 'none';
        div.querySelector('#companion-progress').style.display = 'block';
        onMerge(v, a);
    };
    div.querySelector('#compCopy').onclick = () => {
        const cmd = `ffmpeg -i "${v.url}" -i "${a.url}" -c copy -y "${sanitizeFilename(v.tabTitle || currentTab.title)}.mp4"`;
        navigator.clipboard.writeText(cmd).then(() => ui.showToast(t('toastCommandCopied')));
    };
    return div;
}
