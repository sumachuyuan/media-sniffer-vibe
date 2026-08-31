/**
 * Sovereign Parser - Logic for manifest parsing (HLS/DASH)
 */
import { logger } from '../common/logger.js';
import { getCachedResult, setCachedResult } from './storage.js';

export async function parseMPD(url) {
  try {
    const cached = getCachedResult(url);
    if (cached) return cached;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    // fetch() does not reject on HTTP errors — without this guard a 403/404 body
    // (e.g. "403 Forbidden") gets parsed as a valid-but-empty manifest.
    if (!response.ok) {
      logger.warn(`parseMPD fetch failed: HTTP ${response.status}`);
      return null;
    }
    const text = await response.text();

    if (!text.includes('<MPD') || !text.includes('<Representation')) {
      return null;
    }

    let totalDuration = 0;
    const durMatch = text.match(/mediaPresentationDuration=["']([^"']+)["']/i);
    if (durMatch) {
      const durStr = durMatch[1]; // e.g. PT1H2M30.5S
      const h = durStr.match(/(\d+)H/i), m = durStr.match(/(\d+)M/i), s = durStr.match(/([\d.]+)S/i);
      totalDuration = (parseInt(h?.[1] || 0) * 3600) + (parseInt(m?.[1] || 0) * 60) + parseFloat(s?.[1] || 0);
    }

    const qualities = [];
    const repRegex = /<Representation[^>]+(?:width=["'](\d+)["'][^>]+height=["'](\d+)["']|bandwidth=["'](\d+)["'])[^>]*>/gi;
    let match;

    while ((match = repRegex.exec(text)) !== null) {
      const width = match[1];
      const height = match[2];
      const bandwidth = match[3];
      if (width && height) {
        qualities.push({
          resolution: `${width}x${height}`,
          bandwidth: bandwidth ? Math.round(bandwidth / 1024) + 'kbps' : 'unknown'
        });
      }
    }

    const uniqueQualities = Array.from(new Set(qualities.map(q => q.resolution)))
      .map(res => qualities.find(q => q.resolution === res))
      .sort((a, b) => (parseInt(b.resolution.split('x')[1]) || 0) - (parseInt(a.resolution.split('x')[1]) || 0));

    const result = {
        qualities: uniqueQualities.length > 0 ? uniqueQualities : null,
        totalDuration: totalDuration
    };
    if (uniqueQualities.length > 0) setCachedResult(url, result);
    return uniqueQualities.length > 0 ? result : null;
  } catch (e) {
    return null;
  }
}

export async function parseM3U8(url) {
  try {
    const cached = getCachedResult(url);
    if (cached) return cached;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) {
      logger.warn(`parseM3U8 fetch failed: HTTP ${response.status}`);
      return null;
    }
    const text = await response.text();

    let encryption = null;
    let mediaSequence = 0;
    const seqMatch = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
    if (seqMatch) mediaSequence = parseInt(seqMatch[1]);

    if (text.includes('#EXT-X-KEY:')) {
      const keyMatch = text.match(/#EXT-X-KEY:METHOD=([^,]+)(?:,URI="([^"]+)")?(?:,IV=([^, \n]+))?/i);
      if (keyMatch) {
        encryption = {
          method: keyMatch[1],
          uri: keyMatch[2] || null,
          iv: keyMatch[3] || null,
          mediaSequence: mediaSequence
        };
      }
    }

    const qualities = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          const resMatch = line.match(/RESOLUTION=(\d+x\d+)/i);
          const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
          let streamUrl = '';
          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j].trim();
            if (nextLine && !nextLine.startsWith('#')) { streamUrl = nextLine; break; }
          }
          if (resMatch && streamUrl) {
            const absoluteUrl = streamUrl.startsWith('http') ? streamUrl : new URL(streamUrl, url).href;
            qualities.push({
              resolution: resMatch[1],
              bandwidth: bwMatch ? Math.round(bwMatch[1] / 1024) + 'kbps' : 'unknown',
              url: absoluteUrl
            });
          }
        }
    }

    const uniqueQualities = qualities
      .sort((a, b) => (parseInt(b.resolution.split('x')[1]) || 0) - (parseInt(a.resolution.split('x')[1]) || 0))
      .filter((q, idx, arr) => arr.findIndex(t => t.resolution === q.resolution) === idx);

    const result = {
      qualities: uniqueQualities.length > 0 ? uniqueQualities : null,
      encryption: encryption,
      isMediaPlaylist: text.includes('#EXTINF:'),
      mapUrl: text.includes('#EXT-X-MAP:') ? (text.match(/#EXT-X-MAP:URI="([^"]+)"/i)?.[1] || null) : null,
      totalDuration: 0
    };

    if (result.isMediaPlaylist) {
      const infRegex = /#EXTINF:([\d\.]+)/g;
      let infMatch, total = 0;
      while ((infMatch = infRegex.exec(text)) !== null) total += parseFloat(infMatch[1]);
      result.totalDuration = total;
    }
    if (result.mapUrl && !result.mapUrl.startsWith('http')) {
      result.mapUrl = new URL(result.mapUrl, url).href;
    }
    setCachedResult(url, result);
    return result;
  } catch (e) {
    return null;
  }
}

export async function parseHlsSegments(playlistUrl) {
  try {
    const response = await fetch(playlistUrl);
    if (!response.ok) {
      logger.warn(`parseHlsSegments fetch failed: HTTP ${response.status}`);
      return { segments: [], encryption: null, mapUrl: null };
    }
    const text = await response.text();
    if (text.includes('#EXT-X-STREAM-INF:') && !text.includes('#EXTINF:')) {
      const masterData = await parseM3U8(playlistUrl);
      if (masterData && masterData.qualities && masterData.qualities.length > 0) {
        return await parseHlsSegments(masterData.qualities[0].url);
      }
    }
    let encryption = null;
    let mapUrl = null;
    let mediaSequence = 0;
    const lines = text.split('\n');
    const segments = [];
    const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
    const seqMatch = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
    if (seqMatch) mediaSequence = parseInt(seqMatch[1]);
    const keyMatch = text.match(/#EXT-X-KEY:METHOD=([^,]+)(?:,URI="([^"]+)")?(?:,IV=([^, \n]+))?/i);
    if (keyMatch) {
      encryption = {
        method: keyMatch[1],
        uri: keyMatch[2] ? (keyMatch[2].startsWith('http') ? keyMatch[2] : new URL(keyMatch[2], playlistUrl).href) : null,
        iv: keyMatch[3] || null,
        mediaSequence: mediaSequence
      };
    }
    const mapMatch = text.match(/#EXT-X-MAP:URI="([^"]+)"/i);
    if (mapMatch) mapUrl = mapMatch[1].startsWith('http') ? mapMatch[1] : new URL(mapMatch[1], playlistUrl).href;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !line.startsWith('#')) {
        if (line.startsWith('http')) segments.push(line);
        else if (line.startsWith('/')) segments.push(new URL(playlistUrl).origin + line);
        else segments.push(baseUrl + line);
      }
    }
    const res = { segments, encryption, mapUrl };
    logger.info(`parseHlsSegments result: ${res.segments.length} segments found. Encrypted: ${!!res.encryption}`);
    return res;
  } catch (e) {
    logger.error('Failed to parse HLS segments', e);
    return { segments: [], encryption: null, mapUrl: null };
  }
}

export async function parseDashSegments(mpdUrl) {
  try {
    const response = await fetch(mpdUrl);
    const text = await response.text();
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const mpd = doc.querySelector('MPD');
    if (!mpd) return { segments: [], encryption: null, mapUrl: null };

    // Resolve document base URL (prefer explicit <BaseURL> element)
    const baseUrlEl = mpd.querySelector('BaseURL');
    const baseUrl = baseUrlEl?.textContent
      ? (baseUrlEl.textContent.startsWith('http') ? baseUrlEl.textContent : new URL(baseUrlEl.textContent, mpdUrl).href)
      : mpdUrl.substring(0, mpdUrl.lastIndexOf('/') + 1);

    // --- SegmentTemplate (most common: YouTube-like CDNs, CMAF) ---
    const segTemplate = mpd.querySelector('SegmentTemplate');
    if (segTemplate) {
      const mediaAttr  = segTemplate.getAttribute('media');
      const initAttr   = segTemplate.getAttribute('initialization');
      const startNum   = parseInt(segTemplate.getAttribute('startNumber') || '1');
      const timescale  = parseInt(segTemplate.getAttribute('timescale')   || '1');
      const segDur     = parseInt(segTemplate.getAttribute('duration')    || '0');
      const repId      = mpd.querySelector('Representation')?.getAttribute('id') || '';

      // Derive real segment count from mediaPresentationDuration + segment duration
      let count = 50; // safe fallback for live/unknown
      const durAttr = mpd.getAttribute('mediaPresentationDuration');
      if (durAttr && segDur > 0 && timescale > 0) {
        const totalSec = parseMpdDuration(durAttr);
        count = Math.ceil((totalSec * timescale) / segDur);
      }

      const mapUrl = initAttr
        ? resolveUrl(resolveDashTemplate(initAttr, { RepresentationID: repId }), baseUrl)
        : null;

      const segments = mediaAttr
        ? Array.from({ length: count }, (_, i) =>
            resolveUrl(resolveDashTemplate(mediaAttr, { RepresentationID: repId, Number: startNum + i }), baseUrl))
        : [];

      logger.info(`parseDashSegments (SegmentTemplate): ${segments.length} segments, init=${!!mapUrl}`);
      return { segments, encryption: null, mapUrl };
    }

    // --- SegmentList (explicit <SegmentURL> elements) ---
    const segList = mpd.querySelector('SegmentList');
    if (segList) {
      const initEl = segList.querySelector('Initialization');
      const mapUrl = initEl
        ? resolveUrl(initEl.getAttribute('sourceURL') || '', baseUrl)
        : null;

      const segments = Array.from(segList.querySelectorAll('SegmentURL'))
        .map(el => resolveUrl(el.getAttribute('media') || '', baseUrl))
        .filter(Boolean);

      logger.info(`parseDashSegments (SegmentList): ${segments.length} segments, init=${!!mapUrl}`);
      return { segments, encryption: null, mapUrl };
    }

    logger.warn('parseDashSegments: no SegmentTemplate or SegmentList found in MPD');
    return { segments: [], encryption: null, mapUrl: null };
  } catch (e) {
    logger.error('Failed to parse DASH segments', e);
    return { segments: [], encryption: null, mapUrl: null };
  }
}

/** Parse ISO 8601 duration (e.g. PT1H2M30.5S) → seconds */
function parseMpdDuration(iso) {
  const h = parseFloat(iso.match(/(\d+)H/i)?.[1] || 0);
  const m = parseFloat(iso.match(/(\d+)M(?!P)/i)?.[1] || 0);
  const s = parseFloat(iso.match(/([\d.]+)S/i)?.[1] || 0);
  return h * 3600 + m * 60 + s;
}

/** Expand DASH template identifiers: $RepresentationID$, $Number$, $Number%05d$ */
function resolveDashTemplate(template, vars) {
  return template
    .replace(/\$RepresentationID\$/g, vars.RepresentationID ?? '')
    .replace(/\$Number(%0(\d+)d)?\$/g, (_, _fmt, width) => {
      const n = String(vars.Number ?? 0);
      return width ? n.padStart(parseInt(width), '0') : n;
    });
}

/** Resolve a possibly-relative URL against a base */
function resolveUrl(url, base) {
  if (!url) return '';
  return url.startsWith('http') ? url : base + url;
}
