import xlsx from "xlsx";
import VehicleLookup from "../models/VehicleLookup.js";
import { invalidatePrefix } from "../config/redis.js";
import logToFile from "../logger.js";

// Source sheet ("vehicle notes database.xlsx", Sheet1) columns are:
//   make | model | notes | category | Edit | Delete
// "notes", "Edit" and "Delete" are ignored on import — Edit/Delete are just
// UI action-button leftovers baked into the exported sheet, and "notes" is
// not part of the Make/Model/Type dropdown data this table exists for.
// Header matching is case-insensitive/trim-tolerant so a re-exported sheet
// (Title Case headers, extra whitespace, etc.) still imports cleanly.
const HEADER_ALIASES = {
  make: "make",
  model: "model",
  category: "type",
  type: "type",
};

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase();
}

/**
 * Parses an uploaded workbook buffer into { make, model, type } rows.
 * Blank/incomplete rows are skipped and counted.
 */
export function parseVehicleLookupWorkbook(buffer) {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = xlsx.utils.sheet_to_json(sheet, { defval: "", raw: false });

  let skipped = 0;
  const seen = new Set();
  const docs = [];

  for (const row of raw) {
    const mapped = {};
    for (const [key, value] of Object.entries(row)) {
      const field = HEADER_ALIASES[normalizeHeader(key)];
      if (!field) continue; // ignores notes/Edit/Delete/unknown columns
      mapped[field] = typeof value === "string" ? value.trim() : value;
    }

    if (!mapped.make || !mapped.model || !mapped.type) {
      skipped++;
      continue;
    }

    const dedupeKey = `${mapped.make}|${mapped.model}|${mapped.type}`.toUpperCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    docs.push({ make: mapped.make, model: mapped.model, type: mapped.type });
  }

  return { docs, skipped, total: raw.length };
}

/**
 * Replaces the entire VehicleLookup collection with the contents of the
 * uploaded workbook — this table is meant to always mirror the client's
 * master spreadsheet exactly, so a re-upload is a full re-sync rather than
 * an incremental merge (matches how Tech Data CSV import/export behaves).
 */
export async function importVehicleLookupWorkbook(buffer) {
  const { docs, skipped, total } = parseVehicleLookupWorkbook(buffer);

  if (docs.length > 0) {
    await VehicleLookup.deleteMany({});
    await VehicleLookup.insertMany(docs, { ordered: false });
  }

  await invalidatePrefix("vehicle-lookup:");
  logToFile(`[VehicleLookupImport] ✅ Replaced table: ${docs.length} row(s) imported, ${skipped} skipped, ${total} total`);

  return { processed: docs.length, skipped, total };
}

/** Builds an .xlsx workbook buffer (Make / Model / Category columns) for download. */
export function buildVehicleLookupWorkbook(rows) {
  const sheetRows = rows.map((r) => ({ Make: r.make, Model: r.model, Category: r.type }));
  const sheet = xlsx.utils.json_to_sheet(sheetRows, { header: ["Make", "Model", "Category"] });
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, sheet, "Sheet1");
  return xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
}
