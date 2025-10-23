import { readFileSync } from 'fs';
import { join } from 'path';

interface Config {
  DISABLE_CACHE: boolean;
  DISABLE_PROXY: boolean;
  DISABLE_M3U8: boolean;
  DISABLE_MP4: boolean;
  ENABLE_REDIS: boolean;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD: string;
  REDIS_DB: number;
  TURNSTILE_SECRET: string;
  JWT_SECRET: string;
  REQ_DEBUG: boolean;
}

let config: Config;

try {
  const configPath = join(process.cwd(), 'config.json');
  const configData = JSON.parse(readFileSync(configPath, 'utf8'));

  // Type the config and provide defaults
  config = {
    DISABLE_CACHE: configData.DISABLE_CACHE ?? false,
    DISABLE_PROXY: configData.DISABLE_PROXY ?? false,
    DISABLE_M3U8: configData.DISABLE_M3U8 ?? false,
    DISABLE_MP4: configData.DISABLE_MP4 ?? false,
    ENABLE_REDIS: configData.ENABLE_REDIS ?? false,
    REDIS_HOST: configData.REDIS_HOST ?? 'localhost',
    REDIS_PORT: configData.REDIS_PORT ?? 6379,
    REDIS_PASSWORD: configData.REDIS_PASSWORD ?? '',
    REDIS_DB: configData.REDIS_DB ?? 0,
    TURNSTILE_SECRET: configData.TURNSTILE_SECRET ?? '',
    JWT_SECRET: configData.JWT_SECRET ?? '',
    REQ_DEBUG: configData.REQ_DEBUG ?? false,
  };
} catch (error) {
  console.warn('Warning: Could not load config.json, using default values');
  config = {
    DISABLE_CACHE: false,
    DISABLE_PROXY: false,
    DISABLE_M3U8: false,
    DISABLE_MP4: false,
    ENABLE_REDIS: false,
    REDIS_HOST: 'localhost',
    REDIS_PORT: 6379,
    REDIS_PASSWORD: '',
    REDIS_DB: 0,
    TURNSTILE_SECRET: '',
    JWT_SECRET: '',
    REQ_DEBUG: false,
  };
}

export default config;
