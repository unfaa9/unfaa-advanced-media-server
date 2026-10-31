import { fileTypeFromFile } from 'file-type';
import { TExt } from '../storage/layout';

export type TKind = 'image' | 'video' | 'document';
export type TMediaType = { kind: TKind; mime: string; ext: TExt };

// Allowlist by detected (magic-byte) type. The client's filename, extension and Content-Type are
// ignored. SVG/HTML/XML are never detected as any of these, so they are rejected.
const ALLOWED: Record<string, TMediaType> = {
  'image/jpeg': { kind: 'image', mime: 'image/jpeg', ext: 'jpg' },
  'image/png': { kind: 'image', mime: 'image/png', ext: 'png' },
  'image/webp': { kind: 'image', mime: 'image/webp', ext: 'webp' },
  'image/gif': { kind: 'image', mime: 'image/gif', ext: 'gif' },
  'video/mp4': { kind: 'video', mime: 'video/mp4', ext: 'mp4' },
  'video/x-m4v': { kind: 'video', mime: 'video/mp4', ext: 'mp4' },
  'video/webm': { kind: 'video', mime: 'video/webm', ext: 'webm' },
  'application/pdf': { kind: 'document', mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    kind: 'document',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: 'docx',
  },
};

export const sniff = async (file: string): Promise<TMediaType | null> => {
  const detected = await fileTypeFromFile(file);
  return (detected && ALLOWED[detected.mime]) || null;
};

export const mimeByExt: Record<TExt, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  docx: ALLOWED[
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ].mime,
};
