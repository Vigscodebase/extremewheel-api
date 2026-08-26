import xlsx from "xlsx";
import VehicleLookup from "../models/VehicleLookup.js";
import VehicleLookupYear from "../models/VehicleLookupYear.js";
import { invalidatePrefix } from "../config/redis.js";
import logToFile from "../logger.js";

// Source sheet ("vehicle notes database.xlsx", Sheet1) columns are:
//   make | model | notes | category | Edit | Delete
// "notes", "Edit" and "Delete" are ignored on import — Edit/Delete are just
// UI action-button leftovers baked into the exported sheet, and "notes" is
// not part of the Make/Model/Type dropdown data this table exists for.
// Header matching is case-insensitive/trim-tolerant so a re-exported sheet
// (Title Case headers, extra whitespace, etc.) still imports cleanly.
//
// "year" is intentionally optional and not part of HEADER_ALIASES' required
// trio — the current spreadsheet doesn't have it, but if the client ever
// adds one (any of the aliases below), its distinct values are picked up
// automatically and feed the Year dropdown (see collectYears below), without
// needing a code change.
const HEADER_ALIASES = {
  make: "make",
  model: "model",
  category: "type",
  type: "type",
  year: "year",
  years: "year",
  "model year": "year",
  yr: "year",
};

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase();
}

/**
 * Finds which row in a raw array-of-arrays sheet is actually the header
 * row, instead of assuming it's always row 0.
 *
 * Why this matters: the app's own UI tells people to "download, edit, and
 * re-upload" this sheet (see the Vehicle Notes database card), and Excel/
 * Google Sheets makes it very easy to end up with a stray blank row, a
 * title/banner row ("Vehicle Notes Database" merged across A1:F1), or a
 * filter row above the real headers after a manual edit. Previously this
 * importer read `sheet_to_json` with default options, which always treats
 * row 0 as headers — if that row isn't the real header row, every column
 * key comes back as a generic "__EMPTY"-style placeholder, none of it
 * matches HEADER_ALIASES, every row fails the make/model/type check, and
 * the import silently "succeeds" with 0 rows imported and everything
 * skipped, with no clear indication of why.
 *
 * Scans the first MAX_HEADER_SCAN_ROWS rows and picks the first one that
 * contains recognized headers for both "make" and "model" (the two columns
 * that are always present and required) — that's a strong enough signal to
 * be the real header row regardless of what's above it.
 */
const MAX_HEADER_SCAN_ROWS = 15;

function findHeaderRow(rows) {
  const limit = Math.min(rows.length, MAX_HEADER_SCAN_ROWS);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] || [];
    const fields = new Set(row.map((cell) => HEADER_ALIASES[normalizeHeader(cell)]).filter(Boolean));
    if (fields.has("make") && fields.has("model")) {
      return i;
    }
  }
  return -1;
}

/**
 * Parses an uploaded workbook buffer into { make, model, type } rows, plus
 * any distinct "year" values found (see HEADER_ALIASES note above).
 * Blank/incomplete rows are skipped and counted.
 */
export function parseVehicleLookupWorkbook(buffer) {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  // Read as a raw array-of-arrays first so header-row detection can look at
  // the actual grid instead of trusting row 0 to be the header.
  const grid = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false, blankrows: false });

  const headerRowIndex = findHeaderRow(grid);
  if (headerRowIndex === -1) {
    // No recognizable header row anywhere in the first few rows — nothing
    // to safely import. Every row counts as skipped rather than throwing,
    // so the UI can show "0 imported, N skipped" instead of a crash.
    return { docs: [], skipped: grid.length, total: grid.length, years: [] };
  }

  const headerRow = grid[headerRowIndex];
  const columnFields = headerRow.map((cell) => HEADER_ALIASES[normalizeHeader(cell)] || null);
  const dataRows = grid.slice(headerRowIndex + 1);

  let skipped = 0;
  const seen = new Set();
  const docs = [];
  const years = new Set();

  for (const row of dataRows) {
    const mapped = {};
    columnFields.forEach((field, colIndex) => {
      if (!field) return; // ignores notes/Edit/Delete/unknown columns
      const value = row[colIndex];
      mapped[field] = typeof value === "string" ? value.trim() : value;
    });

    if (mapped.year !== undefined && mapped.year !== null && String(mapped.year).trim() !== "") {
      years.add(String(mapped.year).trim());
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

  return { docs, skipped, total: dataRows.length, years: Array.from(years) };
}

/**
 * Replaces the entire VehicleLookup collection with the contents of the
 * uploaded workbook — this table is meant to always mirror the client's
 * master spreadsheet exactly, so a re-upload is a full re-sync rather than
 * an incremental merge (matches how Tech Data CSV import/export behaves).
 *
 * Any "year" values found are merged (not replaced) into VehicleLookupYear,
 * since — unlike make/model/type — years also accumulate independently from
 * the Vehicle Notes form itself (see quickAddVehicleLookupYear) and a sheet
 * re-upload shouldn't wipe those out.
 */
export async function importVehicleLookupWorkbook(buffer) {
  const { docs, skipped, total, years } = parseVehicleLookupWorkbook(buffer);

  if (docs.length > 0) {
    await VehicleLookup.deleteMany({});
    await VehicleLookup.insertMany(docs, { ordered: false });
  }

  if (years.length > 0) {
    await VehicleLookupYear.bulkWrite(
      years.map((year) => ({
        updateOne: { filter: { year }, update: { $setOnInsert: { year } }, upsert: true },
      })),
      { ordered: false }
    );
  }

  await invalidatePrefix("vehicle-lookup:");
  logToFile(
    `[VehicleLookupImport] ✅ Replaced table: ${docs.length} row(s) imported, ${skipped} skipped, ${total} total, ${years.length} distinct year(s) merged`
  );

  return { processed: docs.length, skipped, total, yearsFound: years.length };
}

/** Builds an .xlsx workbook buffer (Make / Model / Category columns) for download. */
export function buildVehicleLookupWorkbook(rows) {
  const sheetRows = rows.map((r) => ({ Make: r.make, Model: r.model, Category: r.type }));
  const sheet = xlsx.utils.json_to_sheet(sheetRows, { header: ["Make", "Model", "Category"] });
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, sheet, "Sheet1");
  return xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
}

/**
 * Adds a single Make/Model/Type combo to the predefined list, ignoring it if
 * that exact combo is already there. Used by the Vehicle Notes "Add / Edit
 * vehicle" form so that saving a vehicle with a freshly-typed Make/Model/Type
 * — not just ones already in the sheet — makes it available as a dropdown
 * option going forward (a no-op, not an error, if it already exists).
 */
export async function quickAddVehicleLookup({ make, model, type }) {
  await VehicleLookup.updateOne(
    { make, model, type },
    { $setOnInsert: { make, model, type } },
    { upsert: true }
  );
  await invalidatePrefix("vehicle-lookup:");
}

/** Same idea as quickAddVehicleLookup, for the independent Year dropdown. */
export async function quickAddVehicleLookupYear(year) {
  await VehicleLookupYear.updateOne({ year }, { $setOnInsert: { year } }, { upsert: true });
  await invalidatePrefix("vehicle-lookup:");
}
