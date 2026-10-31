import { Account } from '../../../generated/prisma/client';
import ProblemError from '../../../errors/ProblemError';
import prisma from '../../../shared/prisma';
import {
  lockFiles,
  markDeleted,
  TLockedFile,
  trashBytes,
  TX_OPTIONS,
} from '../files/files.service';
import { ensureAccount } from './accounts.quota';

const serialize = (a: Account) => {
  const quota = a.quotaBytes === null ? null : Number(a.quotaBytes);
  const used = Number(a.usedBytes);
  return {
    ref: a.ref,
    quota_bytes: quota,
    used_bytes: used,
    file_count: a.fileCount,
    usage_percent: quota ? Math.round((used / quota) * 10000) / 100 : null,
    deleted: a.deletedAt !== null,
  };
};

// Create or update the quota (null = unlimited). Lowering below usage is allowed.
export const upsertAccount = async (ref: string, quotaBytes: number | null) => {
  const account = await prisma.$transaction(async tx => {
    await ensureAccount(tx, ref);
    return tx.account.update({
      where: { ref },
      data: { quotaBytes: quotaBytes === null ? null : BigInt(quotaBytes) },
    });
  });
  return serialize(account);
};

export const getAccount = async (ref: string) => {
  const account = await prisma.account.findUnique({ where: { ref } });
  if (!account) throw new ProblemError('not_found', 'account not found');
  return serialize(account);
};

// Soft-deletes every live file of the account (normal trash window), regardless of
// references, then marks the account deleted. The account row lock serializes this against
// uploads, so an upload that races with the deletion is either deleted too or revives it.
export const deleteAccount = async (ref: string) => {
  const deleted = await prisma.$transaction(async tx => {
    const [account] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM accounts WHERE ref = ${ref} FOR UPDATE`;
    if (!account) throw new ProblemError('not_found', 'account not found');
    const live = await tx.file.findMany({
      where: { accountId: account.id, status: { in: ['pending', 'active'] } },
      select: { id: true },
    });
    const files: TLockedFile[] = live.length
      ? await lockFiles(
          tx,
          live.map(f => f.id)
        )
      : [];
    for (const f of files) await markDeleted(tx, f);
    await tx.account.update({
      where: { id: account.id },
      data: { deletedAt: new Date() },
    });
    return files;
  }, TX_OPTIONS);
  for (const f of deleted) await trashBytes(f);
  return { deleted_files: deleted.length };
};
