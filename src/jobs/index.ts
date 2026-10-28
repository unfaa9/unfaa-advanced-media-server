import { startCdnPurgeWorker } from './cdnPurgeWorker';
import {
  idempotencyExpiry,
  orphanSweep,
  refreshStorageGauges,
  tmpSweep,
  trashPurge,
  variantLru,
} from './maintenance';
import { reconcile } from './reconcile';
import { startScheduler, TPeriodicJob } from './scheduler';

const MIN = 60_000;
const HOUR = 60 * MIN;

const periodicJobs: TPeriodicJob[] = [
  { name: 'orphan_sweep', intervalMs: 15 * MIN, run: orphanSweep },
  { name: 'trash_purge', intervalMs: HOUR, run: trashPurge },
  { name: 'tmp_sweep', intervalMs: HOUR, run: tmpSweep },
  { name: 'variant_lru', intervalMs: 24 * HOUR, run: variantLru },
  { name: 'idempotency_expiry', intervalMs: 24 * HOUR, run: idempotencyExpiry },
  { name: 'reconcile', intervalMs: 7 * 24 * HOUR, run: () => reconcile() },
  { name: 'storage_gauges', intervalMs: MIN, run: refreshStorageGauges },
];

// Starts all background work; the returned function stops it and waits for running jobs.
export const startJobs = () => {
  const stopScheduler = startScheduler(periodicJobs);
  const stopPurger = startCdnPurgeWorker();
  return async () => {
    await Promise.all([stopScheduler(), stopPurger()]);
  };
};
