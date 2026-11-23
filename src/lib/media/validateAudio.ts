import ProblemError from '../../errors/ProblemError';

// Structural checks for audio files. No decoding and no transcoding: the goal is to refuse
// truncated / corrupt / disguised files and to read the duration where the header has it.
// Every function takes the whole file (audio is capped at 25 MB) and returns its `meta`.

const invalid = (detail: string) => new ProblemError('invalid_content', detail);

export type TAudioMeta = { duration_ms: number | null; codec?: string };

const ms = (seconds: number): number | null =>
  Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;

// ---- MP4 / M4A ---------------------------------------------------------------------------

type TBox = { type: string; start: number; header: number; end: number };

// Child boxes of [from, to). Returns null when a size field points outside the range.
const childBoxes = (buf: Buffer, from: number, to: number): TBox[] | null => {
  const out: TBox[] = [];
  let offset = from;
  while (offset + 8 <= to) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > to) return null;
      const large = buf.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < header || offset + size > to) return null;
    out.push({ type, start: offset, header, end: offset + size });
    offset += size;
  }
  return out;
};

const find = (buf: Buffer, parent: TBox, type: string): TBox[] =>
  (childBoxes(buf, parent.start + parent.header, parent.end) ?? []).filter(
    b => b.type === type
  );

/**
 * Track handler types (`soun`, `vide`, …) and the movie duration of a structurally valid MP4.
 * Used to store audio-only MP4s (Messenger / Instagram voice clips) as m4a audio.
 */
export const mp4Info = (
  buf: Buffer
): { handlers: string[]; duration_ms: number | null } => {
  const top = childBoxes(buf, 0, buf.length) ?? [];
  const moov = top.find(b => b.type === 'moov');
  if (!moov) return { handlers: [], duration_ms: null };

  const handlers: string[] = [];
  for (const trak of find(buf, moov, 'trak')) {
    for (const mdia of find(buf, trak, 'mdia')) {
      for (const hdlr of find(buf, mdia, 'hdlr')) {
        // full box: version+flags (4), pre_defined (4), handler_type (4)
        const at = hdlr.start + hdlr.header + 8;
        if (at + 4 <= hdlr.end)
          handlers.push(buf.toString('latin1', at, at + 4));
      }
    }
  }

  let duration: number | null = null;
  const mvhd = find(buf, moov, 'mvhd')[0];
  if (mvhd) {
    const p = mvhd.start + mvhd.header;
    const version = buf[p];
    if (version === 1 && p + 32 <= mvhd.end) {
      const scale = buf.readUInt32BE(p + 20);
      const d = Number(buf.readBigUInt64BE(p + 24));
      if (scale > 0) duration = ms(d / scale);
    } else if (version === 0 && p + 20 <= mvhd.end) {
      const scale = buf.readUInt32BE(p + 12);
      const d = buf.readUInt32BE(p + 16);
      if (scale > 0) duration = ms(d / scale);
    }
  }
  return { handlers, duration_ms: duration };
};

// ---- OGG (Opus / Vorbis) -----------------------------------------------------------------

const OGG_HEADER = 27;

// Size of the Ogg page at `offset`, or -1 when its header/segment table runs past the end.
const oggPageSize = (buf: Buffer, offset: number): number => {
  if (offset + OGG_HEADER > buf.length) return -1;
  if (buf.toString('latin1', offset, offset + 4) !== 'OggS') return -1;
  const segments = buf[offset + 26];
  if (offset + OGG_HEADER + segments > buf.length) return -1;
  let body = 0;
  for (let i = 0; i < segments; i++) body += buf[offset + OGG_HEADER + i];
  return OGG_HEADER + segments + body;
};

export const validateOgg = (buf: Buffer): TAudioMeta => {
  if (buf.length < 64 || buf.toString('latin1', 0, 4) !== 'OggS') {
    throw invalid('not an Ogg file');
  }
  const head = buf.subarray(0, Math.min(buf.length, 512));
  const opusAt = head.indexOf('OpusHead');
  const vorbisAt = head.indexOf('\x01vorbis', 0, 'latin1');
  if (opusAt < 0 && vorbisAt < 0) {
    throw invalid('Ogg file has no Opus or Vorbis audio');
  }

  // Walk every page: the sizes must chain exactly to the end of the file (truncation check).
  let offset = 0;
  let last = -1;
  while (offset < buf.length) {
    const size = oggPageSize(buf, offset);
    if (size < 0 || offset + size > buf.length) {
      throw invalid('Ogg file is truncated or corrupt');
    }
    last = offset;
    offset += size;
  }

  // Duration = granule position of the last page / sample rate (Opus always 48 kHz, minus pre-skip).
  const granule = Number(buf.readBigInt64LE(last + 6));
  if (opusAt >= 0) {
    const preSkip =
      opusAt + 12 <= buf.length ? buf.readUInt16LE(opusAt + 10) : 0;
    return { codec: 'opus', duration_ms: ms((granule - preSkip) / 48000) };
  }
  // Vorbis identification header: \x01vorbis, version (4), channels (1), sample rate (4)
  const rate =
    vorbisAt + 16 <= buf.length ? buf.readUInt32LE(vorbisAt + 12) : 0;
  return { codec: 'vorbis', duration_ms: rate > 0 ? ms(granule / rate) : null };
};

// ---- ID3 (MP3 / ADTS prefix) -------------------------------------------------------------

// Length of a leading ID3v2 tag (0 when there is none).
const id3Length = (buf: Buffer): number => {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size =
    ((buf[6] & 0x7f) << 21) |
    ((buf[7] & 0x7f) << 14) |
    ((buf[8] & 0x7f) << 7) |
    (buf[9] & 0x7f);
  const footer = buf[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
};

// ---- MP3 ---------------------------------------------------------------------------------

// Bitrates (kbps) for Layer III: [MPEG-1, MPEG-2/2.5]
const L3_BITRATES = [
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

type TMp3Frame = { length: number; samples: number; rate: number };

// Layer III frame header at `o`, or null when it is not a valid one.
const mp3Frame = (buf: Buffer, o: number): TMp3Frame | null => {
  if (o + 4 > buf.length) return null;
  if (buf[o] !== 0xff || (buf[o + 1] & 0xe0) !== 0xe0) return null;
  const version = (buf[o + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 = reserved
  const layer = (buf[o + 1] >> 1) & 3; // 1 = Layer III
  if (version === 1 || layer !== 1) return null;
  const bitrateIdx = buf[o + 2] >> 4;
  const rateIdx = (buf[o + 2] >> 2) & 3;
  if (bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) return null;
  const mpeg1 = version === 3;
  const bitrate = L3_BITRATES[mpeg1 ? 0 : 1][bitrateIdx] * 1000;
  const rate = SAMPLE_RATES[version][rateIdx];
  const padding = (buf[o + 2] >> 1) & 1;
  const samples = mpeg1 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * bitrate) / rate) + padding;
  return length > 4 ? { length, samples, rate } : null;
};

export const validateMp3 = (buf: Buffer): TAudioMeta => {
  let o = id3Length(buf);
  // allow a little junk/padding before the first frame
  const limit = Math.min(buf.length, o + 4096);
  while (o < limit && !mp3Frame(buf, o)) o++;
  let frames = 0;
  let seconds = 0;
  while (o < buf.length) {
    const f = mp3Frame(buf, o);
    if (!f) break;
    if (o + f.length > buf.length) break; // a cut last frame is tolerated
    frames++;
    seconds += f.samples / f.rate;
    o += f.length;
  }
  if (frames < 3) throw invalid('not a valid MP3 file');
  return { codec: 'mp3', duration_ms: ms(seconds) };
};

// ---- AAC (ADTS) --------------------------------------------------------------------------

const ADTS_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];

export const validateAdts = (buf: Buffer): TAudioMeta => {
  let o = id3Length(buf);
  let frames = 0;
  let seconds = 0;
  while (o < buf.length) {
    if (o + 7 > buf.length) throw invalid('AAC file is truncated');
    if (buf[o] !== 0xff || (buf[o + 1] & 0xf6) !== 0xf0) {
      throw invalid('corrupt AAC (ADTS) stream');
    }
    const rate = ADTS_RATES[(buf[o + 2] >> 2) & 0x0f];
    const length =
      ((buf[o + 3] & 3) << 11) | (buf[o + 4] << 3) | (buf[o + 5] >> 5);
    if (!rate || length < 7) throw invalid('corrupt AAC (ADTS) stream');
    if (o + length > buf.length) throw invalid('AAC file is truncated');
    const blocks = (buf[o + 6] & 3) + 1;
    seconds += (1024 * blocks) / rate;
    frames++;
    o += length;
  }
  if (frames < 1) throw invalid('not a valid AAC file');
  return { codec: 'aac', duration_ms: ms(seconds) };
};

// ---- WAV ---------------------------------------------------------------------------------

export const validateWav = (buf: Buffer): TAudioMeta => {
  if (
    buf.length < 44 ||
    buf.toString('latin1', 0, 4) !== 'RIFF' ||
    buf.toString('latin1', 8, 12) !== 'WAVE'
  ) {
    throw invalid('not a WAV file');
  }
  let o = 12;
  let byteRate = 0;
  let dataSize = -1;
  while (o + 8 <= buf.length) {
    const id = buf.toString('latin1', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length)
        throw invalid('corrupt WAV header');
      byteRate = buf.readUInt32LE(body + 8);
    } else if (id === 'data') {
      if (body + size > buf.length) throw invalid('WAV file is truncated');
      dataSize = size;
      break;
    }
    o = body + size + (size % 2); // chunks are word-aligned
  }
  if (!byteRate || dataSize < 0) throw invalid('WAV has no fmt or data chunk');
  return { codec: 'pcm', duration_ms: ms(dataSize / byteRate) };
};
