// Usage:
//   node scripts/importAppGuide.js /path/to/tblAppGuide-Templatenew.xls
//   node scripts/importAppGuide.js /path/to/file.xls --queue   (enqueue via BullMQ/Redis
//                                                                and let workers/appGuideWorker.js
//                                                                process it in the background)
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

import connectDB from "../config/db.js";
import { importAppGuideFile } from "../utils/appGuideImporter.js";

async function main() {
  const filePath = process.argv[2];
  const useQueue = process.argv.includes("--queue");

  if (!filePath) {
    console.error("Usage: node scripts/importAppGuide.js <path-to-xlsx> [--queue]");
    process.exit(1);
  }
  const absolutePath = path.resolve(filePath);

  if (useQueue) {
    // Background mode: hand the job to BullMQ/Redis and exit immediately.
    // Run `node workers/appGuideWorker.js` (separately, kept running) to
    // actually process it. Best for the full ~30k row production sheet.
    const { enqueueAppGuideImport } = await import("../queues/appGuideQueue.js");
    const job = await enqueueAppGuideImport(absolutePath);
    console.log(`[import] Queued job ${job.id} for ${absolutePath}. Start the worker with:`);
    console.log(`  node workers/appGuideWorker.js`);
    process.exit(0);
  }

  // Direct mode: import inline in this process (no Redis required). Fine
  // for local dev / smaller sheets; for the full production workbook the
  // --queue mode above is recommended so it doesn't block your terminal.
  await connectDB();
  console.log(`[import] Importing ${absolutePath} directly...`);
  const result = await importAppGuideFile(absolutePath, ({ processed, total }) => {
    process.stdout.write(`\r[import] ${processed}/${total} rows...`);
  });
  console.log(`\n[import] ✅ Done: ${result.processed}/${result.total} rows upserted.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[import] ❌ Failed:", err);
  process.exit(1);
});
