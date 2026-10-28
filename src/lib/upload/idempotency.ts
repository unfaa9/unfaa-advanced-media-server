import crypto from 'crypto';
import prisma from '../../shared/prisma';

const WINDOW_MS = 24 * 3600_000;
export const MAX_KEY_LENGTH = 255;

// Serializes concurrent requests with the same key inside this process (single replica).
const chains = new Map<string, Promise<unknown>>();

export const withKeyLock = async <T>(
  key: string,
  fn: () => Promise<T>
): Promise<T> => {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.catch(() => undefined);
  chains.set(key, settled);
  try {
    return await run;
  } finally {
    if (chains.get(key) === settled) chains.delete(key);
  }
};

// Same key must mean same query parameters (order-independent) and same file bytes.
export const fingerprint = (
  query: Record<string, unknown>,
  uploadSha256: Buffer
): string => {
  const canonical = Object.keys(query)
    .sort()
    .map(k => `${k}=${String(query[k])}`)
    .join('&');
  return `v2:${crypto
    .createHash('sha256')
    .update(canonical)
    .update('\n')
    .update(uploadSha256)
    .digest('hex')}`;
};

export type TStoredResponse = {
  fingerprint: string;
  status: number;
  response: unknown;
};

export const findResponse = async (
  key: string
): Promise<TStoredResponse | null> => {
  const row = await prisma.idempotencyKey.findUnique({ where: { key } });
  if (!row || row.createdAt.getTime() + WINDOW_MS < Date.now()) return null;
  return row;
};

export const saveResponse = async (
  key: string,
  value: TStoredResponse
): Promise<void> => {
  await prisma.idempotencyKey.upsert({
    where: { key },
    create: { key, ...value, response: value.response as object },
    update: {
      ...value,
      response: value.response as object,
      createdAt: new Date(),
    },
  });
};

export const expireOld = async (): Promise<number> => {
  const { count } = await prisma.idempotencyKey.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - WINDOW_MS) } },
  });
  return count;
};
