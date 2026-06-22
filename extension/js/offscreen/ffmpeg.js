/**
 * Sovereign FFmpeg Wrapper
 */
import { logger } from '../common/logger.js';

let ffmpegInstance = null;
let isLoading = false;

export async function initFFmpeg(forceNew = false) {
  if (!forceNew && ffmpegInstance) return ffmpegInstance;
  if (isLoading) return new Promise(r => {
    const i = setInterval(() => { if(ffmpegInstance && !forceNew){ clearInterval(i); r(ffmpegInstance); } }, 100);
  });

  logger.info('--- INITIATING FFmpeg ENGINE ---');
  isLoading = true;
  try {
    const { createFFmpeg } = window.FFmpeg;
    const ffmpeg = createFFmpeg({
      log: false,
      corePath: chrome.runtime.getURL('libs/ffmpeg-core.js'),
      mainName: 'main'
    });
    ffmpeg.setLogger(({ type, message }) => logger.debug(`[FFmpeg ${type}] ${message}`));
    await ffmpeg.load();
    logger.info('Engine Core is READY');
    isLoading = false;
    if (!forceNew) ffmpegInstance = ffmpeg;
    return ffmpeg;
  } catch (err) {
    logger.error('Engine Load Failed', err);
    isLoading = false;
    throw err;
  }
}

export async function runFFmpeg(ffmpeg, args) {
    const cleanArgs = (args[0] && args[0].toLowerCase().includes('ffmpeg')) ? args.slice(1) : args;
    logger.info(`Executing: ffmpeg ${cleanArgs.join(' ')}`);

    // Keep the Service Worker alive during long FFmpeg tasks (e.g. 5-10 min remux of 1.39GB).
    // MV3 SWs are terminated after ~30s of inactivity. We send a heartbeat every 10s via
    // ffmpeg.setProgress so Chrome resets the SW idle timer without adding fake progress UI.
    let _swKeepAliveTs = Date.now();
    ffmpeg.setProgress(({ ratio }) => {
        const now = Date.now();
        if (now - _swKeepAliveTs >= 10000) {
            _swKeepAliveTs = now;
            chrome.runtime.sendMessage({
                type: 'FFMPEG_PROGRESS',
                progress: Math.min(Math.round(ratio * 94), 94), // cap at 94 — never show 100% prematurely
                stage: 'merging',
                url: '',
            }).catch(() => {});
        }
    });

    try {
        await ffmpeg.run(...cleanArgs);
        return 0;
    } catch (e) {
        const detail = (e && typeof e === 'object')
          ? `${e.name || 'Error'}: ${e.message || '(no message)'} | type=${e.type || '?'}`
          : String(e);
        logger.error(`Execution Failed: ${detail}`);
        return -1;
    }
}

const WORK_FILE_PATTERNS = [
    /^part_\d+\.ts$/,
    /^(iv|ia|init|final|merged)\.(mp4|mkv|ts)$/,
    /^concat\.txt$/,
    /^input\.webm$/,          // WebM remux: input
    /^output\.mp4$/,          // WebM remux: output
];

export function cleanupFS(ffmpeg) {
    try {
        ffmpeg.FS('readdir', '/').forEach(f => {
            if (WORK_FILE_PATTERNS.some(re => re.test(f))) {
                try { ffmpeg.FS('unlink', f); } catch (_) {}
            }
        });
    } catch (_) {}
}

/** 
 * Proactive cleanup specifically for after a successful merge 
 * to free up MEMFS memory immediately.
*/
export function cleanupAfterMerge(ffmpeg) {
    cleanupFS(ffmpeg);
    logger.info('Proactive MEMFS cleanup completed.');
}
