import { Queue } from "bullmq";
import { redis } from "../config/redis.js";

export const TIRE_SIZES_IMPORT_QUEUE = "tire-sizes-import";

// Mirrors queues/appGuideQueue.js exactly — same reasoning applies: even
// though tblTireSizes.xls is a much smaller sheet than the Application
// Guide workbook, running it off the request/response cycle via a
// dedicated worker keeps the initialization pipeline consistent between
// the two source spreadsheets.
export const tireSizesQueue = new Queue(TIRE_SIZES_IMPORT_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 20,
    removeOnFail: 50,
  },
});

/**
 * Enqueue an import job for a tblTireSizes.xls workbook already sitting on
 * disk (or an accessible path your worker knows how to read).
 * @param {string} filePath - absolute path to the .xls/.xlsx file
 */
export async function enqueueTireSizesImport(filePath) {
  return tireSizesQueue.add("import", { filePath }, { jobId: `tire-sizes-import-${Date.now()}` });
}

export default tireSizesQueue;
