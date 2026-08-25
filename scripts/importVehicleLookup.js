// Initial-seed / CLI alternative to the in-app "Upload database" button on
// the Vehicle Notes page — useful for the very first deploy, before there's
// a logged-in staff/admin user to do it through the UI.
//
// Usage:
//   node scripts/importVehicleLookup.js /path/to/vehicle_notes_database.xlsx
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import dotenv from "dotenv";
dotenv.config({ path: path.join(__dirname, "../.env") });

import connectDB from "../config/db.js";
import { importVehicleLookupWorkbook } from "../utils/vehicleLookupImporter.js";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node scripts/importVehicleLookup.js <path-to-xlsx>");
    process.exit(1);
  }
  const absolutePath = path.resolve(filePath);
  const buffer = fs.readFileSync(absolutePath);

  await connectDB();
  console.log(`[import] Importing ${absolutePath}...`);
  const result = await importVehicleLookupWorkbook(buffer);
  console.log(`[import] ✅ Done: ${result.processed} row(s) imported, ${result.skipped} skipped, ${result.total} total.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[import] ❌ Failed:", err);
  process.exit(1);
});
