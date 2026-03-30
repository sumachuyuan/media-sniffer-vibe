const assert = require('assert');

function normalizeUrl(url) {
  let u = new URL(url);
  u.hash = '';
  return u.toString();
}

function getFingerprint(u) {
  try {
    const urlObj = new URL(u);
    const path = urlObj.pathname.toLowerCase();
    const mediaExts = ['.mp3', '.mp4', '.wav', '.aac', '.flac', '.opus', '.webm', '.ts', '.m4a', '.m4v'];
    
    if (mediaExts.some(ext => path.endsWith(ext))) {
      return urlObj.protocol + "//" + urlObj.host + urlObj.pathname.toLowerCase();
    }
    
    urlObj.hash = '';
    const noiseParams = ['token', 'sign', 'sig', 'signature', 'timestamp', 'expire', 'expires', '_t', 'ts', 'time', 't', '_', 'auth', 'key', 'nonce', 'uuid'];
    for (const p of noiseParams) {
      urlObj.searchParams.delete(p);
    }
    return urlObj.toString().toLowerCase();
  } catch (e) { }
  return u.toLowerCase();
}

let original_url1 = "https://pw.net/1.mp3?token=ABC";
let original_url2 = "https://pw.net/1.mp3?token=DEF";

let u1 = normalizeUrl(original_url1);
let u2 = normalizeUrl(original_url2);
console.log(getFingerprint(u1));
console.log(getFingerprint(u2));

