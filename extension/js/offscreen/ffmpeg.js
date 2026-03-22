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
    try {
        await ffmpeg.run(...cleanArgs);
        return 0;
    } catch (e) {
        logger.error('Execution Failed', e);
        return -1;
    }
}

const WORK_FILE_PATTERNS = [
    /^part_\d+\.ts$/,
    /^(iv|ia|init|final|merged)\.mp4$/,
    /^concat\.txt$/,
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
