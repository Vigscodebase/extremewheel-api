// One-time initialization: pulls every existing Tire Size Option preset's
// width/aspect/rim into oe_tiresize (source "tire-options"), the same as
// the tblTireSizes.xls / tblAppGuide-Templatenew.xls imports do for their
// sources. Run once when oe_tiresize is first introduced; after that, the
// tireOptionRouter create/update handlers in server.js keep it in sync
// going forward, so this script never needs to run again for new presets.
//
// Usage: node scripts/backfillOeTireSizeFromTireOptions.js
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

import connectDB from "../config/db.js";
import TireOption from "../models/TireOption.js";
import { upsertManyOeTireSizes } from "../utils/oeTireSizeService.js";

async function main() {
  await connectDB();

  const presets = await TireOption.find().lean();
  const sizes = presets
    .filter((p) => p.width && p.aspect && p.rim)
    .map((p) => ({ width: p.width, aspect: p.aspect, rim: p.rim, _id: p._id, label: p.label }));

  const sourceRefFor = (s) => String(s._id);
  const labelFor = (s) => s.label;

  const result = await upsertManyOeTireSizes(sizes, "tire-options", { sourceRefFor, labelFor });

  console.log(
    `[backfill] ✅ Done: ${result.inserted}/${presets.length} preset sizes inserted into oe_tiresize (${result.duplicates} already on file).`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] ❌ Failed:", err);
  process.exit(1);
});
