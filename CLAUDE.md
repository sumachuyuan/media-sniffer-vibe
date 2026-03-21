# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Media Sniffer Vibe** is a Chrome Extension (Manifest V3) for capturing and downloading media streams (HLS/M3U8, DASH/MPD, MP4, audio) from web pages. It uses FFmpeg.wasm for in-browser segment merging with zero server dependency.

## Development Setup

**No build step required.** Load the `extension/` folder directly into Chrome:
1. Open `chrome://extensions/`
2. Enable Developer Mode
3. Click "Load unpacked" → select the `extension/` directory

After editing any file, click the reload button on the extension card in `chrome://extensions/`. For service worker changes, also click "Service Worker" link to see logs.

## Releasing

Releases are automated via GitHub Actions (`.github/workflows/auto-release.yml`). Bump the version in `extension/manifest.json` and push to `master` — the workflow auto-creates a git tag and GitHub release with the zipped extension.

## Architecture

This is a Chrome MV3 extension with four isolated execution contexts that communicate via `chrome.runtime.sendMessage`:

```
Background (Service Worker)          Popup (UI)
├─ main.js    ← message hub          ├─ main.js    ← state + events
├─ sniffer.js ← network interception ├─ renderer.js ← DOM generation
├─ parser.js  ← M3U8/MPD parsing     ├─ i18n.js    ← localization
├─ orchestrator.js ← FFmpeg/offscreen lifecycle
└─ storage.js ← tab-based URL cache

Content Script (page context)        Offscreen Document (FFmpeg worker)
└─ content.js ← DOM <video> detection ├─ main.js  ← segment download pool
                                       ├─ ffmpeg.js ← FFmpeg.wasm init/exec
                                       └─ crypto.js ← AES-128 decryption
```

### Message Flow

1. **Network capture**: `background/main.js` listens via `chrome.webRequest.onBeforeRequest` → passes URLs to `sniffer.js` for classification → stores in `storage.js` keyed by tab ID
2. **Popup open**: `popup/main.js` requests stored URLs from background → `renderer.js` builds DOM
3. **Download**: Popup sends download command → background's `orchestrator.js` creates offscreen document → `offscreen/main.js` fetches segments concurrently → FFmpeg merges → `chrome.downloads` saves file
4. **CMD mode**: For YouTube/Bilibili, copies `yt-dlp` command to clipboard instead of downloading

### Key Design Decisions

- **Offscreen document lifecycle**: Only one offscreen document can exist at a time (Chrome limitation). `orchestrator.js` manages creation/destruction and queues concurrent download requests.
- **Concurrency pool**: `offscreen/main.js` uses a shared index pool pattern (not Promise.all) to download segments in parallel with configurable thread count (1–5). Failed segments are tracked and retried in a second pass.
- **DNR rules**: `orchestrator.js` uses `chrome.declarativeNetRequest` to inject `Origin` and `Referer` headers when fetching segments that require them for CORS.
- **Noise filtering**: `sniffer.js` aggressively filters ad pixels, analytics beacons, and tracking URLs before storing detected media.

## Localization

All user-facing strings go through `popup/i18n.js` which wraps `chrome.i18n.getMessage()`. String keys are defined in `_locales/zh_CN/messages.json` and `_locales/en/messages.json`. Chinese (zh_CN) is the primary locale.

## Logging

Use the shared `common/logger.js` module. It prefixes log messages by component and respects a debug flag. Do not use `console.log` directly in new code.

## No Tests

There are no automated tests. Testing is manual: load the extension, visit target sites (YouTube, Bilibili, Douyin, TikTok, Feishu/Lark), and verify capture and download behavior.

## Git Development Workflow

- **Atomic Local Commits**: Use `git commit` locally to record significant bug fixes or feature completions. Avoid over-committing for every line of code change.
- **Strict Remote Push**: **NEVER** push to the remote repository (`origin master` or tags) without explicit confirmation from the user. The user retains full control over the remote sync and automated release triggers.
- **Internal Docs**: Keep all audit reports and internal technical documents in the `docs/` folder, which must stay untracked/ignored by Git.
