import { cacheAnalytics, redisCache } from '../utils/redis-cache';
import {
  setResponseHeaders,
  getQuery,
  sendError,
  createError,
  isPreflightRequest,
  handleCors
} from 'h3';

export default defineEventHandler(async (event) => {
  // Handle CORS preflight requests
  if (isPreflightRequest(event)) return handleCors(event, {});

  try {
    const analytics = cacheAnalytics.getStats();
    const redisStats = redisCache.getStats();

    // Calculate additional metrics
    const totalMemorySaved = analytics.totalRequests > 0 ?
      Math.floor((parseFloat(analytics.compressionSavings.replace('%', '')) / 100) *
                 parseInt(analytics.avgSegmentSize.replace(' bytes', '').replace(',', '')) *
                 analytics.totalRequests) : 0;

    const response = {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      performance: {
        cache_hit_rate: analytics.hitRate,
        total_requests: analytics.totalRequests,
        cache_hits: analytics.hits,
        cache_misses: analytics.misses,
        average_segment_size: analytics.avgSegmentSize,
        compression_savings: analytics.compressionSavings,
        estimated_memory_saved: `${totalMemorySaved.toLocaleString()} bytes`
      },
      redis: {
        connected: redisStats.connected,
        host: redisStats.host,
        port: redisStats.port,
        expiry_hours: redisStats.expiryHours
      },
      recommendations: {
        cache_efficiency: parseFloat(analytics.hitRate.replace('%', '')) > 80 ? 'Excellent' :
                         parseFloat(analytics.hitRate.replace('%', '')) > 60 ? 'Good' : 'Needs improvement',
        memory_usage: parseFloat(analytics.compressionSavings.replace('%', '')) > 60 ? 'Optimal' : 'Could be better'
      }
    };

    setResponseHeaders(event, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*'
    });

    return response;
  } catch (error: any) {
    console.error('Error generating cache analytics:', error);
    return sendError(event, createError({
      statusCode: 500,
      statusMessage: 'Error generating analytics'
    }));
  }
});
