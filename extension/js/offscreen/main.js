/**
 * Sovereign Media Sniffer - Offscreen Entry (v25.0.0 Modular)
 */
import { logger } from '../common/logger.js';
import { initFFmpeg, runFFmpeg, cleanupFS, cleanupAfterMerge } from './ffmpeg.js';
import { decryptBuffer } from './crypto.js';

// ---------------------------------------------------------------------------
// IndexedDB helper — retrieves the FileSystemFileHandle stored by the popup.
// ---------------------------------------------------------------------------
const _IDB = { name: 'vibeRecordDB', store: 'handles', key: 'currentFileHandle' };
const _IDB_REMUX_KEY = 'remuxInputBlob';

function _retrieveFileHandle() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_IDB.name, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(_IDB.store);
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction(_IDB.store, 'readonly');
      const get = tx.objectStore(_IDB.store).get(_IDB.key);
      get.onsuccess = () => { db.close(); resolve(get.result); };
      get.onerror = () => { db.close(); reject(get.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

/** Retrieve the ArrayBuffer saved by record/offscreen.js after recording completes. */
function _retrieveRemuxBytes() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_IDB.name, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(_IDB.store);
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction(_IDB.store, 'readonly');
      const get = tx.objectStore(_IDB.store).get(_IDB_REMUX_KEY);
      get.onsuccess = () => { db.close(); resolve(get.result || null); };
      get.onerror = () => { db.close(); reject(get.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

/** Delete the remux bytes from IDB after use to free storage space. */
function _clearRemuxBlob() {
  return new Promise((resolve) => {
    const req = indexedDB.open(_IDB.name, 1);
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction(_IDB.store, 'readwrite');
      tx.objectStore(_IDB.store).delete(_IDB_REMUX_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    };
    req.onerror = () => resolve();
  });
}

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
    
    // Attempt merging with '-c copy'. 
    // Note: MP4 container might fail for VP9+Opus. If it fails, we try MKV as a robust fallback.
    let result = await runFFmpeg(ffmpeg, ['-y', '-nostdin', '-i', 'iv.mp4', '-i', 'ia.mp4', '-c', 'copy', 'final.mp4']);
    let finalExt = 'mp4';

    if (result !== 0) {
      logger.warn('MP4 merge failed, attempting MKV fallback for codec compatibility...');
      result = await runFFmpeg(ffmpeg, ['-y', '-nostdin', '-i', 'iv.mp4', '-i', 'ia.mp4', '-c', 'copy', 'final.mkv']);
      finalExt = 'mkv';
    }
    
    if (result !== 0) {
      throw new Error('FFMPEG_EXEC_ERROR: Merge failed for both MP4 and MKV containers.');
    }

    if (isCancelled) throw new Error('CANCELLED');
    const outData = ffmpeg.FS('readFile', `final.${finalExt}`);
    const blobUrl = URL.createObjectURL(new Blob([outData.buffer], { type: `video/${finalExt === 'mkv' ? 'x-matroska' : 'mp4'}` }));
    chrome.runtime.sendMessage({ type: 'FFMPEG_COMPLETE', blobUrl, filename: `${outputName}.${finalExt}`, url: progressUrl, itemId }).catch(() => { });
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

    const result = await runFFmpeg(ffmpeg, finalArgs);
    if (result !== 0) throw new Error('FFMPEG_EXEC_ERROR: Segment merge failed.');
    logger.info(`FFmpeg process completed for ${outputName}`);
    if (isCancelled) throw new Error('CANCELLED');
    const outData = ffmpeg.FS('readFile', `${outputName}.mp4`);
    const blobUrl = URL.createObjectURL(new Blob([outData.buffer], { type: 'video/mp4' }));
    chrome.runtime.sendMessage({ type: 'FFMPEG_COMPLETE', blobUrl, filename: `${outputName}.mp4`, url: progressUrl, itemId }).catch(() => { });
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
    chrome.runtime.sendMessage({ type: 'FFMPEG_COMPLETE', blobUrl, filename: `${outputName}.mp4`, url, itemId, isProxy: true });
  } catch (e) {
    if (e.message !== 'CANCELLED') {
      logger.error('Proxy Download Error', e);
      chrome.runtime.sendMessage({ type: 'FFMPEG_ERROR', error: e.message, url, itemId, isProxy: true });
    }
  } finally {
    isMerging = false;
  }
}

// --- WebM → MP4 Remux (Phase 5) ---
// Called after recording completes; reads the saved .webm via FileSystemFileHandle,
// remuxes to .mp4 with -c copy -movflags +faststart (no re-encode), then triggers download.
async function handleWebMRemux(m) {
  if (isMerging) return;
  isMerging = true;
  const { outputName } = m;

  let ffmpeg = null;
  try {
    sendProgress(5, outputName, '读取录制文件...');

    // Read the recorded WebM bytes from IDB.
    // record/offscreen.js stores the file as a plain ArrayBuffer in IDB after
    // the worker closes the writable stream — this avoids fileHandle.getFile()
    // which throws SecurityError in a new document context (user activation required).
    const buffer = await _retrieveRemuxBytes();
    if (!buffer) throw new Error('IDB 中未找到录制数据，请重试录制');

    const fileSizeMB = (buffer.byteLength / 1024 / 1024).toFixed(1);
    logger.info(`[Remux] Input: ${outputName} (${fileSizeMB} MB from IDB)`);

    const inputBytes = new Uint8Array(buffer);

    sendProgress(20, outputName, '初始化 FFmpeg...');
    ffmpeg = await initFFmpeg(true);
    cleanupFS(ffmpeg);

    ffmpeg.FS('writeFile', 'input.webm', inputBytes);

    sendProgress(45, outputName, '转封装为 MP4...');
    const mp4Name = outputName.replace(/\.webm$/i, '.mp4');
    const result = await runFFmpeg(ffmpeg, [
      '-y', '-nostdin',
      '-i', 'input.webm',
      '-c', 'copy',
      '-movflags', '+faststart',
      'output.mp4',
    ]);

    if (result !== 0) throw new Error('FFmpeg remux 执行失败，请检查 WebM 文件格式');

    sendProgress(90, outputName, '准备下载...');
    const outData = ffmpeg.FS('readFile', 'output.mp4');
    const blobUrl = URL.createObjectURL(new Blob([outData.buffer], { type: 'video/mp4' }));

    chrome.runtime.sendMessage({
      type: 'FFMPEG_COMPLETE',
      blobUrl,
      filename: mp4Name,
      url: outputName,
      isRemux: true,
    }).catch(() => {});
  } catch (e) {
    const detail = `${e.name || 'Error'}: ${e.message || String(e)}`;
    logger.error(`[Remux] Error — ${detail}`, e);
    chrome.runtime.sendMessage({
      type: 'FFMPEG_ERROR',
      error: `MP4 转封装失败: ${detail}`,
      url: outputName,
      isRemux: true,
    }).catch(() => {});
  } finally {
    if (ffmpeg) cleanupAfterMerge(ffmpeg);
    await _clearRemuxBlob().catch(() => {}); // free IDB storage
    isMerging = false;
  }
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === 'FFMPEG_MERGE') handleMerge(m);
  if (m.type === 'FFMPEG_MERGE_SEGMENTS') handleMergeSegments(m);
  if (m.type === 'START_PROXY_DOWNLOAD') handleProxyDownload(m);
  if (m.type === 'WEBM_REMUX') handleWebMRemux(m);
  if (m.type === 'CANCEL_FFMPEG_MERGE') isCancelled = true;
});

chrome.runtime.sendMessage({ type: 'FFMPEG_READY' }).catch(() => { });
