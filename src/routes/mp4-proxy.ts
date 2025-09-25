import { setResponseHeaders } from 'h3';

// Check if MP4 proxying is disabled via environment variable
const isMp4ProxyDisabled = () => process.env.DISABLE_MP4 === 'true';

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

    // Return the response body as a stream to avoid memory buffering
    return response.body;
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

  return await proxyMP4(event);
});
