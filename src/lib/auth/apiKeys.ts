import crypto from 'crypto';
import { v7 as uuidv7 } from 'uuid';
import prisma from '../../shared/prisma';

export const SCOPES = [
  'files:read',
  'files:write',
  'files:delete',
  'accounts:read',
  'accounts:write',
] as const;
export type TScope = (typeof SCOPES)[number];

export type TAuthenticatedKey = {
  id: string;
  name: string;
  scopes: TScope[];
};

const BASE62 =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KEY_BODY_LENGTH = 43; // ≈ 256 bits
const KEY_FORMAT = /^msk_[0-9A-Za-z]{43}$/;
const CACHE_TTL_MS = 60_000; // revocation takes effect within 60 s
const TOUCH_INTERVAL_MS = 60_000;

const randomBase62 = (length: number): string => {
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      // 248 = 4 * 62: reject the tail to keep the distribution uniform.
      if (byte < 248 && out.length < length) out += BASE62[byte % 62];
    }
  }
  return out;
};

export const hashKey = (key: string): Buffer =>
  crypto.createHash('sha256').update(key).digest();

export const createKey = async (input: {
  name: string;
  scopes: TScope[];
  expiresAt?: Date;
}): Promise<{ id: string; key: string }> => {
  const key = `msk_${randomBase62(KEY_BODY_LENGTH)}`;
  const id = uuidv7();
  await prisma.apiKey.create({
    data: {
      id,
      name: input.name,
      prefix: key.slice(0, 12),
      keyHash: hashKey(key),
      scopes: input.scopes,
      expiresAt: input.expiresAt,
    },
  });
  return { id, key };
};

type TCacheEntry = {
  key: TAuthenticatedKey;
  expiresAt: Date | null;
  cachedUntil: number;
};
// Only valid keys are cached, so a flood of wrong keys cannot evict them.
const cache = new Map<string, TCacheEntry>();
const lastTouched = new Map<string, number>();

const touch = (id: string) => {
  const now = Date.now();
  if ((lastTouched.get(id) ?? 0) + TOUCH_INTERVAL_MS > now) return;
  lastTouched.set(id, now);
  prisma.apiKey
    .update({ where: { id }, data: { lastUsedAt: new Date(now) } })
    .catch(() => undefined);
};

// Returns the key if it is well-formed, known, not revoked and not expired.
export const verifyKey = async (
  raw: string
): Promise<TAuthenticatedKey | null> => {
  if (!KEY_FORMAT.test(raw)) return null;
  const hash = hashKey(raw);
  const cacheKey = hash.toString('hex');
  const now = Date.now();

  let entry = cache.get(cacheKey);
  if (!entry || entry.cachedUntil < now) {
    cache.delete(cacheKey);
    const row = await prisma.apiKey.findUnique({ where: { keyHash: hash } });
    if (!row || row.revokedAt) return null;
    entry = {
      key: { id: row.id, name: row.name, scopes: row.scopes as TScope[] },
      expiresAt: row.expiresAt,
      cachedUntil: now + CACHE_TTL_MS,
    };
    cache.set(cacheKey, entry);
  }
  if (entry.expiresAt && entry.expiresAt.getTime() <= now) return null;
  touch(entry.key.id);
  return entry.key;
};

export const clearKeyCache = (): void => cache.clear();
