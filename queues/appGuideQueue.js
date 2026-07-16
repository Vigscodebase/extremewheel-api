import { Queue } from "bullmq";
import { redis } from "../config/redis.js";

export const APP_GUIDE_IMPORT_QUEUE = "app-guide-import";

// A 30,000+ row spreadsheet import is exactly the kind of slow, retry-able,
// progress-trackable job BullMQ is for — it runs off the request/response
// cycle in a worker process instead of blocking an API request or a one-off
// script for minutes.
export const appGuideQueue = new Queue(APP_GUIDE_IMPORT_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 20,
    removeOnFail: 50,
  },
});

/**
 * Enqueue an import job for a workbook already sitting on disk (or an
 * accessible path/URL your worker knows how to read).
 * @param {string} filePath - absolute path to the .xls/.xlsx file
 */
export async function enqueueAppGuideImport(filePath) {
  return appGuideQueue.add("import", { filePath }, { jobId: `import-${Date.now()}` });
}

export default appGuideQueue;
