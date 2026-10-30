// Deletes image files in uploads/vehicle-notes that no vehicle note references.
//
// Photos are uploaded the moment they are picked in the Add / Edit form, so a
// photo that is picked and then discarded (form cancelled, photo replaced
// before saving) leaves a file behind. This sweeps those up.
//
//   node scripts/cleanupOrphanImages.js            # list only (dry run)
//   node scripts/cleanupOrphanImages.js --apply    # delete
//
// Files younger than 24 hours are always kept, so a photo that is still in an
// open, unsaved form is never removed.

import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import mongoose from "mongoose";
import VehicleNote from "../models/VehicleNote.js";
import { VEHICLE_IMAGE_DIR, VEHICLE_IMAGE_URL_PREFIX } from "../utils/imageProcessor.js";

dotenv.config();
const APPLY = process.argv.includes("--apply");
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

try {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set.");
  await mongoose.connect(process.env.MONGODB_URI);

  const referenced = new Set();
  for await (const v of VehicleNote.find().select("image beforeImage afterImage gallery").lean().cursor()) {
    for (const p of [v.image, v.beforeImage, v.afterImage, ...(v.gallery || [])]) if (p) referenced.add(p);
  }

  const files = await fs.readdir(VEHICLE_IMAGE_DIR).catch(() => []);
  let orphans = 0;
  for (const name of files) {
    if (!name.endsWith(".webp") && !name.endsWith(".tmp")) continue;
    if (referenced.has(`${VEHICLE_IMAGE_URL_PREFIX}${name}`)) continue;
    const file = path.join(VEHICLE_IMAGE_DIR, name);
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs < MIN_AGE_MS) continue;
    orphans += 1;
    console.log(`${APPLY ? "deleting" : "orphan"}: ${name} (${(stat.size / 1024).toFixed(1)} KB)`);
    if (APPLY) await fs.unlink(file);
  }
  console.log(`${files.length} file(s) checked, ${orphans} orphan(s)${APPLY ? " deleted." : ". Re-run with --apply to delete."}`);
} catch (err) {
  console.error(`Cleanup failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
