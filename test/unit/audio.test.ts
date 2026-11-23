import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import config from '../../src/config';
import { maxBytesFor } from '../../src/app/modules/files/files.service';
import { mimeByExt, sniff } from '../../src/lib/media/sniff';
import { isValidExt } from '../../src/lib/storage/layout';
import { validateNonImage } from '../../src/lib/media/validateMedia';

const FIX = path.join(__dirname, '..', 'fixtures', 'audio');
const fix = (name: string) => path.join(FIX, name);
const tmp = (name: string, data: Buffer | string) => {
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ms-audio-')),
    name
  );
  fs.writeFileSync(p, data);
  return p;
};
const cut = (name: string, keep = 0.6) => {
  const b = fs.readFileSync(fix(name));
  return tmp(`cut-${name}`, b.subarray(0, Math.floor(b.length * keep)));
};
// fixtures are 1 s tones
const aboutOneSecond = (meta: Record<string, unknown>) => {
  const d = meta.duration_ms as number;
  expect(d).toBeGreaterThan(800);
  expect(d).toBeLessThan(1300);
};

describe('sniff audio', () => {
  it.each([
    ['opus.ogg', 'ogg', 'audio/ogg'],
    ['vorbis.ogg', 'ogg', 'audio/ogg'],
    ['id3.mp3', 'mp3', 'audio/mpeg'],
    ['bare.mp3', 'mp3', 'audio/mpeg'],
    ['voice.m4a', 'm4a', 'audio/mp4'],
    ['adts.aac', 'aac', 'audio/aac'],
    ['tone.wav', 'wav', 'audio/wav'],
  ])('%s → %s', async (file, ext, mime) => {
    expect(await sniff(fix(file))).toEqual({ kind: 'audio', ext, mime });
  });

  it('ignores the name: an mp3 called .png is still audio', async () => {
    const p = tmp('song.png', fs.readFileSync(fix('id3.mp3')));
    expect(await sniff(p)).toMatchObject({ kind: 'audio', ext: 'mp3' });
  });

  it('an audio-only MP4 sniffs as video (reclassified after validation)', async () => {
    expect(await sniff(fix('sound-only.mp4'))).toMatchObject({
      kind: 'video',
      ext: 'mp4',
    });
  });

  it('every audio ext is a storage ext with an exact served type', () => {
    for (const ext of ['ogg', 'mp3', 'm4a', 'aac', 'wav']) {
      expect(isValidExt(ext)).toBe(true);
    }
    expect(mimeByExt.ogg).toBe('audio/ogg');
    expect(mimeByExt.m4a).toBe('audio/mp4');
    expect(mimeByExt.mp3).toBe('audio/mpeg');
  });
});

describe('validate audio', () => {
  it.each([
    ['opus.ogg', 'ogg', 'opus'],
    ['vorbis.ogg', 'ogg', 'vorbis'],
    ['id3.mp3', 'mp3', 'mp3'],
    ['bare.mp3', 'mp3', 'mp3'],
    ['adts.aac', 'aac', 'aac'],
    ['tone.wav', 'wav', 'pcm'],
  ])('%s is valid, codec %s, duration read', async (file, ext, codec) => {
    const meta = await validateNonImage(fix(file), ext);
    expect(meta.codec).toBe(codec);
    aboutOneSecond(meta);
  });

  it('m4a: valid, duration from mvhd', async () => {
    const meta = await validateNonImage(fix('voice.m4a'), 'm4a');
    expect(meta.sound_only).toBe(true);
    aboutOneSecond(meta);
  });

  it('marks a sound-only MP4 and leaves a real video alone', async () => {
    const audio = await validateNonImage(fix('sound-only.mp4'), 'mp4');
    expect(audio.sound_only).toBe(true);
    aboutOneSecond(audio);
    const video = await validateNonImage(fix('video.mp4'), 'mp4');
    expect(video).toEqual({ faststart: true });
  });

  it.each([
    ['opus.ogg', 'ogg'],
    ['vorbis.ogg', 'ogg'],
    ['adts.aac', 'aac'],
    ['tone.wav', 'wav'],
    ['voice.m4a', 'm4a'],
  ])('rejects a truncated %s', async (file, ext) => {
    await expect(validateNonImage(cut(file), ext)).rejects.toMatchObject({
      code: 'invalid_content',
    });
  });

  it('rejects junk that only starts like audio', async () => {
    await expect(
      validateNonImage(tmp('x.ogg', 'OggS' + 'x'.repeat(200)), 'ogg')
    ).rejects.toMatchObject({ code: 'invalid_content' });
    await expect(
      validateNonImage(tmp('x.mp3', Buffer.alloc(500, 0)), 'mp3')
    ).rejects.toMatchObject({ code: 'invalid_content' });
    await expect(
      validateNonImage(tmp('x.wav', 'RIFF\0\0\0\0WAVE' + 'x'.repeat(60)), 'wav')
    ).rejects.toMatchObject({ code: 'invalid_content' });
  });

  it('an m4a holding a video track is refused', async () => {
    await expect(
      validateNonImage(fix('video.mp4'), 'm4a')
    ).rejects.toMatchObject({ code: 'invalid_content' });
  });
});

describe('size limits', () => {
  it('audio has its own limit (20 MB default); other kinds keep MAX_FILE_BYTES', () => {
    expect(maxBytesFor('audio')).toBe(config.upload.maxAudioBytes);
    expect(config.upload.maxAudioBytes).toBe(20 * 1024 * 1024);
    expect(maxBytesFor('image')).toBe(config.upload.maxFileBytes);
    expect(maxBytesFor('video')).toBe(config.upload.maxFileBytes);
    expect(config.upload.maxStreamBytes).toBe(
      Math.max(config.upload.maxFileBytes, config.upload.maxAudioBytes)
    );
  });
});
