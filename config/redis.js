import Redis from "ioredis";
import logToFile from "../logger.js";

// Redis is an optimization layer (response caching + BullMQ job queue), not
// a hard dependency of the core app. If it's unreachable we log and keep
// serving requests straight from MongoDB — nothing that currently works
// should start failing just because Redis isn't running yet in an
// environment.
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null, // required by BullMQ workers/queues sharing this client
  lazyConnect: false,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});

redis.on("connect", () => logToFile(`[Redis] ✅ Connected -> ${REDIS_URL}`));
redis.on("error", (err) => logToFile(`[Redis] ⚠️ ${err.message}`));

/**
 * Cache-aside helper: return the cached value if present, otherwise run
 * `fetcher`, cache its result for `ttlSeconds`, and return it. Falls back to
 * calling `fetcher` directly (no crash) if Redis is down.
 */
export async function cached(key, ttlSeconds, fetcher) {
  try {
    const hit = await redis.get(key);
    if (hit !== null) return JSON.parse(hit);
  } catch (err) {
    logToFile(`[Redis] cache read failed for ${key}: ${err.message}`);
  }

  const fresh = await fetcher();

  try {
    await redis.set(key, JSON.stringify(fresh), "EX", ttlSeconds);
  } catch (err) {
    logToFile(`[Redis] cache write failed for ${key}: ${err.message}`);
  }

  return fresh;
}

/** Invalidate every cache key under a prefix, e.g. "app-guide:" after a re-import. */
export async function invalidatePrefix(prefix) {
  try {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
  } catch (err) {
    logToFile(`[Redis] cache invalidation failed for ${prefix}: ${err.message}`);
  }
}

export default redis;
