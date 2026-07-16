import xlsx from "xlsx";
import AppGuide from "../models/AppGuide.js";
import { invalidatePrefix } from "../config/redis.js";
import logToFile from "../logger.js";

const BATCH_SIZE = 1000;

// Maps the exact source column headers (tblAppGuide-Templatenew.xls, Sheet1)
// to AppGuide schema fields. Keeping this explicit (rather than
// lower-casing/guessing headers) means a re-exported sheet with reordered
// columns still imports correctly as long as the header text matches.
const COLUMN_MAP = {
  ID: "sourceId",
  txtTireSize: "txtTireSize",
  txtOptTireSize: "txtOptTireSize",
  Stagfront: "stagFront",
  Stagrear: "stagRear",
  txtMake: "txtMake",
  txtModel: "txtModel",
  txtType: "txtType",
  txtOption: "txtOption",
  txtYear: "txtYear",
  txtBolt: "txtBolt",
  txtLug: "txtLug",
  txtHub: "txtHub",
  txtOffset: "txtOffset",
  Minoffset: "minOffset",
  Maxoffset: "maxOffset",
  Minoffsetrear: "minOffsetRear",
  Maxoffsetrear: "maxOffsetRear",
  stag1front: "stag1Front",
  stag1rear: "stag1Rear",
  stag2front: "stag2Front",
  stag2rear: "stag2Rear",
  stag3front: "stag3Front",
  stag3rear: "stag3Rear",
  stag4front: "stag4Front",
  stag4rear: "stag4Rear",
  wheel_code: "wheelCode",
  makeid: "makeId",
  modelid: "modelId",
  yearid: "yearId",
  submodelid: "submodelId",
  "big brake": "bigBrake",
  Optionid: "optionId",
  "load tire size": "loadTireSize",
  "speed tire size": "speedTireSize",
  "load opt tire size": "loadOptTireSize",
  "speed opt tire size": "speedOptTireSize",
  "load stag front": "loadStagFront",
  "speed stag front": "speedStagFront",
  "load stag rear": "loadStagRear",
  "speed stag rear": "speedStagRear",
};

// F17..F30 columns are per-wheel-diameter "does this fitment work on a 17in
// wheel?" flags — collapsed into a single fitsByDiameter map.
const DIAMETER_COLUMNS = Array.from({ length: 14 }, (_, i) => `F${17 + i}`);

function rowToDoc(row) {
  const doc = {};
  for (const [col, field] of Object.entries(COLUMN_MAP)) {
    if (row[col] === undefined || row[col] === null || row[col] === "") continue;
    doc[field] = typeof row[col] === "string" ? row[col].trim() : row[col];
  }

  const fitsByDiameter = {};
  let hasAny = false;
  for (const col of DIAMETER_COLUMNS) {
    if (row[col] !== undefined && row[col] !== null && row[col] !== "") {
      fitsByDiameter[col.slice(1)] = Boolean(Number(row[col]) || row[col] === true);
      hasAny = true;
    }
  }
  if (hasAny) doc.fitsByDiameter = fitsByDiameter;

  return doc;
}

/**
 * Streams a workbook into the AppGuide collection using batched upserts
 * (keyed on the source row ID, so re-running an import is idempotent).
 * @param {string} filePath
 * @param {(progress: {processed: number, total: number}) => void} [onProgress]
 */
export async function importAppGuideFile(filePath, onProgress) {
  const workbook = xlsx.readFile(filePath, { cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });

  const total = rows.length;
  let processed = 0;
  let batch = [];

  for (const row of rows) {
    const doc = rowToDoc(row);
    if (!doc.sourceId) continue; // skip malformed/blank rows

    batch.push({
      updateOne: {
        filter: { sourceId: doc.sourceId },
        update: { $set: doc },
        upsert: true,
      },
    });

    if (batch.length >= BATCH_SIZE) {
      await AppGuide.bulkWrite(batch, { ordered: false });
      processed += batch.length;
      batch = [];
      onProgress?.({ processed, total });
      logToFile(`[AppGuideImport] ${processed}/${total} rows upserted`);
    }
  }

  if (batch.length) {
    await AppGuide.bulkWrite(batch, { ordered: false });
    processed += batch.length;
    onProgress?.({ processed, total });
  }

  // Cascading dropdown + tech-data reads are cached; a re-import means the
  // cache is stale.
  await invalidatePrefix("app-guide:");

  logToFile(`[AppGuideImport] ✅ Completed: ${processed}/${total} rows upserted from ${filePath}`);
  return { processed, total };
}

export default importAppGuideFile;
