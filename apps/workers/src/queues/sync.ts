/**
 * Platform sync queue (Shopify push, Snoonu CSV export, etc.).
 * Phase 8 will implement.
 */
import { Worker } from 'bullmq';
import { connection, QUEUE_PREFIX } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

export function startSyncWorker() {
  const worker = new Worker(
    'sync',
    async (job) => {
      logger.info({ jobId: job.id, platform: job.data?.platform }, 'Sync job received');
      // TODO Phase 8: sync to platform
    },
    { connection, prefix: QUEUE_PREFIX, concurrency: 2 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Sync job failed');
  });

  return worker;
}
