import xlsx from "xlsx";
import VehicleLookup from "../models/VehicleLookup.js";
import VehicleLookupYear from "../models/VehicleLookupYear.js";
import VehicleLookupMake from "../models/VehicleLookupMake.js";
import VehicleLookupOption, { VEHICLE_LOOKUP_OPTION_KINDS } from "../models/VehicleLookupOption.js";
import VehicleNote from "../models/VehicleNote.js";
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

/**
 * Adds a Make on its own (no Model/Type yet) to the predefined Make list —
 * used by the Tire Size Option preset popup, where a preset only has a Make.
 * Upserts, so adding one that already exists is a harmless no-op.
 */
export async function addVehicleLookupMake(make) {
  await VehicleLookupMake.updateOne({ make }, { $setOnInsert: { make } }, { upsert: true });
  await invalidatePrefix("vehicle-lookup:");
}

/**
 * Deleting a Model or Type only ever removes rows *under* a make. If that
 * would leave the make with no rows at all it would vanish from the Make
 * dropdown as a side effect, so it's parked in VehicleLookupMake first.
 */
async function keepMakeIfEmptied(make, remainingFilter) {
  const remaining = await VehicleLookup.countDocuments({ make, ...remainingFilter });
  if (remaining === 0) {
    await VehicleLookupMake.updateOne({ make }, { $setOnInsert: { make } }, { upsert: true });
  }
}

/**
 * Removes one Year from the predefined Year list. Years are independent of
 * make/model/type (see models/VehicleLookupYear.js), so there is nothing
 * cascading to clean up — and, like the Make/Model/Type deletes below,
 * Vehicle Notes already saved with that year keep it.
 * Resolves to the number of rows removed (0 means the year wasn't found).
 */
export async function deleteVehicleLookupYear(year) {
  const rows = await VehicleLookupYear.deleteOne({ year });
  await invalidatePrefix("vehicle-lookup:");
  return rows.deletedCount;
}

/**
 * Removes a Make from the predefined list along with every Model/Type row
 * under it. Existing Vehicle Notes and Tire Size Option presets are plain
 * documents that store their own make/model/type text, so they are left
 * exactly as they are.
 * Resolves to the number of rows removed (0 means the make wasn't found).
 */
export async function deleteVehicleLookupMake(make) {
  const rows = await VehicleLookup.deleteMany({ make });
  const standalone = await VehicleLookupMake.deleteOne({ make });
  await invalidatePrefix("vehicle-lookup:");
  return rows.deletedCount + standalone.deletedCount;
}

/** Removes one Model (all of its Type rows) from under a Make. Keeps the Make. */
export async function deleteVehicleLookupModel(make, model) {
  const filter = { make, model };
  if ((await VehicleLookup.countDocuments(filter)) === 0) return 0;
  await keepMakeIfEmptied(make, { model: { $ne: model } });
  const rows = await VehicleLookup.deleteMany(filter);
  await invalidatePrefix("vehicle-lookup:");
  return rows.deletedCount;
}

/**
 * Removes one Type from a Make + Model. Keeps the Make. (A model with only
 * that one type has nothing left to describe it, so it goes too — a Type is
 * what a lookup row is made of.)
 */
export async function deleteVehicleLookupType(make, model, type) {
  const filter = { make, model, type };
  if ((await VehicleLookup.countDocuments(filter)) === 0) return 0;
  await keepMakeIfEmptied(make, { $nor: [{ model, type }] });
  const rows = await VehicleLookup.deleteMany(filter);
  await invalidatePrefix("vehicle-lookup:");
  return rows.deletedCount;
}


// --- Submodel / Tire size / Wheel offset dropdown lists --------------------
// See models/VehicleLookupOption.js. Same rules as the Year list: staff and admin
// grow and prune it (enforced on the routes), values already saved on vehicle
// notes are never touched by a delete.

export const isLookupOptionKind = (kind) => VEHICLE_LOOKUP_OPTION_KINDS.includes(kind);

/**
 * Canonical stored form of a list value, or `null` when it isn't acceptable for
 * that kind. Mirrors what the Add / Edit vehicle form and the save service accept,
 * so a value that can be picked from a list can always be saved on a vehicle.
 *   submodel     -> trimmed text, max 80 characters
 *   tire-size    -> "205/55R16" | "205-55-16" -> "205 55 16" (width 105-495, aspect 20-95, rim 10-30)
 *   wheel-offset -> whole number of mm between -200 and 200, as text ("-12")
 */
export function normalizeLookupOptionValue(kind, raw) {
  const text = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
  if (!text) return null;

  if (kind === "submodel") return text.slice(0, 80);

  if (kind === "tire-size") {
    const nums = text.match(/\d+/g) || [];
    const [w, a, r] = nums.map(Number);
    const ok = nums.length === 3 && w >= 105 && w <= 495 && a >= 20 && a <= 95 && r >= 10 && r <= 30;
    return ok ? `${w} ${a} ${r}` : null;
  }

  if (kind === "wheel-offset") {
    if (!/^-?\d{1,3}$/.test(text)) return null;
    const n = Number(text);
    return n >= -200 && n <= 200 ? String(n) : null;
  }

  return null;
}

// Numeric order for sizes / offsets (205 55 16 before 225 45 17; -12 before 5),
// alphabetical for submodels.
function compareLookupOptions(kind, a, b) {
  if (kind === "submodel") return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  if (kind === "wheel-offset") return Number(a) - Number(b);
  const pa = String(a).split(" ").map(Number);
  const pb = String(b).split(" ").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/** Every value of one list, in display order. */
export async function listVehicleLookupOptions(kind) {
  const values = await VehicleLookupOption.distinct("value", { kind });
  return values.filter(Boolean).sort((a, b) => compareLookupOptions(kind, a, b));
}

/** Adds one value to a list; adding one that exists is a harmless no-op. */
export async function quickAddVehicleLookupOption(kind, value) {
  await VehicleLookupOption.updateOne({ kind, value }, { $setOnInsert: { kind, value } }, { upsert: true });
  await invalidatePrefix("vehicle-lookup:");
}

/** Removes one value from a list. Resolves to how many were removed (0 = not found). */
export async function deleteVehicleLookupOption(kind, value) {
  const rows = await VehicleLookupOption.deleteOne({ kind, value });
  await invalidatePrefix("vehicle-lookup:");
  return rows.deletedCount;
}

// Which vehicle-note field(s) feed which list when seeding.
const OPTION_SEED_SOURCES = [
  { kind: "submodel", fields: ["submodel"] },
  { kind: "tire-size", fields: ["frontTireSize", "rearTireSize"] },
  { kind: "wheel-offset", fields: ["frontWheelOffset", "rearWheelOffset"] },
];

/**
 * Fills the Submodel / Tire size / Wheel offset lists with the values already on
 * saved vehicle notes. Upserts only — never removes anything. Resolves to the
 * number of values added.
 */
export async function seedVehicleLookupOptionsFromNotes() {
  let added = 0;
  for (const { kind, fields } of OPTION_SEED_SOURCES) {
    const found = new Set();
    for (const field of fields) {
      const values = await VehicleNote.distinct(field);
      for (const raw of values) {
        const value = normalizeLookupOptionValue(kind, raw);
        if (value) found.add(value);
      }
    }
    if (found.size === 0) continue;
    const result = await VehicleLookupOption.bulkWrite(
      [...found].map((value) => ({
        updateOne: { filter: { kind, value }, update: { $setOnInsert: { kind, value } }, upsert: true },
      })),
      { ordered: false }
    );
    added += result.upsertedCount;
  }
  if (added > 0) await invalidatePrefix("vehicle-lookup:");
  return added;
}

/**
 * Run at startup: when the three lists have never been filled (the collection is
 * completely empty), seed them from the existing vehicle notes so the dropdowns
 * aren't empty on first use. Once any value exists this does nothing, so values
 * that staff delete later never come back by themselves.
 */
export async function seedVehicleLookupOptionsIfEmpty() {
  if ((await VehicleLookupOption.estimatedDocumentCount()) > 0) return 0;
  return seedVehicleLookupOptionsFromNotes();
}
