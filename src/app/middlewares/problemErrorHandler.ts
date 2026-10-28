/* eslint-disable @typescript-eslint/no-unused-vars */
import { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import config from '../../config';
import ProblemError from '../../errors/ProblemError';
import logger from '../../shared/logger';

// RFC 9457 application/problem+json for the /api/v1/files and /accounts APIs.
const problemErrorHandler: ErrorRequestHandler = (
  error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  let problem: ProblemError;
  if (error instanceof ProblemError) {
    problem = error;
  } else if (error instanceof ZodError) {
    const detail = error.issues
      .map(i => `${i.path.slice(1).join('.') || i.path.join('.')}: ${i.message}`)
      .join('; ');
    problem = new ProblemError('invalid_request', detail);
  } else if (error?.type === 'entity.parse.failed') {
    problem = new ProblemError('invalid_request', 'malformed JSON body');
  } else {
    logger.error({ err: error, request_id: req.id }, 'unhandled error');
    problem = new ProblemError('internal', 'internal server error');
  }

  if (res.headersSent) return;
  for (const [k, v] of Object.entries(problem.headers)) res.setHeader(k, v);
  if (problem.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
  res
    .status(problem.status)
    .type('application/problem+json')
    .json({
      type: `${config.publicBaseUrl}/docs/errors#${problem.code}`,
      title: problem.title,
      status: problem.status,
      code: problem.code,
      detail: problem.message,
      request_id: req.id,
    });
};

export default problemErrorHandler;
