/**
 * VibeMuxer — Minimal Streaming WebM Muxer
 *
 * Produces a crash-resilient WebM file by writing every Cluster immediately
 * to disk via the FileSystem Access API WritableFileStream. Both the Segment
 * and every Cluster use "unknown size" EBML encoding, which means VLC and
 * other modern players can play a file that was never properly "closed".
 *
 * Design constraints:
 *  - Classic script (no ES module) — loaded via importScripts() inside the Worker
 *  - No external dependencies
 *  - Supports H.264 (V_MPEG4/ISO/AVC) and VP9 (V_VP9) video tracks
 *  - Lazy header write: EBML + Segment + SegmentInfo + Tracks are written only
 *    after the FIRST keyframe arrives, so we can embed the CodecPrivate (AVCC
 *    box for H.264) that WebCodecs supplies in EncodedVideoChunkMetadata
 *  - New Cluster starts on every keyframe or after ~1 s, whichever comes first
 *
 * Usage (inside Worker):
 *   const muxer = new VibeMuxer(writableFileStream, { width, height, codec });
 *   muxer.addChunk(chunk, metadata);   // async, returns Promise
 *   await muxer.finalize();            // flush + close stream
 *
 * Loaded by worker.js via:
 *   importScripts(self.location.href.replace(/worker\.js$/, 'muxer.js'));
 */

(function (global) {
  'use strict';

  // -------------------------------------------------------------------------
  // Low-level EBML encoding helpers
  // -------------------------------------------------------------------------

  /** Concatenate multiple Uint8Arrays into one. */
  function concat(...arrays) {
    const total = arrays.reduce((n, a) => n + a.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) { out.set(a, offset); offset += a.byteLength; }
    return out;
  }

  /** Encode an unsigned integer into `byteLen` big-endian bytes. */
  function uint(n, byteLen) {
    const b = new Uint8Array(byteLen);
    for (let i = byteLen - 1; i >= 0; i--) { b[i] = n & 0xFF; n = Math.floor(n / 256); }
    return b;
  }

  /** Encode `n` as an EBML Variable-size Integer (VINT) for element sizes. */
  function vint(n) {
    if (n < 0x7F)       return new Uint8Array([n | 0x80]);
    if (n < 0x3FFF)     return new Uint8Array([(n >> 8) | 0x40, n & 0xFF]);
    if (n < 0x1FFFFF)   return new Uint8Array([(n >> 16) | 0x20, (n >> 8) & 0xFF, n & 0xFF]);
    if (n < 0x0FFFFFFF) return new Uint8Array([(n >> 24) | 0x10, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF]);
    throw new RangeError(`VINT overflow: ${n}`);
  }

  /** 8-byte "unknown size" marker used for streaming Segment and Cluster elements. */
  const UNKNOWN_SIZE = new Uint8Array([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);

  /** Wrap data with an EBML element: raw ID bytes + VINT(size) + data. */
  function el(id, data) {
    return concat(new Uint8Array(id), vint(data.byteLength), data);
  }

  /** Open an EBML container element with unknown size (for streaming containers). */
  function elOpen(id) {
    return concat(new Uint8Array(id), UNKNOWN_SIZE);
  }

  const enc = new TextEncoder();
  const str = (s) => enc.encode(s);

  /** Encode a 64-bit IEEE 754 double in big-endian (used for SamplingFrequency). */
  function float64(n) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, n, false);
    return new Uint8Array(buf);
  }

  // -------------------------------------------------------------------------
  // Random UID (8 bytes) for TrackUID
  // -------------------------------------------------------------------------
  function randomUID() {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    return b;
  }

  // -------------------------------------------------------------------------
  // EBML element ID constants
  // -------------------------------------------------------------------------
  // IDs are raw byte arrays passed directly to el() / elOpen().
  const ID = {
    EBML:             [0x1A, 0x45, 0xDF, 0xA3],
    EBMLVersion:      [0x42, 0x86],
    EBMLReadVersion:  [0x42, 0xF7],
    EBMLMaxIDLen:     [0x42, 0xF2],
    EBMLMaxSizeLen:   [0x42, 0xF3],
    DocType:          [0x42, 0x82],
    DocTypeVersion:   [0x42, 0x87],
    DocTypeReadVersion:[0x42, 0x85],

    Segment:          [0x18, 0x53, 0x80, 0x67],

    SegmentInfo:      [0x15, 0x49, 0xA9, 0x66],
    TimestampScale:   [0x2A, 0xD7, 0xB1],
    MuxingApp:        [0x4D, 0x80],
    WritingApp:       [0x57, 0x41],

    Tracks:           [0x16, 0x54, 0xAE, 0x6B],
    TrackEntry:       [0xAE],
    TrackNumber:      [0xD7],
    TrackUID:         [0x73, 0xC5],
    TrackType:        [0x83],
    CodecID:          [0x86],
    CodecPrivate:     [0x63, 0xA2],
    Video:            [0xE0],
    PixelWidth:       [0xB0],
    PixelHeight:      [0xBA],

    Cluster:          [0x1F, 0x43, 0xB6, 0x75],
    Timestamp:        [0xE7],
    SimpleBlock:      [0xA3],

    // Audio track elements
    Audio:            [0xE1],
    SamplingFrequency:[0xB5],
    Channels:         [0x9F],
  };

  // -------------------------------------------------------------------------
  // Static section builders
  // -------------------------------------------------------------------------

  function buildEBMLHeader() {
    return el(ID.EBML, concat(
      el(ID.EBMLVersion,       new Uint8Array([1])),
      el(ID.EBMLReadVersion,   new Uint8Array([1])),
      el(ID.EBMLMaxIDLen,      new Uint8Array([4])),
      el(ID.EBMLMaxSizeLen,    new Uint8Array([8])),
      el(ID.DocType,           str('webm')),
      el(ID.DocTypeVersion,    new Uint8Array([4])),
      el(ID.DocTypeReadVersion,new Uint8Array([2])),
    ));
  }

  function buildSegmentInfo() {
    // TimestampScale = 1,000,000 → timestamps in the file are in milliseconds
    return el(ID.SegmentInfo, concat(
      el(ID.TimestampScale, uint(1_000_000, 4)),
      el(ID.MuxingApp,      str('VibeMuxer/1.0')),
      el(ID.WritingApp,     str('MediaSnifferVibe')),
    ));
  }

  function buildTracks(codec, width, height, codecPrivate, audioOpts, isAudioOnly) {
    // -----------------------------------------------------------------------
    // Phase 8: Audio-only track configuration.
    // In this mode, we emit a single A_OPUS track as Track 1.
    // -----------------------------------------------------------------------
    if (isAudioOnly && audioOpts) {
      const opusHead = buildOpusHead(audioOpts.sampleRate, audioOpts.channels);
      const audioBox = el(ID.Audio, concat(
        el(ID.SamplingFrequency, float64(audioOpts.sampleRate)),
        el(ID.Channels,          new Uint8Array([audioOpts.channels])),
      ));
      const audioTrackBody = concat(
        el(ID.TrackNumber,  new Uint8Array([1])),
        el(ID.TrackUID,     randomUID()),
        el(ID.TrackType,    new Uint8Array([2])), // 2 = audio
        el(ID.CodecID,      str('A_OPUS')),
        el(ID.CodecPrivate, opusHead),
        audioBox,
      );
      return el(ID.Tracks, el(ID.TrackEntry, audioTrackBody));
    }

    // Standard video + optional audio configuration
    const codecIdStr = codec.startsWith('avc') ? 'V_MPEG4/ISO/AVC' : 'V_VP9';

    const videoBox = el(ID.Video, concat(
      el(ID.PixelWidth,  uint(width,  2)),
      el(ID.PixelHeight, uint(height, 2)),
    ));

    let trackBody = concat(
      el(ID.TrackNumber, new Uint8Array([1])),
      el(ID.TrackUID,    randomUID()),
      el(ID.TrackType,   new Uint8Array([1])),  // 1 = video
      el(ID.CodecID,     str(codecIdStr)),
      videoBox,
    );

    // CodecPrivate carries the AVCC box (AVCDecoderConfigurationRecord) for H.264.
    // VP9 does not require it. Include only when present.
    if (codecPrivate && codecPrivate.byteLength > 0) {
      trackBody = concat(trackBody, el(ID.CodecPrivate, new Uint8Array(codecPrivate)));
    }

    const videoTrackEntry = el(ID.TrackEntry, trackBody);

    if (!audioOpts) {
      return el(ID.Tracks, videoTrackEntry);
    }

    // Audio track (track number 2, A_OPUS)
    const opusHead = buildOpusHead(audioOpts.sampleRate, audioOpts.channels);
    const audioBox = el(ID.Audio, concat(
      el(ID.SamplingFrequency, float64(audioOpts.sampleRate)),
      el(ID.Channels,          new Uint8Array([audioOpts.channels])),
    ));
    const audioTrackBody = concat(
      el(ID.TrackNumber,  new Uint8Array([2])),
      el(ID.TrackUID,     randomUID()),
      el(ID.TrackType,    new Uint8Array([2])),  // 2 = audio
      el(ID.CodecID,      str('A_OPUS')),
      el(ID.CodecPrivate, opusHead),
      audioBox,
    );

    return el(ID.Tracks, concat(videoTrackEntry, el(ID.TrackEntry, audioTrackBody)));
  }

  /**
   * Builds the OpusHead binary structure required as CodecPrivate for A_OPUS tracks.
   * Spec: https://wiki.xiph.org/OggOpus#ID_Header
   */
  function buildOpusHead(sampleRate, channels) {
    const buf = new Uint8Array(19);
    // Magic signature "OpusHead"
    buf[0] = 0x4F; buf[1] = 0x70; buf[2] = 0x75; buf[3] = 0x73;
    buf[4] = 0x48; buf[5] = 0x65; buf[6] = 0x61; buf[7] = 0x64;
    buf[8]  = 1;           // Version
    buf[9]  = channels;    // Channel count
    buf[10] = 0x38; buf[11] = 0x01; // Pre-skip: 312 (uint16 LE) — standard for 48 kHz
    // Input sample rate (uint32 LE)
    buf[12] = (sampleRate)        & 0xFF;
    buf[13] = (sampleRate >> 8)   & 0xFF;
    buf[14] = (sampleRate >> 16)  & 0xFF;
    buf[15] = (sampleRate >> 24)  & 0xFF;
    buf[16] = 0; buf[17] = 0; // Output gain (int16 LE) = 0
    buf[18] = 0;               // Channel mapping family: 0 = mono/stereo
    return buf;
  }

  // -------------------------------------------------------------------------
  // SimpleBlock builder
  // -------------------------------------------------------------------------

  /**
   * @param {EncodedVideoChunk} chunk
   * @param {number} clusterTimestampMs
   * @param {number|undefined} overrideTimestampUs  If provided, used instead of chunk.timestamp
   */
  function buildSimpleBlock(chunk, clusterTimestampMs, overrideTimestampUs) {
    const chunkTimeMs  = overrideTimestampUs !== undefined
      ? Math.round(overrideTimestampUs / 1000)    // override already in µs → ms
      : Math.round(chunk.timestamp / 1000);        // chunk.timestamp is µs → ms
    const relativeTs   = Math.max(0, chunkTimeMs - clusterTimestampMs);
    const clampedRelTs = Math.min(relativeTs, 32767); // int16 max

    const flags = chunk.type === 'key' ? 0x80 : 0x00;

    const blockHeader = concat(
      new Uint8Array([0x81]),               // track number 1 as VINT
      uint(clampedRelTs, 2),               // relative timestamp (big-endian int16)
      new Uint8Array([flags]),
    );

    const frameBytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(frameBytes);

    return el(ID.SimpleBlock, concat(blockHeader, frameBytes));
  }

  // =========================================================================
  // VibeMuxer — public class
  // =========================================================================

  class VibeMuxer {
    /**
     * @param {WritableStream|FileSystemWritableFileStream} writable
     * @param {{ width: number, height: number, codec: string, sampleRate?: number, channels?: number, isAudioOnly?: boolean }} options
     */
    constructor(writable, { width, height, codec, sampleRate, channels, isAudioOnly = false }) {
      this._writable      = writable;
      this._width         = width;
      this._height        = height;
      this._codec         = codec;
      this._audioOpts     = (sampleRate && channels) ? { sampleRate, channels } : null;
      this._isAudioOnly   = isAudioOnly;

      this._headerWritten    = false;
      this._pendingChunks    = [];   // video chunks buffered before first keyframe
      this._clusterTimeMs    = -1;   // current cluster's start timestamp (ms)
      this._CLUSTER_DURATION = 1000; // open a new cluster at most every 1000 ms

      // Acquire a persistent WritableStreamDefaultWriter for standard WritableStreams
      // (transferred IDB adapter). FileSystemWritableFileStream exposes .write()
      // directly on the object itself, so it does not need a writer.
      this._writer = (typeof writable.write === 'function') ? null : writable.getWriter();
    }

    /**
     * Feed one EncodedVideoChunk to the muxer.
     * Must be awaited to maintain write ordering.
     *
     * @param {EncodedVideoChunk} chunk
     * @param {EncodedVideoChunkMetadata|undefined} metadata
     * @param {number|undefined} overrideTimestampUs
     *   Normalised timestamp in µs (chunk.timestamp − firstTimestamp).
     *   When provided, this value is used for all WebM timing instead of
     *   chunk.timestamp, guaranteeing the file starts at t=0 regardless of
     *   what the system clock was when the encoder emitted the first chunk.
     */
    async addChunk(chunk, metadata, overrideTimestampUs) {
      if (!this._headerWritten) {
        if (chunk.type !== 'key') {
          // Must not write a delta frame before the header is ready.
          // In practice this won't happen because the encoder always starts with
          // a keyframe, but guard defensively.
          this._pendingChunks.push({ chunk, metadata, overrideTimestampUs });
          return;
        }

        // First keyframe — extract CodecPrivate (AVCC box) from WebCodecs metadata
        const codecPrivate = metadata?.decoderConfig?.description ?? null;
        await this._writeHeader(codecPrivate);
        this._headerWritten = true;

        // Drain any buffered pre-keyframe chunks (edge case)
        for (const p of this._pendingChunks) {
          await this._writeBlock(p.chunk, p.overrideTimestampUs);
        }
        this._pendingChunks = [];
      }

      await this._writeBlock(chunk, overrideTimestampUs);
    }

    /**
     * Feed one EncodedAudioChunk to the muxer.
     * Drops audio that arrives before the first video cluster is open (only the first ~33ms).
     *
     * @param {EncodedAudioChunk} chunk
     * @param {number|undefined} overrideTimestampUs
     *   Normalised timestamp in µs (chunk.timestamp − firstTimestamp).
     */
    async addAudioChunk(chunk, overrideTimestampUs) {
      // -----------------------------------------------------------------------
      // Phase 8: Header handling for audio-only mode.
      // If we are in audio-only mode, the header is not written via addChunk
      // (as there is no video). We must trigger it on the first audio packet.
      // -----------------------------------------------------------------------
      if (!this._headerWritten) {
        if (!this._isAudioOnly) return; // Standard mode waits for video keyframe

        await this._writeHeader(null);
        this._headerWritten = true;
      }

      const chunkTimeMs = overrideTimestampUs !== undefined
        ? Math.round(overrideTimestampUs / 1000)
        : Math.round(chunk.timestamp / 1000);

      // Open a cluster if needed (always open on first packet)
      if (this._clusterTimeMs < 0 || (chunkTimeMs - this._clusterTimeMs) >= this._CLUSTER_DURATION) {
        this._clusterTimeMs = chunkTimeMs;
        await this._write(concat(
          elOpen(ID.Cluster),
          el(ID.Timestamp, uint(chunkTimeMs, 4)),
        ));
      }

      // In audio-only mode, track is 1; in standard mode, track is 2.
      const trackId = this._isAudioOnly ? 1 : 2;
      const blockHeader = concat(
        new Uint8Array([0x80 | trackId]),
        uint(Math.min(32767, Math.max(0, chunkTimeMs - this._clusterTimeMs)), 2),
        new Uint8Array([0x00]),
      );

      const frameBytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(frameBytes);

      await this._write(el(ID.SimpleBlock, concat(blockHeader, frameBytes)));
    }

    /** Write all static sections: EBML header + Segment (unknown size) + SegmentInfo + Tracks. */
    async _writeHeader(codecPrivate) {
      await this._write(concat(
        buildEBMLHeader(),
        elOpen(ID.Segment),
        buildSegmentInfo(),
        buildTracks(this._codec, this._width, this._height, codecPrivate, this._audioOpts, this._isAudioOnly),
      ));
    }

    /** Write a SimpleBlock, opening a new Cluster when required. */
    async _writeBlock(chunk, overrideTimestampUs) {
      const chunkTimeMs = overrideTimestampUs !== undefined
        ? Math.round(overrideTimestampUs / 1000)
        : Math.round(chunk.timestamp / 1000);

      // Open a new Cluster when:
      //   (a) no cluster has been started yet
      //   (b) a keyframe arrives (ideal seek point)
      //   (c) the current cluster exceeds CLUSTER_DURATION
      const needNewCluster =
        this._clusterTimeMs < 0 ||
        chunk.type === 'key' ||
        (chunkTimeMs - this._clusterTimeMs) >= this._CLUSTER_DURATION;

      if (needNewCluster) {
        this._clusterTimeMs = chunkTimeMs;
        // Cluster with unknown size — any crash leaves already-written clusters intact
        await this._write(concat(
          elOpen(ID.Cluster),
          el(ID.Timestamp, uint(chunkTimeMs, 4)),
        ));
      }

      await this._write(buildSimpleBlock(chunk, this._clusterTimeMs, overrideTimestampUs));
    }

    async _write(data) {
      if (this._writer) {
        await this._writer.write(data);
      } else {
        // FileSystemWritableFileStream: exposes .write() directly on the object
        await this._writable.write(data);
      }
    }

    /** Flush and close the stream. Normal exit; file is complete and seekable. */
    async finalize() {
      if (!this._headerWritten && this._isAudioOnly) {
        // Ensure header is written even for extremely short audio-only recordings
        // (stop() called before the first audio packet was encoded).
        await this._writeHeader(null);
        this._headerWritten = true;
      }
      if (this._writer) {
        await this._writer.close();
        this._writer = null;
      } else {
        await this._writable.close();
      }
    }
  }

  // Expose on global scope so importScripts callers can access it
  global.VibeMuxer = VibeMuxer;

}(self));
