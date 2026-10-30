// Redis (official `redis` package, node-redis v5+) + the BullMQ queue for
// background Vehicle Note saves. BullMQ 6+ runs directly on node-redis clients,
// so ioredis is not needed anywhere.
//
// Why a separate file from config/redis.js (the cache helper): the queue needs
// clients with their own behaviour (fail-fast for the API, patient for the
// worker) that would change how the existing cache client behaves.
//
// Env:
//   REDIS_URL   redis://[user:password@]host:port[/db]   (rediss:// for TLS; default redis://127.0.0.1:6379)
import { createClient } from "redis";
import { Queue } from "bullmq";
import logToFile from "../logger.js";

// Read lazily: server.js calls dotenv.config() *after* its imports are
// evaluated, so a top-level `const` would miss values that only live in .env.
export const redisUrl = () => process.env.REDIS_URL || "redis://127.0.0.1:6379";

export const VEHICLE_NOTE_QUEUE = "vehicle-note-saves";
// Redis pub/sub channel the worker publishes progress on and the WebSocket
// server (in the API process) listens to. Going through Redis means it works
// whether the worker runs inside the API process, in its own process, or the
// API runs as several instances.
export const SAVE_EVENTS_CHANNEL = "vehicle-notes:save-events";

const tag = (name) => `[Redis:${name}]`;

/**
 * New dedicated, already-connecting client. `kind`:
 *  - "main"       the API's shared client (queue producer, WebSocket tickets,
 *                 publishing events). FAILS FAST while Redis is down — commands
 *                 reject immediately instead of waiting — so the API can fall
 *                 back to saving inline and the person is never left hanging.
 *  - "worker"     used by the BullMQ Worker. Patient: commands wait for Redis to
 *                 come back (BullMQ duplicates it for its blocking connection).
 *  - "subscriber" dedicated to SUBSCRIBE (a subscribed client can't run other
 *                 commands). Re-subscribes by itself after a reconnect.
 */
export function createRedis(kind) {
    const client = createClient({
        url: redisUrl(),
        disableOfflineQueue: kind === "main",
        // Never give up; retry quickly at first, then every 3 s at most.
        socket: { reconnectStrategy: (retries) => Math.min(retries * 100, 3000) },
    });

    // Without an 'error' listener node-redis would crash the process on a dropped
    // connection. It reconnects on its own; we only log (once per outage).
    let down = false;
    client.on("error", (err) => {
        if (!down) logToFile(`${tag(kind)} ❌ ${err.message}`);
        down = true;
    });
    client.on("ready", () => {
        if (down) logToFile(`${tag(kind)} ✅ reconnected`);
        down = false;
    });

    client.connect().catch((err) => logToFile(`${tag(kind)} could not connect: ${err.message}`));
    return client;
}

/** Resolves once `client` is ready, or after `ms` (whichever comes first). */
export function whenReady(client, ms = 3000) {
    if (client.isReady) return Promise.resolve(true);
    return new Promise((resolve) => {
        const done = (ok) => { clearTimeout(timer); client.off("ready", onReady); resolve(ok); };
        const onReady = () => done(true);
        const timer = setTimeout(() => done(false), ms);
        client.once("ready", onReady);
    });
}

/** Rejects if `promise` hasn't settled after `ms` — nothing in the save path may hang on Redis. */
export function withTimeout(promise, ms, what = "Redis call") {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Graceful close that works across node-redis versions (`close()` in v5, `quit()` before). */
export async function closeRedis(client) {
    if (!client?.isOpen) return;
    try {
        await (typeof client.close === "function" ? client.close() : client.quit());
    } catch {
        client.destroy?.();
    }
}

let queue;
let sharedConn;

/** Shared fail-fast client (publish events, issue / redeem WebSocket tickets, BullMQ producer). */
export function getRedis() {
    if (!sharedConn) sharedConn = createRedis("main");
    return sharedConn;
}

export function getQueue() {
    if (!queue) {
        queue = new Queue(VEHICLE_NOTE_QUEUE, {
            connection: getRedis(),
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: "exponential", delay: 1500 },
                // The worker strips the photos from a job as soon as it succeeds, so
                // keeping the (tiny) record for 15 minutes is cheap — and it lets a
                // browser that was asleep still ask "did my save go through?".
                removeOnComplete: { age: 900, count: 500 },
                removeOnFail: { age: 3600, count: 200 },
            },
        });
        queue.on("error", () => { /* already logged by the connection */ });
    }
    return queue;
}

export function isRedisReady() {
    return Boolean(sharedConn?.isReady);
}

export async function publishSaveEvent(event) {
    try {
        const client = getRedis();
        // A freshly started process (e.g. the standalone worker) may publish its
        // first event a moment before the connection is up.
        await whenReady(client, 3000);
        await withTimeout(client.publish(SAVE_EVENTS_CHANNEL, JSON.stringify(event)), 3000, "publish");
    } catch (err) {
        // Never fail a save because a progress ping couldn't be sent — the client
        // also polls the job status as a safety net.
        logToFile(`[Queue] could not publish save event: ${err.message}`);
    }
}

export async function closeQueue() {
    await Promise.allSettled([queue?.close()]);
    await closeRedis(sharedConn);
}
