import { Server } from 'http';
import app from './app';
import config from './config';
import { startJobs } from './jobs';
import { ensureDirs } from './lib/storage/localStorage';
import logger from './shared/logger';
import { startMetricsServer } from './shared/metrics';
import prisma from './shared/prisma';

const SHUTDOWN_GRACE_MS = 25_000;

async function bootstrap() {
  await ensureDirs();
  // A real query, because $connect() no longer fails on an unreachable database (driver adapter).
  await prisma.$queryRaw`SELECT 1`;

  const server: Server = app.listen(config.port, () => {
    logger.info(`Server running on port ${config.port}`);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000; // uploads from slow clients
  server.keepAliveTimeout = 120_000;

  const metricsServer = startMetricsServer(config.metricsPort);
  const stopJobs = startJobs();

  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down');
    const force = setTimeout(() => process.exit(code || 1), SHUTDOWN_GRACE_MS);
    force.unref();
    // Stop accepting, let in-flight requests drain, then stop workers and the pool.
    await new Promise<void>(resolve => server.close(() => resolve()));
    metricsServer.close();
    await stopJobs();
    await prisma.$disconnect();
    logger.info('Server closed');
    process.exit(code);
  };

  process.on('uncaughtException', error => {
    logger.fatal({ err: error }, 'uncaught exception');
    shutdown(1);
  });
  process.on('unhandledRejection', error => {
    logger.fatal({ err: error }, 'unhandled rejection');
    shutdown(1);
  });
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
}

bootstrap().catch(err => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
