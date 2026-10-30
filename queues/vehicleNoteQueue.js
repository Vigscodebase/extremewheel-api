// Producer side: what the HTTP routes use to hand a save to the worker.
import { getQueue, isRedisReady, publishSaveEvent } from "../config/queue.js";

const JOB_NAME = "save";

/**
 * Queue a save. Resolves with the BullMQ job id, or rejects if Redis can't be
 * reached right now (the caller then saves inline so the user is never blocked
 * by an infrastructure problem).
 */
export async function enqueueVehicleNoteSave(payload) {
    const queue = getQueue();
    if (!isRedisReady()) throw new Error("Redis not ready");
    // For a create, the vehicle id doubles as the job id: submitting the very
    // same create twice (double click, flaky-network retry) can't queue it twice.
    const jobId = payload.kind === "create" ? `create-${payload.vehicleId}` : undefined;
    const job = await queue.add(JOB_NAME, payload, jobId ? { jobId } : undefined);
    await publishSaveEvent({
        userId: payload.user._id,
        jobId: job.id,
        clientRef: payload.clientRef,
        status: "queued",
    });
    return String(job.id);
}

/**
 * Current state of a job, in the same vocabulary as the WebSocket events.
 * Only the person who queued it (or an admin) may look.
 */
export async function getVehicleNoteSaveStatus(jobId, user) {
    const job = await getQueue().getJob(jobId);
    if (!job) return null;
    if (String(job.data?.user?._id) !== String(user._id) && user.role !== "admin") return null;

    const state = await job.getState();
    if (state === "completed") return { jobId, status: "done", vehicle: job.returnvalue?.vehicle };
    if (state === "failed") return { jobId, status: "failed", message: job.failedReason || "Something went wrong on our end." };
    if (state === "active") return { jobId, status: "processing" };
    return { jobId, status: "queued" };
}
