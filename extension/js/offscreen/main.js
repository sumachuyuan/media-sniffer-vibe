/**
 * Sovereign Media Sniffer - Offscreen Entry (v25.0.0 Modular)
 */
import { logger } from '../common/logger.js';
import { initFFmpeg, runFFmpeg, cleanupFS, cleanupAfterMerge } from './ffmpeg.js';
import { decryptBuffer } from './crypto.js';

let isMerging = false;
let isCancelled = false;

const t = (key) => (typeof chrome !== 'undefined' && chrome.i18n) ? chrome.i18n.getMessage(key) || key : key;

function sendProgress(progress, url, stage = t('fetching'), itemId = null) {
    chrome.runtime.sendMessage({ type: 'FFMPEG_PROGRESS', progress, url, stage, itemId }).catch(() => {});
}

// --- Companion Stream Merge ---
async function handleMerge(m) {
  if (isMerging) return;
  isMerging = true; isCancelled = false;
  const { videoUrl, audioUrl, outputName, manifestUrl, itemId } = m;
  const progressUrl = manifestUrl || videoUrl;
  let ffmpeg = null;

  try {
    const fetchAsset = async (url) => {
        if (isCancelled) throw new Error('CANCELLED');
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.blob();
    };

    logger.info(`Fetching assets: video=${videoUrl}, audio=${audioUrl}`);
    const [vBlob, aBlob] = await Promise.all([fetchAsset(videoUrl), fetchAsset(audioUrl)]);
    logger.info('Assets fetched successfully');

    ffmpeg = await initFFmpeg(true);
    cleanupFS(ffmpeg);

    ffmpeg.FS('writeFile', 'iv.mp4', new Uint8Array(await vBlob.arrayBuffer()));
    ffmpeg.FS('writeFile', 'ia.mp4', new Uint8Array(await aBlob.arrayBuffer()));

    if (isCancelled) throw new Error('CANCELLED');
    sendProgress(70, progressUrl, t('merging'), itemId);
    await runFFmpeg(ffmpeg, ['-y', '-nostdin', '-i', 'iv.mp4', '-i', 'ia.mp4', '-c', 'copy', 'final.mp4']);

    if (isCancelled) throw new Error('CANCELLED');
    const outData = ffmpeg.FS('readFile', 'final.mp4');
    const blobUrl = URL.createObjectURL(new Blob([outData.buffer], { type: 'video/mp4' }));
    chrome.runtime.sendMessage({ type: 'FFMPEG_COMPLETE', blobUrl, filename: outputName, url: progressUrl, itemId }).catch(() => {});
  } catch (e) {
    if (e.message !== 'CANCELLED') {
        logger.error('Merge FATAL Error', e);
        chrome.runtime.sendMessage({ type: 'FFMPEG_ERROR', error: e.message, url: progressUrl, itemId }).catch(() => {});
    }
  } finally {
    if (ffmpeg) cleanupAfterMerge(ffmpeg);
    isMerging = false;
  }
}

// --- Segmented Stream Merge ---
async function handleMergeSegments(m) {
  if (isMerging) return;
  isMerging = true; isCancelled = false;
  const { segments, outputName, manifestUrl, itemId, encryption, mapUrl, concurrency = 1 } = m;
  const progressUrl = manifestUrl || segments?.[0];
  const total = segments?.length || 0;

  let blobs = []; // For cleanup

  let aesKey = null;
  let ffmpeg = null;
  try {
    ffmpeg = await initFFmpeg(true);
    cleanupFS(ffmpeg);

    if (encryption?.method === 'AES-128' && encryption.uri) {
        const r = await fetch(encryption.uri);
        aesKey = await r.arrayBuffer();
    }

    if (mapUrl) {
        logger.info(`Fetching initialization map: ${mapUrl}`);
        const r = await fetch(mapUrl);
        ffmpeg.FS('writeFile', 'init.mp4', new Uint8Array(await r.arrayBuffer()));
    }

    logger.info(`Starting fetch of ${total} segments with concurrency=${concurrency}...`);
    
    // Pool-based fetching
    const results = new Array(total);
    let completed = 0;
    const pool = async (index) => {
        if (isCancelled || index >= total) return;
        try {
            const resp = await fetch(segments[index]);
            if (!resp.ok) throw new Error(`Segment ${index} fetch failed: ${resp.status}`);
            let buf = new Uint8Array(await resp.arrayBuffer());
            if (aesKey) buf = await decryptBuffer(buf, aesKey, encryption.iv, (encryption.mediaSequence || 0) + index);
            ffmpeg.FS('writeFile', `part_${index}.ts`, buf);
            buf = null; // Memory hygiene
            completed++;
            if (completed % 20 === 0 || completed === total) {
                sendProgress(Math.round((completed / total) * 90), progressUrl, t('fetching'), itemId);
            }
            await pool(index + concurrency);
        } catch (e) { throw e; }
    };

    const initialThreads = Math.min(concurrency, total);
    const threads = [];
    for (let i = 0; i < initialThreads; i++) threads.push(pool(i));
    await Promise.all(threads);

    if (isCancelled) throw new Error('CANCELLED');
    logger.info('All segments fetched and written to FS');

    let concatList = mapUrl ? "file 'init.mp4'\n" : "";
    for (let i = 0; i < total; i++) concatList += `file 'part_${i}.ts'\n`;
    ffmpeg.FS('writeFile', 'concat.txt', new TextEncoder().encode(concatList));

    sendProgress(95, progressUrl, t('merging'), itemId);
    await runFFmpeg(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-fflags', '+genpts+igndts', '-movflags', '+faststart', 'final.mp4']);

    if (isCancelled) throw new Error('CANCELLED');
    const outData = ffmpeg.FS('readFile', 'final.mp4');
    const blobUrl = URL.createObjectURL(new Blob([outData.buffer], { type: 'video/mp4' }));
    chrome.runtime.sendMessage({ type: 'FFMPEG_COMPLETE', blobUrl, filename: outputName, url: progressUrl, itemId }).catch(() => {});
  } catch (e) {
    if (e.message !== 'CANCELLED') {
        logger.error('Segment Merge FATAL Error', e);
        chrome.runtime.sendMessage({ type: 'FFMPEG_ERROR', error: e.message, url: progressUrl, itemId }).catch(() => {});
    }
  } finally {
    if (ffmpeg) cleanupAfterMerge(ffmpeg);
    isMerging = false; aesKey = null;
  }
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === 'FFMPEG_MERGE') handleMerge(m);
  if (m.type === 'FFMPEG_MERGE_SEGMENTS') handleMergeSegments(m);
  if (m.type === 'CANCEL_FFMPEG_MERGE') isCancelled = true;
});

chrome.runtime.sendMessage({ type: 'FFMPEG_READY' }).catch(() => {});
