/**
 * Sovereign Sniffer - Logic for intercepting and filtering URLs
 */
import { logger } from '../common/logger.js';

export const MEDIA_SIGNATURES = [
  '.m3u8', '.mpd', '.mp4', '.webm', 'googlevideo.com', 'videoplayback',
  'chunklist', 'mime=video', 'mime=audio', 'douyinvod.com', 'tiktokv.com',
  '/video/tos/', '/music/', '.m4a'
];

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
  'vmind.qq.com', 'pgdt.qq.com', 'gdt.qq.com'
];

export function isNoiseFragment(url) {
  const urlLower = url.toLowerCase();
  if (urlLower.includes('.m3u8') || urlLower.includes('chunklist')) return false;

  const fragmentSigns = [
    'seg-', 'fragment-', 'part-', '/ts/', '.ts', '.m4f', 'chunk-',
    'range=', 'bytes=', 'index=', '/sq/', '/shub/', 'webmask'
  ];

  if (urlLower.includes('googlevideo.com') || urlLower.includes('bilivideo.com')) {
    if (urlLower.includes('range=') || urlLower.includes('clen=') || urlLower.includes('live=1')) return true;
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
    const match = url.match(/[&?]id=([^&]+)/);
    if (match) return `yt-${match[1]}`;
    const pathMatch = url.match(/\/id\/([^\/\?]+)/);
    if (pathMatch) return `yt-${pathMatch[1]}`;
  }
  if (urlLower.includes('.m4s') || urlLower.includes('bilivideo.com')) {
    const tridMatch = url.match(/[&?]trid=([a-f0-9]+)/i);
    if (tridMatch) return `bili-${tridMatch[1].substring(0, 16)}`;
    const parts = url.split('/');
    const idPart = parts.find(p => p.length > 20 && /^[a-f0-9]+$/i.test(p));
    if (idPart) return `bili-${idPart.substring(0, 16)}`;
  }
  const sessMatch = url.match(/[&?](session_id|sid|task_id|mt)=([^&]+)/i);
  if (sessMatch) return sessMatch[2];
  return null;
}

export function detectMediaType(url) {
  const urlLower = url.toLowerCase();
  if (urlLower.includes('media-audio') || urlLower.includes('v-ams')) return 'audio';
  if (urlLower.includes('media-video') || urlLower.includes('v-video')) return 'video';
  if (urlLower.includes('.m4s')) {
    if (urlLower.includes('video') || urlLower.includes('avc1') || urlLower.includes('hev1')) return 'video';
    if (urlLower.includes('audio') || urlLower.includes('mp4a')) return 'audio';
  }
  if (urlLower.includes('mime=audio') || urlLower.includes('type=audio') || urlLower.includes('/audio/') || urlLower.includes('/music/') || urlLower.includes('.m4a')) return 'audio';
  if (urlLower.includes('mime=video') || urlLower.includes('type=video') || urlLower.includes('/video/')) return 'video';
  return null;
}

export function isValidMediaMime(mimeType, url = '') {
  if (!mimeType) return false;
  const mimeLower = mimeType.toLowerCase();
  
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
