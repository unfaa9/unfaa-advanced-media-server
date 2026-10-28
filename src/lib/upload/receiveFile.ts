import busboy from 'busboy';
import crypto from 'crypto';
import { Request } from 'express';
import fs from 'fs';
import { v7 as uuidv7 } from 'uuid';
import ProblemError from '../../errors/ProblemError';
import { tmpPath } from '../storage/layout';
import { remove } from '../storage/localStorage';

export type TReceivedFile = {
  path: string;
  size: number;
  sha256: Buffer;
  originalName: string | null;
};

const MAX_NAME_LENGTH = 255;

// Strips path components and control characters; only used for display / download names.
export const sanitizeFilename = (name: string | undefined): string | null => {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '');
  return clean.trim().slice(0, MAX_NAME_LENGTH) || null;
};

// Streams exactly one multipart part named "file" into tmp/, hashing and counting as it goes.
// The size limit is enforced while streaming; nothing is buffered in memory.
export const receiveFile = (
  req: Request,
  maxBytes: number
): Promise<TReceivedFile> =>
  new Promise((resolve, reject) => {
    if (!req.is('multipart/form-data')) {
      return reject(
        new ProblemError('invalid_request', 'body must be multipart/form-data')
      );
    }

    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: req.headers,
        // No `parts` limit: busboy emits partsLimit when the count *reaches* it, which would
        // reject a valid single-part upload. files:1 + fields:0 already allow only one part.
        limits: { files: 1, fileSize: maxBytes, fields: 0 },
      });
    } catch {
      return reject(new ProblemError('invalid_request', 'malformed multipart'));
    }

    const dest = tmpPath(`${uuidv7()}.upload`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    let sawFile = false;
    let writeDone: Promise<void> | null = null;
    let failure: ProblemError | null = null;
    let originalName: string | null = null;

    const fail = (e: ProblemError) => {
      if (!failure) failure = e;
    };

    bb.on('file', (name, stream, info) => {
      if (name !== 'file' || sawFile) {
        fail(
          new ProblemError(
            'invalid_request',
            'exactly one part named "file" is required'
          )
        );
        stream.resume();
        return;
      }
      sawFile = true;
      originalName = sanitizeFilename(info.filename);
      const out = fs.createWriteStream(dest, { flags: 'wx' });
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        hash.update(chunk);
      });
      stream.on('limit', () =>
        fail(
          new ProblemError(
            'file_too_large',
            `file exceeds the ${maxBytes}-byte limit`
          )
        )
      );
      writeDone = new Promise((res, rej) => {
        out.on('finish', () => res());
        out.on('error', rej);
        stream.on('error', rej);
      });
      stream.pipe(out);
    });
    bb.on('field', () =>
      fail(new ProblemError('invalid_request', 'unexpected form field'))
    );
    for (const limit of ['filesLimit', 'fieldsLimit']) {
      bb.on(limit, () =>
        fail(
          new ProblemError(
            'invalid_request',
            'exactly one part named "file" is required'
          )
        )
      );
    }

    const cleanupAndReject = async (e: unknown) => {
      await remove(dest);
      reject(
        e instanceof ProblemError
          ? e
          : new ProblemError('invalid_request', 'upload interrupted')
      );
    };

    bb.on('error', cleanupAndReject);
    bb.on('close', async () => {
      try {
        if (writeDone) await writeDone;
        if (failure) return cleanupAndReject(failure);
        if (!sawFile) {
          return cleanupAndReject(
            new ProblemError('invalid_request', 'missing part named "file"')
          );
        }
        if (size === 0) {
          return cleanupAndReject(
            new ProblemError('invalid_request', 'file is empty')
          );
        }
        resolve({ path: dest, size, sha256: hash.digest(), originalName });
      } catch (e) {
        cleanupAndReject(e);
      }
    });
    req.on('aborted', () => cleanupAndReject(null));
    req.pipe(bb);
  });
