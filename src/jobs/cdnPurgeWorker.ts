import { purgeUrls } from '../lib/cdn/cdn';
import logger from '../shared/logger';
import { metrics } from '../shared/metrics';
import prisma from '../shared/prisma';

const POLL_MS = 5_000;
const BATCH = 10;
const LEASE_SECONDS = 120;

type TClaimedJob = { id: bigint; payload: { urls: string[] }; attempts: number };

// Exponential backoff 30 s → 1 h with ±20 % jitter.
const backoffMs = (attempts: number) => {
  const base = Math.min(3600_000, 30_000 * 2 ** attempts);
  return Math.round(base * (0.8 + Math.random() * 0.4));
};

const claimBatch = () =>
  prisma.$queryRaw<TClaimedJob[]>`
    UPDATE jobs SET locked_until = now() + (${LEASE_SECONDS} * interval '1 second')
     WHERE id IN (
       SELECT id FROM jobs
        WHERE kind = 'cdn_purge' AND attempts < max_attempts AND run_at <= now()
          AND (locked_until IS NULL OR locked_until < now())
        ORDER BY id LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED)
    RETURNING id, payload, attempts`;

const processBatch = async (): Promise<number> => {
  const jobs = await claimBatch();
  for (const job of jobs) {
    try {
      await purgeUrls(job.payload.urls);
      await prisma.job.delete({ where: { id: job.id } });
      metrics.jobs.inc({ job: 'cdn_purge', result: 'ok' });
    } catch (err) {
      metrics.jobs.inc({ job: 'cdn_purge', result: 'error' });
      logger.warn({ err, job_id: String(job.id) }, 'cdn purge failed');
      await prisma.job.update({
        where: { id: job.id },
        data: {
          attempts: { increment: 1 },
          lastError: String(err).slice(0, 1000),
          runAt: new Date(Date.now() + backoffMs(job.attempts)),
          lockedUntil: null,
        },
      });
    }
  }
  return jobs.length;
};

const refreshGauges = async () => {
  const [pending, dead] = await Promise.all([
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM jobs WHERE kind = 'cdn_purge' AND attempts < max_attempts`,
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM jobs WHERE kind = 'cdn_purge' AND attempts >= max_attempts`,
  ]);
  metrics.jobsPending.set(Number(pending[0].n));
  metrics.jobsDead.set(Number(dead[0].n));
};

export const startCdnPurgeWorker = () => {
  let stopped = false;
  let current: Promise<void> = Promise.resolve();
  const loop = async () => {
    while (!stopped) {
      try {
        const n = await processBatch();
        await refreshGauges();
        if (n === BATCH) continue; // more work waiting
      } catch (err) {
        logger.error({ err }, 'cdn purge worker error');
      }
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  };
  current = loop();
  return async () => {
    stopped = true;
    await current;
  };
};
