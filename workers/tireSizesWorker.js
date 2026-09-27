// Run as its own process: `node workers/tireSizesWorker.js`
// (added to ecosystem.json as its own pm2 app for production — see
// "extremewheel-tire-sizes-worker" — so it stays running independently of
// the API process, same as workers/appGuideWorker.js.)
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

import { Worker } from "bullmq";
import connectDB from "../config/db.js";
import { redis } from "../config/redis.js";
import { TIRE_SIZES_IMPORT_QUEUE } from "../queues/tireSizesQueue.js";
import { importTireSizesFile } from "../utils/tireSizesImporter.js";
import logToFile from "../logger.js";

async function start() {
  await connectDB();

  const worker = new Worker(
    TIRE_SIZES_IMPORT_QUEUE,
    async (job) => {
      const { filePath } = job.data;
      logToFile(`[TireSizesWorker] Starting import job ${job.id} -> ${filePath}`);
      const result = await importTireSizesFile(filePath, ({ processed, total }) => {
        job.updateProgress(total ? Math.floor((processed / total) * 100) : 0);
      });
      return result;
    },
    { connection: redis, concurrency: 1 }
  );

  worker.on("completed", (job, result) => {
    logToFile(`[TireSizesWorker] ✅ Job ${job.id} completed: ${result.inserted}/${result.total} rows inserted`);
  });

  worker.on("failed", (job, err) => {
    logToFile(`[TireSizesWorker] ❌ Job ${job?.id} failed: ${err.message}`);
  });

  console.log("[TireSizesWorker] Listening for tire-sizes-import jobs...");
}

start().catch((err) => {
  console.error("[TireSizesWorker] Fatal startup error:", err);
  process.exit(1);
});
