import express, { NextFunction, Request, Response } from 'express';
import ProblemError from '../../errors/ProblemError';
import { apiKeyAuth } from '../middlewares/apiKeyAuth';
import problemErrorHandler from '../middlewares/problemErrorHandler';
import { accountsRoutes } from '../modules/accounts/accounts.route';
import { filesRoutes } from '../modules/files/files.route';
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

const routeNotFound = (req: Request, res: Response, next: NextFunction) =>
  next(new ProblemError('not_found', 'route not found'));

moduleRoutes.forEach(route =>
  router.use(
    route.path,
    apiKeyAuth,
    route.route,
    routeNotFound,
    problemErrorHandler
  )
);
export default router;
