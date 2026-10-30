// BullMQ worker: performs the slow part of saving a vehicle note (the big
// MongoDB write) off the request path and reports progress over Redis pub/sub,
// which the WebSocket server relays to the browser.
//
// Two ways to run it:
//   1. Inside the API process (default) — server.js calls startVehicleNoteWorker().
//   2. As its own process (recommended once traffic grows):
//        RUN_QUEUE_WORKER=false on the API, and `node workers/vehicleNoteWorker.js`
//        (npm run worker) next to it. Scale it independently with WORKER_CONCURRENCY.
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Worker, UnrecoverableError } from "bullmq";
import logToFile from "../logger.js";
import { createRedis, closeRedis, VEHICLE_NOTE_QUEUE, publishSaveEvent, closeQueue } from "../config/queue.js";
import { saveVehicleNote, summarizeVehicle, describeSaveError } from "../services/vehicleNoteSaveService.js";

export function startVehicleNoteWorker() {
    // BullMQ leaves a client you hand it open, so this worker closes its own.
    const connection = createRedis("worker");
    const worker = new Worker(
        VEHICLE_NOTE_QUEUE,
        async (job) => {
            const { user, clientRef } = job.data;
            // Photos were already stripped after a successful run (stalled-job re-delivery).
            if (job.data.done) return job.returnvalue || {};
            const emit = (status, extra = {}) =>
                publishSaveEvent({ userId: user._id, jobId: String(job.id), clientRef, status, ...extra });

            await emit("processing");
            try {
                await job.updateProgress(30);
                const doc = await saveVehicleNote(job.data);
                await job.updateProgress(100);

                const vehicle = summarizeVehicle(doc);
                // Free the (potentially many-MB) photo payload from Redis right away.
                await job.updateData({ kind: job.data.kind, user, clientRef, done: true }).catch(() => { });
                await emit("done", { vehicle });
                return { vehicle };
            } catch (err) {
                const { message, retriable } = describeSaveError(err);
                logToFile(`[Worker] save ${job.id} attempt ${job.attemptsMade + 1} failed: ${err.stack || err}`);
                // Friendly message becomes job.failedReason, which the status
                // endpoint hands to the browser.
                throw retriable ? new Error(message) : new UnrecoverableError(message);
            }
        },
        {
            connection,
            concurrency: Number(process.env.WORKER_CONCURRENCY) || 4,
        }
    );

    worker.on("failed", async (job, err) => {
        if (!job) return;
        const finalAttempt = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts || 1);
        if (!finalAttempt) {
            // Will be retried — keep the person informed instead of silent.
            await publishSaveEvent({
                userId: job.data.user?._id, jobId: String(job.id), clientRef: job.data.clientRef,
                status: "processing", retrying: true,
            });
            return;
        }
        await publishSaveEvent({
            userId: job.data.user?._id, jobId: String(job.id), clientRef: job.data.clientRef,
            status: "failed", message: err.message,
        });
        // The browser still has the form data and offers "try again", so the
        // photos don't need to linger in Redis.
        await job.updateData({ kind: job.data.kind, user: job.data.user, clientRef: job.data.clientRef, done: true }).catch(() => { });
    });

    worker.on("error", (err) => logToFile(`[Worker] ${err.message}`));
    worker.on("closed", () => { closeRedis(connection); });
    logToFile(`[Worker] vehicle-note save worker started (concurrency ${worker.opts.concurrency})`);
    return worker;
}

// `node workers/vehicleNoteWorker.js` — standalone mode.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    dotenv.config();
    const { default: connectDB } = await import("../config/db.js");
    await connectDB();
    const worker = startVehicleNoteWorker();

    const shutdown = async () => {
        await worker.close();
        await closeQueue();
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}
