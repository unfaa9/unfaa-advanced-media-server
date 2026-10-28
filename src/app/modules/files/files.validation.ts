import { z } from 'zod';
import { UUID_V7 } from '../../../lib/storage/layout';

const label = z
  .string()
  .regex(/^[A-Za-z0-9_.:@-]{1,128}$/, 'use [A-Za-z0-9_.:@-], ≤ 128 chars');
// <entity>:<id>:<field>, e.g. user:123:avatar — free text for the server, but printable.
const ownerRef = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'printable ASCII without spaces');
const fileId = z.string().regex(UUID_V7, 'invalid file id');
const boolString = z
  .enum(['true', 'false'])
  .transform(v => v === 'true')
  .optional();

const idParams = z.object({ id: fileId });

const uploadQuery = z
  .object({
    visibility: z
      .enum(['public'], {
        errorMap: () => ({ message: 'only public files are supported' }),
      })
      .optional(),
    confirm: boolString,
    purpose: label.optional(),
    owner_ref: ownerRef.optional(),
    account: label.optional(),
  })
  .strict();

const listQuery = z
  .object({
    cursor: fileId.optional(),
    limit: z.coerce.number().int().min(1).default(50).transform(n => Math.min(n, 200)),
    purpose: label.optional(),
    status: z.enum(['pending', 'active', 'deleted', 'purged']).optional(),
    account: label.optional(),
    owner_ref: ownerRef.optional(),
  })
  .strict();

const confirm = z.object({
  params: idParams,
  body: z.object({ owner_ref: ownerRef.optional() }).strict().default({}),
});

const confirmBatch = z.object({
  body: z
    .object({
      ids: z.array(fileId).min(1).max(100),
      owner_ref: ownerRef.optional(),
    })
    .strict(),
});

const addRef = z.object({
  params: idParams,
  body: z.object({ owner_ref: ownerRef }).strict(),
});

// DELETE bodies are not always forwarded by proxies, so owner_ref may also be a query param.
const removeRef = z
  .object({
    params: idParams,
    body: z.object({ owner_ref: ownerRef.optional() }).default({}),
    query: z.object({ owner_ref: ownerRef.optional() }),
  })
  .refine(v => v.body.owner_ref || v.query.owner_ref, {
    message: 'owner_ref is required',
    path: ['body', 'owner_ref'],
  });

const deleteByOwner = z.object({
  body: z
    .object({
      owner_ref_prefix: z
        .string()
        .min(3)
        .max(255)
        .refine(p => p.endsWith(':'), 'must end with ":"'),
    })
    .strict(),
});

const deleteFile = z.object({
  params: idParams,
  query: z.object({ force: boolString }).passthrough(),
});

export const filesValidation = {
  idParams,
  uploadQuery,
  listQuery,
  confirm,
  confirmBatch,
  addRef,
  removeRef,
  deleteByOwner,
  deleteFile,
};
