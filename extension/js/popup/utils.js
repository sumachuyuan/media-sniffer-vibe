/**
 * Sovereign Popup Utils
 */
export function sanitizeFilename(title) {
    if (!title) return 'video';
    let cleanTitle = title
      .replace(/ - YouTube/gi, '')
      .replace(/ \| Bilibili/gi, '')
      .replace(/_哔哩哔哩_bilibili/gi, '')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .replace(/\s+/g, '_')
      .trim();
    
    return cleanTitle.replace(/[\\\/:\*\?"<>|!$`%^&()\[\]{}'#]/g, '_') || 'video';
}

export function copyToClipboard(text, onComplete) {
    navigator.clipboard.writeText(text).then(onComplete);
}

export function buildYtDlpCommand({ url, title, ua, mode = 'mp4' }) {
    if (mode !== 'mp4' && mode !== 'mp3') {
        throw new Error(`Unsupported yt-dlp output mode: ${mode}`);
    }

    const isYouTube = url.includes('youtube.com') || url.includes('googlevideo.com');
    const remoteFlag = isYouTube ? ' --remote-components ejs:github' : '';
    const formatFlag = mode === 'mp3'
        ? ' -f bestaudio/best -x --audio-format mp3 --audio-quality 0'
        : ' --merge-output-format mp4';

    return `yt-dlp${remoteFlag} --cookies-from-browser chrome --referer "${url}" --user-agent "${ua}" --impersonate chrome --concurrent-fragments 5 --no-mtime${formatFlag} -o "${sanitizeFilename(title)}.%(ext)s" "${url}"`;
}

export function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
