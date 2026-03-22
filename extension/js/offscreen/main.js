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
  chrome.runtime.sendMessage({ type: 'FFMPEG_PROGRESS', progress, url, stage, itemId }).catch(() => { });
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
    chrome.runtime.sendMessage({ type: 'FFMPEG_COMPLETE', blobUrl, filename: outputName, url: progressUrl, itemId }).catch(() => { });
  } catch (e) {
    if (e.message !== 'CANCELLED') {
      logger.error('Merge FATAL Error', e);
      chrome.runtime.sendMessage({ type: 'FFMPEG_ERROR', error: e.message, url: progressUrl, itemId }).catch(() => { });
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

    const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
    const MAX_ATTEMPTS = 3;

    const fetchAndProcess = async (index, workerId) => {
      try {
        const url = segments[index];
        let buf, attempt = 0;
        while (true) {
          let errorMsg = '';
          try {
            logger.debug(`Worker ${workerId} fetching segment ${index}: ${url}`);
            const resp = await fetch(url, { credentials: 'include' });
            if (!resp.ok) {
              errorMsg = `Status ${resp.status}`;
              logger.warn(`Worker ${workerId} segment ${index} failed: ${errorMsg}`);
              if (!RETRYABLE_STATUSES.has(resp.status)) throw new Error(errorMsg);
            } else {
              buf = new Uint8Array(await resp.arrayBuffer());
              logger.debug(`Worker ${workerId} segment ${index} fetched successfully (${buf.length} bytes)`);
              break;
            }
          } catch (e) {
            errorMsg = e.message;
            logger.warn(`Worker ${workerId} segment ${index} fetch error: ${errorMsg}`);
          }

          if (++attempt >= MAX_ATTEMPTS) throw new Error(errorMsg || 'Max attempts reached');

          const delay = 500 * Math.pow(2, attempt - 1); 
          logger.info(`Worker ${workerId} segment ${index} retrying in ${delay}ms...`);
          await sleep(delay);
        }
        if (aesKey) buf = await decryptBuffer(buf, aesKey, encryption.iv, (encryption.mediaSequence || 0) + index);

        ffmpeg.FS('writeFile', `part_${index}.ts`, buf);
        buf = null; // Memory hygiene

        completed++;
        if (completed % 20 === 0 || completed === total) {
          sendProgress(Math.round((completed / total) * 90), progressUrl, t('fetching'), itemId);
        }
      } catch (e) {
        logger.error(`Worker ${workerId} segment ${index} FATAL: ${e.message}`);
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

    let finalArgs;
    if (mapUrl) {
      logger.info('Executing binary concat for fMP4 segments...');
      const parts = [ffmpeg.FS('readFile', 'init.mp4')];
      for (let i = 0; i < total; i++) {
        parts.push(ffmpeg.FS('readFile', `part_${i}.ts`));
        try { ffmpeg.FS('unlink', `part_${i}.ts`); } catch(e){} // Free memory
      }
      try { ffmpeg.FS('unlink', 'init.mp4'); } catch(e){}

      const mergedBlob = new Blob(parts);
      const mergedBuffer = new Uint8Array(await mergedBlob.arrayBuffer());
      ffmpeg.FS('writeFile', 'merged.mp4', mergedBuffer);
      
      finalArgs = ['-y', '-i', 'merged.mp4', '-c', 'copy', '-movflags', '+faststart', `${outputName}.mp4`];
    } else {
      let concatList = "";
      for (let i = 0; i < total; i++) concatList += `file 'part_${i}.ts'\n`;
      ffmpeg.FS('writeFile', 'concat.txt', new TextEncoder().encode(concatList));
      finalArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-bsf:a', 'aac_adtstoasc', '-c', 'copy', '-fflags', '+genpts+igndts', '-movflags', '+faststart', `${outputName}.mp4`];
    }

    sendProgress(95, progressUrl, t('merging'), itemId);
    logger.info(`FFmpeg starting with args: ${finalArgs.join(' ')}`);
    sendProgress(95, progressUrl, t('merging'), itemId);
    
    await ffmpeg.run(...finalArgs);
    logger.info(`FFmpeg process completed for ${outputName}`);
    if (isCancelled) throw new Error('CANCELLED');
    const outData = ffmpeg.FS('readFile', `${outputName}.mp4`);
    const blobUrl = URL.createObjectURL(new Blob([outData.buffer], { type: 'video/mp4' }));
    chrome.runtime.sendMessage({ type: 'FFMPEG_COMPLETE', blobUrl, filename: outputName, url: progressUrl, itemId }).catch(() => { });
  } catch (e) {
    if (e.message !== 'CANCELLED') {
      logger.error('Segment Merge FATAL Error', e);
      chrome.runtime.sendMessage({ type: 'FFMPEG_ERROR', error: e.message, url: progressUrl, itemId }).catch(() => { });
    }
  } finally {
    if (ffmpeg) cleanupAfterMerge(ffmpeg);
    isMerging = false; aesKey = null;
  }
}

// --- Single File Proxy Download ---
async function handleProxyDownload(m) {
  if (isMerging) return;
  isMerging = true; isCancelled = false;
  const { url, outputName, itemId } = m;

  try {
    sendProgress(5, url, t('fetching'), itemId);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const contentLength = +resp.headers.get('Content-Length');
    const reader = resp.body.getReader();
    let receivedLength = 0;
    let chunks = [];

    while (true) {
      if (isCancelled) throw new Error('CANCELLED');
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      receivedLength += value.length;
      if (contentLength && receivedLength % (1024 * 1024) === 0) { // Update every 1MB
        sendProgress(Math.round((receivedLength / contentLength) * 95), url, t('fetching'), itemId);
      }
    }

    const blob = new Blob(chunks, { type: resp.headers.get('Content-Type') || 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    chrome.runtime.sendMessage({ type: 'FFMPEG_COMPLETE', blobUrl, filename: outputName, url, itemId, isProxy: true });
  } catch (e) {
    if (e.message !== 'CANCELLED') {
      console.error('Proxy Download Error', e);
      chrome.runtime.sendMessage({ type: 'FFMPEG_ERROR', error: e.message, url, itemId, isProxy: true });
    }
  } finally {
    isMerging = false;
  }
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === 'FFMPEG_MERGE') handleMerge(m);
  if (m.type === 'FFMPEG_MERGE_SEGMENTS') handleMergeSegments(m);
  if (m.type === 'START_PROXY_DOWNLOAD') handleProxyDownload(m);
  if (m.type === 'CANCEL_FFMPEG_MERGE') isCancelled = true;
});

chrome.runtime.sendMessage({ type: 'FFMPEG_READY' }).catch(() => { });
