import fsp from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { v7 as uuidv7 } from 'uuid';
import config from '../../config';
import { metrics } from '../../shared/metrics';
import { imageSlots } from '../media/processImage';
import { originalPath, tmpPath, variantPath } from '../storage/layout';
import { exists, remove } from '../storage/localStorage';

const VARIANT_SOURCES = ['jpg', 'png', 'webp'] as const;

export const isAllowedVariant = (w: number, fmt: string): boolean =>
  config.variants.widths.includes(w) &&
  (config.variants.formats as string[]).includes(fmt);

// The read path has no DB: find the original by trying the image extensions that have variants.
export const findVariantSource = async (id: string): Promise<string | null> => {
  for (const ext of VARIANT_SOURCES) {
    const p = originalPath(id, ext);
    if (await exists(p)) return p;
  }
  return null;
};

const encode = (img: sharp.Sharp, fmt: string): sharp.Sharp => {
  const { image } = config;
  switch (fmt) {
    case 'jpg':
      return img
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: image.jpegQuality, mozjpeg: true });
    case 'png':
      return img.png({ compressionLevel: 9, adaptiveFiltering: true });
    case 'webp':
      return img.webp({ quality: image.webpQuality, effort: 4 });
    case 'avif':
      return img.avif({ quality: image.avifQuality, effort: 4 });
    default:
      throw new Error(`unsupported variant format ${fmt}`);
  }
};

// Concurrent requests for the same variant share one render.
const inflight = new Map<string, Promise<string | null>>();

const render = async (
  id: string,
  source: string,
  w: number,
  fmt: string
): Promise<string | null> => {
  const dest = variantPath(id, w, fmt);
  const tmp = tmpPath(`${uuidv7()}.variant`);
  const end = metrics.variantDuration.startTimer();
  try {
    await imageSlots(() =>
      encode(
        sharp(source, { limitInputPixels: config.image.maxPixels })
          .rotate()
          .resize({ width: w, withoutEnlargement: true }) // never upscale
          .toColourspace('srgb'),
        fmt
      ).toFile(tmp)
    );
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(tmp, dest);
    metrics.variantGenerations.inc({ fmt });
  } finally {
    end();
    await remove(tmp);
  }
  // The file may have been deleted while rendering: don't leave a variant behind.
  if (!(await exists(source))) {
    await remove(dest);
    return null;
  }
  return dest;
};

// Returns the cached variant path, rendering it on first request. null = no such source.
export const getVariant = async (
  id: string,
  w: number,
  fmt: string
): Promise<string | null> => {
  const dest = variantPath(id, w, fmt);
  if (await exists(dest)) return dest;
  const source = await findVariantSource(id);
  if (!source) return null;

  let job = inflight.get(dest);
  if (!job) {
    job = render(id, source, w, fmt).finally(() => inflight.delete(dest));
    inflight.set(dest, job);
  }
  return job;
};
