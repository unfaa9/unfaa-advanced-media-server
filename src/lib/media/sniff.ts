import { fileTypeFromFile } from 'file-type';
import { TExt } from '../storage/layout';

export type TKind = 'image' | 'video' | 'document' | 'audio';
export type TMediaType = { kind: TKind; mime: string; ext: TExt };

const AUDIO_OGG: TMediaType = { kind: 'audio', mime: 'audio/ogg', ext: 'ogg' };
const AUDIO_M4A: TMediaType = { kind: 'audio', mime: 'audio/mp4', ext: 'm4a' };
const AUDIO_WAV: TMediaType = { kind: 'audio', mime: 'audio/wav', ext: 'wav' };

// Allowlist by detected (magic-byte) type. The client's filename, extension and Content-Type are
// ignored. SVG/HTML/XML are never detected as any of these, so they are rejected.
// Audio: only formats every browser plays and Meta / WhatsApp fetch (AMR, FLAC, WMA… are rejected;
// the backend converts those first). Audio-only MP4 is sniffed as video/mp4 and reclassified after
// validation (see audioOnlyMp4 in files.service).
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
  'audio/ogg': AUDIO_OGG,
  'audio/ogg; codecs=opus': AUDIO_OGG,
  'audio/opus': AUDIO_OGG,
  'audio/mpeg': { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' },
  'audio/x-m4a': AUDIO_M4A,
  'audio/mp4': AUDIO_M4A,
  'audio/aac': { kind: 'audio', mime: 'audio/aac', ext: 'aac' },
  'audio/wav': AUDIO_WAV,
  'audio/vnd.wave': AUDIO_WAV,
  'audio/x-wav': AUDIO_WAV,
};

export const sniff = async (file: string): Promise<TMediaType | null> => {
  const detected = await fileTypeFromFile(file);
  return (detected && ALLOWED[detected.mime]) || null;
};

/** An MP4 whose only tracks are sound: stored and served as m4a audio. */
export const AUDIO_ONLY_MP4: TMediaType = AUDIO_M4A;

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
  // Exact types matter: WhatsApp checks Content-Type when it fetches a media link.
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
};
