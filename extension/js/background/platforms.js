/**
 * Platform-specific signature rules.
 *
 * Each rule describes how to handle URLs from a particular platform:
 *   - id:               unique identifier
 *   - match:            predicate (receives lowercase URL)
 *   - groupTag:         extracts a pairing/dedup key (receives original URL), returns string|null
 *   - mediaType:        detects 'audio'|'video' from URL (receives original URL), returns string|null
 *   - normalizeParams:  query params to strip for deduplication
 *   - proxyRequired:    whether direct downloads must go through the offscreen proxy fetch
 *
 * Rule order matters: the first matching rule wins in extractGroupTag / detectMediaType.
 * Put more-specific rules (reddit) before broad ones (bilibili) when their match predicates overlap.
 */
export const PLATFORM_RULES = [
  {
    id: 'youtube',
    match: (url) => url.includes('googlevideo.com'),
    groupTag: (url) => {
      const cpn = url.match(/[&?]cpn=([^&]+)/)?.[1];
      if (cpn) return `yt-cpn-${cpn}`;
      const id = url.match(/[&?]id=([^&]+)/)?.[1];
      if (id) return `yt-${id}`;
      const pathId = url.match(/\/id\/([^\/\?]+)/)?.[1];
      return pathId ? `yt-${pathId}` : null;
    },
    mediaType: (url) => {
      const itag = parseInt(url.match(/[&?]itag=(\d+)/)?.[1]);
      if (!itag) return null;
      // Audio-only itags: 139/140/141 (m4a), 171/172 (webm vorbis), 249/250/251 (opus)
      return [139, 140, 141, 171, 172, 249, 250, 251].includes(itag) ? 'audio' : 'video';
    },
    normalizeParams: ['range', 'rn', 'rbuf'],
    proxyRequired: false,
  },
  {
    id: 'facebook',
    match: (url) => url.includes('fbcdn.net') || url.includes('efg='),
    groupTag: (url) => {
      const efgMatch = url.match(/[&?]efg=([^&]+)/);
      if (!efgMatch) return null;
      try {
        const decoded = atob(decodeURIComponent(efgMatch[1]));
        const vidMatch = decoded.match(/"video_id":(\d+)/);
        return vidMatch ? `fb-${vidMatch[1]}` : null;
      } catch { return null; }
    },
    mediaType: (url) => {
      const efgMatch = url.match(/[&?]efg=([^&]+)/);
      if (!efgMatch) return null;
      try {
        const decoded = atob(decodeURIComponent(efgMatch[1]));
        if (decoded.includes('audio')) return 'audio';
        if (decoded.includes('video')) return 'video';
      } catch {}
      return null;
    },
    normalizeParams: ['range', 'rn', 'rbuf'],
    proxyRequired: false,
  },
  // Reddit must come before bilibili: v.redd.it CMAF streams also use .m4s
  {
    id: 'reddit',
    match: (url) => url.includes('v.redd.it'),
    groupTag: (url) => {
      const id = url.split('/').find(p => p.length >= 10 && p.length <= 15);
      return id ? `reddit-${id}` : null;
    },
    mediaType: null,
    normalizeParams: [],
    proxyRequired: false,
  },
  {
    id: 'bilibili',
    // bilivideo.com CDN, bilibili.com direct links, or any .m4s not from Reddit
    match: (url) => url.includes('bilivideo.com') || url.includes('bilibili.com') || (url.includes('.m4s') && !url.includes('v.redd.it')),
    groupTag: (url) => {
      const trid = url.match(/[&?]trid=([a-f0-9]+)/i)?.[1];
      if (trid) return `bili-${trid.substring(0, 16)}`;
      const id = url.split('/').find(p => p.length > 20 && /^[a-f0-9]+$/i.test(p));
      return id ? `bili-${id.substring(0, 16)}` : null;
    },
    mediaType: null,
    normalizeParams: [],
    proxyRequired: true,
  },
  {
    id: 'tiktok',
    match: (url) => url.includes('tiktok.com') || url.includes('douyinvod.com'),
    groupTag: (url) => url.match(/[&?](session_id|logid)=([^&]+)/i)?.[2] ?? null,
    mediaType: null,
    normalizeParams: [],
    proxyRequired: true,
  },
];
