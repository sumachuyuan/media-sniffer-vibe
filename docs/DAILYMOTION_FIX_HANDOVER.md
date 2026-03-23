# Dailymotion Download Issue - Technical Handover (v1.39.2)

## 1. Problem Description
The extension fails to successfully download/merge videos from Dailymotion (specifically `https://www.dailymotion.com/video/x9s8y2c`).
- **Symptom**: The sniffer may detect the URL, but clicking download/merge results in "Scanning failed" or a truncated MP4 file (approx. 262 bytes), which is typical for a "403 Forbidden" or "302 Redirect to Login" response from the CDN.
- **Goal**: Enable full detection and merging of Dailymotion's HLS (fMP4) streams.

## 2. Technical Obstacles
- **Iframe Isolation**: The player is typically in a cross-origin iframe (e.g., `geo.dailymotion.com`). The CDN (`*.dmcdn.net`) requires the `Referer` to be that iframe's origin.
- **Session Authentication**: The CDN uses `sec2(...)` signed tokens embedded in segment URLs (primary auth). Session cookies on `.dailymotion.com` are NOT sent to `*.dmcdn.net` (different eTLD+1); `credentials: 'include'` has no effect on the CDN.
- **Dynamic Tokens**: URLs contain `sec2(...)` tokens which are relative to the session and expire quickly.
- **fMP4 Structure**: Uses an initialization map (`init.mp4`) and `.m4s` fragments.
- **Origin Header (unfixable via DNR)**: Extension contexts always send `Origin: chrome-extension://<id>`. DNR cannot modify/remove `Origin` (restricted header). If the CDN checks `Origin` server-side, this would cause 403s. However, video CDNs typically check `Referer` (hotlink protection), not `Origin`.

## 3. Implemented Fixes (v1.37.0 - v1.39.2)

### A. Referer & Initiator Capture
In `background/main.js`, we now use `details.initiator` to capture the real source of the media request and store it as `item.referer`.
```javascript
// background/main.js
const { url, tabId, initiator } = details;
const refUrl = initiator ? `${initiator}/` : null;
// stored in MediaItem
```

### B. Session-Aware Fetching
All `fetch()` calls in the background and offscreen contexts use `credentials: 'include'`. This has limited effect on CDN requests (different eTLD+1 from `.dailymotion.com`) but is harmless.
- **Files**: `background/parser.js`, `js/offscreen/main.js`.

### C. Authenticated Parsing (GET_SEGMENTS)
The `GET_SEGMENTS` message now passes `referer` and `ua` so the background parser can authenticate against Dailymotion's variant playlists.
- **Files**: `popup/main.js`, `background/main.js`.

### D. DNR Rule Injection - Broad Domain Anchor (v1.39.2 Fix)
**Bug fixed**: The previous `urlFilter = '*://${u.host}/*'` was too narrow. It only matched the manifest's exact CDN subdomain (e.g., `nm3.dmcdn.net`), missing segments served from sibling subdomains (e.g., `nm2.dmcdn.net`).

**Fix**: Use the `||baseDomain/` DNR anchor pattern to cover ALL subdomains of the CDN domain.
```javascript
// orchestrator.js - before (v1.39.1)
condition.urlFilter = `*://${u.host}/*`;  // Only nm3.dmcdn.net

// orchestrator.js - after (v1.39.2)
const parts = u.hostname.split('.');
const baseDomain = parts.length > 2 ? parts.slice(-2).join('.') : u.hostname;
condition.urlFilter = `||${baseDomain}/`;  // Covers nm2.dmcdn.net, nm3.dmcdn.net, etc.
```

### E. DNR Rule Race Condition Fix (v1.39.2 Fix)
**Bug fixed**: `GET_SEGMENTS` scheduled `setTimeout(clearDnrRules, 2000)` after returning segment URLs. This 2-second timer fired DURING the subsequent segment download phase, removing the DNR rules mid-transfer → all segments after ~2 seconds got 403 → 262-byte output.

**Root cause timeline**:
```
T=0ms:    GET_SEGMENTS → updateDnrRulesForFetch → rule 1001 set
T=~200ms: parseHlsSegments done → sendResponse → setTimeout(clearDnrRules, 2000)
T=~250ms: Popup → START_FFMPEG_MERGE sent
T=~300ms: START_FFMPEG_MERGE → updateDnrRulesForFetch (re-sets rule 1001)
T=2200ms: ⚠️ clearDnrRules fires! Removes rule 1001 mid-download!
T=2200ms+: All segment fetches have no Referer → 403 → tiny/corrupt MP4
```

**Fix**: Changed timeout from 2000ms to 30000ms. `START_FFMPEG_MERGE` always overrides the rule anyway; the 30s is only a safety net for the "scan failed, no merge" case.

### F. Offscreen Lifecycle
Added an 8-second delay before closing the offscreen document to ensure the download manager finishes reading the `blob:`.

## 4. Current State of Relevant Code

### [background/main.js](file:///Users/huyuanlong/works/github/media-sniffer-vibe/extension/js/background/main.js)
- Captures `initiator` as `referer`.
- Stores `referer` in `tabStorage`.
- Handles `GET_SEGMENTS` with DNR rules applied (30s safety-net cleanup).

### [background/orchestrator.js](file:///Users/huyuanlong/works/github/media-sniffer-vibe/extension/js/background/orchestrator.js)
- `updateDnrRulesForFetch`: Uses `||baseDomain/` for broad CDN subdomain coverage.

### [background/parser.js](file:///Users/huyuanlong/works/github/media-sniffer-vibe/extension/js/background/parser.js)
- All `fetch` calls use `{ credentials: 'include' }`.

### [js/offscreen/main.js](file:///Users/huyuanlong/works/github/media-sniffer-vibe/extension/js/offscreen/main.js)
- All `fetch` calls (segments, keys, maps) use `{ credentials: 'include' }`.

## 5. Remaining Hypotheses (If v1.39.2 Still Fails)

1. **Origin Header Blocking**: If CDN checks `Origin: chrome-extension://...` server-side → need content script proxy. Inject content script into `geo.dailymotion.com` iframe and have it proxy segment fetches (complex, but the only reliable fix for strict Origin checks).

2. **sec2 Token Expiry**: Tokens embedded in segment URLs expire. If user waits too long after page load before clicking download, tokens are invalid. No fix possible from the extension side — user must click quickly.

3. **Multi-CDN Segments**: If segments resolve to a completely different CDN domain (not `dmcdn.net`), the `||dmcdn.net/` rule won't cover it. Check actual segment URLs in the parsed M3U8 playlist for their domain.
