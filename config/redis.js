import { createClient } from "redis";
import logToFile from "../logger.js";

// Redis is an optimization layer (response caching), not a hard dependency of
// the core app. If it's unreachable we log and keep serving requests straight
// from MongoDB — nothing that currently works should start failing just because
// Redis isn't running yet in an environment.
//
// Uses the official `redis` package (node-redis v5+). The BullMQ queue / worker /
// WebSocket code has its own clients in config/queue.js.

// Created on first use, not at import time: server.js calls dotenv.config()
// *after* its imports are evaluated, so reading REDIS_URL up here would miss a
// value that only lives in .env.
let client;

// Never log the password that may be inside the URL.
const safeUrl = (url) => url.replace(/\/\/[^@/]*@/, "//***@");

function getClient() {
  if (client) return client;
  const url = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  client = createClient({
    url,
    // While Redis is down, commands fail at once (instead of waiting for it) —
    // `cached()` then simply goes to MongoDB, so no request ever hangs on the cache.
    disableOfflineQueue: true,
    socket: { reconnectStrategy: (retries) => Math.min(retries * 500, 5000) },
  });
  client.on("ready", () => logToFile(`[Redis] ✅ Connected -> ${safeUrl(url)}`));
  client.on("error", (err) => logToFile(`[Redis] ⚠️ ${err.message}`));
  client.connect().catch((err) => logToFile(`[Redis] could not connect: ${err.message}`));
  return client;
}

/** Start connecting now (call once at startup) so the very first request can already hit the cache. */
export function connectCache() {
  getClient();
}

// `redis` stays importable the way it was (`import { redis }` / default), but is
// now the node-redis client — e.g. `redis.set(key, value, { EX: seconds })`.
export const redis = new Proxy({}, {
  get(_target, prop) {
    const c = getClient();
    const value = c[prop];
    return typeof value === "function" ? value.bind(c) : value;
  },
});

/**
 * Cache-aside helper: return the cached value if present, otherwise run
 * `fetcher`, cache its result for `ttlSeconds`, and return it. Falls back to
 * calling `fetcher` directly (no crash) if Redis is down.
 */
export async function cached(key, ttlSeconds, fetcher) {
  try {
    const hit = await getClient().get(key);
    if (hit !== null) return JSON.parse(hit);
  } catch (err) {
    logToFile(`[Redis] cache read failed for ${key}: ${err.message}`);
  }

  const fresh = await fetcher();

  try {
    await getClient().set(key, JSON.stringify(fresh), { EX: ttlSeconds });
  } catch (err) {
    logToFile(`[Redis] cache write failed for ${key}: ${err.message}`);
  }

  return fresh;
}

const escapeGlob = (s) => s.replace(/[\\*?[\]]/g, "\\$&");

/** Invalidate every cache key under a prefix, e.g. "app-guide:" after a re-import. */
export async function invalidatePrefix(prefix) {
  try {
    const c = getClient();
    // SCAN instead of KEYS: KEYS blocks Redis while it walks every key.
    const keys = [];
    let cursor = "0";
    do {
      const page = await c.scan(cursor, { MATCH: `${escapeGlob(prefix)}*`, COUNT: 500 });
      cursor = String(page.cursor);
      keys.push(...page.keys);
    } while (cursor !== "0");
    for (let i = 0; i < keys.length; i += 500) await c.del(keys.slice(i, i + 500));
  } catch (err) {
    logToFile(`[Redis] cache invalidation failed for ${prefix}: ${err.message}`);
  }
}

export default redis;
