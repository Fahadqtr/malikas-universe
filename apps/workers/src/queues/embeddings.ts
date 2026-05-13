/**
 * Embedding generator queue.
 * Generate vector embeddings for products via Voyage AI.
 * Phase 6 will implement.
 */
import { Worker } from 'bullmq';
import { connection, QUEUE_PREFIX } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

export function startEmbeddingWorker() {
  const worker = new Worker(
    'embeddings',
    async (job) => {
      logger.info({ jobId: job.id, sku: job.data?.master_sku }, 'Embedding job received');
      // TODO Phase 6: generate + save embedding
    },
    { connection, prefix: QUEUE_PREFIX, concurrency: 4 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Embedding job failed');
  });

  return worker;
}
