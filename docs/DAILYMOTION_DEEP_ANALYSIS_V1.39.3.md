# Dailymotion Deep Architecture Analysis (v1.39.3)

## 1. The "Smoking Gun": Origin-Based CORS Enforcement
Through high-resolution auditing (v1.39.3 Deep Audit), we have identified the definitive reason for the "262-byte" truncated MP4 files on Dailymotion.

It is **NOT** just the `Referer`. It is the **`Origin`** header.

### Evidence from Controlled Fetch Tests:
| Context | Origin | Referer | Result |
| :--- | :--- | :--- | :--- |
| **Dailymotion Page** | `https://www.dailymotion.com` | `https://geo.dailymotion.com/` | **200 OK** |
| **Extension Context** | `chrome-extension://[ID]` | `https://geo.dailymotion.com/` | **403 Forbidden (262B)** |
| **Google.com Tab** | `https://www.google.com` | `https://geo.dailymotion.com/` | **403 Forbidden (CORS Error)** |

**Conclusion**: Dailymotion's CDN (`*.dmcdn.net`) performs strict CORS validation. If the `Origin` header is anything other than a trusted Dailymotion domain, the CDN returns a 403 Forbidden response (which happens to be an XML error body of ~262 bytes).

---

## 2. Why Previous Fixes Failed
- **v1.39.1 - v1.39.3**: We correctly identified the need for `Referer: https://geo.dailymotion.com/`. However, we left the `Origin` header as the default `chrome-extension://...`.
- **DNR Scoping**: While we broadened the scoping, we were only injecting `Referer` and `User-Agent`. The `Origin` remained a red flag for the CDN.

---

## 3. The Proposed "Tough Nut" Fix (v1.39.4)
We must treat the extension as a fully authorized Dailymotion environment by forcing the following headers during the download/merge phase:

### A. DNR Header Overwrites
Using `declarativeNetRequest`, we will inject:
1.  **`Origin`**: `https://www.dailymotion.com` (To pass CORS checks).
2.  **`Referer`**: `https://geo.dailymotion.com/` (To pass source frame checks).
3.  **`Sec-Fetch-Site`**: `same-site` or `same-origin` (To hide the cross-origin nature).

### B. Implementation (orchestrator.js)
```javascript
// Add Origin to the modifyHeaders action
requestHeaders: [
    { header: 'Referer', operation: 'set', value: referer },
    { header: 'Origin', operation: 'set', value: 'https://www.dailymotion.com' },
    { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-site' }
]
```

### C. Implementation (offscreen/main.js & parser.js)
Continue using `credentials: 'include'` to ensure the session context is maintained alongside the spoofed headers.

---

## 4. Next Steps
- [ ] User review of this analysis.
- [ ] Implement `Origin` and `Sec-Fetch-Site` injection in `orchestrator.js`.
- [ ] Final end-to-end verification.

---
*Created on 2026-03-22 by Sovereign Analysis Module.*
