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

export function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
