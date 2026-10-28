import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';

const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;

// Propagates the caller's X-Request-Id or generates one; always echoed back.
const requestId = (req: Request, res: Response, next: NextFunction) => {
  const incoming = req.get('x-request-id');
  req.id =
    incoming && VALID_ID.test(incoming)
      ? incoming
      : crypto.randomBytes(12).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  next();
};

export default requestId;
