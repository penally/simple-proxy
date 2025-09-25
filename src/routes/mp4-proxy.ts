import { setResponseHeaders } from 'h3';

// Check if caching is disabled via environment variable
const isCacheDisabled = () => process.env.DISABLE_CACHE === 'true';

// Check if MP4 proxying is disabled via environment variable
const isMp4ProxyDisabled = () => process.env.DISABLE_MP4 === 'true';

interface CacheEntry {
  data: Uint8Array;
  headers: Record<string, string>;
  timestamp: number;
  range: string; // Store the range this chunk represents
}

const CACHE_MAX_SIZE = 500; // Reduced for MP4 chunks
const CACHE_EXPIRY_MS = 4 * 60 * 60 * 1000; // 4 hours for MP4 chunks
const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB chunks
const segmentCache: Map<string, CacheEntry> = new Map();

function cleanupCache() {
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

function getCachedChunk(url: string, range: string) {
  // Return undefined immediately if cache is disabled
  if (isCacheDisabled()) {
    return undefined;
  }

  const cacheKey = `${url}:${range}`;
  const entry = segmentCache.get(cacheKey);
  if (entry) {
    if (Date.now() - entry.timestamp > CACHE_EXPIRY_MS) {
      segmentCache.delete(cacheKey);
      return undefined;
    }
    return entry;
  }
  return undefined;
}

function getCacheStats() {
  const sizes = Array.from(segmentCache.values())
    .map(entry => entry.data.byteLength);

  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  const avgBytes = sizes.length > 0 ? totalBytes / sizes.length : 0;

  return {
    entries: segmentCache.size,
    totalSizeMB: (totalBytes / (1024 * 1024)).toFixed(2),
    avgEntrySizeMB: (avgBytes / (1024 * 1024)).toFixed(2),
    maxSize: CACHE_MAX_SIZE,
    expiryHours: CACHE_EXPIRY_MS / (60 * 60 * 1000)
  };
}

let cleanupInterval: any = null;
function startCacheCleanupInterval() {
  if (!cleanupInterval) {
    cleanupInterval = setInterval(cleanupCache, 30 * 60 * 1000); // Clean every 30 minutes
    console.log('Started MP4 cache cleanup interval');
  }
}

startCacheCleanupInterval();

async function prefetchMP4Chunk(url: string, start: number, end: number, headers: HeadersInit) {
  // Skip prefetching if cache is disabled
  if (isCacheDisabled()) {
    return;
  }

  if (segmentCache.size >= CACHE_MAX_SIZE) {
    cleanupCache();
  }

  const range = `bytes=${start}-${end}`;
  const cacheKey = `${url}:${range}`;

  const existing = segmentCache.get(cacheKey);
  const now = Date.now();
  if (existing && (now - existing.timestamp <= CACHE_EXPIRY_MS)) {
    return;
  }

  try {
    const requestHeaders = new Headers({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
      ...headers,
      'Range': range,
    });

    const response = await globalThis.fetch(url, {
      method: 'GET',
      headers: requestHeaders,
    });

    if (!response.ok) {
      console.error(`Failed to prefetch MP4 chunk: ${response.status} ${response.statusText}`);
      return;
    }

    const data = new Uint8Array(await response.arrayBuffer());

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    segmentCache.set(cacheKey, {
      data,
      headers: responseHeaders,
      timestamp: Date.now(),
      range
    });

    console.log(`Prefetched and cached MP4 chunk: ${range} (${(data.byteLength / (1024 * 1024)).toFixed(2)}MB)`);
  } catch (error) {
    console.error(`Error prefetching MP4 chunk ${range}:`, error);
  }
}

async function prefetchMP4Chunks(url: string, contentLength: number, headers: HeadersInit) {
  if (isCacheDisabled()) {
    console.log('Cache disabled - skipping MP4 prefetch operations');
    return;
  }

  cleanupCache();

  // Prefetch chunks in 10MB increments, up to a reasonable limit (first 100MB)
  const maxPrefetchBytes = Math.min(contentLength, 100 * 1024 * 1024);
  const promises = [];

  for (let start = 0; start < maxPrefetchBytes; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE - 1, contentLength - 1);
    promises.push(prefetchMP4Chunk(url, start, end, headers));
  }

  console.log(`Starting to prefetch ${promises.length} MP4 chunks for ${url}`);

  try {
    await Promise.all(promises);
  } catch (error) {
    console.error('Error prefetching MP4 chunks:', error);
  }
}

/**
 * Parses HTTP Range header and returns start/end byte positions
 * Supports formats like: bytes=0-1023, bytes=1024-, bytes=-512
 */
function parseRangeHeader(rangeHeader: string, contentLength: number): { start: number; end: number } | null {
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const [, startStr, endStr] = match;
  let start = startStr ? parseInt(startStr, 10) : 0;
  let end = endStr ? parseInt(endStr, 10) : contentLength - 1;

  // Handle suffix-byte-range-spec (e.g., bytes=-512)
  if (!startStr && endStr) {
    start = Math.max(0, contentLength - end);
    end = contentLength - 1;
  }

  // Ensure valid range
  if (start >= contentLength || end >= contentLength || start > end) {
    return null;
  }

  return { start, end };
}

/**
 * Proxies MP4 files with range request support for efficient streaming
 */
async function proxyMP4(event: any) {
  const url = getQuery(event).url as string;
  const headersParam = getQuery(event).headers as string;

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

  try {
    // First, get content length with a HEAD request
    const headResponse = await globalThis.fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
        ...(headers as HeadersInit),
      }
    });

    if (!headResponse.ok) {
      throw new Error(`Failed to fetch MP4 headers: ${headResponse.status} ${headResponse.statusText}`);
    }

    const contentLength = parseInt(headResponse.headers.get('content-length') || '0', 10);
    const contentType = headResponse.headers.get('content-type') || 'video/mp4';
    const acceptRanges = headResponse.headers.get('accept-ranges') || 'bytes';

    // Check if client requested a range
    const rangeHeader = getHeader(event, 'range');
    let start = 0;
    let end = contentLength - 1;
    let isPartial = false;

    if (rangeHeader && acceptRanges === 'bytes') {
      const range = parseRangeHeader(rangeHeader, contentLength);
      if (range) {
        start = range.start;
        end = range.end;
        isPartial = true;
      }
    }

    // Check cache first for partial requests
    if (isPartial && !isCacheDisabled()) {
      const requestedRange = `bytes=${start}-${end}`;
      const cachedChunk = getCachedChunk(url, requestedRange);

      if (cachedChunk) {
        setResponseHeaders(event, {
          'Content-Type': cachedChunk.headers['content-type'] || contentType,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Accept-Ranges': acceptRanges,
          'Content-Range': `bytes ${start}-${end}/${contentLength}`,
          'Content-Length': cachedChunk.data.byteLength.toString(),
          'Cache-Control': 'public, max-age=3600'
        });

        setResponseStatus(event, 206); // Partial Content
        return cachedChunk.data;
      }
    }

    // Prepare request headers for the actual fetch
    const requestHeaders = new Headers({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
      ...(headers as Record<string, string>),
    });

    // Add range header if this is a partial request
    if (isPartial) {
      requestHeaders.set('Range', `bytes=${start}-${end}`);
    }

    const response = await globalThis.fetch(url, {
      method: 'GET',
      headers: requestHeaders,
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`Failed to fetch MP4: ${response.status} ${response.statusText}`);
    }

    // Set appropriate headers for MP4 response
    const responseHeaders: Record<string, string> = {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Accept-Ranges': acceptRanges,
    };

    if (isPartial) {
      const actualRange = response.headers.get('content-range');
      const actualLength = response.headers.get('content-length');

      responseHeaders['Content-Range'] = actualRange || `bytes ${start}-${end}/${contentLength}`;
      responseHeaders['Content-Length'] = actualLength || (end - start + 1).toString();
      setResponseStatus(event, 206); // Partial Content
    } else {
      responseHeaders['Content-Length'] = contentLength.toString();
      // Allow caching for complete MP4 files (but not ranges)
      responseHeaders['Cache-Control'] = 'public, max-age=3600';
    }

    setResponseHeaders(event, responseHeaders);

    // Stream the response body directly without buffering
    const data = new Uint8Array(await response.arrayBuffer());

    // Start prefetching additional chunks in the background after serving this request
    if (!isCacheDisabled() && contentLength > 0) {
      setTimeout(() => {
        prefetchMP4Chunks(url, contentLength, headers as HeadersInit).catch(error => {
          console.error('Error in background prefetching:', error);
        });
      }, 100); // Small delay to ensure response is sent first
    }

    return data;
  } catch (error: any) {
    console.error('Error proxying MP4:', error);
    return sendError(event, createError({
      statusCode: error.response?.status || 500,
      statusMessage: error.message || 'Error proxying MP4 file'
    }));
  }
}

export function handleCacheStats(event: any) {
  cleanupCache();
  setResponseHeaders(event, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  });
  return getCacheStats();
}

export default defineEventHandler(async (event) => {
  // Handle CORS preflight requests
  if (isPreflightRequest(event)) return handleCors(event, {});

  if (isMp4ProxyDisabled()) {
    return sendError(event, createError({
      statusCode: 404,
      statusMessage: 'MP4 proxying is disabled'
    }));
  }

  if (event.path === '/mp4-cache-stats') {
    return handleCacheStats(event);
  }

  return await proxyMP4(event);
});
