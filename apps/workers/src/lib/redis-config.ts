/**
 * Redis connection config + factory (side-effect free).
 *
 * Importing this module does NOT open a socket — it only exposes the config and
 * a factory. The live singleton connection lives in `./redis.ts`, which calls
 * `createRedisConnection()`. Keeping the two apart lets tests validate the
 * options and constructability without connecting to a real Redis server.
 *
 * NOTE on the import: ioredis exposes the client class as the NAMED export
 * `Redis` (`export { default as Redis }`). Under `moduleResolution: NodeNext`
 * the default import resolves to the module namespace (not the class), which is
 * why `new IORedis(...)` failed with TS2351. The named import is the correct,
 * ESM-compatible form.
 */
import { Redis, type RedisOptions } from 'ioredis';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
export const QUEUE_PREFIX = process.env.REDIS_QUEUE_PREFIX ?? 'malikas';

/**
 * Connection options required by BullMQ for a shared connection
 * (see https://docs.bullmq.io/guide/connections).
 */
export const redisConnectionOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

/**
 * Build a Redis connection. Only opens a socket when called (and only when the
 * first command runs, if `lazyConnect` is passed by the caller).
 */
export function createRedisConnection(url: string = REDIS_URL): Redis {
  return new Redis(url, redisConnectionOptions);
}
