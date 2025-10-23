import { getQuery } from 'h3';

export interface MP4ChunkInfo {
  index: number;
  start: number;
  end: number;
  size: number;
  url: string;
}

export interface MP4Manifest {
  url: string;
  totalSize: number;
  chunkSize: number;
  totalChunks: number;
  chunks: MP4ChunkInfo[];
  headers: Record<string, string>;
}

// Default chunk size: Small chunks like TS segments for efficient streaming
const DEFAULT_CHUNK_SIZE = 256 * 1024; // 256KB (like TS segments)

export class MP4ChunkManager {
  private chunkSize: number;

  constructor(chunkSize: number = DEFAULT_CHUNK_SIZE) {
    this.chunkSize = chunkSize;
  }

  /**
   * Generate chunk information for an MP4 file
   */
  generateManifest(
    url: string,
    totalSize: number,
    headers: Record<string, string> = {},
    customChunkSize?: number
  ): MP4Manifest {
    const chunkSize = customChunkSize || this.chunkSize;
    const totalChunks = Math.ceil(totalSize / chunkSize);

    const chunks: MP4ChunkInfo[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize - 1, totalSize - 1);
      const size = end - start + 1;

      chunks.push({
        index: i,
        start,
        end,
        size,
        url: this.getChunkUrl(url, i, headers)
      });
    }

    return {
      url,
      totalSize,
      chunkSize,
      totalChunks,
      chunks,
      headers
    };
  }

  /**
   * Get the range header for a specific chunk
   */
  getChunkRange(chunkIndex: number, totalSize: number): string {
    const start = chunkIndex * this.chunkSize;
    const end = Math.min(start + this.chunkSize - 1, totalSize - 1);
    return `bytes=${start}-${end}`;
  }

  /**
   * Generate URL for a specific chunk
   */
  getChunkUrl(url: string, chunkIndex: number, headers: Record<string, string>): string {
    const headersParam = encodeURIComponent(JSON.stringify(headers));
    return `/mp4-proxy?url=${encodeURIComponent(url)}&chunk=${chunkIndex}&headers=${headersParam}`;
  }

  /**
   * Generate cache key for a chunk
   */
  getChunkCacheKey(url: string, chunkIndex: number): string {
    return `mp4_chunk:${Buffer.from(url).toString('base64')}:chunk_${chunkIndex}`;
  }

  /**
   * Extract chunk index from query parameters
   */
  parseChunkIndex(event: any): number | null {
    const chunkParam = getQuery(event).chunk as string;
    if (!chunkParam) return null;

    const chunkIndex = parseInt(chunkParam, 10);
    return isNaN(chunkIndex) ? null : chunkIndex;
  }

  /**
   * Check if request is for chunked streaming
   */
  isChunkedRequest(event: any): boolean {
    return getQuery(event).chunked === 'true' || this.parseChunkIndex(event) !== null;
  }
}

// Singleton instance
export const mp4ChunkManager = new MP4ChunkManager();
