import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import ProblemError from '../../src/errors/ProblemError';
import { processImage } from '../../src/lib/media/processImage';
import { sniff } from '../../src/lib/media/sniff';
import { stripMetadata } from '../../src/lib/media/stripMetadata';
import {
  validateDocx,
  validateMp4,
  validatePdf,
} from '../../src/lib/media/validateMedia';

const tmp = (name: string, data: Buffer | string) => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-')), name);
  fs.writeFileSync(p, data);
  return p;
};

// A noisy photo-like image so JPEG compression has something to do.
const photo = async (w = 1200, h = 800) => {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + ((i / w) | 0) * 13) % 256;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } });
};

const box = (type: string, payload = Buffer.alloc(8)) => {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(b.length, 0);
  b.write(type, 4, 'latin1');
  payload.copy(b, 8);
  return b;
};

describe('sniff', () => {
  it('detects by magic bytes, not by name', async () => {
    const jpg = await (await photo(16, 16)).jpeg().toBuffer();
    expect(await sniff(tmp('cat.png', jpg))).toMatchObject({ ext: 'jpg' });
  });
  it('rejects SVG and HTML disguised as images', async () => {
    expect(await sniff(tmp('x.jpg', '<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(await sniff(tmp('x.jpg', '<!doctype html><script>alert(1)</script>'))).toBeNull();
  });
});

describe('processImage', () => {
  it('compresses a raw JPEG at the same resolution and strips EXIF', async () => {
    const input = await (await photo())
      .withMetadata({ exif: { IFD0: { Copyright: 'secret-gps' } } })
      .jpeg({ quality: 100 })
      .toBuffer();
    const out = await processImage(input, 'jpg');
    expect(out.width).toBe(1200);
    expect(out.height).toBe(800);
    expect(out.compressed).toBe(true);
    expect(out.data.length).toBeLessThan(input.length);
    expect((await sharp(out.data).metadata()).exif).toBeUndefined();
  });

  it('applies EXIF orientation', async () => {
    const input = await (await photo(200, 100))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const out = await processImage(input, 'jpg');
    expect([out.width, out.height]).toEqual([100, 200]);
  });

  it('never makes a file bigger: keeps original pixels when saving is too small', async () => {
    const input = await (await photo(300, 200)).jpeg({ quality: 40, mozjpeg: true }).toBuffer();
    const out = await processImage(input, 'jpg');
    expect(out.data.length).toBeLessThanOrEqual(input.length);
  });

  it('rejects decompression bombs and corrupt images with 422', async () => {
    const bomb = await sharp({
      create: { width: 10000, height: 10000, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    await expect(processImage(bomb, 'png')).rejects.toMatchObject({ code: 'invalid_content' });
    await expect(processImage(Buffer.from('\xff\xd8\xff garbage'), 'jpg')).rejects.toBeInstanceOf(
      ProblemError
    );
  });
});

describe('stripMetadata', () => {
  it('removes PNG text chunks but keeps pixels', async () => {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#f00' },
    })
      .png()
      .withMetadata({ exif: { IFD0: { Artist: 'me' } } })
      .toBuffer();
    const out = stripMetadata(png, 'png');
    expect(out.includes(Buffer.from('eXIf'))).toBe(false);
    expect((await sharp(out).raw().toBuffer()).equals(await sharp(png).raw().toBuffer())).toBe(true);
  });
});

describe('validators', () => {
  it('mp4: detects faststart and rejects truncation', () => {
    const fast = Buffer.concat([box('ftyp'), box('moov'), box('mdat')]);
    const slow = Buffer.concat([box('ftyp'), box('mdat'), box('moov')]);
    expect(validateMp4(fast)).toEqual({ faststart: true });
    expect(validateMp4(slow)).toEqual({ faststart: false });
    expect(() => validateMp4(fast.subarray(0, fast.length - 3))).toThrow(ProblemError);
    expect(() => validateMp4(Buffer.concat([box('ftyp'), box('mdat')]))).toThrow(ProblemError);
  });

  it('pdf: requires %%EOF', () => {
    expect(() => validatePdf(Buffer.from('%PDF-1.7\n...\n%%EOF\n'))).not.toThrow();
    expect(() => validatePdf(Buffer.from('%PDF-1.7\n... truncated'))).toThrow(ProblemError);
  });

  it('docx: rejects a plain zip renamed to .docx', async () => {
    // Minimal valid empty zip (end of central directory only).
    const emptyZip = Buffer.from('504b0506' + '00'.repeat(18), 'hex');
    await expect(validateDocx(tmp('x.docx', emptyZip))).rejects.toMatchObject({
      code: 'invalid_content',
    });
  });
});
