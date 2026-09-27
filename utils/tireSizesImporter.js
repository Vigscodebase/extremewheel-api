import xlsx from "xlsx";
import { upsertManyOeTireSizes } from "./oeTireSizeService.js";
import logToFile from "../logger.js";

// tblTireSizes.xls (sheet "tblTireSizes") has a merged group-label row
// ("Width | aspect | Rim") in row 1, with the real column headers one row
// below it: ID, nWidth, nProfile, nWheel, min width, max width, brand,
// date checked. `range: 1` (0-based) skips that first row so sheet_to_json
// reads row 2 as the header instead of the group-label row.
const HEADER_ROW_INDEX = 1;

const BATCH_SIZE = 1000;

/**
 * Streams tblTireSizes.xls into the oe_tiresize collection (source
 * "tblTireSizes"). Insert-only — a width/aspect/rim already in oe_tiresize
 * (from this file or any other source) is left untouched, never overwritten.
 * @param {string} filePath
 * @param {(progress: {processed: number, total: number}) => void} [onProgress]
 */
export async function importTireSizesFile(filePath, onProgress) {
  const workbook = xlsx.readFile(filePath, { cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { range: HEADER_ROW_INDEX, defval: null });

  const total = rows.length;
  const sizes = [];
  const sourceRefById = new Map();

  for (const row of rows) {
    const width = Number(row.nWidth);
    const aspect = Number(row.nProfile);
    const rim = Number(row.nWheel);
    if (!width || !aspect || !rim) continue;
    const size = { width, aspect, rim };
    sizes.push(size);
    if (row.ID !== undefined && row.ID !== null) {
      sourceRefById.set(`${width}|${aspect}|${rim}`, String(row.ID));
    }
  }

  let processed = 0;
  let inserted = 0;
  let duplicates = 0;
  const sourceRefFor = (s) => sourceRefById.get(`${s.width}|${s.aspect}|${s.rim}`);

  for (let i = 0; i < sizes.length; i += BATCH_SIZE) {
    const chunk = sizes.slice(i, i + BATCH_SIZE);
    const result = await upsertManyOeTireSizes(chunk, "tblTireSizes", { sourceRefFor });
    inserted += result.inserted;
    duplicates += result.duplicates;
    processed += chunk.length;
    onProgress?.({ processed, total });
    logToFile(`[TireSizesImport] ${processed}/${total} rows processed`);
  }

  logToFile(
    `[TireSizesImport] ✅ Completed: ${inserted}/${total} rows inserted (${duplicates} duplicate/skipped) from ${filePath}`
  );
  return { processed: total, total, inserted, duplicates };
}

export default importTireSizesFile;
