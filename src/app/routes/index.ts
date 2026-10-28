import express, { NextFunction, Request, Response } from 'express';
import ProblemError from '../../errors/ProblemError';
import { apiKeyAuth } from '../middlewares/apiKeyAuth';
import problemErrorHandler from '../middlewares/problemErrorHandler';
import { accountsRoutes } from '../modules/accounts/accounts.route';
import { fileUploadRoutes } from '../modules/fileUpload/fileUpload.route';
import { filesRoutes } from '../modules/files/files.route';
import { videoUploadRoutes } from '../modules/videoUpload/videoUpload.route';
const router = express.Router();

// API-key protected routes with application/problem+json errors (docs/api).
const moduleRoutes = [
  {
    path: '/files',
    route: filesRoutes,
  },
  {
    path: '/accounts',
    route: accountsRoutes,
  },
];

// Pre-API-key routes, kept for existing clients. Use /files instead.
const legacyRoutes = [
  {
    path: '/uploadImg',
    route: fileUploadRoutes,
  },
  {
    path: '/uploadVideo',
    route: videoUploadRoutes,
  },
];

const routeNotFound = (req: Request, res: Response, next: NextFunction) =>
  next(new ProblemError('not_found', 'route not found'));

const deprecated = (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', '</api/v1/files>; rel="successor-version"');
  next();
};

moduleRoutes.forEach(route =>
  router.use(
    route.path,
    apiKeyAuth,
    route.route,
    routeNotFound,
    problemErrorHandler
  )
);
legacyRoutes.forEach(route => router.use(route.path, deprecated, route.route));
export default router;
