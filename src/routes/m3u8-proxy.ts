import { setResponseHeaders } from 'h3';
import config from '../utils/config';

// Check if caching is disabled via config
const isCacheDisabled = () => config.DISABLE_CACHE;

function parseURL(req_url: string, baseUrl?: string) {
  if (baseUrl) {
    return new URL(req_url, baseUrl).href;
  }
  
  const match = req_url.match(/^(?:(https?:)?\/\/)?(([^\/?]+?)(?::(\d{0,5})(?=[\/?]|$))?)([\/?][\S\s]*|$)/i);
  
  if (!match) {
    return null;
  }
  
  if (!match[1]) {
    if (/^https?:/i.test(req_url)) {
      return null;
    }
    
    // Scheme is omitted
    if (req_url.lastIndexOf("//", 0) === -1) {
      // "//" is omitted
      req_url = "//" + req_url;
    }
    req_url = (match[4] === "443" ? "https:" : "http:") + req_url;
  }
  
  try {
    const parsed = new URL(req_url);
    if (!parsed.hostname) {
      // "http://:1/" and "http:/notenoughslashes" could end up here
      return null;
    }
    return parsed.href;
  } catch (error) {
    return null;
  }
}

interface CacheEntry {
  data: Uint8Array;
  headers: Record<string, string>;
  timestamp: number;
}

const CACHE_MAX_SIZE = 2000;
const CACHE_EXPIRY_MS = 2 * 60 * 60 * 1000;
const segmentCache: Map<string, CacheEntry> = new Map();

export function cleanupCache() {
  const now = Date.now();
  let expiredCount = 0;
  
  for (const [url, entry] of segmentCache.entries()) {
    if (now - entry.timestamp > CACHE_EXPIRY_MS) {
      segmentCache.delete(url);
      expiredCount++;
    }
  }
  
  if (segmentCache.size > CACHE_MAX_SIZE) {
    const entries = Array.from(segmentCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    const toRemove = entries.slice(0, segmentCache.size - CACHE_MAX_SIZE);
    for (const [url] of toRemove) {
      segmentCache.delete(url);
    }
    
    console.log(`Cache size limit reached. Removed ${toRemove.length} oldest entries. Current size: ${segmentCache.size}`);
  }
  
  if (expiredCount > 0) {
    console.log(`Cleaned up ${expiredCount} expired cache entries. Current size: ${segmentCache.size}`);
  }
  
  return segmentCache.size;
}

let cleanupInterval: any = null;
function startCacheCleanupInterval() {
  if (!cleanupInterval) {
    cleanupInterval = setInterval(cleanupCache, 30 * 60 * 1000);
    console.log('Started periodic cache cleanup interval');
  }
}

startCacheCleanupInterval();


export function getCachedSegment(url: string) {
  // Return undefined immediately if cache is disabled
  if (isCacheDisabled()) {
    return undefined;
  }
  
  const entry = segmentCache.get(url);
  if (entry) {
    if (Date.now() - entry.timestamp > CACHE_EXPIRY_MS) {
      segmentCache.delete(url);
      return undefined;
    }
    return entry;
  }
  return undefined;
}

export function getCacheStats() {
  const sizes = Array.from(segmentCache.values())
    .map(entry => entry.data.byteLength);
  
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  const avgBytes = sizes.length > 0 ? totalBytes / sizes.length : 0;
  
  return {
    entries: segmentCache.size,
    totalSizeMB: (totalBytes / (1024 * 1024)).toFixed(2),
    avgEntrySizeKB: (avgBytes / 1024).toFixed(2),
    maxSize: CACHE_MAX_SIZE,
    expiryHours: CACHE_EXPIRY_MS / (60 * 60 * 1000)
  };
}

/**
 * Proxies m3u8 files and replaces the content to point to the proxy
 */
async function proxyM3U8(event: any) {
  const url = getQuery(event).url as string;
  const headersParam = getQuery(event).headers as string;
  const lbParam = getQuery(event).lb as string;

  if (!url) {
    return sendError(event, createError({
      statusCode: 400,
      statusMessage: 'URL parameter is required'
    }));
  }


  let headers = {};
  try {
    headers = headersParam ? JSON.parse(headersParam) : {};
  } catch (e) {
    return sendError(event, createError({
      statusCode: 400,
      statusMessage: 'Invalid headers format'
    }));
  }

  // Always use local proxy
  const selectedUrl = '/s';
  const lbChoice = 'local';

  try {
    const response = await globalThis.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
        ...(headers as HeadersInit),
      }
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`Failed to fetch M3U8: ${response.status} ${response.statusText} for URL: ${url}`);
      console.error(`Response body: ${errorText}`);
      throw new Error(`Failed to fetch M3U8: ${response.status} ${response.statusText}`);
    }

    const m3u8Content = await response.text();
    
    if (m3u8Content.includes("RESOLUTION=")) {
      // This is a master playlist with multiple quality variants
      const lines = m3u8Content.split("\n");
      const newLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("#")) {
          if (line.startsWith("#EXT-X-KEY:")) {
            // Proxy the key URL
            const regex = /https?:\/\/[^\""\s]+/g;
            const keyUrl = regex.exec(line)?.[0];
            if (keyUrl) {
              const encodedUrl = Buffer.from(keyUrl).toString('base64');
              const proxyKeyUrl = `${selectedUrl}?u=${encodedUrl}&headers=${encodeURIComponent(JSON.stringify(headers))}&lb=${lbChoice}`;
              newLines.push(line.replace(keyUrl, proxyKeyUrl));
            } else {
              newLines.push(line);
            }
          } else if (line.startsWith("#EXT-X-MEDIA:")) {
            // Proxy alternative media URLs (like audio streams)
            const regex = /https?:\/\/[^\""\s]+/g;
            const mediaUrl = regex.exec(line)?.[0];
            if (mediaUrl) {
              const encodedUrl = Buffer.from(mediaUrl).toString('base64');
              const proxyMediaUrl = `${selectedUrl}?u=${encodedUrl}&headers=${encodeURIComponent(JSON.stringify(headers))}&lb=${lbChoice}`;
              newLines.push(line.replace(mediaUrl, proxyMediaUrl));
            } else {
              newLines.push(line);
            }
          } else {
            newLines.push(line);
          }
        } else if (line.trim()) {
          // This is a quality variant URL
          const variantUrl = parseURL(line, url);
          if (variantUrl) {
            const encodedUrl = Buffer.from(variantUrl).toString('base64');
            newLines.push(`${selectedUrl}?u=${encodedUrl}&headers=${encodeURIComponent(JSON.stringify(headers))}&lb=${lbChoice}`);
          } else {
            newLines.push(line);
          }
        } else {
          // Empty line, preserve it
          newLines.push(line);
        }
      }
      
      // Set appropriate headers
      setResponseHeaders(event, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      
      return newLines.join("\n");
    } else {
      // This is a media playlist with segments
      const lines = m3u8Content.split("\n");
      const newLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("#")) {
          if (line.startsWith("#EXT-X-KEY:")) {
            // Proxy the key URL
            const regex = /https?:\/\/[^\""\s]+/g;
            const keyUrl = regex.exec(line)?.[0];
            if (keyUrl) {
              const encodedUrl = Buffer.from(keyUrl).toString('base64');
              const proxyKeyUrl = `${selectedUrl}?u=${encodedUrl}&headers=${encodeURIComponent(JSON.stringify(headers))}&lb=${lbChoice}`;
              newLines.push(line.replace(keyUrl, proxyKeyUrl));
            } else {
              newLines.push(line);
            }
          } else {
            newLines.push(line);
          }
        } else if (line.trim() && !line.startsWith("#")) {
          // This is a segment URL (.ts file)
          const segmentUrl = parseURL(line, url);
          if (segmentUrl) {
            const encodedUrl = Buffer.from(segmentUrl).toString('base64');
            newLines.push(`${selectedUrl}?u=${encodedUrl}&headers=${encodeURIComponent(JSON.stringify(headers))}&lb=${lbChoice}`);
          } else {
            newLines.push(line);
          }
        } else {
          // Comment or empty line, preserve it
          newLines.push(line);
        }
      }

      // Set appropriate headers
      setResponseHeaders(event, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      
      return newLines.join("\n");
    }
  } catch (error: any) {
    console.error('Error proxying M3U8:', error);
    return sendError(event, createError({
      statusCode: 500,
      statusMessage: error.message || 'Error proxying M3U8 file'
    }));
  }
}


export default defineEventHandler(async (event) => {
  // Handle CORS preflight requests
  if (isPreflightRequest(event)) return handleCors(event, {});

  if (config.DISABLE_M3U8) {
    return sendError(event, createError({
      statusCode: 404,
      statusMessage: 'M3U8 proxying is disabled'
    }));
  }

  return await proxyM3U8(event);
});
