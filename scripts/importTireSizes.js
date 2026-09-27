// Usage:
//   node scripts/importTireSizes.js /path/to/tblTireSizes.xls
//   node scripts/importTireSizes.js /path/to/file.xls --queue   (enqueue via BullMQ/Redis
//                                                                 and let workers/tireSizesWorker.js
//                                                                 process it in the background)
//
// Mirrors scripts/importAppGuide.js — the same initialization pattern, one
// script per source workbook (tblAppGuide-Templatenew.xls / tblTireSizes.xls).
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

import connectDB from "../config/db.js";
import { importTireSizesFile } from "../utils/tireSizesImporter.js";

async function main() {
  const filePath = process.argv[2];
  const useQueue = process.argv.includes("--queue");

  if (!filePath) {
    console.error("Usage: node scripts/importTireSizes.js <path-to-xlsx> [--queue]");
    process.exit(1);
  }
  const absolutePath = path.resolve(filePath);

  if (useQueue) {
    // Background mode: hand the job to BullMQ/Redis and exit immediately.
    // Run `node workers/tireSizesWorker.js` (separately, kept running) to
    // actually process it.
    const { enqueueTireSizesImport } = await import("../queues/tireSizesQueue.js");
    const job = await enqueueTireSizesImport(absolutePath);
    console.log(`[import] Queued job ${job.id} for ${absolutePath}. Start the worker with:`);
    console.log(`  node workers/tireSizesWorker.js`);
    process.exit(0);
  }

  // Direct mode: import inline in this process (no Redis required). Fine
  // for local dev / the ~586-row production sheet.
  await connectDB();
  console.log(`[import] Importing ${absolutePath} directly...`);
  const result = await importTireSizesFile(absolutePath, ({ processed, total }) => {
    process.stdout.write(`\r[import] ${processed}/${total} rows...`);
  });
  console.log(`\n[import] ✅ Done: ${result.inserted}/${result.total} rows inserted (${result.duplicates} duplicate/skipped).`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[import] ❌ Failed:", err);
  process.exit(1);
});
