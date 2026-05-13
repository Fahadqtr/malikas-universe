/**
 * Workers bootstrap.
 * Starts all BullMQ queue processors on this VPS.
 */
import { logger } from './lib/logger.js';
import { startWhatsappWorker } from './queues/whatsapp.js';
import { startImageWorker } from './queues/images.js';
import { startSyncWorker } from './queues/sync.js';
import { startEmbeddingWorker } from './queues/embeddings.js';

async function main() {
  logger.info('Starting Malika workers...');

  await Promise.all([
    startWhatsappWorker(),
    startImageWorker(),
    startSyncWorker(),
    startEmbeddingWorker(),
  ]);

  logger.info('All workers running.');
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker bootstrap failed');
  process.exit(1);
});

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => {
    logger.info(`Received ${signal}, shutting down...`);
    process.exit(0);
  });
});
