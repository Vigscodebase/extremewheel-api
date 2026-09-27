import xlsx from "xlsx";
import OeTireSize from "../models/OeTireSize.js";
import { upsertManyOeTireSizes } from "./oeTireSizeService.js";
import logToFile from "../logger.js";

// Flexible header matching (case/space-insensitive) so a plain "Width /
// Aspect / Rim" sheet, tblTireSizes.xls's own "nWidth / nProfile / nWheel"
// headers, or a re-exported download from this same feature (see
// buildOeTireSizeWorkbook below) all import cleanly. Mirrors the header-alias
// + header-row-detection approach in utils/vehicleLookupImporter.js.
const HEADER_ALIASES = {
  width: "width",
  nwidth: "width",
  "section width": "width",
  "tire width": "width",
  aspect: "aspect",
  nprofile: "aspect",
  profile: "aspect",
  "aspect ratio": "aspect",
  rim: "rim",
  nwheel: "rim",
  wheel: "rim",
  "rim diameter": "rim",
  diameter: "rim",
};

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase();
}

const MAX_HEADER_SCAN_ROWS = 10;

// Finds the header row the same way vehicleLookupImporter does — scans the
// first few rows for one that has recognizable width/rim columns, rather
// than assuming row 0 (tblTireSizes.xls itself has a merged group-label
// row above its real headers, so this also lets that exact file be
// re-uploaded here without a special case).
function findHeaderRow(grid) {
  const limit = Math.min(grid.length, MAX_HEADER_SCAN_ROWS);
  for (let i = 0; i < limit; i++) {
    const row = grid[i] || [];
    const fields = new Set(row.map((cell) => HEADER_ALIASES[normalizeHeader(cell)]).filter(Boolean));
    if (fields.has("width") && fields.has("rim")) return i;
  }
  return -1;
}

/** Parses an uploaded workbook buffer into {width,aspect,rim} sizes. */
export function parseOeTireSizeWorkbook(buffer) {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const grid = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true, blankrows: false });

  const headerRowIndex = findHeaderRow(grid);
  if (headerRowIndex === -1) {
    return { sizes: [], skipped: grid.length, total: grid.length };
  }

  const headerRow = grid[headerRowIndex];
  const columnFields = headerRow.map((cell) => HEADER_ALIASES[normalizeHeader(cell)] || null);
  const dataRows = grid.slice(headerRowIndex + 1);

  let skipped = 0;
  const sizes = [];
  for (const row of dataRows) {
    const mapped = {};
    columnFields.forEach((field, colIndex) => {
      if (!field) return;
      mapped[field] = row[colIndex];
    });
    const width = Number(mapped.width);
    const aspect = Number(mapped.aspect);
    const rim = Number(mapped.rim);
    if (!width || !aspect || !rim) {
      skipped++;
      continue;
    }
    sizes.push({ width, aspect, rim });
  }

  return { sizes, skipped, total: dataRows.length };
}

/**
 * Uploads a Width/Aspect/Rim workbook into oe_tiresize — insert-only, so a
 * size already on file (from this upload, an earlier one, or any other
 * source) is left exactly as it is rather than overwritten; only genuinely
 * new sizes are appended. Returns { inserted, duplicates, skipped, total }.
 */
export async function importOeTireSizeWorkbook(buffer, { fileName } = {}) {
  const { sizes, skipped, total } = parseOeTireSizeWorkbook(buffer);
  const result = await upsertManyOeTireSizes(sizes, "manual-upload", {
    sourceRefFor: fileName ? () => fileName : undefined,
  });
  logToFile(
    `[OeTireSizeExcel] Upload: ${result.inserted} inserted, ${result.duplicates} already-on-file, ${skipped} unparseable, ${total} rows total` +
      (fileName ? ` (${fileName})` : "")
  );
  return { inserted: result.inserted, duplicates: result.duplicates, skipped, total };
}

const DOWNLOAD_COLUMNS = [
  "Width",
  "Aspect",
  "Rim",
  "Overall Height (in)",
  "Tread Width (in)",
  "Height Lower Limit (in)",
  "Height Upper Limit (in)",
  "Tread Lower Limit (in)",
  "Tread Upper Limit (in)",
  "Source",
];

/** Builds an .xlsx workbook buffer of the current oe_tiresize collection for download. */
export function buildOeTireSizeWorkbook(rows) {
  const sheetRows = rows.map((r) => ({
    Width: r.width,
    Aspect: r.aspect,
    Rim: r.rim,
    "Overall Height (in)": r.overallHeightIn,
    "Tread Width (in)": r.treadWidthIn,
    "Height Lower Limit (in)": r.heightLowerLimitIn,
    "Height Upper Limit (in)": r.heightUpperLimitIn,
    "Tread Lower Limit (in)": r.treadLowerLimitIn,
    "Tread Upper Limit (in)": r.treadUpperLimitIn,
    Source: r.source,
  }));
  const sheet = xlsx.utils.json_to_sheet(sheetRows, { header: DOWNLOAD_COLUMNS });
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, sheet, "oe_tiresize");
  return xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
}

/** Fetches every oe_tiresize row (sorted for a stable, readable export). */
export async function fetchAllOeTireSizesForExport() {
  return OeTireSize.find().sort({ rim: 1, width: 1, aspect: 1 }).lean();
}
