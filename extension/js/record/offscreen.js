/**
 * Record Offscreen Document
 *
 * Pipeline:
 *   chrome.tabCapture.getMediaStreamId() [background]
 *     → getUserMedia({ chromeMediaSource:'tab', chromeMediaSourceId: streamId })
 *       → MediaStreamTrackProcessor → ReadableStream<VideoFrame>
 *           → worker.postMessage(frame, [frame])         ← Transferable zero-copy
 *             → Worker: VideoEncoder (GPU/SW H.264) + createImageBitmap downscale
 *               → VibeMuxer → IDB WritableStream
 *       → MediaStreamTrackProcessor → ReadableStream<AudioData>
 *           → worker.postMessage(frame, [frame])
 *             → Worker: AudioEncoder (Opus 128 kbps)
 *               → VibeMuxer.addAudioChunk() → same IDB WritableStream
 */
import { logger } from '../common/logger.js';
import {
  createChunkWritableStream,
  consolidateChunks,
  clearSession,
} from './storage.js';

const COMPONENT = '[RecordOffscreen]';

let worker = null;
let mediaStream = null;
let videoReader = null;
let audioReader = null;
let isRunning = false;
let frameIndex = 0;
let wakeLock = null;
let _isAudioOnly = false;
let _heartbeatInterval = null;

// ---------------------------------------------------------------------------
// Main lifecycle
// ---------------------------------------------------------------------------

/**
 * @param {string}  streamId    From chrome.tabCapture.getMediaStreamId() via background.
 * @param {string}  quality     'UHD' | '1080P' | '720P'
 * @param {boolean} isAudioOnly Phase 8: capture audio track only (no video encoding).
 * @param {string}  filename    Phase 9: temporary filename for metrics/logging.
 */
async function startTest({ streamId, quality, isAudioOnly = false, filename = 'recording.webm' }) {
  if (isRunning) {
    logger.warn(`${COMPONENT} startTest rejected: Capture is already running.`);
    return;
  }
  isRunning = true;

  // Guard must be set synchronously before any await to prevent re-entrant calls.
  await clearSession().catch(() => {});
  frameIndex = 0;
  _isAudioOnly = !!isAudioOnly;

  // Start heartbeat: written to chrome.storage so popup can detect crashes even
  // if the Service Worker was suspended and restarted between the last heartbeat
  // and the popup opening.
  _heartbeatInterval = setInterval(() => {
    // Optional chaining guards against the rare case where the offscreen document
    // is being torn down by Chrome when this timer fires its final tick.
    chrome?.storage?.local?.set({ recordLastHeartbeat: Date.now() })?.catch?.(() => {});
  }, 5000);

  // Silent start — IDB-backed WritableStream; transferred to worker zero-copy
  const writable = createChunkWritableStream();

  logger.info(`${COMPONENT} === Phase 9 tab-capture START [${quality}] ===`);

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
      logger.info(`${COMPONENT} Chunk capture complete. Consolidating IDB chunks...`);
      const filename = `vibe_recording_${Date.now()}.webm`;
      
      chrome.runtime.sendMessage({
        type: 'RECORD_STOPPED',
        totalFrames: frameIndex,
        filename,
        isAudioOnly: _isAudioOnly,
      }).catch(() => {});
      setTimeout(() => { if (worker) { worker.terminate(); worker = null; } }, 100);

      // Consolidate all IDB chunks into remuxInputBlob for the FFmpeg offscreen.
      consolidateChunks().then(() => {
        chrome.runtime.sendMessage({ type: 'RECORD_BLOB_READY', filename }).catch(() => {});
      }).catch((err) => {
        logger.warn(`${COMPONENT} Failed to consolidate IDB chunks: ${err.message}`);
        chrome.runtime.sendMessage({ type: 'RECORD_BLOB_FAILED', filename, error: err.message }).catch(() => {});
      });

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
    worker?.terminate(); worker = null;
    return;
  }

  if (typeof MediaStreamTrackProcessor === 'undefined') {
    const err = 'MediaStreamTrackProcessor unavailable (Chrome 94+ required)';
    chrome.runtime.sendMessage({ type: 'RECORD_ERROR', error: err }).catch(() => { });
    isRunning = false;
    worker?.terminate(); worker = null;
    return;
  }

  try {
    // Phase 9.4: Static Tab Capture Constraints (Mv3 Standard)
    // IMPORTANT: Including 'displaySurface' or 'mandatory' in an Offscreen document 
    // will trigger a system-level picker prompt, which is auto-rejected (Permission dismissed).
    const W_MAP = { 'UHD': 3840, '1080P': 1920, '720P': 1280 };
    const H_MAP = { 'UHD': 2160, '1080P': 1080, '720P': 720 };
    const targetW = W_MAP[quality] || 1920;
    const targetH = H_MAP[quality] || 1080;

    const constraints = {
      video: isAudioOnly ? false : {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          minWidth: targetW, minHeight: targetH,
          maxWidth: targetW, maxHeight: targetH,
        }
      },
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        }
      },
    };
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    logger.error(`${COMPONENT} getUserMedia failed: ${err.message}`);
    chrome.runtime.sendMessage({ type: 'RECORD_ERROR', error: `标签页捕获失败: ${err.message}` }).catch(() => { });
    isRunning = false;
    worker?.terminate(); worker = null;
    return;
  }

  const videoTrack = mediaStream.getVideoTracks()[0];
  const audioTrack = mediaStream.getAudioTracks()[0];

  // In standard mode a video track is required; in audio-only mode it is intentionally absent.
  if (!videoTrack && !isAudioOnly) {
    const err = '捕获流中没有视频轨道';
    chrome.runtime.sendMessage({ type: 'RECORD_ERROR', error: err }).catch(() => { });
    isRunning = false;
    worker?.terminate(); worker = null;
    return;
  }

  // Chrome tab capture MUTES the original tab — to allow the user to hear the 
  // audio while recording, we must route the stream back to the speakers.
  if (audioTrack) {
    logger.info(`${COMPONENT} Audio track captured [${audioTrack.label}] — bridging to speakers`);
    try {
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(mediaStream);
      source.connect(audioCtx.destination);
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    } catch (err) {
      logger.warn(`${COMPONENT} Audio bridging failed: ${err.message}`);
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
  // Phase 9: writable must be transferred to the worker via the second argument
  worker.postMessage({
    type: 'INIT',
    width: s.width,
    height: s.height,
    writable,
    filename,
    quality,
    hasAudio,
    isAudioOnly,
    sampleRate: audioSettings.sampleRate,
    channels: audioSettings.channelCount,
  }, [writable]);

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
    worker?.terminate(); worker = null;
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

  if (_heartbeatInterval) { clearInterval(_heartbeatInterval); _heartbeatInterval = null; }
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
    startTest({ 
      streamId: msg.streamId, 
      quality: msg.quality || '1080P', 
      isAudioOnly: msg.isAudioOnly || false,
      filename: msg.filename || 'recording.webm'
    });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'STOP_RECORD_TEST') {
    stopTest();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'CLEAR_RECORD_STORAGE') {
    // Force reset local state if popup detects a crash via heartbeat
    isRunning = false;
    if (_heartbeatInterval) { clearInterval(_heartbeatInterval); _heartbeatInterval = null; }
    if (worker) { worker.terminate(); worker = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    clearSession().catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
});

chrome.runtime.sendMessage({ type: 'RECORD_OFFSCREEN_READY' }).catch(() => { });
logger.info(`${COMPONENT} Offscreen document initialised`);
