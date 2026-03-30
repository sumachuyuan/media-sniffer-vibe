/**
 * Record Worker — WebCodecs encoding + VibeMuxer streaming
 *
 * Pipeline:
 *   VideoFrame (Transferable) → VideoEncoder (H.264 HW/SW or VP9)
 *     → VibeMuxer → IDB WritableStream (transferred from record/offscreen.js)
 *   AudioData  (Transferable) → AudioEncoder (Opus 128 kbps)
 *     → VibeMuxer (same stream, interleaved with video)
 *
 * Message protocol (in):
 *   { type: 'INIT',        width, height, writable, filename, quality,
 *                          hasAudio, isAudioOnly, sampleRate, channels }
 *   { type: 'FRAME',       frame, index }       — VideoFrame (Transferable)
 *   { type: 'AUDIO_FRAME', frame }              — AudioData  (Transferable)
 *   { type: 'STOP' }                            — flush encoders → finalize muxer
 *
 * Message protocol (out):
 *   { type: 'ENCODER_READY', mode, codec }
 *   { type: 'STATS', frameCount, encodedCount, keyframeCount,
 *           avgFps, instantFps, bitrateKbps, writtenMB,
 *           resolution, encoderMode, elapsed }
 *   { type: 'STATS', ..., final: true, totalEncodedMB, totalWrittenMB }
 *   { type: 'RECORD_WRITE_COMPLETE', filename }
 *   { type: 'ENCODE_ERROR', error }
 */

// Load the WebM muxer from a sibling file.
// self.location.href = chrome-extension://ID/js/record/worker.js
// → muxerUrl         = chrome-extension://ID/js/record/muxer.js
// importScripts() resolves relative to the worker's origin, so same-extension URLs work.
importScripts(self.location.href.replace(/worker\.js(\?.*)?$/, 'muxer.js'));

// ---------------------------------------------------------------------------
// Encoder config presets
// ---------------------------------------------------------------------------
const CODEC_H264_HW = 'avc1.640028';   // H.264 High Profile L4.0  — GPU
const CODEC_H264_SW = 'avc1.42E01E';   // H.264 Baseline L3.0      — software
const CODEC_VP9 = 'vp09.00.10.08'; // VP9 Profile 0             — last resort

const TARGET_BITRATE = 5 * 1024 * 1024; // 5 Mbps
const KEYFRAME_INTERVAL = 60;              // keyframe every 2 s @ 30 fps

// Audio encoder constants
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = 128 * 1024; // 128 kbps Opus

// Quality → max resolution (null = no scaling)
const QUALITY_MAX = {
  'UHD': null,
  '1080P': { width: 1920, height: 1080 },
  '720P': { width: 1280, height: 720 },
};

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------
let encoder = null;
let audioEncoder = null;
let muxer = null;
let writable = null;
let outputName = '';

// Sentinel flag: non-null when downscaling is needed (set to true in handleInit)
let offscreenCanvas = null; // used as boolean — createImageBitmap handles actual scaling
let encodeWidth = 0;
let encodeHeight = 0;

let encoderMode = 'unknown';
let activeCodec = '';
let activeRes = '';

let frameCount = 0;
let encodedCount = 0;
let keyframeCount = 0;
let totalEncodedBytes = 0;
let totalWrittenBytes = 0; // tracks flushed + queued bytes written to disk
let audioEncodedCount = 0;
let audioFrameCount = 0;
let hasAudio = false;

// Buffer backpressure state
let pendingVideoBytes = 0; // bytes queued but not yet written (video)
let pendingAudioBytes = 0; // bytes queued but not yet written (audio)
let bitrateReduced = false;
let currentEncoderConfig = null;
const BUFFER_THRESHOLD = 50 * 1024 * 1024; // 50 MB — reduce bitrate above this
const BUFFER_RECOVER = 25 * 1024 * 1024; // 25 MB — restore bitrate below this

let startTime = null;
let lastWindowTime = null;
let windowFrames = 0;
let firstTimestamp = null; // first raw timestamp in microseconds
let lastFrameTimestampUs = null; // monotonic guard — last timestamp sent to encoder

// ---------------------------------------------------------------------------
// Async muxer write queue
//
// VideoEncoder's `output` callback is synchronous, but VibeMuxer.addChunk()
// is async (disk I/O). We serialise all writes by chaining Promises:
//
//   muxerChain = muxerChain.then(() => muxer.addChunk(chunk, meta));
//
// This guarantees write order and lets us await all outstanding writes
// at stop time with a single `await muxerChain`.
// ---------------------------------------------------------------------------
let muxerChain = Promise.resolve();
// NOTE: audio writes are merged INTO muxerChain (not a separate chain) to guarantee
// all audio SimpleBlocks are written after the WebM header — see handleEncodedAudio.

// Serialised async frame-processing chain — ensures createImageBitmap GPU readback
// completes before VideoFrame is constructed and encode order is preserved.
let frameProcessingChain = Promise.resolve();

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
self.onmessage = async function (e) {
  const { type } = e.data;
  if (type === 'INIT') { await handleInit(e.data); return; }
  if (type === 'FRAME') { handleFrame(e.data); return; }
  if (type === 'AUDIO_FRAME') { handleAudioFrame(e.data); return; }
  if (type === 'STOP') { await handleStop(); return; }
};

// ---------------------------------------------------------------------------
// INIT — probe hardware, configure encoder, open muxer + file
// ---------------------------------------------------------------------------
async function handleInit({ width, height, writable: _writable, filename, quality, hasAudio: _hasAudio, isAudioOnly = false, sampleRate: _sr, channels: _ch }) {
  const sampleRate = _sr || AUDIO_SAMPLE_RATE;
  const channels = _ch || AUDIO_CHANNELS;

  outputName = filename || 'recording.webm';
  hasAudio = !!_hasAudio;
  writable = _writable;

  // Phase 8: audio-only mode — skip VideoEncoder entirely, only init AudioEncoder + muxer.
  if (isAudioOnly) {
    encoderMode = 'audio';
    activeCodec = 'opus';
    activeRes = 'audio-only';
    encodeWidth = 0;
    encodeHeight = 0;

    if (hasAudio && typeof AudioEncoder !== 'undefined') {
      try {
        const audioConfig = { codec: 'opus', sampleRate, numberOfChannels: channels, bitrate: AUDIO_BITRATE };
        const audioSupport = await AudioEncoder.isConfigSupported(audioConfig);
        if (audioSupport.supported) {
          audioEncoder = new AudioEncoder({
            output: handleEncodedAudio,
            error: (err) => self.postMessage({ type: 'ENCODE_ERROR', error: `Audio: ${err.message}` }),
          });
          audioEncoder.configure(audioConfig);
        } else {
          self.postMessage({ type: 'ENCODE_ERROR', error: 'AudioEncoder not supported for audio-only recording' });
          return;
        }
      } catch (err) {
        self.postMessage({ type: 'ENCODE_ERROR', error: `Audio init failed: ${err.message}` });
        return;
      }
    }

    try {
      // Phase 9: writable is now passed directly from offscreen.js
      muxer = new VibeMuxer(writable, {
        isAudioOnly: true,
        sampleRate,
        channels,
      });
    } catch (err) {
      self.postMessage({ type: 'ENCODE_ERROR', error: `Cannot initialized Muxer: ${err.message}` });
      return;
    }

    self.postMessage({ type: 'ENCODER_READY', mode: 'audio', codec: 'opus' });
    return;
  }

  // --- Standard video+audio mode ---
  // Determine encode resolution based on quality tier
  const maxRes = QUALITY_MAX[quality] || null;
  if (maxRes && (width > maxRes.width || height > maxRes.height)) {
    const ratio = Math.min(maxRes.width / width, maxRes.height / height);
    encodeWidth = Math.round(width * ratio / 2) * 2; // keep even for codec
    encodeHeight = Math.round(height * ratio / 2) * 2;
    offscreenCanvas = true; // flag: createImageBitmap downscaling required
  } else {
    encodeWidth = width;
    encodeHeight = height;
  }

  // 'realtime' emits frames immediately — essential for live recording.
  // 'quality' mode buffers frames for seconds (B-frame look-ahead) which causes
  // frozen video playback and drops all audio before the first cluster opens.
  const baseConfig = { width: encodeWidth, height: encodeHeight, latencyMode: 'realtime', bitrate: TARGET_BITRATE };

  const candidates = [
    { codec: CODEC_H264_HW, hardwareAcceleration: 'prefer-hardware', label: 'HW' },
    { codec: CODEC_H264_SW, hardwareAcceleration: 'prefer-software', label: 'SW' },
    { codec: CODEC_VP9, hardwareAcceleration: 'prefer-software', label: 'SW' },
  ];

  let chosenConfig = null;
  let chosenLabel = 'SW';

  for (const c of candidates) {
    const cfg = { ...baseConfig, codec: c.codec, hardwareAcceleration: c.hardwareAcceleration };
    try {
      const result = await VideoEncoder.isConfigSupported(cfg);
      if (result.supported) { chosenConfig = cfg; chosenLabel = c.label; break; }
    } catch (_) { /* unknown codec string — try next */ }
  }

  if (!chosenConfig) {
    self.postMessage({ type: 'ENCODE_ERROR', error: 'No supported VideoEncoder codec on this device' });
    return;
  }

  encoderMode = chosenLabel;
  activeCodec = chosenConfig.codec;
  activeRes = `${encodeWidth}x${encodeHeight}`;

  // Open the video encoder
  encoder = new VideoEncoder({
    output: handleEncodedChunk,
    error: (err) => self.postMessage({ type: 'ENCODE_ERROR', error: err.message }),
  });
  encoder.configure(chosenConfig);
  currentEncoderConfig = chosenConfig; // saved for bitrate reconfiguration

  // Open the audio encoder (Opus) if the stream has audio
  if (hasAudio && typeof AudioEncoder !== 'undefined') {
    try {
      const audioConfig = {
        codec: 'opus',
        sampleRate,
        numberOfChannels: channels,
        bitrate: AUDIO_BITRATE,
      };
      const audioSupport = await AudioEncoder.isConfigSupported(audioConfig);
      if (audioSupport.supported) {
        audioEncoder = new AudioEncoder({
          output: handleEncodedAudio,
          error: (err) => self.postMessage({ type: 'ENCODE_ERROR', error: `Audio: ${err.message}` }),
        });
        audioEncoder.configure(audioConfig);
      } else {
        hasAudio = false; // fall back to video-only
      }
    } catch (_) {
      hasAudio = false;
    }
  } else {
    hasAudio = false;
  }

  // Open the writable stream (transferred from offscreen) and create the muxer
  try {
    muxer = new VibeMuxer(writable, {
      width: encodeWidth,
      height: encodeHeight,
      codec: activeCodec,
      ...(hasAudio ? { sampleRate, channels } : {}),
    });
  } catch (err) {
    self.postMessage({ type: 'ENCODE_ERROR', error: `Cannot initialized Muxer: ${err.message}` });
    return;
  }

  self.postMessage({ type: 'ENCODER_READY', mode: encoderMode, codec: activeCodec });
}

// ---------------------------------------------------------------------------
// Encoder output callback (synchronous) — with buffer backpressure monitoring
//
// Each EncodedVideoChunk is appended to the muxerChain as an async task.
// pendingVideoBytes tracks bytes queued but not yet confirmed written to disk.
// If the queue exceeds BUFFER_THRESHOLD (50 MB) the encoder is reconfigured at
// half bitrate; it is restored once the queue drains below BUFFER_RECOVER (25 MB).
// ---------------------------------------------------------------------------
function handleEncodedChunk(chunk, metadata) {
  encodedCount++;
  totalEncodedBytes += chunk.byteLength;
  if (chunk.type === 'key') keyframeCount++;

  // Normalise timestamps so the WebM file always starts at t=0.
  // chunk.timestamp is read-only on EncodedVideoChunk, so we compute the
  // offset here (synchronously, before the async chain runs) and pass it as
  // overrideTimestampUs to the muxer instead of mutating the chunk.
  if (firstTimestamp === null) firstTimestamp = chunk.timestamp;
  const normalizedTsUs = chunk.timestamp - firstTimestamp;

  const chunkBytes = chunk.byteLength;
  pendingVideoBytes += chunkBytes;

  muxerChain = muxerChain.then(async () => {
    await muxer.addChunk(chunk, metadata, normalizedTsUs);
    totalWrittenBytes += chunkBytes;
    pendingVideoBytes -= chunkBytes;

    // Restore bitrate once I/O has caught up
    if (bitrateReduced && (pendingVideoBytes + pendingAudioBytes) < BUFFER_RECOVER) {
      bitrateReduced = false;
      if (encoder && encoder.state === 'configured' && currentEncoderConfig) {
        encoder.configure({ ...currentEncoderConfig, bitrate: TARGET_BITRATE });
      }
    }
  }).catch((err) => {
    pendingVideoBytes -= chunkBytes;
    self.postMessage({ type: 'ENCODE_ERROR', error: `Muxer write error: ${err.message}` });
  });

  // Detect I/O backpressure — reduce bitrate to relieve the queue
  if (!bitrateReduced && (pendingVideoBytes + pendingAudioBytes) > BUFFER_THRESHOLD) {
    bitrateReduced = true;
    if (encoder && encoder.state === 'configured' && currentEncoderConfig) {
      encoder.configure({ ...currentEncoderConfig, bitrate: Math.round(TARGET_BITRATE / 2) });
    }
  }
}

// ---------------------------------------------------------------------------
// Audio encoder output callback (synchronous)
//
// Audio writes are chained onto muxerChain (not a separate chain) so they
// are always interleaved with video writes in arrival order.  This guarantees
// the WebM header / first Cluster is written before any audio SimpleBlock,
// preventing the addAudioChunk guard from silently dropping all audio.
// ---------------------------------------------------------------------------
function handleEncodedAudio(chunk) {
  audioEncodedCount++;

  // Same timestamp normalisation as video: EncodedAudioChunk.timestamp is
  // read-only, so compute the normalised value and pass as overrideTimestampUs.
  if (firstTimestamp === null) firstTimestamp = chunk.timestamp;
  const normalizedTsUs = chunk.timestamp - firstTimestamp;

  const chunkBytes = chunk.byteLength;
  pendingAudioBytes += chunkBytes;
  muxerChain = muxerChain.then(async () => {
    await muxer.addAudioChunk(chunk, normalizedTsUs);
    pendingAudioBytes -= chunkBytes;
  }).catch((err) => {
    pendingAudioBytes -= chunkBytes;
    self.postMessage({ type: 'ENCODE_ERROR', error: `Audio mux error: ${err.message}` });
  });
}

// ---------------------------------------------------------------------------
// AUDIO_FRAME — encode one AudioData from the capture stream
// ---------------------------------------------------------------------------
function handleAudioFrame({ frame }) {
  if (!audioEncoder || audioEncoder.state !== 'configured') {
    frame.close();
    return;
  }

  const now = performance.now();
  if (!startTime) { startTime = now; lastWindowTime = now; }

  // Pass the raw AudioData directly — timestamp normalisation happens in
  // handleEncodedAudio (the encoder output callback) via overrideTimestampUs,
  // because EncodedAudioChunk.timestamp is read-only and AudioData.timestamp
  // cannot be changed without copying all PCM data into a new buffer.
  audioEncoder.encode(frame);
  frame.close();

  audioFrameCount++;

  // In audio-only mode, handleFrame is never called, so we must emit stats here.
  // Audio frames arrive in much smaller buffers (often 10ms-20ms chunks ≈ 50-100 fps)
  if (encoderMode === 'audio' && (audioFrameCount % 50 === 0)) {
    emitStats(false);
  }
}

// ---------------------------------------------------------------------------
// FRAME — encode one VideoFrame
//
// When downscaling is required, createImageBitmap() is used instead of
// OffscreenCanvas.drawImage() + new VideoFrame(canvas).  GPU-backed
// VideoFrames may not have completed their GPU→CPU readback when drawImage
// returns, so reading the canvas immediately can yield stale pixels (all
// frames look identical → frozen video).  createImageBitmap handles the
// async readback internally and resolves only when pixel data is ready.
//
// To preserve encode order the async path is serialised through
// frameProcessingChain — each frame waits for the previous bitmap decode
// before being passed to the encoder.
// ---------------------------------------------------------------------------
function handleFrame({ frame }) {
  if (!encoder || encoder.state !== 'configured') {
    frame.close();
    return;
  }

  const now = performance.now();
  if (!startTime) { startTime = now; lastWindowTime = now; }

  frameCount++;
  windowFrames++;

  const forceKeyFrame = (frameCount % KEYFRAME_INTERVAL === 1);

  // Monotonic timestamp guard: VideoEncoder requires strictly non-decreasing
  // timestamps. Under heavy GPU load (especially UHD) the capture pipeline can
  // deliver frames with equal or slightly regressed timestamps.  Clamp any
  // non-advancing frame to lastFrameTimestampUs + 1 µs so the encoder never
  // sees a timestamp that goes backward.
  let ts = frame.timestamp;
  if (lastFrameTimestampUs !== null && ts <= lastFrameTimestampUs) {
    ts = lastFrameTimestampUs + 1;
  }
  lastFrameTimestampUs = ts;

  if (offscreenCanvas) {
    // Capture corrected timestamp before transferring frame to async chain.
    frameProcessingChain = frameProcessingChain.then(() =>
      createImageBitmap(frame, { resizeWidth: encodeWidth, resizeHeight: encodeHeight, resizeQuality: 'medium' })
    ).then((bitmap) => {
      frame.close();
      const scaledFrame = new VideoFrame(bitmap, { timestamp: ts });
      bitmap.close();
      if (encoder && encoder.state === 'configured') {
        encoder.encode(scaledFrame, { keyFrame: forceKeyFrame });
      }
      scaledFrame.close();
    }).catch((err) => {
      frame.close();
      self.postMessage({ type: 'ENCODE_ERROR', error: `Frame scale error: ${err.message}` });
    });
  } else {
    // UHD path: re-wrap with corrected timestamp (VideoFrame.timestamp is read-only).
    const correctedFrame = (ts === frame.timestamp)
      ? frame
      : new VideoFrame(frame, { timestamp: ts });
    encoder.encode(correctedFrame, { keyFrame: forceKeyFrame });
    correctedFrame.close();
    if (correctedFrame !== frame) frame.close();
  }

  if (frameCount % 30 === 0) emitStats(false);
}

// ---------------------------------------------------------------------------
// STOP — flush encoder → drain muxer chain → finalise file → signal done
// ---------------------------------------------------------------------------
async function handleStop() {
  // 1. Drain pending async frame-scaling tasks so all frames reach the encoder
  await frameProcessingChain;

  // 2. Flush video encoder: resolves only after all remaining output callbacks fire
  if (encoder && encoder.state === 'configured') {
    await encoder.flush();
    encoder.close();
    encoder = null;
  }

  // 3. Flush audio encoder
  if (audioEncoder && audioEncoder.state === 'configured') {
    await audioEncoder.flush();
    audioEncoder.close();
    audioEncoder = null;
  }

  // 4. Drain the unified write queue (video + audio merged into muxerChain)
  await muxerChain;

  // 5. Finalise: close the WritableFileStream (writes OS buffer → disk)
  if (muxer) {
    await muxer.finalize();
    muxer = null;
  }

  // 6. Emit final stats
  emitStats(true);

  // 7. Signal offscreen: file is closed and safe to use
  self.postMessage({ type: 'RECORD_WRITE_COMPLETE', filename: outputName });
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
function emitStats(final) {
  const now = performance.now();
  const elapsed = startTime ? (now - startTime) / 1000 : 0;

  const windowElapsed = lastWindowTime ? (now - lastWindowTime) / 1000 : 0;
  const instantFps = (!final && windowElapsed > 0)
    ? (windowFrames / windowElapsed).toFixed(1)
    : '0.0';

  lastWindowTime = now;
  windowFrames = 0;

  const bitrateKbps = elapsed > 0
    ? ((totalEncodedBytes * 8) / elapsed / 1000).toFixed(0)
    : '0';

  const writtenMB = (totalWrittenBytes / 1024 / 1024).toFixed(2);
  const pendingMB = ((pendingVideoBytes + pendingAudioBytes) / 1024 / 1024).toFixed(2);

  const msg = {
    type: 'STATS',
    frameCount,
    encodedCount,
    keyframeCount,
    avgFps: elapsed > 0 ? (frameCount / elapsed).toFixed(1) : '0.0',
    instantFps,
    bitrateKbps,
    writtenMB,
    resolution: activeRes,
    encoderMode,
    codec: activeCodec,
    elapsed: elapsed.toFixed(1),
    hasAudio,
    audioEncodedCount,
    pendingMB,
    bitrateReduced,
    // Add debug info
    headerWritten: muxer ? !!muxer._headerWritten : false,
    vChainLen: frameCount - encodedCount,
    aEncoderState: audioEncoder ? audioEncoder.state : 'none',
    vEncoderState: encoder ? encoder.state : 'none',
    final,
  };

  if (final) {
    msg.totalEncodedMB = (totalEncodedBytes / 1024 / 1024).toFixed(2);
    msg.totalWrittenMB = writtenMB;
  }

  self.postMessage(msg);
}
