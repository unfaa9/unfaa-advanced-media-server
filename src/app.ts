import cors from 'cors';
import express, { Application, NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import pinoHttp from 'pino-http';
import globalErrorHandler from './app/middlewares/globalErrorHandler';
import requestId from './app/middlewares/requestId';
import { deliveryRoutes } from './app/modules/delivery/delivery.route';
import { healthRoutes } from './app/modules/health/health.route';
import routes from './app/routes';
import logger from './shared/logger';
import { metrics } from './shared/metrics';

const app: Application = express();
app.disable('x-powered-by');

app.use(requestId);
app.use(
  pinoHttp({
    logger,
    genReqId: req => (req as Request).id,
    // Path only: query strings and headers can carry secrets.
    serializers: {
      req: req => ({ id: req.id, method: req.method, path: req.url.split('?')[0] }),
      res: res => ({ status: res.statusCode }),
    },
    customProps: req => ({ request_id: (req as Request).id }),
  })
);

app.use((req, res, next) => {
  const end = metrics.httpDuration.startTimer();
  res.on('finish', () => {
    // Route patterns, not raw paths, keep label cardinality bounded.
    const route = req.route
      ? `${req.baseUrl}${req.route.path}`
      : req.path.split('/')[1] || '/';
    end({ route, method: req.method });
    metrics.httpRequests.inc({ route, method: req.method, status: res.statusCode });
  });
  next();
});

// Public delivery and health checks: no auth, no body parsing.
app.use(healthRoutes);
app.use(deliveryRoutes);

app.use(cors());

//parser
app.use(express.json({ type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/v1', routes);

//global error handler
app.use(globalErrorHandler);

//handle not found
app.use((req: Request, res: Response, next: NextFunction) => {
  res.status(httpStatus.NOT_FOUND).json({
    success: false,
    message: 'Not Found',
    errorMessages: [
      {
        path: req.originalUrl,
        message: 'API Not Found',
      },
    ],
  });
  next();
});

export default app;
