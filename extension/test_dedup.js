const assert = require('assert');

// Simulate state
const state = {
  tabStorage: new Map()
};

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (u.hash) { u.hash = ''; }
    const bustParams = ['bytestart', 'byteend', 'range', '_t', 'ts', 'time', 't', '_'];
    for (const param of bustParams) {
      if (u.searchParams.has(param)) { u.searchParams.delete(param); }
    }
    return u.toString();
  } catch(e) { return url; }
}

function sanitizeTitle(t) { return t || 'Unknown'; }
function detectMediaType(url) { return 'audio'; }
function extractGroupTag(url) { return null; }

async function addMedia(tabId, rawUrl, title, qualities = null, encryption = null, isSegmented = false, estimatedSize = 0) {
  const url = normalizeUrl(rawUrl);
  const urlLower = url.toLowerCase();

  const getFingerprint = (u) => {
    try {
      const urlObj = new URL(u);
      const path = urlObj.pathname.toLowerCase();
      const mediaExts = ['.mp3', '.mp4', '.wav', '.aac', '.flac', '.opus', '.webm', '.ts', '.m4a', '.m4v'];
      
      if (mediaExts.some(ext => path.endsWith(ext))) {
        return urlObj.protocol + "//" + urlObj.host + urlObj.pathname.toLowerCase();
      }
      
      urlObj.hash = '';
      const noiseParams = ['token', 'sign', 'sig', 'signature', 'timestamp', 'expire', 'expires', '_t', 'ts', 'time', 't', '_', 'auth', 'key', 'nonce', 'uuid', 'req_id', 'session_id'];
      for (const p of noiseParams) {
        urlObj.searchParams.delete(p);
      }
      return urlObj.toString().toLowerCase();
    } catch (e) { }
    return u.toLowerCase();
  };
  const fingerprint = getFingerprint(url);

  if (!state.tabStorage.has(tabId)) state.tabStorage.set(tabId, []);
  let urls = state.tabStorage.get(tabId);

  const urlObjForCheck = new URL(url);
  const existing = urls.find(item => {
    const itemLower = item.url.toLowerCase();
    
    if (itemLower === urlLower) return true;
    if (getFingerprint(itemLower) === fingerprint) return true;
    
    if (estimatedSize > 10240 && item.estimatedSize === estimatedSize) {
      try {
        const itemObj = new URL(item.url);
        if (itemObj.host === urlObjForCheck.host) {
          return true;
        }
      } catch (e) {}
    }
    
    return false;
  });

  if (existing) {
    let updated = false;
    if (estimatedSize > 0 && (!existing.estimatedSize || existing.estimatedSize === 0)) {
      existing.estimatedSize = estimatedSize;
      updated = true;
    }
    const newTabTitle = sanitizeTitle(title);
    if (newTabTitle && newTabTitle !== 'Unknown' && (!existing.tabTitle || existing.tabTitle === 'Unknown' || newTabTitle.length > existing.tabTitle.length)) {
      existing.tabTitle = newTabTitle;
      updated = true;
    }
    return;
  }

  urls.push({
    id: Date.now() + "_" + Math.floor(Math.random() * 1000000),
    url,
    timestamp: Date.now(),
    tabTitle: sanitizeTitle(title),
    qualities,
    mediaType: detectMediaType(url),
    groupTag: extractGroupTag(url),
    encryption,
    isSegmented,
    estimatedSize
  });
}

async function test() {
  state.tabStorage.clear();
  
  // Test case 1: DOM vs Network (same URL exactly)
  await addMedia(1, "https://pw.net/test.mp3", "From DOM", null, null, false, 0);
  await addMedia(1, "https://pw.net/test.mp3", "From Network", null, null, false, 12345);
  
  // Test case 2: DOM vs Network (with different noise params, mp3 extension)
  await addMedia(1, "https://pw.net/track.mp3", "From DOM", null, null, false, 0);
  await addMedia(1, "https://pw.net/track.mp3?token=XYZ", "From Network", null, null, false, 25000);
  
  // Test case 3: DOM vs Network (no extension, with noise params)
  await addMedia(1, "https://pw.net/play?id=1", "From DOM", null, null, false, 0);
  await addMedia(1, "https://pw.net/play?id=1&token=ABC", "From Network", null, null, false, 0);

  // Test case 4: Same size, different paths (should NOT merge if paths are different unless they are same host and > 10KB)
  // Wait, if they are > 10KB and same host and same size, DO THEY MERGE?!
  await addMedia(1, "https://pw.net/track_1", "Track 1", null, null, false, 50000);
  await addMedia(1, "https://pw.net/track_2", "Track 2", null, null, false, 50000);

  console.log(state.tabStorage.get(1));
}

test();
