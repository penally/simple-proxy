import { setResponseHeaders } from 'h3';
import config from '../utils/config';

// Import the functions from m3u8-proxy
import { getCacheStats, cleanupCache } from './m3u8-proxy';

export default defineEventHandler(async (event) => {
  // Handle CORS preflight requests
  if (event.node.req.method === 'OPTIONS') {
    setResponseHeaders(event, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*'
    });
    return '';
  }

  cleanupCache();
  setResponseHeaders(event, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*'
  });

  const stats = getCacheStats();
  return {
    ...stats,
    config: {
      DISABLE_CACHE: config.DISABLE_CACHE,
      DISABLE_M3U8: config.DISABLE_M3U8,
      ENABLE_REDIS: config.ENABLE_REDIS
    }
  };
});
