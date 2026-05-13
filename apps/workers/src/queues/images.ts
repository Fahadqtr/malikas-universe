/**
 * Image pipeline queue.
 * Consumes jobs that resize, hash, upload, and link images.
 */
import { Worker } from 'bullmq';
import { connection, QUEUE_PREFIX } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { processImageJob, type ImagePipelineJob } from '../jobs/image-pipeline.js';

export function startImageWorker() {
  const worker = new Worker<ImagePipelineJob>(
    'image-pipeline',
    async (job) => {
      logger.info({ jobId: job.id, sku: job.data.master_sku }, 'Processing image job');
      await processImageJob(job.data);
    },
    {
      connection,
      prefix: QUEUE_PREFIX,
      concurrency: 4,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 500 },
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Image job failed');
  });
  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, sku: job.data.master_sku }, 'Image job completed');
  });

  return worker;
}
