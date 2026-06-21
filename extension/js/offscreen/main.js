/**
 * Sovereign Media Sniffer - Offscreen Entry (v25.0.0 Modular)
 */
import { logger } from '../common/logger.js';
import { initFFmpeg, runFFmpeg, cleanupFS, cleanupAfterMerge } from './ffmpeg.js';
import { decryptBuffer } from './crypto.js';

import {
  loadRemuxInput,
  loadRemuxOutput,
  deleteRemuxInput,
  saveRemuxOutput,
} from '../record/storage.js';

let isMerging = false;
let isCancelled = false;

const t = (key) => (typeof chrome !== 'undefined' && chrome.i18n) ? chrome.i18n.getMessage(key) || key : key;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// SW keep-alive heartbeat (module-level, covers fetch + encode phases)
// ffmpeg.js setProgress covers the runFFmpeg window; this timer covers
// everything else (IDB reads, segment fetching, consolidation) so the
// MV3 Service Worker never goes idle for more than 20 seconds.
// ---------------------------------------------------------------------------
let _heartbeatTimer = null;

function _startHeartbeat(taskName) {
  _stopHeartbeat();
  logger.info(`[Heartbeat] Started for task: ${taskName}`);
  _heartbeatTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_HEARTBEAT', task: taskName })
      .catch(() => {}); // SW may briefly restart; suppress the transient error
  }, 20000);
}

function _stopHeartbeat() {
  if (_heartbeatTimer !== null) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
    logger.info('[Heartbeat] Stopped.');
  }
}

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
  _startHeartbeat('handleMerge');

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

    // AUDIT: Clear old files to prevent stale FS state
    ['iv.mp4', 'ia.mp4', 'final.mp4', 'final.mkv'].forEach(f => {
      try { ffmpeg.FS('unlink', f); } catch (e) { /* ignore */ }
    });

    ffmpeg.FS('writeFile', 'iv.mp4', new Uint8Array(await vBlob.arrayBuffer()));
    ffmpeg.FS('writeFile', 'ia.mp4', new Uint8Array(await aBlob.arrayBuffer()));

    // AUDIT: Mandatory manual unlink to prevent FS locks or stale state on first run
    ['input.webm', 'output.mp3', 'output.mp4'].forEach(f => {
      try { ffmpeg.FS('unlink', f); } catch (e) { /* silent */ }
    });

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
    _stopHeartbeat();
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
  _startHeartbeat('handleMergeSegments');
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
              logger.debug(`Worker ${workerId} segment ${index} failed: ${errorMsg}`);
              if (!RETRYABLE_STATUSES.has(resp.status)) throw new Error(errorMsg);
            } else {
              buf = new Uint8Array(await resp.arrayBuffer());
              logger.debug(`Worker ${workerId} segment ${index} fetched successfully (${buf.length} bytes)`);
              break;
            }
          } catch (e) {
            errorMsg = e.message;
            logger.debug(`Worker ${workerId} segment ${index} fetch error: ${errorMsg}`);
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
        try { ffmpeg.FS('unlink', `part_${i}.ts`); } catch (e) { } // Free memory
      }
      try { ffmpeg.FS('unlink', 'init.mp4'); } catch (e) { }

      const mergedBlob = new Blob(parts);
      const mergedBuffer = new Uint8Array(await mergedBlob.arrayBuffer());
      ffmpeg.FS('writeFile', 'merged.mp4', mergedBuffer);

      finalArgs = ['-y', '-i', 'merged.mp4', '-map', '0', '-c', 'copy', '-fflags', '+genpts', '-movflags', '+faststart', `${outputName}.mp4`];
    } else {
      let concatList = "";
      for (let i = 0; i < total; i++) concatList += `file 'part_${i}.ts'\n`;
      ffmpeg.FS('writeFile', 'concat.txt', new TextEncoder().encode(concatList));
      finalArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-map', '0', '-bsf:a', 'aac_adtstoasc', '-c', 'copy', '-fflags', '+genpts+igndts', '-movflags', '+faststart', `${outputName}.mp4`];
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
    _stopHeartbeat();
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
  logger.info('[Remux] handleWebMRemux triggered. Starting IDB fetch...');

  let ffmpeg = null;
  _startHeartbeat('handleWebMRemux');
  try {
    sendProgress(5, outputName, '读取录制文件...');

    // Read the recorded WebM bytes from IDB.
    // record/offscreen.js stores the file as a plain ArrayBuffer in IDB after
    // the worker closes the writable stream — this avoids fileHandle.getFile()
    // which throws SecurityError in a new document context (user activation required).
    let buffer = await loadRemuxInput();
    if (!buffer) throw new Error('IDB 中未找到录制数据，请重试录制');

    logger.info('[Remux] IDB read success, bytes length:', buffer.byteLength);
    const fileSizeMB = (buffer.byteLength / 1024 / 1024).toFixed(1);
    logger.info(`[Remux] Input: ${outputName} (${fileSizeMB} MB from IDB)`);

    let inputBytes = new Uint8Array(buffer);

    sendProgress(20, outputName, '初始化 FFmpeg...');
    ffmpeg = await initFFmpeg(true);
    cleanupFS(ffmpeg);

    ffmpeg.FS('writeFile', 'input.webm', inputBytes);
    // ✅ WASM 已持有数据副本，立即释放 JS 侧引用，允许 GC 回收 input buffer
    buffer = null;
    inputBytes = null;

    sendProgress(45, outputName, '转封装为 MP4...');
    const mp4Name = outputName.replace(/\.webm$/i, '.mp4');
    const result = await runFFmpeg(ffmpeg, [
      '-y', '-nostdin',
      '-i', 'input.webm',
      '-map', '0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-strict', '-2',
      '-movflags', '+faststart',
      'output.mp4',
    ]);

    if (result !== 0) throw new Error('FFmpeg remux 执行失败，请检查 WebM 文件格式');

    // ✅ 先 unlink 输入文件释放 WASM 堆内存，再读取输出，避免 input+output 同时占用 WASM 堆
    try { ffmpeg.FS('unlink', 'input.webm'); } catch (e) { }

    sendProgress(95, outputName, '正在暂存导出文件...');
    const outData = ffmpeg.FS('readFile', 'output.mp4');

    // Save FFmpeg output to IDB; popup will write to disk via FileSystemFileHandle
    // (only popup has the user-activation context for createWritable()).
    await saveRemuxOutput(outData.buffer);
    sendProgress(100, outputName, '导出完成，正在准备回写...');

    chrome.runtime.sendMessage({
      type: 'FFMPEG_COMPLETE',
      filename: mp4Name,
      url: outputName,
      isRemux: true,
      useIDBOutput: true, // Signal to popup to read from IDB
    }).catch(() => { });
  } catch (e) {
    const detail = `${e.name || 'Error'}: ${e.message || String(e)}`;
    logger.error(`[Remux] Error — ${detail}`, e);
    chrome.runtime.sendMessage({
      type: 'FFMPEG_ERROR',
      error: `MP4 转封装失败: ${detail}`,
      url: outputName,
      isRemux: true,
    }).catch(() => { });
  } finally {
    _stopHeartbeat();
    if (ffmpeg) cleanupAfterMerge(ffmpeg);
    // IDB bytes are NOT cleared here so the user can still run "Extract Audio"
    // on the same recording. _clearRemuxBlob() is called in handleAudioExtract
    // after the audio export, or left for the next recording to overwrite.
    isMerging = false;
  }
}

// --- MP3 Audio Extraction (Phase 8) ---
// Reads the same WebM bytes from IDB and runs FFmpeg with -vn -ab 192k to
// produce an MP3. IDB entry is cleared after this operation since audio
// export is considered the final use of the recorded bytes.
async function handleAudioExtract(m) {
  if (isMerging) return;
  isMerging = true;
  const { outputName } = m;
  logger.info('[AudioExtract] handleAudioExtract triggered. Starting IDB fetch...');

  let ffmpeg = null;
  _startHeartbeat('handleAudioExtract');
  try {
    sendProgress(5, outputName, '读取录制文件...');
    let buffer = await loadRemuxInput();
    if (!buffer) throw new Error('IDB 中未找到录制数据，请重试录制');

    logger.info('[AudioExtract] IDB read success, bytes length:', buffer.byteLength);
    let inputBytes = new Uint8Array(buffer);

    sendProgress(20, outputName, '初始化 FFmpeg...');
    ffmpeg = await initFFmpeg(true);
    cleanupFS(ffmpeg);

    ffmpeg.FS('writeFile', 'input.webm', inputBytes);
    // ✅ 释放 JS 侧引用，允许 GC 回收 input buffer
    buffer = null;
    inputBytes = null;

    sendProgress(45, outputName, '提取音频 (MP3)...');
    const mp3Name = outputName.replace(/\.[^.]+$/, '.mp3');
    const result = await runFFmpeg(ffmpeg, [
      '-y', '-nostdin',
      '-i', 'input.webm',
      '-vn',
      '-ab', '192k',
      '-f', 'mp3',
      'output.mp3',
    ]);

    if (result !== 0) throw new Error('FFmpeg 音频提取失败，请检查录制文件格式');

    // ✅ 先 unlink 输入文件释放 WASM 堆，再读取输出
    try { ffmpeg.FS('unlink', 'input.webm'); } catch (e) { }

    sendProgress(95, outputName, '正在暂存音频文件...');
    const outData = ffmpeg.FS('readFile', 'output.mp3');

    await saveRemuxOutput(outData.buffer);
    sendProgress(100, outputName, '提取完成，正在准备回写...');

    chrome.runtime.sendMessage({
      type: 'FFMPEG_COMPLETE',
      filename: mp3Name,
      url: outputName,
      isAudioExtract: true,
      useIDBOutput: true,
    }).catch(() => { });
  } catch (e) {
    const detail = `${e.name || 'Error'}: ${e.message || String(e)}`;
    logger.error(`[AudioExtract] Error — ${detail}`, e);
    chrome.runtime.sendMessage({
      type: 'FFMPEG_ERROR',
      error: `MP3 提取失败: ${detail}`,
      url: outputName,
      isAudioExtract: true,
    }).catch(() => { });
  } finally {
    _stopHeartbeat();
    if (ffmpeg) cleanupAfterMerge(ffmpeg);
    isMerging = false;
  }
}

chrome.runtime.onMessage.addListener((m, _sender, sendResponse) => {
  if (m.type === 'FFMPEG_MERGE') handleMerge(m);
  if (m.type === 'FFMPEG_MERGE_SEGMENTS') handleMergeSegments(m);
  if (m.type === 'START_PROXY_DOWNLOAD') handleProxyDownload(m);
  if (m.type === 'START_WEBM_REMUX') handleWebMRemux(m);
  if (m.type === 'START_AUDIO_EXTRACT') handleAudioExtract(m);
  if (m.type === 'CANCEL_FFMPEG_MERGE') isCancelled = true;

  // ── Track B: SW-side background download ──────────────────────────────────
  // Background detects popup is closed synchronously, then asks offscreen to
  // materialise the IDB output as a Blob URL. SW passes that URL to
  // chrome.downloads.download (same chrome-extension:// origin — accessible).
  if (m.type === 'PREPARE_BLOB_URL') {
    (async () => {
      try {
        logger.info(`[Offscreen] PREPARE_BLOB_URL requested (type: ${m.isAudioExtract ? 'audio' : 'video'})`);
        const buffer = await loadRemuxOutput();
        if (!buffer) throw new Error('IDB remuxOutputBuffer not found');

        const fileSizeMB = (buffer.byteLength / 1024 / 1024).toFixed(1);
        logger.info(`[Offscreen] IDB output loaded: ${fileSizeMB} MB. Creating Blob URL...`);

        const mimeType = m.isAudioExtract ? 'audio/mpeg' : 'video/mp4';
        const blob = new Blob([buffer], { type: mimeType });
        const blobUrl = URL.createObjectURL(blob);
        logger.info(`[Offscreen] Blob URL created. Responding to SW.`);
        sendResponse({ blobUrl });
      } catch (e) {
        logger.error('[Offscreen] PREPARE_BLOB_URL failed:', e);
        sendResponse({ error: e.message });
      }
    })();
    return true; // Keep the message channel open for the async sendResponse above
  }

  // Background sends this after 5s to allow Blob cleanup once download is locked.
  if (m.type === 'REVOKE_BLOB_URL') {
    if (m.blobUrl) {
      URL.revokeObjectURL(m.blobUrl);
      logger.info('[Offscreen] Blob URL revoked on SW request.');
    }
  }

  // Legacy fallback (kept for safety; not reached in the new PREPARE_BLOB_URL flow).
  if (m.type === 'OFFSCREEN_TRIGGER_DOWNLOAD') {
    (async () => {
      try {
        logger.info(`[Offscreen] OFFSCREEN_TRIGGER_DOWNLOAD (legacy) — file: ${m.filename}`);
        const buffer = await loadRemuxOutput();
        if (!buffer) throw new Error('IDB 数据加载失败');

        const blob = new Blob([buffer], { type: m.isAudioExtract ? 'audio/mpeg' : 'video/mp4' });
        const url = URL.createObjectURL(blob);

        chrome.downloads.download({ url, filename: m.filename, saveAs: false }, (downloadId) => {
          if (chrome.runtime.lastError || downloadId === undefined) {
            logger.error(`[Offscreen] Legacy download failed: ${chrome.runtime.lastError?.message}`);
            URL.revokeObjectURL(url);
            chrome.runtime.sendMessage({ type: 'FFMPEG_ERROR', error: `后台下载失败: ${chrome.runtime.lastError?.message}` }).catch(() => { });
            return;
          }
          logger.info(`[Offscreen] Legacy download registered (id=${downloadId}). Cleanup in 3s...`);
          setTimeout(() => {
            URL.revokeObjectURL(url);
            chrome.runtime.sendMessage({ type: 'OFFSCREEN_CLEANUP_REQ' }).catch(() => { });
          }, 3000);
        });
      } catch (e) {
        logger.error('[Offscreen] OFFSCREEN_TRIGGER_DOWNLOAD failed', e);
        chrome.runtime.sendMessage({ type: 'FFMPEG_ERROR', error: `后台下载失败: ${e.message}` }).catch(() => { });
      }
    })();
  }
});

chrome.runtime.sendMessage({ type: 'FFMPEG_READY' }).catch(() => { });
