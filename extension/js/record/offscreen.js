/**
 * Record Offscreen Document — Phase 4: Real Tab Capture + Audio + Resolution
 *
 * Full pipeline (Phase 4):
 *   chrome.tabCapture.getMediaStreamId() [background]
 *     → getUserMedia({ chromeMediaSource:'tab', chromeMediaSourceId: streamId })
 *       → MediaStreamTrackProcessor → ReadableStream<VideoFrame>
 *           → worker.postMessage(frame, [frame])         ← Transferable zero-copy
 *             → Worker: VideoEncoder (GPU/SW H.264) + OffscreenCanvas downscale
 *               → VibeMuxer → WritableFileStream → SSD
 *       → MediaStreamTrackProcessor → ReadableStream<AudioData>
 *           → worker.postMessage(frame, [frame])
 *             → Worker: AudioEncoder (Opus 128 kbps)
 *               → VibeMuxer.addAudioChunk() → same WritableFileStream
 *
 * Key changes vs Phase 3:
 *  - startTest({ fileHandle, streamId, quality }): receives a streamId from popup
 *  - getUserMedia replaces the synthetic canvas captureStream
 *  - Audio track is captured and sent to worker via AUDIO_FRAME messages
 *  - quality ('UHD'/'1080P'/'720P') is forwarded to Worker for OffscreenCanvas downscaling
 *  - INIT message now includes { width, height, fileHandle, quality, hasAudio }
 */
import { logger } from '../common/logger.js';

const COMPONENT = '[RecordOffscreen]';

// ---------------------------------------------------------------------------
// IndexedDB helper — retrieves the FileSystemFileHandle stored by the popup.
// Using IDB avoids losing the prototype chain that occurs when the handle is
// passed through chrome.runtime.sendMessage across IPC boundaries.
// ---------------------------------------------------------------------------
const _IDB = { name: 'vibeRecordDB', store: 'handles', key: 'currentFileHandle' };
const _IDB_REMUX_KEY = 'remuxInputBlob';

/**
 * Read the recorded file as an ArrayBuffer and persist it in IDB.
 *
 * Why ArrayBuffer and not File/Blob:
 *   Chrome's structured-clone of File objects across extension offscreen
 *   documents can silently fail retrieval. A plain ArrayBuffer is always
 *   serialisable and retrieves reliably.
 *
 * Why tx.oncomplete and not put.onsuccess:
 *   put.onsuccess fires when the IDB request is accepted but before the
 *   transaction is committed. Resolving on put.onsuccess + db.close() can
 *   race the commit, leaving the entry absent for subsequent readers.
 *   tx.oncomplete fires only after the transaction is durably committed.
 */
async function _storeRemuxBytes(fileHandle) {
  const file = await fileHandle.getFile();
  logger.info(`${COMPONENT} Reading recorded file for remux (${(file.size / 1024 / 1024).toFixed(1)} MB)...`);
  const buffer = await file.arrayBuffer();
  logger.info(`${COMPONENT} Storing remux bytes in IDB...`);
  await new Promise((resolve, reject) => {
    const req = indexedDB.open(_IDB.name, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(_IDB.store);
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction(_IDB.store, 'readwrite');
      tx.objectStore(_IDB.store).put(buffer, _IDB_REMUX_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror   = () => { db.close(); reject(tx.error); };
      tx.onabort   = () => { db.close(); reject(new Error('IDB transaction aborted')); };
    };
    req.onerror = () => reject(req.error);
  });
  logger.info(`${COMPONENT} Remux bytes stored in IDB (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)`);
}

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

let worker = null;
let mediaStream = null;
let videoReader = null;
let audioReader = null;
let isRunning = false;
let frameIndex = 0;
let wakeLock = null;

// ---------------------------------------------------------------------------
// Main lifecycle
// ---------------------------------------------------------------------------

/**
 * @param {string}  streamId    From chrome.tabCapture.getMediaStreamId() via background.
 * @param {string}  quality     'UHD' | '1080P' | '720P'
 * @param {boolean} isAudioOnly Phase 8: capture audio track only (no video encoding).
 */
async function startTest({ streamId, quality, isAudioOnly = false }) {
  if (isRunning) { logger.warn(`${COMPONENT} Already running`); return; }
  isRunning = true;
  frameIndex = 0;

  // Retrieve FileSystemFileHandle from IndexedDB (stored by popup before sending this message).
  let fileHandle;
  try {
    fileHandle = await _retrieveFileHandle();
    if (!fileHandle || typeof fileHandle.createWritable !== 'function') {
      throw new Error('IndexedDB に保存された fileHandle が無効または見つかりません');
    }
  } catch (err) {
    logger.error(`${COMPONENT} fileHandle retrieval failed: ${err.message}`);
    chrome.runtime.sendMessage({ type: 'RECORD_ERROR', error: `ファイルハンドル取得失敗: ${err.message}` }).catch(() => {});
    isRunning = false;
    return;
  }

  logger.info(`${COMPONENT} === Phase 4 tab-capture START → "${fileHandle.name}" [${quality}] ===`);

  // 1. Spawn the Record Worker
  const workerUrl = chrome.runtime.getURL('js/record/worker.js');
  worker = new Worker(workerUrl);

  // 2. Worker message router
  let resolveEncoderReady;
  const encoderReady = new Promise(resolve => { resolveEncoderReady = resolve; });

  worker.onmessage = (e) => {
    const msg = e.data;

    if (msg.type === 'ENCODER_READY') {
      resolveEncoderReady(msg);
      chrome.runtime.sendMessage({ type: 'RECORD_HW_CHECK', mode: msg.mode, codec: msg.codec }).catch(() => { });

    } else if (msg.type === 'RECORD_WRITE_COMPLETE') {
      // Send RECORD_STOPPED immediately so the background clears isRecording
      // in storage without waiting for the (potentially slow) IDB write.
      logger.info(`${COMPONENT} File write complete: ${msg.filename}`);
      const filename = msg.filename;
      chrome.runtime.sendMessage({
        type: 'RECORD_STOPPED',
        totalFrames: frameIndex,
        filename,
      }).catch(() => {});
      setTimeout(() => { if (worker) { worker.terminate(); worker = null; } }, 100);

      // Store the recorded bytes in IDB for the FFmpeg remux offscreen.
      // This is fire-and-forget from the UI perspective; background waits for
      // RECORD_BLOB_READY before triggering the remux.
      (async () => {
        try {
          await _storeRemuxBytes(fileHandle);
          chrome.runtime.sendMessage({ type: 'RECORD_BLOB_READY', filename }).catch(() => {});
        } catch (err) {
          logger.warn(`${COMPONENT} Failed to store remux bytes: ${err.message}`);
          chrome.runtime.sendMessage({ type: 'RECORD_BLOB_FAILED', filename, error: err.message }).catch(() => {});
        }
      })();

    } else if (msg.type === 'ENCODE_ERROR') {
      logger.error(`${COMPONENT} ${msg.error}`);
      chrome.runtime.sendMessage({ type: 'RECORD_ERROR', error: msg.error }).catch(() => { });

    } else {
      // STATS → forward to popup
      chrome.runtime.sendMessage({ type: 'RECORD_STATS', stats: msg }).catch(() => { });
    }
  };

  worker.onerror = (e) => {
    logger.error(`${COMPONENT} Worker uncaught: ${e.message}`);
    chrome.runtime.sendMessage({ type: 'RECORD_ERROR', error: e.message }).catch(() => { });
  };

  // 3. Capture the tab stream via getUserMedia (streamId from background tabCapture)
  if (!streamId) {
    const err = 'Missing streamId — cannot capture tab';
    logger.error(`${COMPONENT} ${err}`);
    chrome.runtime.sendMessage({ type: 'RECORD_ERROR', error: err }).catch(() => { });
    isRunning = false;
    worker.terminate(); worker = null;
    return;
  }

  if (typeof MediaStreamTrackProcessor === 'undefined') {
    const err = 'MediaStreamTrackProcessor unavailable (Chrome 94+ required)';
    chrome.runtime.sendMessage({ type: 'RECORD_ERROR', error: err }).catch(() => { });
    isRunning = false;
    worker.terminate(); worker = null;
    return;
  }

  try {
    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      // Phase 8: skip video track when audio-only mode is selected
      ...(!isAudioOnly && {
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
      }),
    };
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    logger.error(`${COMPONENT} getUserMedia failed: ${err.message}`);
    chrome.runtime.sendMessage({ type: 'RECORD_ERROR', error: `标签页捕获失败: ${err.message}` }).catch(() => { });
    isRunning = false;
    worker.terminate(); worker = null;
    return;
  }

  const videoTrack = mediaStream.getVideoTracks()[0];
  const audioTrack = mediaStream.getAudioTracks()[0];

  // In standard mode a video track is required; in audio-only mode it is intentionally absent.
  if (!videoTrack && !isAudioOnly) {
    const err = '捕获流中没有视频轨道';
    chrome.runtime.sendMessage({ type: 'RECORD_ERROR', error: err }).catch(() => { });
    isRunning = false;
    worker.terminate(); worker = null;
    return;
  }

  // Chrome tab capture MUTES the original tab — route captured audio back to
  // the speakers via HTMLAudioElement so the user can still hear while recording.
  if (audioTrack) {
    try {
      const audio = new Audio();
      audio.srcObject = mediaStream;
      audio.play().catch(err => logger.warn(`${COMPONENT} Audio passthrough: ${err.message}`));
    } catch (err) {
      logger.warn(`${COMPONENT} Audio passthrough setup failed: ${err.message}`);
    }
  }

  const s = videoTrack ? videoTrack.getSettings() : { width: 0, height: 0 };
  const audioSettings = audioTrack ? audioTrack.getSettings() : {};
  const hasAudio = !!audioTrack;

  if (isAudioOnly) {
    logger.info(`${COMPONENT} Audio-only mode: ${audioSettings.sampleRate || 'N/A'}Hz, ${audioSettings.channelCount || 0}ch`);
  } else {
    logger.info(`${COMPONENT} Video: ${s.width}x${s.height}, Audio: ${audioSettings.sampleRate || 'N/A'}Hz, ${audioSettings.channelCount || 0}ch`);
  }

  // 4. Send INIT — include detected audio parameters for the encoder
  worker.postMessage({
    type: 'INIT',
    width: s.width,
    height: s.height,
    fileHandle,
    quality,
    hasAudio,
    isAudioOnly,
    sampleRate: audioSettings.sampleRate,
    channels: audioSettings.channelCount,
  });

  // 5. Await encoder ready (8 s timeout — tab capture may take longer to initialize)
  let hwInfo;
  try {
    hwInfo = await Promise.race([
      encoderReady,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Encoder INIT timeout after 8 s')), 8000)),
    ]);
  } catch (err) {
    logger.error(`${COMPONENT} ${err.message}`);
    chrome.runtime.sendMessage({ type: 'RECORD_ERROR', error: err.message }).catch(() => { });
    isRunning = false;
    worker.terminate(); worker = null;
    return;
  }
  logger.info(`${COMPONENT} Encoder ready: ${hwInfo.mode} (${hwInfo.codec})`);

  // 6. Request a screen wake lock so the OS does not suspend during recording
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    logger.info(`${COMPONENT} Screen wake lock acquired`);
  } catch (err) {
    logger.warn(`${COMPONENT} Wake lock unavailable: ${err.message}`);
  }

  // 7. Start video frame pump (skipped in audio-only mode)
  if (!isAudioOnly && videoTrack) {
    const videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
    videoReader = videoProcessor.readable.getReader();
    pumpVideoFrames();
  }

  // 8. Start audio frame pump (if available)
  if (audioTrack) {
    const audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
    audioReader = audioProcessor.readable.getReader();
    pumpAudioFrames();
  }
}

async function pumpVideoFrames() {
  logger.info(`${COMPONENT} Video frame pump started`);
  while (isRunning) {
    try {
      const { value: frame, done } = await videoReader.read();
      if (done || !frame) break;
      frameIndex++;
      worker.postMessage({ type: 'FRAME', frame, index: frameIndex }, [frame]);
    } catch (err) {
      if (isRunning) logger.error(`${COMPONENT} Video pump error`, err);
      break;
    }
  }
  logger.info(`${COMPONENT} Video frame pump exited — ${frameIndex} frames sent`);
}

async function pumpAudioFrames() {
  logger.info(`${COMPONENT} Audio frame pump started`);
  while (isRunning) {
    try {
      const { value: frame, done } = await audioReader.read();
      if (done || !frame) break;
      worker.postMessage({ type: 'AUDIO_FRAME', frame }, [frame]);
    } catch (err) {
      if (isRunning) logger.error(`${COMPONENT} Audio pump error`, err);
      break;
    }
  }
  logger.info(`${COMPONENT} Audio frame pump exited`);
}

async function stopTest() {
  if (!isRunning) return;
  isRunning = false;

  if (wakeLock) { await wakeLock.release().catch(() => { }); wakeLock = null; }
  if (videoReader) { await videoReader.cancel().catch(() => { }); videoReader = null; }
  if (audioReader) { await audioReader.cancel().catch(() => { }); audioReader = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }

  // Tell Worker to flush encoder → drain muxer → close file.
  // Cleanup continues in worker.onmessage when RECORD_WRITE_COMPLETE arrives.
  if (worker) worker.postMessage({ type: 'STOP' });

  logger.info(`${COMPONENT} Stop requested — ${frameIndex} frames sent to encoder`);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_RECORD_TEST') {
    startTest({ streamId: msg.streamId, quality: msg.quality || '1080P', isAudioOnly: msg.isAudioOnly || false });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'STOP_RECORD_TEST') {
    stopTest();
    sendResponse({ ok: true });
    return true;
  }
});

chrome.runtime.sendMessage({ type: 'RECORD_OFFSCREEN_READY' }).catch(() => { });
logger.info(`${COMPONENT} Offscreen document initialised`);
