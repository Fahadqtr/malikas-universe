/**
 * WhatsApp inbound processor queue.
 * Phase 7 will fill in the actual processing.
 */
import { Worker } from 'bullmq';
import { connection, QUEUE_PREFIX } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

export function startWhatsappWorker() {
  const worker = new Worker(
    'whatsapp-inbound',
    async (job) => {
      logger.info({ jobId: job.id, data: job.data }, 'WhatsApp job received');
      // TODO Phase 7: process inbound message
    },
    { connection, prefix: QUEUE_PREFIX, concurrency: 4 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'WhatsApp job failed');
  });

  return worker;
}
