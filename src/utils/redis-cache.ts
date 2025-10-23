import { createClient, RedisClientType } from 'redis';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import config from './config';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

interface CacheEntry {
  data: Uint8Array;
  headers: Record<string, string>;
  timestamp: number;
}

interface CacheStorageFormat {
  data: string; // base64 encoded
  headers: Record<string, string>;
  timestamp: number;
  version?: number; // 1 = uncompressed (legacy), 2 = compressed
}

class RedisCache {
  private client: RedisClientType | null = null;
  private isConnected: boolean = false;
  private readonly CACHE_EXPIRY_SECONDS = 2 * 60 * 60; // 2 hours
  private readonly redisEnabled: boolean;

  constructor() {
    this.redisEnabled = config.ENABLE_REDIS;

    if (!this.redisEnabled) {
      console.log('Redis is disabled in config');
      return;
    }

    const host = config.REDIS_HOST;
    const port = config.REDIS_PORT;
    const password = config.REDIS_PASSWORD;
    const db = config.REDIS_DB;

    console.log(`Redis config: ${host}:${port} db:${db}`);

    this.client = createClient({
      url: `redis://:${password}@${host}:${port}/${db}`,
      // Connection options for maximum efficiency
      socket: {
        connectTimeout: 10000,
        keepAlive: 60000, // Extended keep-alive
        reconnectStrategy: (times: number) => {
          const delay = Math.min(times * 100, 3000);
          console.log(`Redis reconnect attempt ${times}, delay: ${delay}ms`);
          return delay;
        }
      },
      // Performance optimizations
      commandsQueueMaxLength: 1000, // Handle more concurrent commands
      disableOfflineQueue: false, // Queue commands when offline
    });

    this.setupEventHandlers();
    this.connect();
  }

  private setupEventHandlers() {
    if (!this.client) return;

    this.client.on('error', (err) => {
      console.error('Redis Client Error:', err);
      this.isConnected = false;
    });

    this.client.on('connect', () => {
      console.log('Connected to Redis');
      this.isConnected = true;
    });

    this.client.on('disconnect', () => {
      console.log('Disconnected from Redis');
      this.isConnected = false;
    });
  }

  private async connect() {
    if (!this.client) return;

    try {
      await this.client.connect();
    } catch (error) {
      console.error('Failed to connect to Redis:', error);
      // Continue without Redis - fallback to in-memory cache if needed
    }
  }

  private getCacheKey(url: string): string {
    // Use a consistent key format for TS segments
    return `ts_segment:${Buffer.from(url).toString('base64')}`;
  }

  private getMP4ChunkKey(url: string, chunkIndex: number): string {
    // Use a consistent key format for MP4 chunks
    return `mp4_chunk:${Buffer.from(url).toString('base64')}:chunk_${chunkIndex}`;
  }

  async get(url: string): Promise<CacheEntry | null> {
    if (!this.isConnected || !this.client) {
      return null;
    }

    try {
      const key = this.getCacheKey(url);
      const data = await this.client.get(key);

      if (!data) {
        return null;
      }

      // Parse the JSON data
      const parsed: CacheStorageFormat = JSON.parse(data);

      // Handle both compressed (version 2) and uncompressed (version 1 or undefined) data formats
      const rawData = Buffer.from(parsed.data, 'base64');
      let finalData: Buffer;

      if (parsed.version === 2) {
        // New compressed format
        finalData = await gunzipAsync(rawData);
      } else {
        // Legacy uncompressed format (version 1 or undefined)
        finalData = rawData;
      }

      const uint8Array = new Uint8Array(finalData);

      return {
        data: uint8Array,
        headers: parsed.headers,
        timestamp: parsed.timestamp
      };
    } catch (error) {
      console.error('Redis get error:', error);
      return null;
    }
  }

  async set(url: string, entry: CacheEntry): Promise<void> {
    if (!this.isConnected || !this.client) {
      return;
    }

    try {
      const key = this.getCacheKey(url);

      // Compress the data before converting to base64
      const compressedData = await gzipAsync(Buffer.from(entry.data));
      const dataToStore: CacheStorageFormat = {
        data: compressedData.toString('base64'),
        headers: entry.headers,
        timestamp: entry.timestamp,
        version: 2 // Compressed format
      };

      await this.client.setEx(key, this.CACHE_EXPIRY_SECONDS, JSON.stringify(dataToStore));
    } catch (error) {
      console.error('Redis set error:', error);
    }
  }

  async delete(url: string): Promise<void> {
    if (!this.isConnected || !this.client) {
      return;
    }

    try {
      const key = this.getCacheKey(url);
      await this.client.del(key);
    } catch (error) {
      console.error('Redis delete error:', error);
    }
  }

  async cleanup(): Promise<void> {
    // Redis automatically expires keys, but we can add cleanup logic if needed
    // For now, just log connection status
    console.log(`Redis cache status: ${this.isConnected ? 'connected' : 'disconnected'}`);
  }

  isCacheDisabled(): boolean {
    return config.DISABLE_CACHE || !this.redisEnabled || !this.isConnected;
  }

  // MP4 Chunk-specific methods
  async getMP4Chunk(url: string, chunkIndex: number): Promise<CacheEntry | null> {
    if (!this.isConnected || !this.client) {
      return null;
    }

    try {
      const key = this.getMP4ChunkKey(url, chunkIndex);
      const data = await this.client.get(key);

      if (!data) {
        return null;
      }

      // Parse the JSON data
      const parsed: CacheStorageFormat = JSON.parse(data);

      // Handle both compressed (version 2) and uncompressed (version 1 or undefined) data formats
      const rawData = Buffer.from(parsed.data, 'base64');
      let finalData: Buffer;

      if (parsed.version === 2) {
        // New compressed format
        finalData = await gunzipAsync(rawData);
      } else {
        // Legacy uncompressed format (version 1 or undefined)
        finalData = rawData;
      }

      const uint8Array = new Uint8Array(finalData);

      return {
        data: uint8Array,
        headers: parsed.headers,
        timestamp: parsed.timestamp
      };
    } catch (error) {
      console.error('Redis getMP4Chunk error:', error);
      return null;
    }
  }

  async setMP4Chunk(url: string, chunkIndex: number, entry: CacheEntry): Promise<void> {
    if (!this.isConnected || !this.client) {
      return;
    }

    try {
      const key = this.getMP4ChunkKey(url, chunkIndex);

      // Compress the data before converting to base64
      const compressedData = await gzipAsync(Buffer.from(entry.data));
      const dataToStore: CacheStorageFormat = {
        data: compressedData.toString('base64'),
        headers: entry.headers,
        timestamp: entry.timestamp,
        version: 2 // Compressed format
      };

      await this.client.setEx(key, this.CACHE_EXPIRY_SECONDS, JSON.stringify(dataToStore));
    } catch (error) {
      console.error('Redis setMP4Chunk error:', error);
    }
  }

  async deleteMP4Chunk(url: string, chunkIndex: number): Promise<void> {
    if (!this.isConnected || !this.client) {
      return;
    }

    try {
      const key = this.getMP4ChunkKey(url, chunkIndex);
      await this.client.del(key);
    } catch (error) {
      console.error('Redis deleteMP4Chunk error:', error);
    }
  }

  getStats(): any {
    return {
      enabled: this.redisEnabled,
      connected: this.isConnected,
      expirySeconds: this.CACHE_EXPIRY_SECONDS,
      host: config.REDIS_HOST,
      port: config.REDIS_PORT
    };
  }
}

// Cache analytics
class CacheAnalytics {
  private hits = 0;
  private misses = 0;
  private totalRequests = 0;
  private totalUncompressedBytes = 0;
  private totalCompressedBytes = 0;

  recordHit(uncompressedBytes: number) {
    this.hits++;
    this.totalRequests++;
    this.totalUncompressedBytes += uncompressedBytes;
  }

  recordMiss(uncompressedBytes: number, compressedBytes: number) {
    this.misses++;
    this.totalRequests++;
    this.totalUncompressedBytes += uncompressedBytes;
    this.totalCompressedBytes += compressedBytes;
  }

  getStats() {
    const hitRate = this.totalRequests > 0 ? (this.hits / this.totalRequests * 100).toFixed(1) : '0.0';
    const avgUncompressed = this.totalRequests > 0 ? (this.totalUncompressedBytes / this.totalRequests).toFixed(0) : '0';
    const compressionRatio = this.totalCompressedBytes > 0 ?
      ((1 - this.totalCompressedBytes / this.totalUncompressedBytes) * 100).toFixed(1) : '0.0';

    return {
      hitRate: `${hitRate}%`,
      totalRequests: this.totalRequests,
      hits: this.hits,
      misses: this.misses,
      avgSegmentSize: `${avgUncompressed} bytes`,
      compressionSavings: `${compressionRatio}%`
    };
  }
}

const cacheAnalytics = new CacheAnalytics();

// Singleton instance
const redisCache = new RedisCache();

export { redisCache, cacheAnalytics, type CacheEntry };
