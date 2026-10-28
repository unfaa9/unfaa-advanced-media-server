import { RequestHandler } from 'express';
import catchAsync from '../../../shared/catchAsync';
import * as accountsService from './accounts.service';
import { accountsValidation } from './accounts.validation';

const upsert: RequestHandler = catchAsync(async (req, res) => {
  const { params, body } = accountsValidation.upsert.parse(req);
  res.json(await accountsService.upsertAccount(params.ref, body.quota_bytes));
});

const getOne: RequestHandler = catchAsync(async (req, res) => {
  const { ref } = accountsValidation.params.parse(req.params);
  res.json(await accountsService.getAccount(ref));
});

const remove: RequestHandler = catchAsync(async (req, res) => {
  const { ref } = accountsValidation.params.parse(req.params);
  res.json(await accountsService.deleteAccount(ref));
});

export const accountsController = { upsert, getOne, remove };
