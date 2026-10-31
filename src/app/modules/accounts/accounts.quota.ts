import { Prisma } from '../../../generated/prisma/client';
import { v7 as uuidv7 } from 'uuid';
import config from '../../../config';
import ProblemError from '../../../errors/ProblemError';

type Tx = Prisma.TransactionClient;

// Creates the account on first use with the default quota, or revives a deleted one.
// The upsert also row-locks the account until the transaction ends, which serializes uploads
// against a concurrent account deletion.
export const ensureAccount = async (tx: Tx, ref: string): Promise<string> => {
  const quota = config.upload.defaultAccountQuotaBytes || null;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO accounts (id, ref, quota_bytes)
    VALUES (${uuidv7()}::uuid, ${ref}, ${quota === null ? null : BigInt(quota)})
    ON CONFLICT (ref) DO UPDATE SET deleted_at = NULL
    RETURNING id::text`;
  return rows[0].id;
};

// Atomic, race-free quota enforcement: zero rows updated means there is no room.
export const chargeAccount = async (
  tx: Tx,
  accountId: string | null,
  bytes: bigint
): Promise<void> => {
  if (!accountId) return;
  const updated = await tx.$executeRaw`
    UPDATE accounts
       SET used_bytes = used_bytes + ${bytes}, file_count = file_count + 1, deleted_at = NULL
     WHERE id = ${accountId}::uuid
       AND (quota_bytes IS NULL OR used_bytes + ${bytes} <= quota_bytes)`;
  if (updated === 0) {
    throw new ProblemError('quota_exceeded', 'account storage quota exceeded');
  }
};

export const releaseAccount = async (
  tx: Tx,
  accountId: string | null,
  bytes: bigint
): Promise<void> => {
  if (!accountId) return;
  await tx.$executeRaw`
    UPDATE accounts
       SET used_bytes = GREATEST(used_bytes - ${bytes}, 0),
           file_count = GREATEST(file_count - 1, 0)
     WHERE id = ${accountId}::uuid`;
};
