import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { dirs } from './layout';

export const ensureDirs = async (): Promise<void> => {
  for (const d of [dirs.tmp, dirs.files, dirs.variants, dirs.trash]) {
    await fsp.mkdir(d, { recursive: true });
  }
};

const fsyncDir = async (dir: string) => {
  const handle = await fsp.open(dir, 'r');
  try {
    await handle.sync();
  } catch {
    // Some filesystems do not support fsync on directories; the rename is still atomic.
  } finally {
    await handle.close();
  }
};

// Durable atomic placement: fsync(file) → rename → fsync(parent dir).
export const commit = async (tmpFile: string, dest: string): Promise<void> => {
  const handle = await fsp.open(tmpFile, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(tmpFile, dest);
  await fsyncDir(path.dirname(dest));
};

// Moves a file (trash / restore). Returns false when the source does not exist.
export const move = async (from: string, to: string): Promise<boolean> => {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
};

export const remove = async (file: string): Promise<void> => {
  await fsp.rm(file, { force: true });
};

export const removeDir = async (dir: string): Promise<void> => {
  await fsp.rm(dir, { recursive: true, force: true });
};

export const exists = (file: string): Promise<boolean> =>
  fsp.access(file, fs.constants.F_OK).then(
    () => true,
    () => false
  );

export type TDiskUsage = { totalBytes: number; freeBytes: number };

export const diskUsage = async (): Promise<TDiskUsage> => {
  const s = await fsp.statfs(dirs.root);
  return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
};

// Recursively lists regular files under dir (reconcile, LRU trim, tmp sweep).
export async function* walk(dir: string): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}
