// One-off: move photos that are already stored as base64 inside MongoDB
// (vehicle notes saved before photos went to disk) into /uploads files.
//
//   node scripts/migrateVehicleImagesToFiles.js --dry-run   # just report
//   node scripts/migrateVehicleImagesToFiles.js             # do it
//
// Safe to re-run: documents that no longer contain base64 are skipped, and the
// database is only updated AFTER the files were written. Back up first anyway
// (mongodump) — the documents shrink, which is the point, but it can't be undone.
import dotenv from "dotenv";
import { isDataUrl, storeImage, uploadRoot } from "../utils/vehicleImageStore.js";

dotenv.config();
const dryRun = process.argv.includes("--dry-run");

const { default: connectDB } = await import("../config/db.js");
const { default: VehicleNote } = await import("../models/VehicleNote.js");
await connectDB();

const FIELDS = ["image", "beforeImage", "afterImage"];
let docs = 0, changed = 0, photos = 0, kept = 0, bytesBefore = 0;

const cursor = VehicleNote.find().select("name image beforeImage afterImage gallery").lean().cursor();
for await (const v of cursor) {
    docs += 1;
    const set = {};
    for (const f of FIELDS) {
        if (!isDataUrl(v[f])) continue;
        bytesBefore += v[f].length;
        photos += 1;
        const out = dryRun ? v[f] : await storeImage(v[f]);
        if (isDataUrl(out)) kept += 1; else set[f] = out;
    }
    if (Array.isArray(v.gallery) && v.gallery.some(isDataUrl)) {
        const gallery = [];
        for (const g of v.gallery) {
            if (!isDataUrl(g)) { gallery.push(g); continue; }
            bytesBefore += g.length;
            photos += 1;
            const out = dryRun ? g : await storeImage(g);
            if (isDataUrl(out)) kept += 1;
            gallery.push(out);
        }
        if (!dryRun) set.gallery = gallery;
    }
    if (Object.keys(set).length || (dryRun && photos)) {
        changed += 1;
        console.log(`${dryRun ? "would convert" : "converted"}: ${v.name} (${v._id})`);
    }
    if (!dryRun && Object.keys(set).length) await VehicleNote.updateOne({ _id: v._id }, { $set: set });
}

console.log(
    `\n${dryRun ? "[dry run] " : ""}${docs} vehicles scanned, ${changed} with inline photos, ${photos} photos ` +
    `(${(bytesBefore / 1e6).toFixed(1)} MB base64)${dryRun ? "" : `, ${photos - kept} written to ${uploadRoot()}, ${kept} left inline (could not convert)`}`
);
process.exit(0);
