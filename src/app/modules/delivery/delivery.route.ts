import crypto from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import fsp from 'fs/promises';
import send from 'send';
import { mimeByExt } from '../../../lib/media/sniff';
import {
  isValidExt,
  isValidId,
  originalPath,
} from '../../../lib/storage/layout';
import { getVariant, isAllowedVariant } from '../../../lib/variants/renderVariant';
import logger from '../../../shared/logger';

// Public delivery. No auth, no DB: the URL maps straight to a file on disk.
const router = express.Router();

const DAY_MS = 24 * 3600_000;

const notFound = (res: Response) =>
  res.status(404).type('text/plain').send('Not Found');

const VARIANT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

const setPublicHeaders = (
  res: Response,
  ext: string,
  contentType: string,
  id: string
) => {
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable'); // browser 7 d
  res.setHeader('CDN-Cache-Control', 'max-age=31536000'); // edge 1 y, purged on delete
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // sandbox breaks Chromium's built-in PDF viewer, so PDFs get only default-src 'none'.
  res.setHeader(
    'Content-Security-Policy',
    ext === 'pdf' ? "default-src 'none'" : "default-src 'none'; sandbox"
  );
  res.setHeader(
    'Content-Disposition',
    ext === 'docx' ? `attachment; filename="${id}.docx"` : 'inline'
  );
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
};

const serve = (
  req: Request,
  res: Response,
  next: NextFunction,
  file: string,
  ext: string,
  contentType: string,
  id: string,
  options: send.SendOptions = {}
) => {
  send(req, file, { cacheControl: false, dotfiles: 'deny', ...options })
    .on('headers', response => setPublicHeaders(response, ext, contentType, id))
    .on('error', (err: { status?: number }) => {
      if (err.status === 404) return notFound(res);
      next(err);
    })
    .pipe(res);
};

router.get('/f/:name', (req, res, next) => {
  const m = /^([0-9a-f-]{36})\.([a-z0-9]+)$/.exec(req.params.name);
  if (!m || !isValidId(m[1]) || !isValidExt(m[2])) return notFound(res);
  serve(req, res, next, originalPath(m[1], m[2]), m[2], mimeByExt[m[2]], m[1]);
});

// Variant ETags are derived from size + key (content is immutable per URL) rather than
// mtime, because the LRU trim refreshes mtimes on hits.
const touched = new Map<string, number>();
const refreshForLru = (file: string) => {
  const now = Date.now();
  if ((touched.get(file) ?? 0) + DAY_MS > now) return;
  touched.set(file, now);
  if (touched.size > 50_000) touched.clear();
  const t = new Date(now);
  fsp.utimes(file, t, t).catch(() => undefined);
};

router.get('/i/:id/:variant', async (req, res, next) => {
  try {
    const { id } = req.params;
    const m = /^(\d{1,5})\.([a-z]+)$/.exec(req.params.variant);
    if (!isValidId(id) || !m) return notFound(res);
    const w = Number(m[1]);
    const fmt = m[2];
    if (!isAllowedVariant(w, fmt)) return notFound(res);

    const file = await getVariant(id, w, fmt);
    if (!file) return notFound(res);
    refreshForLru(file);

    const { size } = await fsp.stat(file);
    const key = crypto
      .createHash('sha1')
      .update(`${id}/${w}.${fmt}`)
      .digest('hex')
      .slice(0, 16);
    res.setHeader('ETag', `"${size.toString(16)}-${key}"`);
    serve(req, res, next, file, fmt, VARIANT_MIME[fmt], id, {
      etag: false,
      lastModified: false,
    });
  } catch (err) {
    logger.error({ err }, 'variant render failed');
    next(err);
  }
});

export const deliveryRoutes = router;
