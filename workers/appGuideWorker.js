// Run as its own process: `node workers/appGuideWorker.js`
// (add to ecosystem.json as a second pm2 app for production so it stays
// running independently of the API process.)
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

import { Worker } from "bullmq";
import connectDB from "../config/db.js";
import { redis } from "../config/redis.js";
import { APP_GUIDE_IMPORT_QUEUE } from "../queues/appGuideQueue.js";
import { importAppGuideFile } from "../utils/appGuideImporter.js";
import logToFile from "../logger.js";

async function start() {
  await connectDB();

  const worker = new Worker(
    APP_GUIDE_IMPORT_QUEUE,
    async (job) => {
      const { filePath } = job.data;
      logToFile(`[AppGuideWorker] Starting import job ${job.id} -> ${filePath}`);
      const result = await importAppGuideFile(filePath, ({ processed, total }) => {
        job.updateProgress(total ? Math.floor((processed / total) * 100) : 0);
      });
      return result;
    },
    { connection: redis, concurrency: 1 }
  );

  worker.on("completed", (job, result) => {
    logToFile(`[AppGuideWorker] ✅ Job ${job.id} completed: ${result.processed}/${result.total} rows`);
  });

  worker.on("failed", (job, err) => {
    logToFile(`[AppGuideWorker] ❌ Job ${job?.id} failed: ${err.message}`);
  });

  console.log("[AppGuideWorker] Listening for app-guide-import jobs...");
}

start().catch((err) => {
  console.error("[AppGuideWorker] Fatal startup error:", err);
  process.exit(1);
});
