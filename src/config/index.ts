/* eslint-disable no-undef */
import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';
import '../shared/zodV3Messages';

dotenv.config({ path: path.join(process.cwd(), '.env') });

// 15 MB: the backend's PDF previews (PREVIEW_MAX_BYTES) are up to 15 MB.
const MAX_FILE_BYTES_CAP = 15 * 1024 * 1024;
const KINDS = ['image', 'video', 'document'] as const;

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform(v => v === 'true' || v === '1');
const csv = z.string().transform(v =>
  v
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
// Env strings are parsed, so string defaults use .prefault (zod 4's .default skips parsing).
// Durations in hours, e.g. TRASH_RETENTION_HOURS=168
const hours = z.coerce.number().positive();

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(5000),
  METRICS_PORT: z.coerce.number().int().default(9090),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5000'),
  DATABASE_URL: z.string().min(1),
  STORAGE_PATH: z.string().default(path.join(process.cwd(), '.data')),
  LOG_LEVEL: z.string().default('info'),
  TRUSTED_PROXIES: csv.prefault('loopback'),

  MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_FILE_BYTES_CAP)
    .default(MAX_FILE_BYTES_CAP),
  ALLOWED_KINDS: csv
    .pipe(z.array(z.enum(KINDS)))
    .prefault('image,video,document'),
  RATE_LIMIT_RPS: z.coerce.number().positive().default(20),
  REQUIRE_ACCOUNT: bool.prefault('false'),
  DEFAULT_ACCOUNT_QUOTA_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .default(5 * 1024 * 1024 * 1024), // 0 = unlimited
  MIN_FREE_DISK_PERCENT: z.coerce.number().min(0).max(100).default(10),

  MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(50_000_000),
  IMAGE_JPEG_QUALITY: z.coerce.number().int().min(1).max(100).default(80),
  IMAGE_WEBP_QUALITY: z.coerce.number().int().min(1).max(100).default(80),
  IMAGE_AVIF_QUALITY: z.coerce.number().int().min(1).max(100).default(55),
  IMAGE_PNG_QUALITY: z.coerce.number().int().min(1).max(100).default(80),
  IMAGE_MIN_SAVING_PERCENT: z.coerce.number().min(0).max(100).default(5),
  VARIANT_WIDTHS: csv
    .pipe(z.array(z.coerce.number<string>().int().positive()))
    .prefault('64,128,256,512,768,1024,1536,2048'),
  VARIANT_FORMATS: csv
    .pipe(z.array(z.enum(['jpg', 'png', 'webp', 'avif'])))
    .prefault('jpg,png,webp,avif'),
  VARIANT_CACHE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024 * 1024),

  PENDING_TTL_HOURS: hours.default(24),
  TRASH_RETENTION_HOURS: hours.default(168),

  CDN_PROVIDER: z.enum(['none', 'cloudflare']).default('none'),
  CF_ZONE_ID: z.string().optional(),
  CF_API_TOKEN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Refuse to start on invalid config.
  console.error('Invalid configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const env = parsed.data;
if (
  env.CDN_PROVIDER === 'cloudflare' &&
  (!env.CF_ZONE_ID || !env.CF_API_TOKEN)
) {
  console.error('CDN_PROVIDER=cloudflare requires CF_ZONE_ID and CF_API_TOKEN');
  process.exit(1);
}

export default {
  env: env.NODE_ENV,
  port: env.PORT,
  metricsPort: env.METRICS_PORT,
  publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ''),
  database_url: env.DATABASE_URL,
  storagePath: path.resolve(env.STORAGE_PATH),
  logLevel: env.LOG_LEVEL,
  trustedProxies: env.TRUSTED_PROXIES,
  upload: {
    maxFileBytes: env.MAX_FILE_BYTES,
    allowedKinds: env.ALLOWED_KINDS,
    rateLimitRps: env.RATE_LIMIT_RPS,
    requireAccount: env.REQUIRE_ACCOUNT,
    defaultAccountQuotaBytes: env.DEFAULT_ACCOUNT_QUOTA_BYTES,
    minFreeDiskPercent: env.MIN_FREE_DISK_PERCENT,
  },
  image: {
    maxPixels: env.MAX_IMAGE_PIXELS,
    jpegQuality: env.IMAGE_JPEG_QUALITY,
    webpQuality: env.IMAGE_WEBP_QUALITY,
    avifQuality: env.IMAGE_AVIF_QUALITY,
    pngQuality: env.IMAGE_PNG_QUALITY,
    minSavingPercent: env.IMAGE_MIN_SAVING_PERCENT,
  },
  variants: {
    widths: env.VARIANT_WIDTHS,
    formats: env.VARIANT_FORMATS,
    cacheMaxBytes: env.VARIANT_CACHE_MAX_BYTES,
  },
  lifecycle: {
    pendingTtlMs: env.PENDING_TTL_HOURS * 3600_000,
    trashRetentionMs: env.TRASH_RETENTION_HOURS * 3600_000,
  },
  cdn: {
    provider: env.CDN_PROVIDER,
    cfZoneId: env.CF_ZONE_ID,
    cfApiToken: env.CF_API_TOKEN,
  },
};
