/**
 * Sovereign Sniffer - Logic for intercepting and filtering URLs
 */
import { logger } from '../common/logger.js';


export const MEDIA_SIGNATURES = [
  '.m3u8', '.mpd', '.mp4', '.webm', 'googlevideo.com', 'videoplayback',
  'chunklist', 'mime=video', 'mime=audio', 'mime_type=video', 'mime_type=audio',
  '/video/tos/', '.m4a'
];

/**
 * Identify high-confidence media streams (ByteDance/TikTok etc.)
 * These should bypass normal noise filters like the 1MB threshold.
 */
export function isVerifiedMedia(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return u.includes('/video/tos/') || u.includes('mime_type=video');
}

export const VALID_MEDIA_MIMES = [
  'video/', 
  'audio/', 
  'application/x-mpegURL', 
  'application/dash+xml', 
  'application/vnd.apple.mpegurl',
  'application/octet-stream'
];

export const NOISE_KEYWORDS = [
  'log_event', 'heartbeat', 'ptracking', 'cmh', 'generate_204',
  'ads', 'analytics', 'doubleclick', 'telemetry', 'beacon',
  '/collect?', '/v1/event', 'crashlytics', 'p-event', 'st-collect',
  'v-metrics', 'tracking', '/stats/', 'm-stats', 'collector',
  'error_log', 'page_view', 'hit_type', 'pixel.', 'umeng',
  'talkingdata', 'qcloudlog', 'sensorsdata', 'growingio',
  'ocpx', 'track.', 'trace.', 'ping?', 'log/', 'aweme/v1/web/report',
  'v1/web/action', '/rpc/', 'data_report', 'web_id', '.webmanifest', 'manifest.json',
  'service-worker.js', 'sw.js', 'workbox-', 'favicon', 'apple-touch-icon', '.map',
  'browser-sync', 'hot-update', 'webpack-dev-server',
  'ykad', 'atm.youku.com', 'cpv.youku.com', 'pre_ad', 'post_ad',
  'adv_', 'ad_url', 'ad_type', 'cupid.iqiyi.com', 'ad.video.qq.com',
  'vmind.qq.com', 'pgdt.qq.com', 'gdt.qq.com', 'tt_to_dsp', 'platform/list/v1'
];

export function isNoiseFragment(url) {
  const urlLower = url.toLowerCase();
  if (urlLower.includes('.m3u8') || urlLower.includes('chunklist')) return false;

  const fragmentSigns = [
    'seg-', 'fragment-', 'part-', '/ts/', '.ts', '.m4f', 'chunk-',
    'index=', 'webmask'
  ];

  if (urlLower.includes('googlevideo.com') || urlLower.includes('bilivideo.com')) {
    // For these platforms, only block if explicitly known to be a small fragment or live stream metadata
    if (urlLower.includes('live=1') && !urlLower.includes('m3u8')) return true;
  }

  if (fragmentSigns.some(sig => urlLower.includes(sig))) {
    if (urlLower.includes('master') || urlLower.includes('playlist')) return false;
    return true;
  }

  if (urlLower.includes('.m4s')) {
    if (urlLower.includes('/sq/') || urlLower.match(/[&?]index=\d+/) || urlLower.includes('/shub/')) return true;
  }

  return false;
}

export function extractGroupTag(url) {
  const urlLower = url.toLowerCase();
  if (urlLower.includes('googlevideo.com')) {
    const cpnMatch = url.match(/[&?]cpn=([^&]+)/);
    if (cpnMatch) return `yt-cpn-${cpnMatch[1]}`;
    const match = url.match(/[&?]id=([^&]+)/);
    if (match) return `yt-${match[1]}`;
    const pathMatch = url.match(/\/id\/([^\/\?]+)/);
    if (pathMatch) return `yt-${pathMatch[1]}`;
  }
  if (urlLower.includes('.m4s') || urlLower.includes('bilivideo.com')) {
    const tridMatch = url.match(/[&?]trid=([a-f0-9]+)/i);
    if (tridMatch) return `bili-${tridMatch[1].substring(0, 16)}`;
    const parts = url.split('/');
    // Reddit (v.redd.it) usually has a 13-character alphanumeric ID in the path
    if (urlLower.includes('v.redd.it')) {
       // URL: https://v.redd.it/djluxgvqrypg1/CMAF_720.mp4
       const idPart = parts.find(p => p.length >= 10 && p.length <= 15);
       if (idPart) return `reddit-${idPart}`;
    }
    const idPart = parts.find(p => p.length > 20 && /^[a-f0-9]+$/i.test(p));
    if (idPart) return `bili-${idPart.substring(0, 16)}`;
  }
  const sessMatch = url.match(/[&?](session_id|sid|task_id|mt|_nc_gid|logid|l)=([^&]+)/i);
  if (sessMatch) return sessMatch[2];

  // Fallback: Facebook video_id inside efg param
  if (url.includes('efg=')) {
    try {
      const efgMatch = url.match(/[&?]efg=([^&]+)/);
      if (efgMatch) {
        const decoded = atob(decodeURIComponent(efgMatch[1]));
        const vidMatch = decoded.match(/"video_id":(\d+)/);
        if (vidMatch) return `fb-${vidMatch[1]}`;
      }
    } catch (e) { /* ignore */ }
  }

  return null;
}

export function detectMediaType(url) {
  const urlLower = url.toLowerCase();
  
  // 1. Direct Keywords (highest priority)
  if (urlLower.includes('media-audio') || urlLower.includes('v-ams') || urlLower.includes('mime=audio') || urlLower.includes('type=audio') || urlLower.includes('_audio') || urlLower.includes('/audio/') || urlLower.includes('/music/')) return 'audio';
  if (urlLower.includes('media-video') || urlLower.includes('v-video') || urlLower.includes('mime=video') || urlLower.includes('type=video') || urlLower.includes('_video') || urlLower.includes('/video/')) return 'video';
  // 2. Platform Specific: YouTube itags
  if (urlLower.includes('googlevideo.com')) {
    const itagMatch = url.match(/[&?]itag=(\d+)/);
    if (itagMatch) {
      const itag = parseInt(itagMatch[1]);
      // Audio itags: 139 (m4a), 140 (m4a), 141 (m4a), 171 (webm), 172 (webm), 249 (opus), 250 (opus), 251 (opus)
      const audioItags = [139, 140, 141, 171, 172, 249, 250, 251];
      if (audioItags.includes(itag)) return 'audio';
      return 'video';
    }
  }

  // 3. Platform Specific: Facebook efg parameter (Base64 encoded JSON)
  if (url.includes('efg=')) {
    try {
      const efgMatch = url.match(/[&?]efg=([^&]+)/);
      if (efgMatch) {
         // Some environments might not have atob directly available in sniffer.js context if exported to offscreen
         // but here it is in background script.
         const decoded = atob(decodeURIComponent(efgMatch[1]));
         if (decoded.includes('audio')) return 'audio';
         if (decoded.includes('video')) return 'video';
      }
    } catch (e) { /* ignore parse error */ }
  }

  // 3. Fallback to common extensions
  const audioExts = ['.m4a', '.mp3', '.wav', '.aac', '.flac', '.opus', '.m4s'];
  if (audioExts.some(ext => urlLower.includes(ext))) {
     // Check if .m4s is actually video (it can be both)
     if (urlLower.includes('.m4s') && (urlLower.includes('video') || urlLower.includes('avc1') || urlLower.includes('hev1'))) return 'video';
     return 'audio';
  }

  const videoExts = ['.webm', '.mp4', '.mkv', '.avi', '.mov', '.flv', '.f4v', '.ts'];
  if (videoExts.some(ext => urlLower.includes(ext))) return 'video';

  return null;
}

export function isValidMediaMime(mimeType, url = '') {
  if (!mimeType) return false;
  const mimeLower = mimeType.toLowerCase();
  const urlLower = url.toLowerCase();

  // Strict rejection for known image signatures in the URL
  // This prevents fake octet-streams or weird CDN paths from bypassing length checks
  const imageSigns = ['.image', '.webp', '.jpg', '.jpeg', '.png', '.gif', '.avif', '~tplv-'];
  if (imageSigns.some(s => urlLower.includes(s))) {
    return false;
  }
  
  if (mimeLower.startsWith('video/') || mimeLower.startsWith('audio/')) return true;
  
  const manifests = [
    'application/x-mpegURL', 
    'application/dash+xml', 
    'application/vnd.apple.mpegurl'
  ];
  if (manifests.some(m => mimeLower.includes(m))) return true;

  // Special case: octet-stream for actual media files (media extension or known API path)
  if (mimeLower.includes('application/octet-stream')) {
    const urlLower = url.toLowerCase();
    const mediaExts = ['.m3u8', '.mpd', '.mp4', '.ts', '.m4s', '.m4a', '.webm', '.mp3', '.wav', '.aac', '.flac'];
    if (mediaExts.some(ext => urlLower.includes(ext))) return true;
    // Feishu/Lark video API paths (no media extension in URL)
    const feishuPaths = [
      'larksuite.com', 'feishu.cn', 'larkuite.com',
      '/suite/drive/', '/file/v1/', '/drive/v1/', '/media/v1/',
      '/video/v1/', '/suite/permission/', 'open.feishu', 'open.larksuite'
    ];
    if (feishuPaths.some(p => urlLower.includes(p))) return true;
  }

  return false;
}

export function normalizeUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    let changed = false;
    if (u.searchParams.has('bytestart')) { u.searchParams.delete('bytestart'); changed = true; }
    if (u.searchParams.has('byteend')) { u.searchParams.delete('byteend'); changed = true; }
    
    // Also handle standard range/bytes params if they are likely for DASH fragments
    // but only if it's a known fragment-heavy domain like Facebook or GoogleVideo
    if (u.hostname.includes('fbcdn.net') || u.hostname.includes('googlevideo.com')) {
      if (u.searchParams.has('range')) { u.searchParams.delete('range'); changed = true; }
      if (u.searchParams.has('rn')) { u.searchParams.delete('rn'); changed = true; }
      if (u.searchParams.has('rbuf')) { u.searchParams.delete('rbuf'); changed = true; }
    }

    if (changed) {
      const normalized = u.toString();
      logger.info(`URL Normalized: ${normalized.substring(0, 100)}...`);
      return normalized;
    }
  } catch (e) { /* ignore */ }
  return url;
}
