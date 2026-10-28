import { Request, RequestHandler, Response } from 'express';
import httpStatus from 'http-status';
import config from '../../../config';
import ProblemError from '../../../errors/ProblemError';
import {
  MAX_KEY_LENGTH,
  findResponse,
  fingerprint,
  saveResponse,
  withKeyLock,
} from '../../../lib/upload/idempotency';
import { receiveFile } from '../../../lib/upload/receiveFile';
import catchAsync from '../../../shared/catchAsync';
import * as filesService from './files.service';
import { filesValidation } from './files.validation';

const upload: RequestHandler = catchAsync(
  async (req: Request, res: Response) => {
    const query = filesValidation.uploadQuery.parse(req.query);
    if (config.upload.requireAccount && !query.account) {
      throw new ProblemError('invalid_request', 'account is required');
    }
    const options = {
      confirm: query.confirm ?? false,
      purpose: query.purpose,
      ownerRef: query.owner_ref,
      account: query.account,
    };
    const key = req.get('idempotency-key');
    if (key !== undefined && (key.length === 0 || key.length > MAX_KEY_LENGTH)) {
      throw new ProblemError(
        'invalid_request',
        `Idempotency-Key must be 1–${MAX_KEY_LENGTH} characters`
      );
    }

    await filesService.assertDiskSpace();

    if (!key) {
      const received = await receiveFile(req, config.upload.maxFileBytes);
      const result = await filesService.storeUpload(received, options);
      res.status(result.status).json(result.body);
      return;
    }

    await withKeyLock(key, async () => {
      const received = await receiveFile(req, config.upload.maxFileBytes);
      const fp = fingerprint(req.query, received.sha256);
      const previous = await findResponse(key);
      if (previous) {
        await filesService.discard(received);
        if (previous.fingerprint !== fp) {
          throw new ProblemError(
            'idempotency_key_reused',
            'Idempotency-Key was already used for a different upload'
          );
        }
        res.setHeader('Idempotent-Replay', 'true');
        res.status(previous.status).json(previous.response);
        return;
      }
      const result = await filesService.storeUpload(received, options);
      await saveResponse(key, {
        fingerprint: fp,
        status: result.status,
        response: result.body,
      });
      res.status(result.status).json(result.body);
    });
  }
);

const getOne: RequestHandler = catchAsync(async (req, res) => {
  const { id } = filesValidation.idParams.parse(req.params);
  res.json(await filesService.getFile(id));
});

const list: RequestHandler = catchAsync(async (req, res) => {
  const q = filesValidation.listQuery.parse(req.query);
  res.json(
    await filesService.listFiles({
      cursor: q.cursor,
      limit: q.limit,
      purpose: q.purpose,
      status: q.status,
      account: q.account,
      ownerRef: q.owner_ref,
    })
  );
});

const confirm: RequestHandler = catchAsync(async (req, res) => {
  const { params, body } = filesValidation.confirm.parse(req);
  const [file] = await filesService.confirmFiles([params.id], body.owner_ref);
  res.json(file);
});

const confirmBatch: RequestHandler = catchAsync(async (req, res) => {
  const { body } = filesValidation.confirmBatch.parse(req);
  res.json({ data: await filesService.confirmFiles(body.ids, body.owner_ref) });
});

const addRef: RequestHandler = catchAsync(async (req, res) => {
  const { params, body } = filesValidation.addRef.parse(req);
  res.json(await filesService.addRef(params.id, body.owner_ref));
});

const removeRef: RequestHandler = catchAsync(async (req, res) => {
  const { params, body, query } = filesValidation.removeRef.parse(req);
  const ownerRef = (body.owner_ref ?? query.owner_ref) as string;
  res.json(await filesService.removeRef(params.id, ownerRef));
});

const deleteByOwner: RequestHandler = catchAsync(async (req, res) => {
  const { body } = filesValidation.deleteByOwner.parse(req);
  res.json(await filesService.deleteByOwner(body.owner_ref_prefix));
});

const remove: RequestHandler = catchAsync(async (req, res) => {
  const { params, query } = filesValidation.deleteFile.parse(req);
  await filesService.deleteFile(params.id, query.force ?? false);
  res.status(httpStatus.NO_CONTENT).end();
});

const restore: RequestHandler = catchAsync(async (req, res) => {
  const { id } = filesValidation.idParams.parse(req.params);
  res.json(await filesService.restoreFile(id));
});

export const filesController = {
  upload,
  getOne,
  list,
  confirm,
  confirmBatch,
  addRef,
  removeRef,
  deleteByOwner,
  remove,
  restore,
};
