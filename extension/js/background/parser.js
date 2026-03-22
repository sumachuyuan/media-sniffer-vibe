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
    const segments = [];
    const baseUrl = mpdUrl.substring(0, mpdUrl.lastIndexOf('/') + 1);
    const mediaMatch = text.match(/media=["']([^"']+)["']/);
    const startMatch = text.match(/startNumber=["'](\d+)["']/);
    if (mediaMatch) {
      const mediaTemplate = mediaMatch[1], startNumber = parseInt(startMatch ? startMatch[1] : '1');
      for (let i = 0; i < 50; i++) {
        const segUrl = mediaTemplate.replace('$Number$', (startNumber + i).toString());
        segments.push(segUrl.startsWith('http') ? segUrl : baseUrl + segUrl);
      }
    }
    const res = { segments, encryption: null, mapUrl: null };
    logger.info(`parseDashSegments result: ${res.segments.length} segments found.`);
    return res;
  } catch (e) {
    logger.error('Failed to parse DASH segments', e);
    return { segments: [], encryption: null, mapUrl: null };
  }
}
