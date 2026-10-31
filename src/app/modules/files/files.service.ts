import { Prisma } from '../../../generated/prisma/client';
import crypto from 'crypto';
import fsp from 'fs/promises';
import { v7 as uuidv7 } from 'uuid';
import config from '../../../config';
import ProblemError from '../../../errors/ProblemError';
import { enqueuePurge, publicUrlsFor } from '../../../lib/cdn/cdn';
import { processImage } from '../../../lib/media/processImage';
import { sniff } from '../../../lib/media/sniff';
import { validateNonImage } from '../../../lib/media/validateMedia';
import {
  originalPath,
  tmpPath,
  trashPath,
  variantDir,
} from '../../../lib/storage/layout';
import {
  commit,
  diskUsage,
  exists,
  move,
  remove,
  removeDir,
} from '../../../lib/storage/localStorage';
import { TReceivedFile } from '../../../lib/upload/receiveFile';
import logger from '../../../shared/logger';
import { metrics } from '../../../shared/metrics';
import prisma from '../../../shared/prisma';
import {
  chargeAccount,
  ensureAccount,
  releaseAccount,
} from '../accounts/accounts.quota';
import { fileInclude, serializeFile } from './files.serialize';

type Tx = Prisma.TransactionClient;
export const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 };
const LIVE = ['pending', 'active'];

export type TUploadOptions = {
  confirm: boolean;
  purpose?: string;
  ownerRef?: string;
  account?: string;
};

export type TLockedFile = {
  id: string;
  account_id: string | null;
  status: string;
  ext: string;
  kind: string;
  size_bytes: bigint;
  deleted_at: Date | null;
};

const notFound = () => new ProblemError('not_found', 'file not found');

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

// Locks file rows in id order (deadlock-free) for the rest of the transaction.
export const lockFiles = (tx: Tx, ids: string[]) =>
  tx.$queryRaw<TLockedFile[]>`
    SELECT id::text, account_id::text, status::text, ext, kind, size_bytes, deleted_at
      FROM files WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;

const lockFile = async (tx: Tx, id: string): Promise<TLockedFile> => {
  const [row] = await lockFiles(tx, [id]);
  if (!row) throw notFound();
  return row;
};

const loadFile = async (id: string) => {
  const f = await prisma.file.findUnique({
    where: { id },
    include: fileInclude,
  });
  if (!f) throw notFound();
  return f;
};

// Soft delete inside a transaction: the row leaves the quota and a CDN purge is queued.
// The bytes move to trash right after commit (see trashBytes).
export const markDeleted = async (tx: Tx, f: TLockedFile): Promise<void> => {
  await tx.file.update({
    where: { id: f.id },
    data: { status: 'deleted', deletedAt: new Date() },
  });
  await releaseAccount(tx, f.account_id, f.size_bytes);
  await enqueuePurge(tx, publicUrlsFor(f.id, f.ext, f.kind));
};

// Origin answers 404 as soon as the original leaves files/. Reconcile retries any failure.
export const trashBytes = async (f: Pick<TLockedFile, 'id' | 'ext'>) => {
  try {
    await move(originalPath(f.id, f.ext), trashPath(f.id, f.ext));
    await removeDir(variantDir(f.id));
  } catch (err) {
    logger.error({ err, file_id: f.id }, 'moving file to trash failed');
  }
};

export const assertDiskSpace = async (): Promise<void> => {
  const { totalBytes, freeBytes } = await diskUsage();
  if (
    totalBytes > 0 &&
    (freeBytes / totalBytes) * 100 < config.upload.minFreeDiskPercent
  ) {
    throw new ProblemError(
      'quota_exceeded',
      'server disk is almost full; uploads are paused'
    );
  }
};

// ---- upload ------------------------------------------------------------------------------

// Reuses a live file with the same uploaded bytes in the same account. Returns null if the
// candidate disappeared in the meantime.
const attachDuplicate = async (id: string, opts: TUploadOptions) => {
  const done = await prisma.$transaction(async tx => {
    const [f] = await lockFiles(tx, [id]);
    if (!f || !LIVE.includes(f.status)) return false;
    if (opts.ownerRef) {
      await tx.fileRef.createMany({
        data: [{ fileId: id, ownerRef: opts.ownerRef }],
        skipDuplicates: true,
      });
    }
    if (opts.confirm && f.status === 'pending') {
      await tx.file.update({
        where: { id },
        data: { status: 'active', confirmedAt: new Date() },
      });
    }
    return true;
  }, TX_OPTIONS);
  if (!done) return null;
  return { ...serializeFile(await loadFile(id)), deduplicated: true };
};

const findDuplicate = async (sha: Buffer<ArrayBuffer>, account?: string) => {
  const f = await prisma.file.findFirst({
    where: {
      uploadSha256: sha,
      status: { in: ['pending', 'active'] },
      ...(account ? { account: { ref: account } } : { accountId: null }),
    },
    select: { id: true },
  });
  return f?.id ?? null;
};

export type TUploadResult = { status: number; body: unknown };

export const storeUpload = async (
  received: TReceivedFile,
  opts: TUploadOptions
): Promise<TUploadResult> => {
  const toClean = [received.path];
  metrics.uploadBytes.inc(received.size);
  try {
    const type = await sniff(received.path);
    if (!type) {
      throw new ProblemError('unsupported_type', 'file type is not allowed');
    }
    if (!config.upload.allowedKinds.includes(type.kind)) {
      throw new ProblemError(
        'unsupported_type',
        `${type.kind} uploads are not enabled on this server`
      );
    }

    // Dedup before the expensive processing.
    for (let attempt = 0; attempt < 3; attempt++) {
      const dupId = await findDuplicate(received.sha256, opts.account);
      if (!dupId) break;
      const body = await attachDuplicate(dupId, opts);
      if (body) {
        metrics.uploads.inc({ kind: type.kind, result: 'deduplicated' });
        return { status: 200, body };
      }
    }

    let storedPath = received.path;
    let width: number | null = null;
    let height: number | null = null;
    let meta: Record<string, unknown> = {};
    if (type.kind === 'image') {
      const input = await fsp.readFile(received.path);
      const out = await processImage(input, type.ext);
      storedPath = tmpPath(`${uuidv7()}.processed`);
      toClean.push(storedPath);
      await fsp.writeFile(storedPath, out.data, { flag: 'wx' });
      width = out.width;
      height = out.height;
    } else {
      meta = await validateNonImage(received.path, type.ext);
    }
    const stored = await fsp.readFile(storedPath);
    const size = BigInt(stored.length);
    const sha256 = crypto.createHash('sha256').update(stored).digest();

    const id = uuidv7();
    const dest = originalPath(id, type.ext);
    let placed = false;
    try {
      await prisma.$transaction(async tx => {
        const accountId = opts.account
          ? await ensureAccount(tx, opts.account)
          : null;
        await chargeAccount(tx, accountId, size);
        await tx.file.create({
          data: {
            id,
            accountId,
            status: opts.confirm ? 'active' : 'pending',
            kind: type.kind,
            mime: type.mime,
            ext: type.ext,
            sizeBytes: size,
            originalSizeBytes: BigInt(received.size),
            sha256,
            uploadSha256: received.sha256,
            width,
            height,
            originalName: received.originalName,
            purpose: opts.purpose ?? null,
            meta: meta as Prisma.InputJsonObject,
            confirmedAt: opts.confirm ? new Date() : null,
            ...(opts.ownerRef
              ? { refs: { create: [{ ownerRef: opts.ownerRef }] } }
              : {}),
          },
        });
        // Bytes are in place before the row becomes visible.
        await commit(storedPath, dest);
        placed = true;
      }, TX_OPTIONS);
    } catch (e) {
      if (placed) await remove(dest);
      if (isUniqueViolation(e)) {
        // A concurrent identical upload won the race: reuse it.
        const dupId = await findDuplicate(received.sha256, opts.account);
        const body = dupId && (await attachDuplicate(dupId, opts));
        if (body) return { status: 200, body };
      }
      throw e;
    }
    metrics.uploads.inc({ kind: type.kind, result: 'created' });
    metrics.compressionSaved.inc(Math.max(0, received.size - stored.length));
    return { status: 201, body: serializeFile(await loadFile(id)) };
  } finally {
    await Promise.all(toClean.map(p => remove(p)));
  }
};

// ---- read --------------------------------------------------------------------------------

export const getFile = async (id: string) => serializeFile(await loadFile(id));

export type TListFilters = {
  cursor?: string;
  limit: number;
  purpose?: string;
  status?: 'pending' | 'active' | 'deleted' | 'purged';
  account?: string;
  ownerRef?: string;
};

export const listFiles = async (f: TListFilters) => {
  const rows = await prisma.file.findMany({
    where: {
      ...(f.cursor ? { id: { lt: f.cursor } } : {}),
      ...(f.purpose ? { purpose: f.purpose } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.account ? { account: { ref: f.account } } : {}),
      ...(f.ownerRef ? { refs: { some: { ownerRef: f.ownerRef } } } : {}),
    },
    include: fileInclude,
    orderBy: { id: 'desc' }, // UUIDv7 = newest first
    take: f.limit + 1,
  });
  const page = rows.slice(0, f.limit);
  return {
    data: page.map(serializeFile),
    next_cursor: rows.length > f.limit ? page[page.length - 1].id : null,
  };
};

// ---- confirm & references ----------------------------------------------------------------

// All-or-nothing: an unknown id → 404, a deleted/purged one → 409, and nothing changes.
export const confirmFiles = async (ids: string[], ownerRef?: string) => {
  const unique = [...new Set(ids)];
  await prisma.$transaction(async tx => {
    const rows = await lockFiles(tx, unique);
    if (rows.length !== unique.length) {
      const found = new Set(rows.map(r => r.id));
      throw new ProblemError(
        'not_found',
        `file not found: ${unique.find(id => !found.has(id))}`
      );
    }
    const bad = rows.find(r => !LIVE.includes(r.status));
    if (bad) {
      throw new ProblemError(
        'invalid_state',
        `file ${bad.id} is ${bad.status} and cannot be confirmed`
      );
    }
    await tx.file.updateMany({
      where: { id: { in: unique }, status: 'pending' },
      data: { status: 'active', confirmedAt: new Date() },
    });
    if (ownerRef) {
      await tx.fileRef.createMany({
        data: unique.map(fileId => ({ fileId, ownerRef })),
        skipDuplicates: true,
      });
    }
  }, TX_OPTIONS);
  const files = await prisma.file.findMany({
    where: { id: { in: unique } },
    include: fileInclude,
    orderBy: { id: 'desc' },
  });
  return files.map(serializeFile);
};

export const addRef = async (id: string, ownerRef: string) => {
  await prisma.$transaction(async tx => {
    const f = await lockFile(tx, id);
    if (!LIVE.includes(f.status)) {
      throw new ProblemError('invalid_state', `file is ${f.status}`);
    }
    await tx.fileRef.createMany({
      data: [{ fileId: id, ownerRef }],
      skipDuplicates: true,
    });
  }, TX_OPTIONS);
  return getFile(id);
};

// Removes one owner's reference. When that was the last reference, the file is deleted.
export const removeRef = async (id: string, ownerRef: string) => {
  const result = await prisma.$transaction(async tx => {
    const f = await lockFile(tx, id);
    const { count: removed } = await tx.fileRef.deleteMany({
      where: { fileId: id, ownerRef },
    });
    const remaining = await tx.fileRef.count({ where: { fileId: id } });
    let status = f.status;
    if (removed > 0 && remaining === 0 && LIVE.includes(f.status)) {
      await markDeleted(tx, f);
      status = 'deleted';
    }
    return { file: f, removed, remaining, status };
  }, TX_OPTIONS);
  if (result.status === 'deleted' && result.file.status !== 'deleted') {
    await trashBytes(result.file);
  }
  return {
    id,
    removed: result.removed > 0,
    remaining_refs: result.remaining,
    status: result.status,
  };
};

const likePrefix = (prefix: string) =>
  `${prefix.replace(/[\\%_]/g, c => `\\${c}`)}%`;

// Removes every reference under the prefix; only files left with no references are deleted.
export const deleteByOwner = async (prefix: string) => {
  const pattern = likePrefix(prefix);
  const { refsRemoved, deleted } = await prisma.$transaction(async tx => {
    const refRows = await tx.$queryRaw<{ file_id: string }[]>`
      SELECT DISTINCT file_id::text FROM file_refs WHERE owner_ref LIKE ${pattern}`;
    const ids = refRows.map(r => r.file_id);
    if (ids.length === 0) return { refsRemoved: 0, deleted: [] };
    const files = await lockFiles(tx, ids);
    const refsRemoved = await tx.$executeRaw`
      DELETE FROM file_refs WHERE file_id = ANY(${ids}::uuid[]) AND owner_ref LIKE ${pattern}`;
    const left = await tx.fileRef.groupBy({
      by: ['fileId'],
      where: { fileId: { in: ids } },
    });
    const stillUsed = new Set(left.map(r => r.fileId));
    const deleted: TLockedFile[] = [];
    for (const f of files) {
      if (!stillUsed.has(f.id) && LIVE.includes(f.status)) {
        await markDeleted(tx, f);
        deleted.push(f);
      }
    }
    return { refsRemoved, deleted };
  }, TX_OPTIONS);
  for (const f of deleted) await trashBytes(f);
  return {
    refs_removed: refsRemoved,
    files_deleted: deleted.length,
    deleted: deleted.length,
  };
};

// ---- delete / restore / purge ------------------------------------------------------------

// Force delete. Refused while other owners still reference the file, unless force=true.
export const deleteFile = async (id: string, force: boolean) => {
  const deleted = await prisma.$transaction(async tx => {
    const f = await lockFile(tx, id);
    if (!LIVE.includes(f.status)) return null; // idempotent
    const refs = await tx.fileRef.count({ where: { fileId: id } });
    if (refs > 0 && !force) {
      throw new ProblemError(
        'has_references',
        `file still has ${refs} reference(s); remove them or pass force=true`
      );
    }
    await markDeleted(tx, f);
    return f;
  }, TX_OPTIONS);
  if (deleted) await trashBytes(deleted);
};

export const restoreFile = async (id: string) => {
  let movedBack: TLockedFile | null = null;
  try {
    await prisma.$transaction(async tx => {
      const f = await lockFile(tx, id);
      const retention = config.lifecycle.trashRetentionMs;
      if (
        f.status !== 'deleted' ||
        !f.deleted_at ||
        f.deleted_at.getTime() + retention < Date.now()
      ) {
        throw new ProblemError(
          'invalid_state',
          'only files deleted within the trash window can be restored'
        );
      }
      await chargeAccount(tx, f.account_id, f.size_bytes);
      await tx.file.update({
        where: { id },
        data: {
          status: 'active',
          deletedAt: null,
          confirmedAt: new Date(),
        },
      });
      if (!(await move(trashPath(f.id, f.ext), originalPath(f.id, f.ext)))) {
        throw new ProblemError(
          'invalid_state',
          'the file bytes are no longer available'
        );
      }
      movedBack = f;
    }, TX_OPTIONS);
  } catch (e) {
    const f = movedBack as TLockedFile | null;
    if (f) await move(originalPath(f.id, f.ext), trashPath(f.id, f.ext));
    if (isUniqueViolation(e)) {
      throw new ProblemError(
        'invalid_state',
        'an identical live file already exists in this account'
      );
    }
    throw e;
  }
  return getFile(id);
};

// Permanently removes bytes (trash purge, orphan sweep, admin purge). The row stays as a
// tombstone. Returns false if the file was already purged.
export const purgeFile = async (
  id: string,
  onlyIf?: (f: TLockedFile) => boolean
): Promise<boolean> => {
  const f = await prisma.$transaction(async tx => {
    const [row] = await lockFiles(tx, [id]);
    if (!row || row.status === 'purged') return null;
    if (onlyIf && !onlyIf(row)) return null;
    if (LIVE.includes(row.status)) {
      await releaseAccount(tx, row.account_id, row.size_bytes);
      await enqueuePurge(tx, publicUrlsFor(row.id, row.ext, row.kind));
    }
    await tx.file.update({
      where: { id },
      data: { status: 'purged', purgedAt: new Date() },
    });
    return row;
  }, TX_OPTIONS);
  if (!f) return false;
  await remove(originalPath(f.id, f.ext));
  await remove(trashPath(f.id, f.ext));
  await removeDir(variantDir(f.id));
  return true;
};

export const bytesExist = (id: string, ext: string) =>
  exists(originalPath(id, ext));

export const discard = (received: TReceivedFile) => remove(received.path);
