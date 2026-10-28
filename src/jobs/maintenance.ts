import fsp from 'fs/promises';
import { purgeFile } from '../app/modules/files/files.service';
import config from '../config';
import { dirs } from '../lib/storage/layout';
import { diskUsage, remove, walk } from '../lib/storage/localStorage';
import { expireOld } from '../lib/upload/idempotency';
import { metrics } from '../shared/metrics';
import prisma from '../shared/prisma';

const BATCH = 500;

// Pending files never confirmed within PENDING_TTL are purged directly (no trash window).
export const orphanSweep = async () => {
  const cutoff = new Date(Date.now() - config.lifecycle.pendingTtlMs);
  let purged = 0;
  for (;;) {
    const rows = await prisma.file.findMany({
      where: { status: 'pending', createdAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH,
    });
    for (const { id } of rows) {
      if (await purgeFile(id, f => f.status === 'pending')) purged++;
    }
    if (rows.length < BATCH) return { purged };
  }
};

// Deleted files past the trash window lose their bytes for good.
export const trashPurge = async () => {
  const cutoff = new Date(Date.now() - config.lifecycle.trashRetentionMs);
  let purged = 0;
  for (;;) {
    const rows = await prisma.file.findMany({
      where: { status: 'deleted', deletedAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH,
    });
    for (const { id } of rows) {
      const ok = await purgeFile(
        id,
        f =>
          f.status === 'deleted' && !!f.deleted_at && f.deleted_at < cutoff
      );
      if (ok) purged++;
    }
    if (rows.length < BATCH) return { purged };
  }
};

// Leftovers from crashed uploads.
export const tmpSweep = async () => {
  const cutoff = Date.now() - 3600_000;
  let removed = 0;
  for await (const file of walk(dirs.tmp)) {
    const st = await fsp.stat(file).catch(() => null);
    if (st && st.mtimeMs < cutoff) {
      await remove(file);
      removed++;
    }
  }
  return { removed };
};

// Trims the variant cache to 80 % of VARIANT_CACHE_MAX_BYTES, least recently used first
// (delivery refreshes mtimes on hits).
export const variantLru = async () => {
  const entries: { file: string; size: number; mtime: number }[] = [];
  let total = 0;
  for await (const file of walk(dirs.variants)) {
    const st = await fsp.stat(file).catch(() => null);
    if (!st) continue;
    entries.push({ file, size: st.size, mtime: st.mtimeMs });
    total += st.size;
  }
  if (total <= config.variants.cacheMaxBytes) return { removed: 0, total };
  const target = config.variants.cacheMaxBytes * 0.8;
  entries.sort((a, b) => a.mtime - b.mtime);
  let removed = 0;
  for (const e of entries) {
    if (total <= target) break;
    await remove(e.file);
    total -= e.size;
    removed++;
  }
  return { removed, total };
};

export const idempotencyExpiry = async () => ({ expired: await expireOld() });

// Cheap gauges refreshed every minute.
export const refreshStorageGauges = async () => {
  const { freeBytes } = await diskUsage();
  metrics.diskFree.set(freeBytes);
  const counts = await prisma.file.groupBy({ by: ['status'], _count: true });
  for (const status of ['pending', 'active', 'deleted', 'purged']) {
    metrics.filesTotal.set(
      { status },
      counts.find(c => c.status === status)?._count ?? 0
    );
  }
  return {};
};
