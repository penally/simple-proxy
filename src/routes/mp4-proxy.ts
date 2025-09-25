import { setResponseHeaders } from 'h3';

// Check if MP4 proxying is disabled via environment variable
const isMp4ProxyDisabled = () => process.env.DISABLE_MP4 === 'true';

/**
 * Proxies MP4 files by serving the complete file with chunked streaming
 * This enables proper seeking since MP4 players need the full file structure
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
    // Always fetch the complete MP4 file for proper seeking
    const response = await globalThis.fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
        ...(headers as HeadersInit),
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch MP4: ${response.status} ${response.statusText}`);
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);

    // Set headers for complete MP4 file with seeking support
    setResponseHeaders(event, {
      'Content-Type': 'video/mp4',
      'Content-Length': contentLength.toString(),
      'Accept-Ranges': 'bytes', // Advertise seeking support
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      // Prevent caching to ensure fresh loads and proper seeking
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Transfer-Encoding': 'chunked', // Enable chunked transfer for streaming
    });

    setResponseStatus(event, 200); // Always return 200 OK for complete file

    // Return the response body as a stream for chunked transfer
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

      // Return headers for HEAD request indicating full file availability
      setResponseHeaders(event, {
        'Content-Type': 'video/mp4',
        'Content-Length': contentLength.toString(),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        // Prevent caching to ensure fresh loads
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });

      setResponseStatus(event, 200); // Always 200 for complete file info
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
