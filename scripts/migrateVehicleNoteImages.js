// One-time migration: base64 images -> WebP files (<= 300 KB) + URL paths.
//
// WHY
// ---
// VehicleNote used to store photos as base64 data URLs inside MongoDB
// (image, beforeImage, afterImage, gallery[]). Photos are now uploaded with
// multer, converted by sharp and stored as files; the database keeps only the
// short URL path. This script converts what is already stored.
//
// WHAT IT TOUCHES
// ---------------
// ONLY the four image fields. Every other value (_id, dates, customer,
// staffNotes, searchTokens, __v, updatedAt, ...) is left exactly as it is.
// Identical photos (the export repeats the same image in several fields) are
// converted once and share one file, so `image === beforeImage` stays true,
// which the detail page relies on.
//
// MODES
// -----
// 1) Database (default: DRY RUN, writes nothing):
//      node scripts/migrateVehicleNoteImages.js            # preview
//      node scripts/migrateVehicleNoteImages.js --apply    # convert + update
//    Take a backup first (mongodump, or keep your vehiclenotes.json export).
//
// 2) Exported JSON file -> new JSON file (no database needed):
//      node scripts/migrateVehicleNoteImages.js --file vehiclenotes.json --out vehiclenotes.migrated.json
//    The output is the input text with only the image strings replaced.
//
// Both modes write the WebP files to UPLOAD_DIR/vehicle-notes (default:
// ./uploads/vehicle-notes). Safe to re-run: converted values are skipped.

import dotenv from "dotenv";
import fs from "fs/promises";
import mongoose from "mongoose";
import {
  MAX_IMAGE_BYTES,
  VEHICLE_IMAGE_DIR,
  dataUrlToBuffer,
  saveImageAsWebp,
  toWebp,
} from "../utils/imageProcessor.js";

dotenv.config();

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const APPLY = flag("--apply");
const FILE_IN = option("--file");
const FILE_OUT = option("--out");
const SINGLE_FIELDS = ["image", "beforeImage", "afterImage"];

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const isDataUrl = (v) => typeof v === "string" && v.startsWith("data:");

// ---- shared conversion (one conversion per distinct image) -----------------
const converted = new Map(); // data URL -> { path, bytes, ... }
const stats = { images: 0, unique: 0, recompressed: [], failed: [] };

async function convert(dataUrl, label) {
  stats.images += 1;
  if (converted.has(dataUrl)) return converted.get(dataUrl);

  const buffer = dataUrlToBuffer(dataUrl);
  if (!buffer || buffer.length === 0) throw new Error(`${label}: not a valid base64 image data URL`);

  let result;
  if (APPLY || FILE_IN) {
    result = await saveImageAsWebp(buffer); // no dimension cap: keep the original pixel size
  } else {
    // Dry run: do the real conversion in memory so sizes are accurate, but write nothing.
    const r = await toWebp(buffer);
    result = { path: "(dry run)", bytes: r.buffer.length, quality: r.quality, resized: r.resized, width: r.width, height: r.height };
  }
  result.sourceBytes = buffer.length;
  stats.unique += 1;
  // Quality below 80 or a smaller pixel size means the photo could not simply be
  // re-encoded; flag it so it can be looked at.
  if (result.resized || (result.quality !== undefined && result.quality < 80)) {
    stats.recompressed.push({ label, sourceBytes: buffer.length, bytes: result.bytes, quality: result.quality, resized: result.resized, width: result.width, height: result.height });
  }
  converted.set(dataUrl, result);
  return result;
}

// ---- mode 1: JSON export -> JSON export -------------------------------------
async function migrateFile() {
  if (!FILE_OUT) throw new Error("--file needs --out <new file>");
  const text = await fs.readFile(FILE_IN, "utf8");

  // Replace only the string literals that hold an image data URL; every other
  // byte of the export is copied through unchanged.
  const literal = /"data:image\/[a-z0-9.+-]+;base64,[^"]*"/gi;
  const matches = [...text.matchAll(literal)];
  let out = "";
  let last = 0;
  for (const m of matches) {
    const value = JSON.parse(m[0]);
    const result = await convert(value, `export offset ${m.index}`);
    out += text.slice(last, m.index) + JSON.stringify(result.path);
    last = m.index + m[0].length;
  }
  out += text.slice(last);
  await fs.writeFile(FILE_OUT, out);
  console.log(`Wrote ${FILE_OUT}`);
}

// ---- mode 2: live database ---------------------------------------------------
async function migrateDatabase() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set.");
  await mongoose.connect(process.env.MONGODB_URI);
  // Native collection on purpose: no schema hooks, no timestamps, so updatedAt,
  // __v and searchTokens are not touched.
  const col = mongoose.connection.collection("vehiclenotes");

  const query = { $or: [...SINGLE_FIELDS.map((f) => ({ [f]: /^data:/ })), { gallery: /^data:/ }] };
  const total = await col.countDocuments(query);
  console.log(`${total} vehicle note(s) still hold base64 images.`);

  let updatedDocs = 0;
  const cursor = col.find(query);
  for await (const doc of cursor) {
    const $set = {};
    for (const field of SINGLE_FIELDS) {
      if (isDataUrl(doc[field])) $set[field] = (await convert(doc[field], `${doc._id}.${field}`)).path;
    }
    if (Array.isArray(doc.gallery) && doc.gallery.some(isDataUrl)) {
      const gallery = [];
      for (let i = 0; i < doc.gallery.length; i += 1) {
        const v = doc.gallery[i];
        gallery.push(isDataUrl(v) ? (await convert(v, `${doc._id}.gallery[${i}]`)).path : v);
      }
      $set.gallery = gallery;
    }
    if (APPLY && Object.keys($set).length) {
      await col.updateOne({ _id: doc._id }, { $set });
      updatedDocs += 1;
    }
  }
  if (APPLY) console.log(`Updated ${updatedDocs} document(s).`);
  await mongoose.disconnect();
}

// ---- run ----------------------------------------------------------------------
try {
  if (FILE_IN) await migrateFile();
  else await migrateDatabase();

  console.log(`\n${stats.images} image reference(s), ${stats.unique} distinct image(s) -> ${VEHICLE_IMAGE_DIR}`);
  for (const r of converted.values()) {
    if (r.bytes > MAX_IMAGE_BYTES) throw new Error("A converted image is over the size limit - aborting.");
  }
  if (stats.recompressed.length) {
    console.log("\nThese images could not be kept at near-original quality / size (to stay under 300 KB):");
    for (const r of stats.recompressed) {
      console.log(`  ${r.label}: ${kb(r.sourceBytes)} -> ${kb(r.bytes)}, quality ${r.quality}${r.resized ? `, resized to ${r.width}x${r.height}` : ""}`);
    }
  } else {
    console.log("All images were re-encoded at full pixel size with high quality.");
  }
  if (!FILE_IN && !APPLY) console.log("\nDry run only - nothing was written. Re-run with --apply to convert and update.");
} catch (err) {
  console.error(`Migration failed: ${err.message}`);
  process.exitCode = 1;
  await mongoose.disconnect().catch(() => {});
}
