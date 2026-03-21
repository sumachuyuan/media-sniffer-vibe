/**
 * Sovereign Media Sniffer - Offscreen Entry (v25.0.0 Modular)
 */
import { logger } from '../common/logger.js';
import { initFFmpeg, runFFmpeg, cleanupFS, cleanupAfterMerge } from './ffmpeg.js';
import { decryptBuffer } from './crypto.js';

let isMerging = false;
let isCancelled = false;

const t = (key) => (typeof chrome !== 'undefined' && chrome.i18n) ? chrome.i18n.getMessage(key) || key : key;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
    
    // Shared index pool for fetching
    let currentIndex = 0;
    const failedSegments = [];
    let completed = 0;

    const fetchAndProcess = async (index, workerId) => {
        const RETRYABLE = new Set([429, 500, 502, 503, 504]);
        const MAX_ATTEMPTS = 3;
        try {
            const url = segments[index];
            let resp, attempt = 0;
            while (true) {
                resp = await fetch(url);
                if (resp.ok) break;
                if (!RETRYABLE.has(resp.status) || ++attempt >= MAX_ATTEMPTS) {
                    throw new Error(`Status ${resp.status}`);
                }
                const delay = 500 * Math.pow(2, attempt - 1); // 500ms, 1000ms
                logger.warn(`Worker ${workerId} segment ${index} got ${resp.status}, retrying in ${delay}ms (attempt ${attempt}/${MAX_ATTEMPTS - 1})`);
                await sleep(delay);
            }

            let buf = new Uint8Array(await resp.arrayBuffer());
            if (aesKey) buf = await decryptBuffer(buf, aesKey, encryption.iv, (encryption.mediaSequence || 0) + index);

            ffmpeg.FS('writeFile', `part_${index}.ts`, buf);
            buf = null; // Memory hygiene

            completed++;
            if (completed % 20 === 0 || completed === total) {
                sendProgress(Math.round((completed / total) * 90), progressUrl, t('fetching'), itemId);
            }
        } catch (e) {
            logger.warn(`Worker ${workerId} failed segment ${index}: ${e.message}`);
            failedSegments.push(index);
        }
    };

    const pool = async (workerId) => {
        while (!isCancelled) {
            const index = currentIndex++;
            if (index >= total) break;
            await fetchAndProcess(index, workerId);
        }
    };

    const threadCount = Math.min(concurrency, total);
    logger.info(`Starting initial fetch pool with ${threadCount} workers...`);
    const threads = [];
    for (let i = 0; i < threadCount; i++) threads.push(pool(i));
    await Promise.all(threads);

    // --- Retry Pass ---
    if (!isCancelled && failedSegments.length > 0) {
        logger.info(`Detected ${failedSegments.length} transient failures. Cooling off for 1s before retry...`);
        await sleep(1000); // Server recovery window
        const toRetry = [...failedSegments];
        failedSegments.length = 0; // Clear for retry tracking
        
        // Single-threaded retry for maximum stability
        for (const index of toRetry) {
            if (isCancelled) break;
            await fetchAndProcess(index, 'retry-agent');
        }
    }

    if (isCancelled) throw new Error('CANCELLED');
    if (failedSegments.length > 0) {
        throw new Error(`Critical failure: ${failedSegments.length} segments could not be fetched after retries.`);
    }

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
