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

// F17..F30 columns hold the upgrade tire size available at each wheel
// diameter — NOT sequential 17"-30" flags and NOT booleans. Per the client:
// "F17 is for 15 inch tires", so column FN maps to diameter (N-2) inches,
// i.e. F17=15", F18=16", F19=17", ... F30=28". Each cell is the actual
// upgrade tire-size string for that diameter (e.g. "225 45 17"), blank when
// that diameter isn't offered as an upgrade for the row's base fitment.
const DIAMETER_COLUMNS = Array.from({ length: 14 }, (_, i) => ({
  col: `F${17 + i}`,
  diameter: String(15 + i),
}));

function rowToDoc(row) {
  const doc = {};
  for (const [col, field] of Object.entries(COLUMN_MAP)) {
    if (row[col] === undefined || row[col] === null || row[col] === "") continue;
    doc[field] = typeof row[col] === "string" ? row[col].trim() : row[col];
  }

  const upgradeSizeByDiameter = {};
  let hasAny = false;
  for (const { col, diameter } of DIAMETER_COLUMNS) {
    const raw = row[col];
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      upgradeSizeByDiameter[diameter] = String(raw).trim();
      hasAny = true;
    }
  }
  if (hasAny) doc.upgradeSizeByDiameter = upgradeSizeByDiameter;

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
