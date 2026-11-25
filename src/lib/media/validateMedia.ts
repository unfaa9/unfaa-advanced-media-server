import fsp from 'fs/promises';
import yauzl from 'yauzl';
import ProblemError from '../../errors/ProblemError';
import {
  mp4Info,
  validateAdts,
  validateMp3,
  validateOgg,
  validateWav,
} from './validateAudio';

const invalid = (detail: string) => new ProblemError('invalid_content', detail);

// MP4: walk the top-level boxes. Requires ftyp first, plus moov and mdat, with box sizes that
// add up to the file length. faststart = moov comes before mdat.
export const validateMp4 = (buf: Buffer): { faststart: boolean } => {
  let offset = 0;
  let moovAt = -1;
  let mdatAt = -1;
  let first = true;
  while (offset < buf.length) {
    if (offset + 8 > buf.length) throw invalid('truncated MP4 box header');
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > buf.length) throw invalid('truncated MP4 box header');
      const large = buf.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('bad MP4 box');
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = buf.length - offset; // box extends to end of file
    }
    if (size < header || offset + size > buf.length) {
      throw invalid('truncated or corrupt MP4');
    }
    if (first && type !== 'ftyp') throw invalid('MP4 must start with ftyp');
    first = false;
    if (type === 'moov' && moovAt < 0) moovAt = offset;
    if (type === 'mdat' && mdatAt < 0) mdatAt = offset;
    offset += size;
  }
  if (moovAt < 0 || mdatAt < 0) throw invalid('MP4 is missing moov or mdat');
  return { faststart: moovAt < mdatAt };
};

// WebM: EBML header, then a Segment element near the start.
export const validateWebm = (buf: Buffer): void => {
  if (buf.length < 64 || buf.readUInt32BE(0) !== 0x1a45dfa3) {
    throw invalid('not a WebM file');
  }
  const segment = Buffer.from([0x18, 0x53, 0x80, 0x67]);
  if (buf.subarray(0, 4096).indexOf(segment) < 0) {
    throw invalid('WebM has no Segment element');
  }
};

// PDF: %PDF- header and a %%EOF marker near the end.
export const validatePdf = (buf: Buffer): void => {
  if (buf.toString('latin1', 0, 5) !== '%PDF-') throw invalid('not a PDF');
  if (buf.subarray(Math.max(0, buf.length - 1024)).indexOf('%%EOF') < 0) {
    throw invalid('PDF is truncated (no %%EOF)');
  }
};

const DOCX_MAX_ENTRIES = 5000;
const DOCX_MAX_UNCOMPRESSED = 200 * 1024 * 1024;
const DOCX_MAX_RATIO = 200;

// DOCX: a real Word package. Rejects macros, path traversal and zip bombs.
export const validateDocx = async (file: string): Promise<void> => {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, z) =>
      err || !z ? reject(invalid('corrupt DOCX archive')) : resolve(z)
    )
  );
  const names = new Set<string>();
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    const fail = (detail: string) => {
      zip.close();
      reject(invalid(detail));
    };
    zip.on('entry', (entry: yauzl.Entry) => {
      const name = entry.fileName;
      if (
        name.startsWith('/') ||
        name.includes('\\') ||
        name.split('/').includes('..')
      ) {
        return fail('DOCX contains an unsafe path');
      }
      if (/(^|\/)vbaProject\.bin$/i.test(name)) {
        return fail('macro-enabled documents are not allowed');
      }
      total += entry.uncompressedSize;
      if (
        names.size >= DOCX_MAX_ENTRIES ||
        total > DOCX_MAX_UNCOMPRESSED ||
        (entry.compressedSize > 0 &&
          entry.uncompressedSize / entry.compressedSize > DOCX_MAX_RATIO)
      ) {
        return fail('DOCX looks like a zip bomb');
      }
      names.add(name);
      zip.readEntry();
    });
    zip.on('end', () => resolve());
    zip.on('error', () => reject(invalid('corrupt DOCX archive')));
    zip.readEntry();
  });
  if (!names.has('[Content_Types].xml') || !names.has('word/document.xml')) {
    throw invalid('not a Word document');
  }
};

// ---- ISO media on disk (mp4 / m4a / mov / 3gp) ------------------------------------------
// Walks the top-level boxes with small reads (8/16-byte headers) and loads only the moov box,
// so a 50 MB video never sits in memory.

const MOOV_MAX_BYTES = 16 * 1024 * 1024;
const MAX_TOP_BOXES = 10_000;
// Old QuickTime files may start without ftyp.
const MOV_FIRST_BOXES = ['ftyp', 'wide', 'free', 'skip', 'moov', 'mdat'];

export const validateIsoFile = async (
  file: string,
  ext: string
): Promise<{ faststart: boolean; moov: Buffer }> => {
  const fd = await fsp.open(file, 'r');
  try {
    const { size: total } = await fd.stat();
    const head = Buffer.alloc(16);
    let offset = 0;
    let moov: { at: number; size: number } | null = null;
    let mdatAt = -1;
    let count = 0;
    while (offset < total) {
      if (++count > MAX_TOP_BOXES) throw invalid('too many MP4 boxes');
      if (offset + 8 > total) throw invalid('truncated MP4 box header');
      const { bytesRead } = await fd.read(head, 0, 16, offset);
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let header = 8;
      if (size === 1) {
        if (bytesRead < 16) throw invalid('truncated MP4 box header');
        const large = head.readBigUInt64BE(8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER))
          throw invalid('bad MP4 box');
        size = Number(large);
        header = 16;
      } else if (size === 0) {
        size = total - offset; // box extends to end of file
      }
      if (size < header || offset + size > total) {
        throw invalid('truncated or corrupt MP4');
      }
      if (count === 1) {
        const ok =
          ext === 'mov' ? MOV_FIRST_BOXES.includes(type) : type === 'ftyp';
        if (!ok) throw invalid('MP4 must start with ftyp');
      }
      if (type === 'moov' && !moov) moov = { at: offset, size };
      if (type === 'mdat' && mdatAt < 0) mdatAt = offset;
      offset += size;
    }
    if (!moov || mdatAt < 0) throw invalid('MP4 is missing moov or mdat');
    if (moov.size > MOOV_MAX_BYTES) throw invalid('MP4 moov box is too large');
    const buf = Buffer.alloc(moov.size);
    await fd.read(buf, 0, moov.size, moov.at);
    return { faststart: moov.at < mdatAt, moov: buf };
  } finally {
    await fd.close();
  }
};

const ISO_EXTS = ['mp4', 'm4a', 'mov', '3gp'];
// WebM is checked on its header only (EBML + Segment); there is no truncation check.
const WEBM_HEAD_BYTES = 1024 * 1024;

const readHead = async (file: string, bytes: number): Promise<Buffer> => {
  const fd = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fd.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
};

export const validateNonImage = async (
  file: string,
  ext: string
): Promise<Record<string, unknown>> => {
  if (ext === 'docx') {
    await validateDocx(file);
    return {};
  }
  if (ISO_EXTS.includes(ext)) {
    const { faststart, moov } = await validateIsoFile(file, ext);
    // mp4Info walks from the top level: a buffer holding just the moov box works.
    const { handlers, duration_ms } = mp4Info(moov);
    // only sound tracks (Messenger / Instagram voice clips): stored as m4a audio
    const sound_only = handlers.length > 0 && handlers.every(h => h === 'soun');
    // an "M4A" holding a video track would be served as audio/mp4: refuse it
    if (ext === 'm4a' && !sound_only) {
      throw invalid('M4A must contain only audio');
    }
    return sound_only
      ? { faststart, duration_ms, sound_only }
      : { faststart, ...(duration_ms != null ? { duration_ms } : {}) };
  }
  if (ext === 'webm') {
    validateWebm(await readHead(file, WEBM_HEAD_BYTES));
    return {};
  }
  // pdf + audio are ≤ 25 MB: read whole.
  const buf = await fsp.readFile(file);
  if (ext === 'pdf') validatePdf(buf);
  if (ext === 'ogg') return validateOgg(buf);
  if (ext === 'mp3') return validateMp3(buf);
  if (ext === 'aac') return validateAdts(buf);
  if (ext === 'wav') return validateWav(buf);
  return {};
};
