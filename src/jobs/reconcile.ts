import { Prisma } from '../generated/prisma/client';
import fsp from 'fs/promises';
import path from 'path';
import {
  dirs,
  isValidExt,
  isValidId,
  originalPath,
  trashPath,
} from '../lib/storage/layout';
import { exists, move, remove, walk } from '../lib/storage/localStorage';
import logger from '../shared/logger';
import { metrics } from '../shared/metrics';
import prisma from '../shared/prisma';

const MIN_ORPHAN_AGE_MS = 24 * 3600_000;
const LIVE = ['pending', 'active'];

export type TReconcileReport = {
  orphansTrashed: string[];
  missingBytes: string[];
  quotaDrift: { ref: string; usedBytes: number; actualBytes: number }[];
  activeWithoutRefs: number;
};

// Disk vs DB, plus account usage counters recomputed from the files table.
export const reconcile = async ({
  dryRun = false,
}: { dryRun?: boolean } = {}): Promise<TReconcileReport> => {
  const report: TReconcileReport = {
    orphansTrashed: [],
    missingBytes: [],
    quotaDrift: [],
    activeWithoutRefs: 0,
  };

  // 1. Served files with no live row (crash between disk and DB, or a failed trash move).
  for await (const file of walk(dirs.files)) {
    const m = /^([0-9a-f-]{36})\.([a-z0-9]+)$/.exec(path.basename(file));
    if (!m || !isValidId(m[1]) || !isValidExt(m[2])) continue;
    const row = await prisma.file.findUnique({
      where: { id: m[1] },
      select: { status: true },
    });
    if (row && LIVE.includes(row.status)) continue;
    const st = await fsp.stat(file).catch(() => null);
    // Rowless files may belong to an upload still in flight; give them a day.
    if (!st || (!row && Date.now() - st.mtimeMs < MIN_ORPHAN_AGE_MS)) continue;
    report.orphansTrashed.push(m[1]);
    if (!dryRun) {
      if (row?.status === 'purged') await remove(file);
      else await move(file, trashPath(m[1], m[2]));
    }
  }

  // 2. Live rows whose bytes are gone (restore those from backup).
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.file.findMany({
      where: {
        status: { in: ['pending', 'active'] },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true, ext: true },
      orderBy: { id: 'asc' },
      take: 1000,
    });
    for (const r of rows) {
      if (!(await exists(originalPath(r.id, r.ext)))) {
        report.missingBytes.push(r.id);
      }
    }
    if (rows.length < 1000) break;
    cursor = rows[rows.length - 1].id;
  }
  if (report.missingBytes.length) {
    logger.error({ file_ids: report.missingBytes }, 'live files with missing bytes');
  }
  metrics.missingFiles.set(report.missingBytes.length);

  // 3. Account counters vs. the truth, fixed under the counter's row lock.
  const accounts = await prisma.account.findMany({ select: { id: true, ref: true } });
  let driftTotal = 0;
  for (const a of accounts) {
    await prisma.$transaction(async tx => {
      // Dry runs take no lock.
      const [locked] = await tx.$queryRaw<{ used_bytes: bigint }[]>`
        SELECT used_bytes FROM accounts WHERE id = ${a.id}::uuid
        ${dryRun ? Prisma.empty : Prisma.sql`FOR UPDATE`}`;
      const [actual] = await tx.$queryRaw<{ bytes: bigint | null; n: bigint }[]>`
        SELECT sum(size_bytes)::bigint AS bytes, count(*) AS n FROM files
         WHERE account_id = ${a.id}::uuid AND status IN ('pending', 'active')`;
      const actualBytes = actual.bytes ?? BigInt(0);
      if (locked.used_bytes === actualBytes) return;
      report.quotaDrift.push({
        ref: a.ref,
        usedBytes: Number(locked.used_bytes),
        actualBytes: Number(actualBytes),
      });
      driftTotal += Math.abs(Number(locked.used_bytes - actualBytes));
      if (!dryRun) {
        await tx.account.update({
          where: { id: a.id },
          data: { usedBytes: actualBytes, fileCount: Number(actual.n) },
        });
      }
    });
  }
  metrics.quotaDrift.set(driftTotal);

  // 4. Informational: active files nobody references (uploaded/confirmed without owner_ref).
  const [noRefs] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM files f
     WHERE f.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM file_refs r WHERE r.file_id = f.id)`;
  report.activeWithoutRefs = Number(noRefs.n);

  return report;
};
