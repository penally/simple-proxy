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
 * Proxies MP4 files with intelligent range request handling for efficient seeking
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
    // First, check if upstream server supports ranges
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
    const acceptRanges = headResponse.headers.get('accept-ranges') || 'none';

    // Check if client requested a range
    const rangeHeader = getHeader(event, 'range');
    const supportsRanges = acceptRanges === 'bytes';
    let start = 0;
    let end = contentLength - 1;
    let isPartial = false;

    if (rangeHeader && supportsRanges) {
      const range = parseRangeHeader(rangeHeader, contentLength);
      if (range) {
        start = range.start;
        end = range.end;
        isPartial = true;
      }
    }

    // Prepare request headers
    const requestHeaders = new Headers({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
      ...(headers as Record<string, string>),
    });

    // Add range header only if upstream supports ranges and we have a valid range
    if (isPartial && supportsRanges) {
      requestHeaders.set('Range', `bytes=${start}-${end}`);
    }

    // Fetch the content (full file or range)
    const response = await globalThis.fetch(url, {
      method: 'GET',
      headers: requestHeaders,
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`Failed to fetch MP4: ${response.status} ${response.statusText}`);
    }

    // Set appropriate headers for MP4 response
    const responseHeaders: Record<string, string> = {
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Accept-Ranges': 'bytes', // Always advertise range support for seeking
    };

    if (isPartial && supportsRanges) {
      // Range request response
      const actualRange = response.headers.get('content-range');
      const actualLength = response.headers.get('content-length');

      responseHeaders['Content-Range'] = actualRange || `bytes ${start}-${end}/${contentLength}`;
      responseHeaders['Content-Length'] = actualLength || (end - start + 1).toString();

      // Prevent caching of range requests to ensure proper seeking
      responseHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      responseHeaders['Pragma'] = 'no-cache';
      responseHeaders['Expires'] = '0';

      setResponseStatus(event, 206); // Partial Content
    } else {
      // Full file response
      responseHeaders['Content-Length'] = contentLength.toString();
      // Allow light caching for full file requests
      responseHeaders['Cache-Control'] = 'public, max-age=60';
      setResponseStatus(event, 200); // OK
    }

    setResponseHeaders(event, responseHeaders);

    // Return the response body as a stream
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

  // Handle HEAD requests for seeking support
  if (event.method === 'HEAD') {
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
      // Get content info for HEAD request
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
      const upstreamAcceptRanges = headResponse.headers.get('accept-ranges') || 'none';

      // Return headers for HEAD request indicating range support when available
      setResponseHeaders(event, {
        'Content-Type': 'video/mp4',
        'Content-Length': contentLength.toString(),
        'Accept-Ranges': 'bytes', // Always advertise bytes support for seeking
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        // Light caching for HEAD requests
        'Cache-Control': 'public, max-age=60',
      });

      setResponseStatus(event, 200); // OK for HEAD
      return ''; // Empty body for HEAD request
    } catch (error: any) {
      console.error('Error handling HEAD request:', error);
      return sendError(event, createError({
        statusCode: error.response?.status || 500,
        statusMessage: error.message || 'Error proxying MP4 HEAD request'
      }));
    }
  }

  return await proxyMP4(event);
});
