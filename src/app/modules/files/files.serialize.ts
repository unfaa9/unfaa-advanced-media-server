import { Account, File, FileRef } from '../../../generated/prisma/client';
import config from '../../../config';

export type TFileWithRelations = File & {
  refs: FileRef[];
  account: Account | null;
};

export const fileInclude = {
  refs: { orderBy: { createdAt: 'asc' } },
  account: true,
} as const;

export const hasVariants = (f: Pick<File, 'kind' | 'ext'>): boolean =>
  f.kind === 'image' && f.ext !== 'gif';

// The public JSON shape of a file (docs/api/uploading.md + refs).
export const serializeFile = (f: TFileWithRelations) => {
  const base = config.publicBaseUrl;
  const live = f.status === 'pending' || f.status === 'active';
  return {
    id: f.id,
    status: f.status,
    visibility: 'public',
    kind: f.kind,
    mime: f.mime,
    size: Number(f.sizeBytes),
    original_size: Number(f.originalSizeBytes),
    compressed: f.sizeBytes < f.originalSizeBytes,
    sha256: Buffer.from(f.sha256).toString('hex'),
    width: f.width,
    height: f.height,
    ...(live ? { url: `${base}/f/${f.id}.${f.ext}` } : {}),
    ...(live && hasVariants(f)
      ? { variants_url_template: `${base}/i/${f.id}/{w}.{fmt}` }
      : {}),
    ...(f.kind === 'video' ? { meta: f.meta } : {}),
    account: f.account?.ref ?? null,
    purpose: f.purpose,
    original_name: f.originalName,
    refs: f.refs.map(r => r.ownerRef),
    ref_count: f.refs.length,
    created_at: f.createdAt.toISOString(),
    confirmed_at: f.confirmedAt?.toISOString() ?? null,
    deleted_at: f.deletedAt?.toISOString() ?? null,
  };
};
