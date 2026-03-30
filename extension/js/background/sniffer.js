/**
 * Sovereign Sniffer - Logic for intercepting and filtering URLs
 */
import { logger } from '../common/logger.js';
import { PLATFORM_RULES } from './platforms.js';


export const MEDIA_SIGNATURES = [
  '.m3u8', '.mpd', '.mp4', '.webm', 'googlevideo.com', 'videoplayback',
  'chunklist', 'mime=video', 'mime=audio', 'mime_type=video', 'mime_type=audio',
  '/video/tos/', '.m4a', '.mp3', '.wav', '.aac', '.flac', '.opus'
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
  for (const rule of PLATFORM_RULES) {
    if (rule.groupTag && rule.match(urlLower)) {
      const tag = rule.groupTag(url);
      if (tag) return tag;
    }
  }
  // Generic fallback for session/task IDs common across platforms
  return url.match(/[&?](session_id|sid|task_id|mt|_nc_gid|logid|l)=([^&]+)/i)?.[2] ?? null;
}

export function detectMediaType(url) {
  const urlLower = url.toLowerCase();

  // 1. Direct keywords (highest priority, platform-agnostic)
  if (urlLower.includes('media-audio') || urlLower.includes('v-ams') || urlLower.includes('mime=audio') || urlLower.includes('type=audio') || urlLower.includes('_audio') || urlLower.includes('/audio/') || urlLower.includes('/music/')) return 'audio';
  if (urlLower.includes('media-video') || urlLower.includes('v-video') || urlLower.includes('mime=video') || urlLower.includes('type=video') || urlLower.includes('_video') || urlLower.includes('/video/')) return 'video';

  // 2. Platform rules (itag lists, efg decoding, etc.)
  for (const rule of PLATFORM_RULES) {
    if (rule.mediaType && rule.match(urlLower)) {
      const type = rule.mediaType(url);
      if (type) return type;
    }
  }

  // 3. Fallback to common file extensions
  const audioExts = ['.m4a', '.mp3', '.wav', '.aac', '.flac', '.opus', '.m4s'];
  if (audioExts.some(ext => urlLower.includes(ext))) {
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
  const imageSigns = ['.image', '.webp', '.jpg', '.jpeg', '.png', '.gif', '.avif', '~tplv-'];
  if (imageSigns.some(s => urlLower.includes(s))) {
    return false;
  }

  if (mimeLower.startsWith('video/') || mimeLower.startsWith('audio/')) return true;

  const manifests = [
    'application/x-mpegurl',
    'application/dash+xml',
    'application/vnd.apple.mpegurl',
    'audio/x-mpegurl',
    'audio/mpegurl'
  ];
  if (manifests.some(m => mimeLower.includes(m))) return true;

  // Special case: octet-stream or non-standard application types for actual media files
  if (mimeLower.includes('octet-stream') || mimeLower.includes('application/x-')) {
    const mediaExts = ['.m3u8', '.mpd', '.mp4', '.ts', '.m4s', '.m4a', '.webm', '.mp3', '.wav', '.aac', '.flac', '.opus', '.m4v'];
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

    // 1. Universal: strip byte-range params, URL fragments (hashes), and typical cache-busters
    if (u.hash) { u.hash = ''; changed = true; }
    const bustParams = ['bytestart', 'byteend', 'range', '_t', 'ts', 'time', 't', '_'];
    for (const param of bustParams) {
      if (u.searchParams.has(param)) { u.searchParams.delete(param); changed = true; }
    }

    // 2. Platform-specific: strip params declared by the first matching rule
    const urlLower = url.toLowerCase();
    for (const rule of PLATFORM_RULES) {
      if (rule.normalizeParams.length > 0 && rule.match(urlLower)) {
        for (const param of rule.normalizeParams) {
          if (u.searchParams.has(param)) { u.searchParams.delete(param); changed = true; }
        }
        break;
      }
    }

    if (changed) {
      const normalized = u.toString().replace(/\/$/, ""); // Strip trailing slash for consistency
      logger.info(`URL Normalized: ${normalized.substring(0, 100)}...`);
      return normalized;
    }
  } catch (e) { /* ignore */ }
  return url;
}
