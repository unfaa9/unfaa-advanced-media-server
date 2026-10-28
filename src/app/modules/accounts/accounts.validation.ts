import { z } from 'zod';

const params = z.object({
  ref: z
    .string()
    .regex(/^[A-Za-z0-9_.:@-]{1,128}$/, 'use [A-Za-z0-9_.:@-], ≤ 128 chars'),
});

const upsert = z.object({
  params,
  body: z
    .object({
      // Required; null means unlimited (the disk guard still applies).
      quota_bytes: z.number().int().min(0).nullable(),
    })
    .strict(),
});

export const accountsValidation = { params, upsert };
