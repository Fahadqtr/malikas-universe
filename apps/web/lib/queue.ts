/**
 * BullMQ producer-side client for the web app.
 * Workers (in apps/workers) consume from these queues.
 *
 * If REDIS_URL is not set, queue calls log a warning instead of crashing.
 * This allows local development without Redis to proceed.
 */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const PREFIX = process.env.REDIS_QUEUE_PREFIX ?? 'malikas';
const REDIS_URL = process.env.REDIS_URL;

let _imageQueue: Queue | null = null;
let _redisConnection: IORedis | null = null;

function getConnection(): IORedis | null {
  if (!REDIS_URL) return null;
  if (_redisConnection) return _redisConnection;
  _redisConnection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  return _redisConnection;
}

export function getImageQueue(): Queue | null {
  if (_imageQueue) return _imageQueue;
  const connection = getConnection();
  if (!connection) {
    console.warn('[queue] REDIS_URL not set — image worker disabled');
    return null;
  }
  _imageQueue = new Queue(`${PREFIX}:image-pipeline`, { connection });
  return _imageQueue;
}

export type ImagePipelineJob = {
  master_sku: string;
  staging_key: string;
  filename: string;
  is_primary: boolean;
  uploaded_by: string;
};

export async function enqueueImagePipeline(job: ImagePipelineJob): Promise<boolean> {
  const queue = getImageQueue();
  if (!queue) return false;
  await queue.add('process', job, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 500,
  });
  return true;
}
