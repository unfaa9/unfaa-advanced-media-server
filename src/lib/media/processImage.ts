import os from 'os';
import pLimit from 'p-limit';
import sharp from 'sharp';
import config from '../../config';
import ProblemError from '../../errors/ProblemError';
import { stripMetadata } from './stripMetadata';

// libvips does its own threading; one job per CPU bounds RAM for concurrent uploads + variants.
sharp.cache(false);
sharp.concurrency(1);
export const imageSlots = pLimit(Math.max(1, os.cpus().length));

// A palette-quantised PNG is used only if it stays this close to the source (screenshots,
// logos); photos saved as PNG fall back to lossless recompression.
const PNG_PALETTE_MIN_PSNR = 38;

export type TProcessedImage = {
  data: Buffer;
  width: number;
  height: number;
  compressed: boolean;
};

const invalid = (detail: string) => new ProblemError('invalid_content', detail);

const isLosslessWebp = (buf: Buffer): boolean => {
  for (let i = 12; i + 8 <= buf.length; ) {
    const fourcc = buf.toString('latin1', i, i + 4);
    if (fourcc === 'VP8L') return true;
    if (fourcc === 'VP8 ') return false;
    const size = buf.readUInt32LE(i + 4);
    i += 8 + size + (size & 1);
  }
  return false;
};

// PSNR between two images, compared at ≤ 512 px to keep it cheap.
const psnr = async (a: Buffer, b: Buffer): Promise<number> => {
  const raw = (input: Buffer) =>
    sharp(input)
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer();
  const [ra, rb] = await Promise.all([raw(a), raw(b)]);
  if (ra.length !== rb.length) return 0;
  let sum = 0;
  for (let i = 0; i < ra.length; i++) {
    const d = ra[i] - rb[i];
    sum += d * d;
  }
  const mse = sum / ra.length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
};

const encode = async (
  input: Buffer,
  ext: string,
  animated: boolean,
  rotate: boolean
): Promise<Buffer> => {
  const { image } = config;
  let pipeline = sharp(input, {
    limitInputPixels: config.image.maxPixels,
    animated,
  }).keepIccProfile();
  if (rotate) pipeline = pipeline.rotate();

  switch (ext) {
    case 'jpg':
      return pipeline
        .jpeg({ quality: image.jpegQuality, mozjpeg: true })
        .toBuffer();
    case 'png': {
      const lossless = await pipeline
        .clone()
        .png({ compressionLevel: 9, effort: 10, adaptiveFiltering: true })
        .toBuffer();
      const palette = await pipeline
        .clone()
        .png({ palette: true, quality: image.pngQuality, effort: 10 })
        .toBuffer();
      if (
        palette.length < lossless.length &&
        (await psnr(lossless, palette)) >= PNG_PALETTE_MIN_PSNR
      ) {
        return palette;
      }
      return lossless;
    }
    case 'webp':
      return pipeline
        .webp(
          isLosslessWebp(input)
            ? { lossless: true, effort: 6 }
            : { quality: image.webpQuality, effort: 6 }
        )
        .toBuffer();
    case 'gif':
      return pipeline.gif({ effort: 10, reuse: true }).toBuffer();
    default:
      throw new Error(`not an image ext: ${ext}`);
  }
};

// Validates and compresses an image at the same resolution. Metadata (EXIF/GPS/XMP/comments) is
// always removed and EXIF orientation applied. The re-encode is kept only when it saves at least
// IMAGE_MIN_SAVING_PERCENT; otherwise the original pixels are kept, so a file never grows.
export const processImage = (input: Buffer, ext: string) =>
  imageSlots(async (): Promise<TProcessedImage> => {
    let meta: sharp.Metadata;
    try {
      meta = await sharp(input, {
        limitInputPixels: config.image.maxPixels,
        animated: true,
      }).metadata();
    } catch {
      throw invalid('corrupt or unsupported image');
    }
    const width = meta.width ?? 0;
    const frameHeight = meta.pageHeight ?? meta.height ?? 0;
    const pages = meta.pages ?? 1;
    if (!width || !frameHeight) throw invalid('image has no dimensions');
    if (width * frameHeight > config.image.maxPixels) {
      throw invalid('image exceeds the pixel limit');
    }
    // Animated images: total pixels across all frames are capped at 2 × MAX_IMAGE_PIXELS.
    if (pages > 1 && width * frameHeight * pages > 2 * config.image.maxPixels) {
      throw invalid('animation exceeds the frame-pixel budget');
    }

    const animated = pages > 1;
    // Orientation 1 = upright; anything else needs the pixels rotated (not for animations).
    const needsRotate = !animated && (meta.orientation ?? 1) > 1;

    let encoded: Buffer;
    try {
      encoded = await encode(input, ext, animated, needsRotate);
    } catch (e) {
      if (e instanceof ProblemError) throw e;
      throw invalid('corrupt image');
    }

    const maxKept = input.length * (1 - config.image.minSavingPercent / 100);
    if (needsRotate || encoded.length <= maxKept) {
      const info = await sharp(encoded, { animated }).metadata();
      return {
        data: encoded,
        width: info.width ?? width,
        height: info.pageHeight ?? info.height ?? frameHeight,
        compressed: encoded.length < input.length,
      };
    }

    let stripped: Buffer;
    try {
      stripped = stripMetadata(input, ext);
    } catch {
      throw invalid('corrupt image structure');
    }
    return { data: stripped, width, height: frameHeight, compressed: false };
  });
