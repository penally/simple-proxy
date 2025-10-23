import {
  setResponseHeaders,
  getQuery,
  sendError,
  createError,
  isPreflightRequest,
  handleCors,
  getRequestProtocol,
  getRequestHost
} from 'h3';
import { redisCache, cacheAnalytics } from '../utils/redis-cache';
import config from '../utils/config';

// Import parseURL function for URL resolution
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

// TS Proxy Cache Control - Set to false to enable caching, true to disable
const DISABLE_TS_CACHE = false;

// Check if caching is disabled via const, config, or Redis unavailability
const isCacheDisabled = () => DISABLE_TS_CACHE || config.DISABLE_CACHE || redisCache.isCacheDisabled();

export default defineEventHandler(async (event) => {
  const startTime = Date.now();

  // Handle CORS preflight requests
  if (isPreflightRequest(event)) return handleCors(event, {});

  if (config.DISABLE_M3U8) {
    return sendError(event, createError({
      statusCode: 404,
      statusMessage: 'TS proxying is disabled'
    }));
  }

  // Get base64 encoded URL or TS segment data parameter and decode it
  const encodedUrl = getQuery(event).u as string;
  const headersParam = getQuery(event).headers as string;
  const lbParam = getQuery(event).lb as string;

  if (!encodedUrl) {
    return sendError(event, createError({
      statusCode: 400,
      statusMessage: 'URL parameter (u) is required'
    }));
  }

  // Decode base64 parameter first to check if it's a playlist URL
  let decodedParam: string;
  try {
    decodedParam = Buffer.from(encodedUrl, 'base64').toString('utf-8');
  } catch (e) {
    return sendError(event, createError({
      statusCode: 400,
      statusMessage: 'Invalid base64 encoding'
    }));
  }

  // If this is a playlist URL (.m3u8) and lb=local, proxy to local m3u8-proxy
  if (lbParam === 'local' && decodedParam.endsWith('.m3u8')) {
    const localM3u8Url = `${getRequestProtocol(event)}://${getRequestHost(event)}/m3u8-proxy?url=${encodeURIComponent(decodedParam)}&headers=${encodeURIComponent(headersParam || '{}')}&lb=local`;
    console.log('Proxying playlist to local m3u8-proxy:', localM3u8Url);
    return await globalThis.fetch(localM3u8Url);
  }


  // Check if it's a URL (starts with http:// or https://)
  const isUrl = decodedParam.startsWith('http://') || decodedParam.startsWith('https://');

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
    if (isUrl) {
      // Handle URL case (existing behavior)
      const url = decodedParam;

      // Only check cache if caching is enabled
      if (!isCacheDisabled()) {
        const cachedSegment = await redisCache.get(url);

        if (cachedSegment) {
          cacheAnalytics.recordHit(cachedSegment.data.byteLength);
          console.log(`🔍 Found cached TS segment: ${url} (${cachedSegment.data.byteLength.toLocaleString()} bytes)`);
          setResponseHeaders(event, {
            'Content-Type': cachedSegment.headers['content-type'] || 'video/mp2t',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': '*',
            'Cache-Control': 'public, max-age=3600' // Allow caching of TS segments
          });

          return cachedSegment.data;
        }
      }

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          // Default User-Agent (from src/utils/headers.ts)
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
          'Connection': 'keep-alive',
          ...(headers as HeadersInit),
        },
        // Performance optimizations
        keepalive: true,
        // Use HTTP/1.1 with keep-alive for better connection reuse
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch TS file: ${response.status} ${response.statusText}`);
      }

      // Get content type before consuming the stream
      const contentType = response.headers.get('content-type') || 'video/mp2t';

      // Clone the response so we can read it twice if needed
      const responseClone = response.clone();

      // Read the response as text first to check if it's M3U8 content
      const responseText = await response.text();

      // Check if this is M3U8 content
      const isM3U8 = contentType.includes('application/vnd.apple.mpegurl') ||
                    contentType.includes('application/x-mpegurl') ||
                    responseText.startsWith('#EXTM3U');

      if (isM3U8) {
        // Process M3U8 content to replace segment URLs with proxied URLs
        const lines = responseText.split("\n");
        const newLines: string[] = [];
        const baseProxyUrl = `${getRequestProtocol(event)}://${getRequestHost(event)}`;

        // Always use local proxy
        const proxyUrl = '/s';

        for (const line of lines) {
          if (line.startsWith("#")) {
            if (line.startsWith("#EXT-X-KEY:")) {
              // Proxy the key URL
              const regex = /https?:\/\/[^\""\s]+/g;
              const keyUrl = regex.exec(line)?.[0];
              if (keyUrl) {
                const encodedUrl = Buffer.from(keyUrl).toString('base64');
                const proxyKeyUrl = `${proxyUrl}?u=${encodedUrl}&headers=${encodeURIComponent(JSON.stringify(headers))}`;
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
              newLines.push(`${proxyUrl}?u=${encodedUrl}&headers=${encodeURIComponent(JSON.stringify(headers))}`);
            } else {
              newLines.push(line);
            }
          } else {
            // Comment or empty line, preserve it
            newLines.push(line);
          }
        }

        const modifiedM3U8 = newLines.join("\n");

        setResponseHeaders(event, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        });

        return modifiedM3U8;
      } else {
        // Not M3U8 content, process as binary data from the cloned response
        const arrayBuffer = await responseClone.arrayBuffer();

        setResponseHeaders(event, {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*',
          'Cache-Control': 'public, max-age=3600' // Allow caching of TS segments
        });

        // Read the response as array buffer for caching
        const data = new Uint8Array(arrayBuffer);

        // Cache the segment asynchronously (don't await to avoid blocking response)
        if (!isCacheDisabled()) {
          // Double-check if segment is already cached to avoid unnecessary writes
          redisCache.get(url).then(existing => {
            if (!existing) {
              redisCache.set(url, {
                data: data,
                headers: { 'content-type': contentType },
                timestamp: Date.now()
              }).then(() => {
                // Calculate compressed size for analytics (rough estimate: 20-30% of original)
                const estimatedCompressedSize = Math.floor(data.byteLength * 0.25);
                cacheAnalytics.recordMiss(data.byteLength, estimatedCompressedSize);
                console.log(`✅ Cached TS segment: ${url} (${data.byteLength.toLocaleString()} bytes)`);
              }).catch(err => console.error('Failed to cache TS segment:', err));
            }
          }).catch(err => {
            // If we can't check cache, still try to cache the segment
            redisCache.set(url, {
              data: data,
              headers: { 'content-type': contentType },
              timestamp: Date.now()
            }).then(() => {
              // Calculate compressed size for analytics (rough estimate: 20-30% of original)
              const estimatedCompressedSize = Math.floor(data.byteLength * 0.25);
              cacheAnalytics.recordMiss(data.byteLength, estimatedCompressedSize);
              console.log(`✅ Cached TS segment: ${url} (${data.byteLength.toLocaleString()} bytes)`);
            }).catch(err => console.error('Failed to cache TS segment:', err));
          });
        }

        // Return the data
        const totalTime = Date.now() - startTime;
        console.log(`⚡ TS request completed in ${totalTime}ms`);
        return data;
      }
    } else {
      // Handle raw TS segment data case
      // The decodedParam is raw TS segment data, encode it back to bytes
      const data = Buffer.from(decodedParam, 'base64');

      setResponseHeaders(event, {
        'Content-Type': 'video/mp2t',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
        'Cache-Control': 'no-cache' // Don't cache raw segments
      });

      const totalTime = Date.now() - startTime;
      console.log(`⚡ Direct TS segment served in ${totalTime}ms (${data.length.toLocaleString()} bytes)`);
      return data;
    }
  } catch (error: any) {
    const errorTime = Date.now() - startTime;
    console.error(`❌ TS request failed in ${errorTime}ms:`, error.message);
    return sendError(event, createError({
      statusCode: 500,
      statusMessage: error.message || 'Error proxying TS file'
    }));
  }
});
