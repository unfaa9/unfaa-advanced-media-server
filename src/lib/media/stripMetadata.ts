// Lossless metadata removal for when a re-encode would not save enough: the original pixels
// are kept byte-for-byte, only EXIF/GPS/XMP/comments are dropped. Colour profiles are kept.

const corrupt = () => new Error('corrupt image structure');

// JPEG: drop APP1 (EXIF/XMP), APP12, APP13 (IPTC) and COM; keep APP0, APP2 (ICC), APP14 (Adobe).
const stripJpeg = (buf: Buffer): Buffer => {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw corrupt();
  const out: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw corrupt();
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xda) {
      out.push(buf.subarray(i)); // start of scan: copy the rest verbatim
      return Buffer.concat(out);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > buf.length) throw corrupt();
    const len = buf.readUInt16BE(i + 2);
    const end = i + 2 + len;
    if (len < 2 || end > buf.length) throw corrupt();
    const drop =
      marker === 0xe1 || marker === 0xec || marker === 0xed || marker === 0xfe;
    if (!drop) out.push(buf.subarray(i, end));
    i = end;
  }
  throw corrupt();
};

const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

const stripPng = (buf: Buffer): Buffer => {
  const out: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  while (i < buf.length) {
    if (i + 12 > buf.length) throw corrupt();
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) throw corrupt();
    if (!PNG_DROP.has(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
};

// WebP: drop EXIF and XMP chunks and clear their flags in VP8X.
const stripWebp = (buf: Buffer): Buffer => {
  if (
    buf.toString('latin1', 0, 4) !== 'RIFF' ||
    buf.toString('latin1', 8, 12) !== 'WEBP'
  ) {
    throw corrupt();
  }
  const chunks: Buffer[] = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const fourcc = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const end = i + 8 + size + (size & 1);
    if (i + 8 + size > buf.length) throw corrupt();
    if (fourcc === 'VP8X') {
      const chunk = Buffer.from(buf.subarray(i, Math.min(end, buf.length)));
      chunk[8] &= ~(0x08 | 0x04); // EXIF and XMP flags
      chunks.push(chunk);
    } else if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      chunks.push(buf.subarray(i, Math.min(end, buf.length)));
    }
    i = end;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
};

// GIF: drop comment, plain-text and application extensions other than the loop count.
const stripGif = (buf: Buffer): Buffer => {
  const sig = buf.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw corrupt();
  let i = 13;
  if (buf[10] & 0x80) i += 3 * (1 << ((buf[10] & 0x07) + 1));
  const out: Buffer[] = [buf.subarray(0, i)];

  const skipSubBlocks = (from: number): number => {
    let j = from;
    while (j < buf.length && buf[j] !== 0) j += buf[j] + 1;
    if (j >= buf.length) throw corrupt();
    return j + 1;
  };

  while (i < buf.length) {
    const intro = buf[i];
    if (intro === 0x3b) {
      out.push(buf.subarray(i, i + 1));
      return Buffer.concat(out);
    }
    if (intro === 0x2c) {
      let j = i + 10;
      if (j > buf.length) throw corrupt();
      if (buf[i + 9] & 0x80) j += 3 * (1 << ((buf[i + 9] & 0x07) + 1));
      j = skipSubBlocks(j + 1); // LZW minimum code size, then data
      out.push(buf.subarray(i, j));
      i = j;
    } else if (intro === 0x21) {
      const label = buf[i + 1];
      const end = skipSubBlocks(i + 2);
      let keep = label === 0xf9; // graphic control
      if (label === 0xff) {
        const app = buf.toString('latin1', i + 3, i + 14);
        keep = app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0';
      }
      if (keep) out.push(buf.subarray(i, end));
      i = end;
    } else {
      throw corrupt();
    }
  }
  // Missing trailer: tolerate it like browsers do.
  out.push(Buffer.from([0x3b]));
  return Buffer.concat(out);
};

export const stripMetadata = (buf: Buffer, ext: string): Buffer => {
  switch (ext) {
    case 'jpg':
      return stripJpeg(buf);
    case 'png':
      return stripPng(buf);
    case 'webp':
      return stripWebp(buf);
    case 'gif':
      return stripGif(buf);
    default:
      return buf;
  }
};
