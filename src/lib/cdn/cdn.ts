import { Prisma } from '../../generated/prisma/client';
import config from '../../config';

// Every public URL a file can have: the original plus all allowlisted variants.
export const publicUrlsFor = (
  id: string,
  ext: string,
  kind: string
): string[] => {
  const base = config.publicBaseUrl;
  const urls = [`${base}/f/${id}.${ext}`];
  if (kind === 'image' && ext !== 'gif') {
    for (const w of config.variants.widths) {
      for (const fmt of config.variants.formats) {
        urls.push(`${base}/i/${id}/${w}.${fmt}`);
      }
    }
  }
  return urls;
};

// Cloudflare accepts up to 30 URLs per purge call on every plan.
const PURGE_BATCH = 30;

// Queues CDN purges inside the caller's transaction, so a purge is never lost.
export const enqueuePurge = async (
  tx: Prisma.TransactionClient,
  urls: string[]
): Promise<void> => {
  if (config.cdn.provider === 'none' || urls.length === 0) return;
  const data = [];
  for (let i = 0; i < urls.length; i += PURGE_BATCH) {
    data.push({
      kind: 'cdn_purge',
      payload: { urls: urls.slice(i, i + PURGE_BATCH) },
    });
  }
  await tx.job.createMany({ data });
};

export const purgeUrls = async (urls: string[]): Promise<void> => {
  if (config.cdn.provider === 'none') return;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${config.cdn.cfZoneId}/purge_cache`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.cdn.cfApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: urls }),
      signal: AbortSignal.timeout(15_000),
    }
  );
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    errors?: unknown;
  } | null;
  if (!res.ok || !body?.success) {
    throw new Error(
      `cloudflare purge failed: HTTP ${res.status} ${JSON.stringify(
        body?.errors ?? ''
      )}`
    );
  }
};
