// One-time migration: run once after deploying the updated VehicleNote
// schema (make + year added, type/model repurposed).
//
// WHY THIS IS NEEDED
// -------------------
// Before this change the form only had 4 fields, mislabeled in the UI:
//   - schema field `type`  displayed as "Make"  (free text, e.g. "Cargo Van")
//   - schema field `model` displayed as "Year"  (free text, e.g. "2023")
// After this change the fields mean what their names say, and two new
// dropdown-driven fields were added:
//   - `make`  (new)  — predefined dropdown
//   - `model` (repurposed) — predefined dropdown, cascades from make
//   - `type`  (repurposed) — predefined dropdown, cascades from make+model
//   - `year`  (new)  — free-entry vehicle year
//
// There is no reliable automatic way to turn an old free-text "Make" value
// like "Cargo Van" into a real (make, model, type) triple from the
// predefined database — that requires a human decision. So this script does
// NOT guess a make/model/type. Instead it:
//   1. Preserves every old value by prefixing it into `offsetNotes` so
//      nothing is silently lost.
//   2. Copies the old `type` value (the old "Make" text) into the new
//      `make` field as a starting point for staff to correct via the
//      Edit-vehicle dropdowns.
//   3. Copies the old `model` value (the old "Year" text) into the new
//      `year` field when it looks like a plausible 4-digit year.
//   4. Leaves `model` blank so the record shows up as incomplete and staff
//      are prompted to pick the real Model + Type from the dropdowns next
//      time they open it (the Edit form requires make+model+type to save).
//
// Usage:  node scripts/migrateVehicleNotesFields.js
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import dotenv from "dotenv";
dotenv.config({ path: path.join(__dirname, "../.env") });

import mongoose from "mongoose";
import connectDB from "../config/db.js";
import VehicleNote from "../models/VehicleNote.js";
import logToFile from "../logger.js";

const YEAR_RE = /^(19|20)\d{2}$/;

async function run() {
  await connectDB();
  logToFile("[MigrateVehicleNotes] Connected. Scanning for pre-migration records…");

  // Pre-migration records never had `make` set, since it didn't exist yet.
  const cursor = VehicleNote.find({ make: { $exists: false } }).cursor();

  let migrated = 0;
  for await (const doc of cursor) {
    const oldType = doc.type || "";
    const oldModel = doc.model || "";
    const looksLikeYear = YEAR_RE.test(String(oldModel).trim());

    const migrationNote =
      `[Migrated ${new Date().toISOString().slice(0, 10)}] Pre-migration values — ` +
      `Make field was: "${oldType || "(blank)"}", Year field was: "${oldModel || "(blank)"}". ` +
      `Please set Make / Model / Type from the dropdowns above.`;

    doc.make = oldType || "Unspecified";
    doc.year = looksLikeYear ? String(oldModel).trim() : "";
    doc.model = ""; // force a real pick from the predefined dropdown
    doc.type = ""; // force a real pick from the predefined dropdown
    doc.offsetNotes = [doc.offsetNotes, migrationNote].filter(Boolean).join("\n\n");

    // Bypass required-field validation for this one-time backfill write —
    // model/type are intentionally blank until staff review them.
    await doc.save({ validateBeforeSave: false });
    migrated++;
  }

  logToFile(`[MigrateVehicleNotes] ✅ Done. Migrated ${migrated} record(s).`);
  await mongoose.disconnect();
}

run().catch((err) => {
  logToFile(`[MigrateVehicleNotes] ❌ Failed: ${err.message}`);
  process.exit(1);
});
