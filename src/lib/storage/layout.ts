import path from 'path';
import config from '../../config';

// Disk layout under STORAGE_PATH:
//   tmp/                              in-flight uploads (same volume → atomic rename)
//   files/YYYY/MM/DD/<id>.<ext>       served originals (date from the UUIDv7 timestamp)
//   variants/<id>/<w>.<fmt>           generated image variants (disposable cache)
//   trash/files/YYYY/MM/DD/<id>.<ext> soft-deleted originals
// Every path is derived from a validated id + allowlisted ext, so the read path never needs the DB
// and path traversal is impossible.

export const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const EXTENSIONS = [
  'jpg',
  'png',
  'webp',
  'gif',
  'mp4',
  'webm',
  'pdf',
  'docx',
] as const;
export type TExt = (typeof EXTENSIONS)[number];

export const isValidId = (id: string): boolean => UUID_V7.test(id);
export const isValidExt = (ext: string): ext is TExt =>
  (EXTENSIONS as readonly string[]).includes(ext);

export const dirs = {
  root: config.storagePath,
  tmp: path.join(config.storagePath, 'tmp'),
  files: path.join(config.storagePath, 'files'),
  variants: path.join(config.storagePath, 'variants'),
  trash: path.join(config.storagePath, 'trash', 'files'),
};

// UUIDv7: the first 48 bits are the unix time in ms.
export const idTimestamp = (id: string): Date =>
  new Date(parseInt(id.replace(/-/g, '').slice(0, 12), 16));

const datePath = (id: string): string => {
  const d = idTimestamp(id);
  const pad = (n: number) => String(n).padStart(2, '0');
  return path.join(
    String(d.getUTCFullYear()),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate())
  );
};

const assertSafe = (id: string, ext: string) => {
  if (!isValidId(id) || !isValidExt(ext)) {
    throw new Error(`invalid storage key ${id}.${ext}`);
  }
};

export const originalPath = (id: string, ext: string): string => {
  assertSafe(id, ext);
  return path.join(dirs.files, datePath(id), `${id}.${ext}`);
};

export const trashPath = (id: string, ext: string): string => {
  assertSafe(id, ext);
  return path.join(dirs.trash, datePath(id), `${id}.${ext}`);
};

export const variantDir = (id: string): string => {
  if (!isValidId(id)) throw new Error(`invalid id ${id}`);
  return path.join(dirs.variants, id);
};

export const variantPath = (id: string, w: number, fmt: string): string =>
  path.join(variantDir(id), `${w}.${fmt}`);

export const tmpPath = (name: string): string =>
  path.join(dirs.tmp, path.basename(name));
