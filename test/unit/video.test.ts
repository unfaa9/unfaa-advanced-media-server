import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertAllowed } from '../../src/app/modules/files/files.service';
import { mimeByExt, sniff, TMediaType } from '../../src/lib/media/sniff';
import { isValidExt } from '../../src/lib/storage/layout';
import { validateNonImage } from '../../src/lib/media/validateMedia';

const MB = 1024 * 1024;
const VIDEO = path.join(__dirname, '..', 'fixtures', 'video');
const AUDIO = path.join(__dirname, '..', 'fixtures', 'audio');
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ms-video-'));

const box = (type: string, payload = Buffer.alloc(8)) => {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(b.length, 0);
  b.write(type, 4, 'latin1');
  payload.copy(b, 8);
  return b;
};

// ftyp + moov (from a real clip) + a sparse mdat of `bytes`, so a big file costs no disk/RAM.
const bigMp4 = async (bytes: number): Promise<string> => {
  const real = fs.readFileSync(path.join(AUDIO, 'video.mp4'));
  const ftyp = box(
    'ftyp',
    Buffer.from('isom\0\0\x02\0isomiso2avc1mp41', 'latin1')
  );
  // moov of the real clip
  let off = 0;
  let moov: Buffer | null = null;
  while (off < real.length) {
    const size = real.readUInt32BE(off);
    if (real.toString('latin1', off + 4, off + 8) === 'moov') {
      moov = real.subarray(off, off + size);
    }
    off += size;
  }
  if (!moov) throw new Error('fixture has no moov');
  const head = Buffer.concat([ftyp, moov]);
  const mdatSize = bytes - head.length;
  const mdatHeader = Buffer.alloc(8);
  mdatHeader.writeUInt32BE(mdatSize, 0);
  mdatHeader.write('mdat', 4, 'latin1');
  const p = path.join(dir(), 'big.mp4');
  const fh = await fsp.open(p, 'w');
  await fh.write(Buffer.concat([head, mdatHeader]), 0, head.length + 8, 0);
  await fh.truncate(bytes);
  await fh.close();
  return p;
};

const type = (
  kind: TMediaType['kind'],
  ext: TMediaType['ext']
): TMediaType => ({
  kind,
  ext,
  mime: mimeByExt[ext],
});

afterEach(() => vi.restoreAllMocks());

describe('video formats', () => {
  it('mov (iPhone) and 3gp (WhatsApp) are allowed with the right mime / ext', async () => {
    expect(await sniff(path.join(VIDEO, 'clip.mov'))).toEqual({
      kind: 'video',
      mime: 'video/quicktime',
      ext: 'mov',
    });
    expect(await sniff(path.join(VIDEO, 'clip.3gp'))).toEqual({
      kind: 'video',
      mime: 'video/3gpp',
      ext: '3gp',
    });
    expect(isValidExt('mov')).toBe(true);
    expect(isValidExt('3gp')).toBe(true);
    expect(mimeByExt.mov).toBe('video/quicktime');
    expect(mimeByExt['3gp']).toBe('video/3gpp');
  });

  it.each(['clip.mov', 'clip.3gp'])(
    '%s validates as a video with a duration',
    async file => {
      const ext = path.extname(file).slice(1);
      const meta = await validateNonImage(path.join(VIDEO, file), ext);
      expect(meta.sound_only).toBeUndefined();
      expect(typeof meta.faststart).toBe('boolean');
      expect(Number(meta.duration_ms)).toBeGreaterThan(500);
    }
  );

  it('a truncated mp4 is refused (422 invalid_content)', async () => {
    const real = fs.readFileSync(path.join(AUDIO, 'video.mp4'));
    const p = path.join(dir(), 'cut.mp4');
    fs.writeFileSync(p, real.subarray(0, real.length - 10));
    await expect(validateNonImage(p, 'mp4')).rejects.toMatchObject({
      code: 'invalid_content',
    });
    const noMdat = path.join(dir(), 'nomdat.mp4');
    fs.writeFileSync(noMdat, Buffer.concat([box('ftyp'), box('moov')]));
    await expect(validateNonImage(noMdat, 'mp4')).rejects.toMatchObject({
      code: 'invalid_content',
    });
  });

  it('validates a 49 MB mp4 without reading the whole file', async () => {
    const p = await bigMp4(49 * MB);
    const readFile = vi.spyOn(fsp, 'readFile');
    const meta = await validateNonImage(p, 'mp4');
    expect(meta.faststart).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('per-kind size limits', () => {
  it('video up to 50 MB; image / document 15 MB; audio 20 MB', () => {
    expect(() => assertAllowed(type('video', 'mp4'), 20 * MB)).not.toThrow();
    expect(() => assertAllowed(type('video', 'mp4'), 49 * MB)).not.toThrow();
    expect(() => assertAllowed(type('video', 'mp4'), 51 * MB)).toThrow(
      /video files can be up to 50 MB/
    );
    expect(() => assertAllowed(type('image', 'jpg'), 16 * MB)).toThrow(
      /image files can be up to 15 MB/
    );
    expect(() => assertAllowed(type('audio', 'mp3'), 21 * MB)).toThrow(
      /audio files can be up to 20 MB/
    );
  });
});
