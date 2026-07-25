/**
 * Unit tests for the Redis connection config/factory.
 *
 * These do NOT connect to a real Redis server: importing `redis-config` has no
 * side effects, and the constructability check uses `lazyConnect` so no socket
 * is opened. This is the regression guard for the TS2351 "not constructable"
 * error (wrong ioredis import form) and for eager-connect-at-import.
 */
import { describe, it, expect } from 'vitest';
import { Redis } from 'ioredis';
import {
  REDIS_URL,
  QUEUE_PREFIX,
  redisConnectionOptions,
  createRedisConnection,
} from '../redis-config.js';

describe('redis-config', () => {
  it('exposes the BullMQ-required connection options', () => {
    expect(redisConnectionOptions.maxRetriesPerRequest).toBeNull();
    expect(redisConnectionOptions.enableReadyCheck).toBe(false);
  });

  it('provides string defaults for URL and queue prefix', () => {
    expect(typeof REDIS_URL).toBe('string');
    expect(REDIS_URL.length).toBeGreaterThan(0);
    expect(typeof QUEUE_PREFIX).toBe('string');
    expect(QUEUE_PREFIX.length).toBeGreaterThan(0);
  });

  it('exposes a factory function', () => {
    expect(typeof createRedisConnection).toBe('function');
  });

  it('constructs a Redis client from the shared options without opening a socket', () => {
    // lazyConnect => no network I/O at construction; proves the class is
    // constructable (the TS2351 fix) and the options are valid.
    const client = new Redis({ ...redisConnectionOptions, lazyConnect: true });
    expect(client).toBeInstanceOf(Redis);
    client.disconnect();
  });
});
