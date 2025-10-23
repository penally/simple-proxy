import { setResponseHeaders, setResponseStatus, getHeaders, getQuery, sendError, createError, defineEventHandler, isPreflightRequest, handleCors } from 'h3';
import config from '../utils/config';
import { specificProxyRequest } from '../utils/proxy';
import { mp4ChunkManager } from '../utils/mp4-chunks';

// Check if MP4 proxying is disabled via config
const isMp4ProxyDisabled = () => config.DISABLE_MP4;

// HLS-like MP4 streaming configuration - adjusted for browser compatibility
const SEGMENT_SIZE = 4.5 * 1024 * 1024; // 4.5MB segments (close to 5MB as requested)
const MAX_SEGMENTS_PER_REQUEST = 3; // Limit segments per request to prevent bandwidth abuse

// Browser-specific streaming capabilities - simplified for reliability
const BROWSER_CAPABILITIES = {
  firefox: {
    supportsChunked: false, // Firefox seeking issues with chunked MP4 - use full file
    supportsProgressive: false, // Firefox works better with full file access
    chunkSize: 0, // Use full file
    needsFullHeaders: true,
    useRangeRequests: true,
    preferFullFile: true // Key fix for Firefox seeking
  },
  safari: {
    supportsChunked: false, // Safari has major issues with chunked MP4
    supportsProgressive: false, // Safari prefers full file downloads
    chunkSize: 0, // Use full file only
    needsFullHeaders: true,
    useRangeRequests: true,
    preferFullFile: true // Key fix for Safari timeouts
  },
  chrome: {
    supportsChunked: true,
    supportsProgressive: true,
    chunkSize: 5 * 1024 * 1024, // 5MB for Chrome
    needsFullHeaders: false,
    useRangeRequests: true,
    preferFullFile: false
  },
  brave: {
    supportsChunked: true,
    supportsProgressive: true,
    chunkSize: 4 * 1024 * 1024, // 4MB for Brave
    needsFullHeaders: false,
    useRangeRequests: true,
    preferFullFile: false
  },
  other: {
    supportsChunked: true,
    supportsProgressive: true,
    chunkSize: 5 * 1024 * 1024, // 5MB default
    needsFullHeaders: false,
    useRangeRequests: true,
    preferFullFile: false
  }
};

// Browser detection and compatibility
function detectBrowser(userAgent: string) {
  const ua = userAgent.toLowerCase();
  if (ua.includes('firefox')) return 'firefox';
  if (ua.includes('brave')) return 'brave';
  if (ua.includes('chrome') && !ua.includes('edg')) return 'chrome';
  if (ua.includes('safari') && !ua.includes('chrome')) return 'safari';
  return 'other';
}

// Get browser-specific headers optimized for inline playback
function getBrowserSpecificHeaders(browser: string, contentLength?: number, isChunked: boolean = false, totalSize?: number): Record<string, string> {
  const capabilities = BROWSER_CAPABILITIES[browser as keyof typeof BROWSER_CAPABILITIES] || BROWSER_CAPABILITIES.other;

  const baseHeaders: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Content-Range, Content-Length, Content-Type',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Cache-Control': capabilities.supportsChunked ? 'public, max-age=3600' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };

  // Add total content length for browsers that need it
  if (capabilities.needsFullHeaders && totalSize && !isChunked) {
    baseHeaders['X-Total-Content-Length'] = totalSize.toString();
  }

  switch (browser) {
    case 'firefox':
      const firefoxHeaders: Record<string, string> = {
        ...baseHeaders,
        'Content-Type': 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
        'X-Content-Duration': 'INFINITY',
        'Content-Disposition': 'inline',
      };

      // Firefox needs proper Content-Length for non-chunked responses
      if (!isChunked && contentLength) {
        firefoxHeaders['Content-Length'] = contentLength.toString();
      }

      return firefoxHeaders;

    case 'safari':
      const safariHeaders: Record<string, string> = {
        ...baseHeaders,
        'Content-Type': 'video/mp4',
        'Content-Disposition': 'inline',
        // Safari requires strict no-cache headers to prevent timeout issues
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
        // Safari-specific headers for MP4 playback
        'X-Playback-Session-Id': Date.now().toString(),
      };

      // Safari needs Content-Length for proper playback
      if (contentLength) {
        safariHeaders['Content-Length'] = contentLength.toString();
      }

      return safariHeaders;

    default: // chrome, brave and others
      return {
        ...baseHeaders,
        'Content-Type': 'video/mp4',
        'Content-Disposition': 'inline',
        ...(contentLength && { 'Content-Length': contentLength.toString() }),
      };
  }
}

/**
 * Get HLS-like playlist/manifest for MP4 segments
 */
async function getMP4Playlist(event: any, url: string, headers: Record<string, string>) {
  try {
    // Get file size first
    const headResponse = await globalThis.fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
        ...headers,
      }
    });

    if (!headResponse.ok) {
      throw new Error(`Failed to get MP4 info: ${headResponse.status} ${headResponse.statusText}`);
    }

    const contentLength = parseInt(headResponse.headers.get('content-length') || '0', 10);
    if (!contentLength) {
      throw new Error('Unable to determine MP4 file size');
    }

    const totalSegments = Math.ceil(contentLength / SEGMENT_SIZE);
    const segments = [];

    // Generate segment URLs (HLS-like format)
    for (let i = 0; i < totalSegments; i++) {
      const start = i * SEGMENT_SIZE;
      const end = Math.min(start + SEGMENT_SIZE - 1, contentLength - 1);
      const size = end - start + 1;

      segments.push({
        index: i,
        start,
        end,
        size,
        url: `/mp4-proxy?url=${encodeURIComponent(url)}&segment=${i}&headers=${encodeURIComponent(JSON.stringify(headers))}`
      });
    }

    const manifest = {
      url,
      totalSize: contentLength,
      segmentSize: SEGMENT_SIZE,
      totalSegments,
      segments,
      headers
    };

    const browser = detectBrowser(getHeaders(event)['user-agent'] || '');
    const responseHeaders = getBrowserSpecificHeaders(browser);

    setResponseHeaders(event, {
      ...responseHeaders,
      'Content-Type': 'application/json',
    });

    return manifest;
  } catch (error: any) {
    console.error('Error generating MP4 playlist:', error);
    throw error;
  }
}

/**
 * Get a specific MP4 segment (4.5MB chunks)
 */
async function getMP4Segment(event: any, url: string, segmentIndex: number, headers: Record<string, string>) {
  try {
    // Get file size first
    const headResponse = await globalThis.fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
        ...headers,
      }
    });

    if (!headResponse.ok) {
      throw new Error(`Failed to get MP4 info: ${headResponse.status} ${headResponse.statusText}`);
    }

    const totalSize = parseInt(headResponse.headers.get('content-length') || '0', 10);
    if (!totalSize) {
      throw new Error('Unable to determine MP4 file size');
    }

    // Calculate segment range
    const start = segmentIndex * SEGMENT_SIZE;
    const end = Math.min(start + SEGMENT_SIZE - 1, totalSize - 1);
    const range = `bytes=${start}-${end}`;

    // Fetch the segment
    const response = await globalThis.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
        'Range': range,
        ...headers,
      }
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`Failed to fetch MP4 segment: ${response.status} ${response.statusText}`);
    }

    const segmentData = new Uint8Array(await response.arrayBuffer());
    const browser = detectBrowser(getHeaders(event)['user-agent'] || '');
    const responseHeaders = getBrowserSpecificHeaders(browser, segmentData.length, false);

    setResponseHeaders(event, {
      ...responseHeaders,
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'X-Segment-Index': segmentIndex.toString(),
      'X-Segment-Start': start.toString(),
      'X-Segment-End': end.toString(),
    });

    setResponseStatus(event, 206);
    return segmentData;
  } catch (error: any) {
    console.error('Error fetching MP4 segment:', error);
    throw error;
  }
}

/**
 * Handle progressive streaming (serves multiple segments at once)
 */
async function getMP4Progressive(event: any, url: string, headers: Record<string, string>, startSegment: number = 0) {
  try {
    // Get file size first
    const headResponse = await globalThis.fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
        ...headers,
      }
    });

    if (!headResponse.ok) {
      throw new Error(`Failed to get MP4 info: ${headResponse.status} ${headResponse.statusText}`);
    }

    const totalSize = parseInt(headResponse.headers.get('content-length') || '0', 10);
    if (!totalSize) {
      throw new Error('Unable to determine MP4 file size');
    }

    const totalSegments = Math.ceil(totalSize / SEGMENT_SIZE);
    const segmentsToServe = Math.min(MAX_SEGMENTS_PER_REQUEST, totalSegments - startSegment);

    const segmentBuffers: Uint8Array[] = [];

    // Fetch segments sequentially
    for (let i = 0; i < segmentsToServe; i++) {
      const segmentIndex = startSegment + i;
      const start = segmentIndex * SEGMENT_SIZE;
      const end = Math.min(start + SEGMENT_SIZE - 1, totalSize - 1);
      const range = `bytes=${start}-${end}`;

      const response = await globalThis.fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
          'Range': range,
          ...headers,
        }
      });

      if (!response.ok && response.status !== 206) {
        console.warn(`Failed to fetch segment ${segmentIndex}, stopping progressive stream`);
        break;
      }

      const segmentData = new Uint8Array(await response.arrayBuffer());
      segmentBuffers.push(segmentData);
    }

    // Combine all segments
    const totalLength = segmentBuffers.reduce((sum, buf) => sum + buf.length, 0);
    const combinedData = new Uint8Array(totalLength);

    let offset = 0;
    for (const segment of segmentBuffers) {
      combinedData.set(segment, offset);
      offset += segment.length;
    }

    const browser = detectBrowser(getHeaders(event)['user-agent'] || '');
    const responseHeaders = getBrowserSpecificHeaders(browser, combinedData.length, false);

    setResponseHeaders(event, {
      ...responseHeaders,
      'X-Start-Segment': startSegment.toString(),
      'X-Segments-Served': segmentBuffers.length.toString(),
      'X-Total-Segments': totalSegments.toString(),
    });

    return combinedData;
  } catch (error: any) {
    console.error('Error in progressive streaming:', error);
    throw error;
  }
}

/**
 * Handle chunked MP4 streaming (serves individual chunks)
 */
async function handleChunkedRequest(event: any, url: string, headers: Record<string, string>) {
  try {
    const browser = detectBrowser(getHeaders(event)['user-agent'] || '');
    const capabilities = BROWSER_CAPABILITIES[browser as keyof typeof BROWSER_CAPABILITIES] || BROWSER_CAPABILITIES.other;

    // Safari doesn't support chunked MP4 streaming well, redirect to regular proxying
    if (!capabilities.supportsChunked) {
      console.log(`Browser ${browser} doesn't support chunked MP4 streaming, falling back to regular proxying`);
      return await proxyMP4(event);
    }

    // Use browser-specific User-Agent for HEAD request too
    let userAgent: string;
    switch (browser) {
      case 'safari':
        userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
        break;
      case 'firefox':
        userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0';
        break;
      case 'chrome':
      case 'brave':
      default:
        userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
        break;
    }

    // Get file size first
    const headResponse = await globalThis.fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': userAgent,
        ...headers,
      }
    });

    if (!headResponse.ok) {
      throw new Error(`Failed to get MP4 info: ${headResponse.status} ${headResponse.statusText}`);
    }

    const totalSize = parseInt(headResponse.headers.get('content-length') || '0', 10);
    if (!totalSize) {
      throw new Error('Unable to determine MP4 file size');
    }

    let chunkIndex = mp4ChunkManager.parseChunkIndex(event);
    let start: number, end: number;
    const chunkSize = capabilities.chunkSize;

    if (chunkIndex === null) {
      // Check if there's a Range header for seeking
      const rangeHeader = getHeaders(event)['range'] || getHeaders(event)['Range'];
      if (rangeHeader && rangeHeader.startsWith('bytes=')) {
        const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (rangeMatch) {
          start = parseInt(rangeMatch[1], 10);
          const endStr = rangeMatch[2];

          // Respect the browser's exact range request for proper MP4 streaming
          end = endStr ? parseInt(endStr, 10) : Math.min(start + chunkSize - 1, totalSize - 1); // Use browser-specific chunk size
        } else {
          // Invalid range, start from beginning with headers
          start = 0;
          end = Math.min(2 * 1024 * 1024 - 1, totalSize - 1); // 2MB for headers
        }
      } else {
        // No range header, start from beginning with headers
        start = 0;
        end = Math.min(2 * 1024 * 1024 - 1, totalSize - 1); // 2MB for headers
      }
    } else {
      // Specific chunk requested
      start = chunkIndex * chunkSize;
      end = Math.min(start + chunkSize - 1, totalSize - 1);
    }

    const range = `bytes=${start}-${end}`;

    const response = await globalThis.fetch(url, {
      headers: {
        'User-Agent': userAgent,
        'Range': range,
        ...headers,
      }
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`Failed to fetch MP4 chunk: ${response.status} ${response.statusText}`);
    }

    const chunkData = new Uint8Array(await response.arrayBuffer());
    const responseHeaders = getBrowserSpecificHeaders(browser, chunkData.length, true, totalSize);

    setResponseHeaders(event, {
      ...responseHeaders,
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'X-Chunked-Response': 'true',
      ...(chunkIndex !== null && { 'X-Chunk-Index': chunkIndex.toString() }),
    });

    setResponseStatus(event, 206);
    return chunkData;
  } catch (error: any) {
    console.error('Error in chunked streaming:', error);
    throw error;
  }
}

/**
 * Handle regular MP4 proxying with browser-specific optimizations
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
    const requestHeaders = getHeaders(event);
    const rangeHeader = requestHeaders['range'] || requestHeaders['Range'];
    const browser = detectBrowser(requestHeaders['user-agent'] || '');
    const capabilities = BROWSER_CAPABILITIES[browser as keyof typeof BROWSER_CAPABILITIES] || BROWSER_CAPABILITIES.other;

    console.log(`MP4 proxy for ${browser}: range=${rangeHeader}, preferFullFile=${capabilities.preferFullFile}`);

    // Use browser-specific User-Agent strings for better compatibility
    let userAgent: string;
    switch (browser) {
      case 'safari':
        userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
        break;
      case 'firefox':
        userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0';
        break;
      case 'chrome':
      case 'brave':
      default:
        userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
        break;
    }

    const fetchHeaders: Record<string, string> = {
      'User-Agent': userAgent,
      ...(headers as Record<string, string>),
    };

    // For browsers that prefer full file access (Firefox, Safari), handle Range headers carefully
    if (capabilities.preferFullFile) {
      // For Firefox and Safari, let them handle their own range requests
      // Don't interfere with their seeking mechanism
      if (rangeHeader && browser === 'firefox') {
        // Firefox can handle some range requests but needs full file context
        fetchHeaders['Range'] = rangeHeader;
        console.log(`Firefox range request: ${rangeHeader}`);
      }
      // Safari gets full file always to avoid timeout issues
    } else if (rangeHeader && capabilities.useRangeRequests) {
      fetchHeaders['Range'] = rangeHeader;
    }

    // For Safari and Firefox, ensure we get the full response without range limitations
    const fetchOptions: any = {
      method: 'GET',
      headers: fetchHeaders,
      redirect: 'follow',
    };

    // Safari-specific handling - ensure clean requests
    if (browser === 'safari') {
      // Safari works best with simple, direct requests
      console.log('Safari MP4 request - using simplified handling');
    }

    await specificProxyRequest(event, url, {
      fetchOptions,
      onResponse(outputEvent, response) {
        const contentRange = response.headers.get('content-range');
        const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
        const isPartialContent = response.status === 206;
        const browser = detectBrowser(getHeaders(event)['user-agent'] || '');
        const totalSize = isPartialContent && contentRange ?
          parseInt(contentRange.split('/')[1], 10) :
          contentLength;

        console.log(`MP4 response for ${browser}: status=${response.status}, contentLength=${contentLength}, totalSize=${totalSize}, isPartial=${isPartialContent}`);

        // Use optimized headers for inline playback with total size info
        const responseHeaders = getBrowserSpecificHeaders(browser, contentLength, false, totalSize);

        if (isPartialContent && contentRange) {
          responseHeaders['Content-Range'] = contentRange;
          console.log(`Setting Content-Range: ${contentRange}`);
        }

        setResponseHeaders(outputEvent, responseHeaders);
      },
    });
  } catch (error: any) {
    console.error('Error proxying MP4:', error);
    return sendError(event, createError({
      statusCode: error.response?.status || 500,
      statusMessage: error.message || 'Error proxying MP4 file'
    }));
  }
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
    // Handle HEAD requests
    if (event.method === 'HEAD') {
      return await proxyMP4(event);
    }

    // Handle different streaming modes based on browser capabilities
    const segmentIndex = getQuery(event).segment;
    const progressive = getQuery(event).progressive;
    const playlist = getQuery(event).playlist;
    const chunked = getQuery(event).chunked;
    const browser = detectBrowser(getHeaders(event)['user-agent'] || '');
    const capabilities = BROWSER_CAPABILITIES[browser as keyof typeof BROWSER_CAPABILITIES] || BROWSER_CAPABILITIES.other;

    // Check for explicit chunked request - but only allow if browser supports it
    if ((chunked === 'true' || chunked === '') && capabilities.supportsChunked) {
      return await handleChunkedRequest(event, url, headers as Record<string, string>);
    }

    // Check for playlist request
    if (playlist === 'true' || playlist === '') {
      return await getMP4Playlist(event, url, headers as Record<string, string>);
    }

    // Check for specific segment request
    if (segmentIndex !== undefined) {
      const index = parseInt(segmentIndex as string, 10);
      if (isNaN(index)) {
        return sendError(event, createError({
          statusCode: 400,
          statusMessage: 'Invalid segment index'
        }));
      }
      return await getMP4Segment(event, url, index, headers as Record<string, string>);
    }

    // Check for progressive streaming request
    if (progressive === 'true' || progressive === '') {
      const startSegment = parseInt((getQuery(event).start as string) || '0', 10);
      return await getMP4Progressive(event, url, headers as Record<string, string>, startSegment);
    }

    // Default behavior based on browser capabilities and request type
    const requestHeaders = getHeaders(event);
    const rangeHeader = requestHeaders['range'] || requestHeaders['Range'];

    // For browsers that prefer full file access (Firefox, Safari), always use direct proxying
    if (capabilities.preferFullFile) {
      console.log(`Browser ${browser} prefers full file access, using direct proxying`);
      return await proxyMP4(event);
    }

    // For other browsers, use the appropriate streaming method
    if (rangeHeader && capabilities.useRangeRequests) {
      // Handle seeking with Range header - use direct proxying for proper MP4 seeking
      return await proxyMP4(event);
    } else if (capabilities.supportsProgressive && !rangeHeader) {
      // No range header - use progressive streaming for auto-play (if supported)
      const startSegment = parseInt((getQuery(event).start as string) || '0', 10);
      return await getMP4Progressive(event, url, headers as Record<string, string>, startSegment);
    } else {
      // Fall back to direct proxying
      return await proxyMP4(event);
    }
  } catch (error: any) {
    console.error('Error in MP4 proxy handler:', error);
    return sendError(event, createError({
      statusCode: error.response?.status || 500,
      statusMessage: error.message || 'Error processing MP4 request'
    }));
  }
});