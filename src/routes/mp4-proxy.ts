import { setResponseHeaders, getHeaders } from 'h3';

// Check if MP4 proxying is disabled via environment variable
const isMp4ProxyDisabled = () => process.env.DISABLE_MP4 === 'true';

/**
 * Proxies MP4 files with support for chunked streaming and range requests
 * This enables fast seeking by loading only requested byte ranges instead of the full file
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
    // Check for Range header in the incoming request for chunked seeking
    const requestHeaders = getHeaders(event);
    const rangeHeader = requestHeaders['range'] || requestHeaders['Range'];

    const fetchHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
      ...(headers as Record<string, string>),
    };

    // Forward Range header if present for partial content requests
    if (rangeHeader) {
      fetchHeaders['Range'] = rangeHeader;
    }

    const response = await globalThis.fetch(url, {
      method: 'GET',
      headers: fetchHeaders,
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`Failed to fetch MP4: ${response.status} ${response.statusText}`);
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    const contentRange = response.headers.get('content-range');
    const isPartialContent = response.status === 206;

    // Set appropriate headers based on whether this is a partial content response
    const responseHeaders: Record<string, string> = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      // Prevent caching to ensure fresh loads and proper seeking
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    };

    if (isPartialContent) {
      // Partial content response
      responseHeaders['Content-Range'] = contentRange || '';
      responseHeaders['Content-Length'] = contentLength.toString();
      setResponseStatus(event, 206);
    } else {
      // Full content response
      responseHeaders['Content-Length'] = contentLength.toString();
      responseHeaders['Transfer-Encoding'] = 'chunked';
      setResponseStatus(event, 200);
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
      // Check for Range header in HEAD request
      const requestHeaders = getHeaders(event);
      const rangeHeader = requestHeaders['range'] || requestHeaders['Range'];

      const fetchHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
        ...(headers as Record<string, string>),
      };

      // Forward Range header for HEAD requests if present
      if (rangeHeader) {
        fetchHeaders['Range'] = rangeHeader;
      }

      // Get content info for HEAD request
      const headResponse = await globalThis.fetch(url, {
        method: 'HEAD',
        headers: fetchHeaders,
      });

      if (!headResponse.ok && headResponse.status !== 206) {
        throw new Error(`Failed to fetch MP4 headers: ${headResponse.status} ${headResponse.statusText}`);
      }

      const contentLength = parseInt(headResponse.headers.get('content-length') || '0', 10);
      const contentRange = headResponse.headers.get('content-range');
      const isPartialContent = headResponse.status === 206;

      // Set appropriate headers based on whether this is a partial content response
      const responseHeaders: Record<string, string> = {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        // Prevent caching to ensure fresh loads
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      };

      if (isPartialContent && contentRange) {
        responseHeaders['Content-Range'] = contentRange;
        responseHeaders['Content-Length'] = contentLength.toString();
        setResponseStatus(event, 206);
      } else {
        responseHeaders['Content-Length'] = contentLength.toString();
        setResponseStatus(event, 200);
      }

      setResponseHeaders(event, responseHeaders);
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
