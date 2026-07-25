/**
 * Shared Redis connection singleton for all BullMQ queues/workers.
 *
 * The config + factory live in `./redis-config.ts` (side-effect free). This
 * module creates the one live connection the app shares. Public surface
 * (`connection`, `QUEUE_PREFIX`) is unchanged for the queue modules.
 */
import { createRedisConnection } from './redis-config.js';

export { QUEUE_PREFIX, REDIS_URL } from './redis-config.js';

export const connection = createRedisConnection();
