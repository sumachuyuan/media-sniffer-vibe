# Privacy Policy: Media Sniffer Vibe

**Last Updated**: 2026-03-20

Media Sniffer Vibe is committed to ensuring your technical sovereignty and data privacy. This extension is designed to be a local-first tool for media capture.

## 1. Data Collection & Usage
- **Zero Data Collection**: Media Sniffer Vibe DOES NOT collect, store, or transmit any personal information, browsing history, or captured media content to external servers.
- **Local Processing**: All media sniffing and merging (via FFmpeg.wasm) occur entirely within your browser's local sandbox (Offscreen Document). No data ever leaves your device.
- **No Third-Party Analytics**: We do not use any tracking pixels, cookies, or 3rd-party analytics services.

## 2. Permissions Justification
- **webRequest**: Used solely to detect media stream manifest URLs (M3U8/MPD) in the background.
- **declarativeNetRequest**: Used to allow fetching media segments by bypassing CORS/Referer restrictions set by providers. Rules are domain-scoped and cleared after use.
- **storage**: Used to store your local preferences (language, performance modes).
- **downloads**: Used to save the final merged video file directly to your local storage.
- **offscreen**: Required to host the FFmpeg.wasm instance in a valid DOM environment.

## 3. Contact & Sovereignty
As this is a tool built for tech-sovereign individuals, we encourage you to audit the source code. If you have questions regarding this policy, please contact the repository maintainer.

---
*Your data, your machine, your rules.*
