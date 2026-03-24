/**
 * RecordStorage — IndexedDB data-access layer for vibeRecordDB.
 *
 * All recording-related IDB operations are consolidated here so that
 * record/offscreen.js, offscreen/main.js, and popup/main.js share a single
 * consistent interface and never duplicate the open/upgrade boilerplate.
 *
 * Database: vibeRecordDB  (version 2)
 * Object stores:
 *   'chunks'  — sequential WebM segment buffers written during recording.
 *               Keys are numeric indices (0, 1, 2, …).
 *   'handles' — named key-value pairs:
 *                 'remuxInputBlob'    — consolidated WebM ArrayBuffer
 *                 'remuxOutputBuffer' — FFmpeg output (MP4/MP3) ArrayBuffer
 *                 'currentFileHandle' — FileSystemFileHandle for final disk write
 */

const DB_NAME    = 'vibeRecordDB';
const DB_VERSION = 2;

const STORE = {
  chunks:  'chunks',
  handles: 'handles',
};

const KEY = {
  remuxInput:  'remuxInputBlob',
  remuxOutput: 'remuxOutputBuffer',
  fileHandle:  'currentFileHandle',
};

// ---------------------------------------------------------------------------
// Internal: open (or reuse) the database connection
// ---------------------------------------------------------------------------

/** Open vibeRecordDB and ensure both object stores exist. */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE.chunks))  db.createObjectStore(STORE.chunks);
      if (!db.objectStoreNames.contains(STORE.handles)) db.createObjectStore(STORE.handles);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = ()  => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Chunk streaming — used during active recording
// ---------------------------------------------------------------------------

/**
 * Returns a WritableStream whose sink writes each chunk into the 'chunks'
 * store with a sequential numeric key.  The DB connection is opened once on
 * the first write and reused for the entire recording session.
 *
 * The returned stream is transferred to the Record Worker via postMessage so
 * that VibeMuxer can write encoded data directly without any memory copy.
 */
function createChunkWritableStream() {
  let chunkIdx = 0;
  let _db = null;

  async function getDB() {
    if (!_db) _db = await openDB();
    return _db;
  }

  return new WritableStream({
    async write(chunk) {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE.chunks, 'readwrite');
        tx.objectStore(STORE.chunks).put(chunk, chunkIdx++);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
      });
    },
    close() { if (_db) { _db.close(); _db = null; } },
    abort() { if (_db) { _db.close(); _db = null; } },
  });
}

// ---------------------------------------------------------------------------
// Consolidation — called once after recording stops
// ---------------------------------------------------------------------------

/**
 * Reads all chunks from the 'chunks' store in insertion order, merges them
 * into a single ArrayBuffer, and saves it under KEY.remuxInput in 'handles'.
 * This makes the recorded WebM available to the FFmpeg offscreen document.
 */
async function consolidateChunks() {
  const db = await openDB();

  const blob = await new Promise((resolve, reject) => {
    const parts = [];
    const tx = db.transaction(STORE.chunks, 'readonly');
    const cursor = tx.objectStore(STORE.chunks).openCursor();
    cursor.onsuccess = (e) => {
      const c = e.target.result;
      if (c) { parts.push(c.value); c.continue(); }
      else   { db.close(); resolve(new Blob(parts, { type: 'video/webm' })); }
    };
    cursor.onerror = () => { db.close(); reject(cursor.error); };
  });

  const buffer = await blob.arrayBuffer();
  const db2 = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db2.transaction(STORE.handles, 'readwrite');
    tx.objectStore(STORE.handles).put(buffer, KEY.remuxInput);
    tx.oncomplete = () => { db2.close(); resolve(); };
    tx.onerror    = () => { db2.close(); reject(tx.error); };
  });
}

// ---------------------------------------------------------------------------
// Remux input — read by FFmpeg offscreen
// ---------------------------------------------------------------------------

/** Read the consolidated WebM ArrayBuffer. Returns null if not found. */
async function loadRemuxInput() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE.handles, 'readonly');
    const get = tx.objectStore(STORE.handles).get(KEY.remuxInput);
    get.onsuccess = () => { db.close(); resolve(get.result ?? null); };
    get.onerror   = () => { db.close(); reject(get.error); };
  });
}

/** Delete the remux input blob (call after FFmpeg has consumed it). */
async function deleteRemuxInput() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE.handles, 'readwrite');
    tx.objectStore(STORE.handles).delete(KEY.remuxInput);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); resolve(); };
  });
}

// ---------------------------------------------------------------------------
// Remux output — written by FFmpeg offscreen, read by popup
// ---------------------------------------------------------------------------

/** Save the FFmpeg-processed ArrayBuffer (MP4 or MP3). */
async function saveRemuxOutput(buffer) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE.handles, 'readwrite');
    tx.objectStore(STORE.handles).put(buffer, KEY.remuxOutput);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/** Read the FFmpeg-processed ArrayBuffer. Returns null if not found. */
async function loadRemuxOutput() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE.handles, 'readonly');
    const get = tx.objectStore(STORE.handles).get(KEY.remuxOutput);
    get.onsuccess = () => { db.close(); resolve(get.result ?? null); };
    get.onerror   = () => { db.close(); reject(get.error); };
  });
}

/** Delete the remux output buffer (call after popup has written the file). */
async function deleteRemuxOutput() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE.handles, 'readwrite');
    tx.objectStore(STORE.handles).delete(KEY.remuxOutput);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); resolve(); };
  });
}

// ---------------------------------------------------------------------------
// File handle — written by popup before export, read back after FFmpeg done
// ---------------------------------------------------------------------------

/**
 * Save a FileSystemFileHandle so the popup can retrieve it after the
 * FFmpeg offscreen document completes processing.  IDB preserves the
 * handle's prototype chain, which is lost if passed via chrome.runtime IPC.
 */
async function saveFileHandle(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE.handles, 'readwrite');
    tx.objectStore(STORE.handles).put(handle, KEY.fileHandle);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/** Read the saved FileSystemFileHandle. Returns null if not found. */
async function loadFileHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE.handles, 'readonly');
    const get = tx.objectStore(STORE.handles).get(KEY.fileHandle);
    get.onsuccess = () => { db.close(); resolve(get.result ?? null); };
    get.onerror   = () => { db.close(); reject(get.error); };
  });
}

// ---------------------------------------------------------------------------
// Session cleanup
// ---------------------------------------------------------------------------

/**
 * Clear all chunk segments and delete the remux input blob.
 * Call before starting a new recording to ensure a clean slate.
 */
async function clearSession() {
  const db = await openDB().catch(() => null);
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction([STORE.handles, STORE.chunks], 'readwrite');
    tx.objectStore(STORE.handles).delete(KEY.remuxInput);
    tx.objectStore(STORE.chunks).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); resolve(); };
  });
}

export {
  openDB,
  createChunkWritableStream,
  consolidateChunks,
  loadRemuxInput,
  deleteRemuxInput,
  saveRemuxOutput,
  loadRemuxOutput,
  deleteRemuxOutput,
  saveFileHandle,
  loadFileHandle,
  clearSession,
};
