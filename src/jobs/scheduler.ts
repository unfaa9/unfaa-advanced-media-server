import prisma from '../shared/prisma';
import logger from '../shared/logger';
import { metrics } from '../shared/metrics';

export type TPeriodicJob = {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
};

const TICK_MS = 30_000;
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;

// Claims one period of a job with an atomic UPDATE, so each tick runs once even if several
// processes share the database.
const claim = async (job: TPeriodicJob): Promise<boolean> => {
  await prisma.$executeRaw`
    INSERT INTO job_runs (name, next_run_at) VALUES (${job.name}, now())
    ON CONFLICT (name) DO NOTHING`;
  const claimed = await prisma.$executeRaw`
    UPDATE job_runs
       SET last_run_at = now(),
           next_run_at = now() + (${job.intervalMs} * interval '1 millisecond')
     WHERE name = ${job.name} AND next_run_at <= now()`;
  return claimed === 1;
};

const runOnce = async (job: TPeriodicJob) => {
  try {
    if (!(await claim(job))) return;
    const result = await job.run();
    metrics.jobs.inc({ job: job.name, result: 'ok' });
    logger.info({ job: job.name, result }, 'job finished');
  } catch (err) {
    metrics.jobs.inc({ job: job.name, result: 'error' });
    logger.error({ err, job: job.name }, 'job failed');
    await prisma.$executeRaw`
      UPDATE job_runs
         SET last_error = ${String(err)},
             next_run_at = now() + (${RETRY_AFTER_FAILURE_MS} * interval '1 millisecond')
       WHERE name = ${job.name}`.catch(() => undefined);
  }
};

// Each job has its own loop so a slow job (reconcile) never delays the others.
export const startScheduler = (jobs: TPeriodicJob[]) => {
  const running = new Map<string, Promise<void>>();
  const timers = jobs.map(job =>
    setInterval(() => {
      if (running.has(job.name)) return;
      const p = runOnce(job).finally(() => running.delete(job.name));
      running.set(job.name, p);
    }, TICK_MS)
  );
  return async () => {
    timers.forEach(clearInterval);
    await Promise.all(running.values());
  };
};
