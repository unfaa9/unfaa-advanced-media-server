import express from 'express';
import fsp from 'fs/promises';
import { dirs } from '../../../lib/storage/layout';
import prisma from '../../../shared/prisma';

const router = express.Router();

// Liveness: the process is up.
router.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});

// Readiness: the database answers and the storage volume is writable.
router.get('/readyz', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const checks: Record<string, string> = {};
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
  } catch {
    checks.database = 'unavailable';
  }
  try {
    const probe = `${dirs.tmp}/.readyz-${process.pid}`;
    await fsp.writeFile(probe, '');
    await fsp.rm(probe, { force: true });
    checks.storage = 'ok';
  } catch {
    checks.storage = 'unavailable';
  }
  const ok = Object.values(checks).every(v => v === 'ok');
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable', checks });
});

export const healthRoutes = router;
