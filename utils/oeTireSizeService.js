import OeTireSize from "../models/OeTireSize.js";
import { tireToleranceLimits, DEFAULT_HEIGHT_TOLERANCE, DEFAULT_TREAD_TOLERANCE } from "./tireMath.js";
import { invalidatePrefix } from "../config/redis.js";
import logToFile from "../logger.js";

// Same tire-size-string shape the client already parses in
// pages/plussizeoptions.jsx and pages/techdata.jsx ("265/70R17", "225 65 17",
// "205 55 16") — kept identical here so a string pulled from txtTireSize/
// F18..F22 parses the same way server-side as it would client-side.
const TIRE_SIZE_STRING_RE = /(\d{3})\s*[/\s]\s*(\d{2,3})\s*R?\s*(\d{2})/i;

export function parseTireSizeString(str) {
  if (!str) return null;
  const match = String(str).match(TIRE_SIZE_STRING_RE);
  if (!match) return null;
  const width = Number(match[1]);
  const aspect = Number(match[2]);
  const rim = Number(match[3]);
  if (!width || !aspect || !rim) return null;
  return { width, aspect, rim };
}

/**
 * Builds a full oe_tiresize document (all six computed fields) for one
 * width/aspect/rim, ready for an insert-only upsert.
 */
export function buildOeTireSizeDoc({ width, aspect, rim }, source, { sourceRef, label, heightTolerance, treadTolerance } = {}) {
  const limits = tireToleranceLimits(
    { width, aspect, rim },
    {
      heightTolerance: heightTolerance ?? DEFAULT_HEIGHT_TOLERANCE,
      treadTolerance: treadTolerance ?? DEFAULT_TREAD_TOLERANCE,
    }
  );
  return {
    width: Number(width),
    aspect: Number(aspect),
    rim: Number(rim),
    overallHeightIn: Number(limits.overallHeightIn.toFixed(4)),
    treadWidthIn: Number(limits.treadWidthIn.toFixed(4)),
    heightUpperLimitIn: Number(limits.heightUpperLimitIn.toFixed(4)),
    heightLowerLimitIn: Number(limits.heightLowerLimitIn.toFixed(4)),
    treadUpperLimitIn: Number(limits.treadUpperLimitIn.toFixed(4)),
    treadLowerLimitIn: Number(limits.treadLowerLimitIn.toFixed(4)),
    heightTolerancePct: heightTolerance ?? DEFAULT_HEIGHT_TOLERANCE,
    treadTolerancePct: treadTolerance ?? DEFAULT_TREAD_TOLERANCE,
    source,
    sourceRef: sourceRef !== undefined && sourceRef !== null ? String(sourceRef) : undefined,
    label: label || undefined,
  };
}

/**
 * Inserts one tire size into oe_tiresize if (width, aspect, rim) isn't
 * already there; a duplicate is silently ignored (never overwritten) — see
 * the unique index + $setOnInsert below. Returns true if a new row was
 * actually inserted, false if it was already present.
 */
export async function upsertOeTireSize(size, source, opts = {}) {
  if (!size?.width || !size?.aspect || !size?.rim) return false;
  const doc = buildOeTireSizeDoc(size, source, opts);
  const result = await OeTireSize.updateOne(
    { width: doc.width, aspect: doc.aspect, rim: doc.rim },
    { $setOnInsert: doc },
    { upsert: true }
  );
  return Boolean(result.upsertedCount || result.upsertedId);
}

/**
 * Batched version of upsertOeTireSize for imports — dedupes within the
 * batch itself first (so a workbook with the same size on multiple rows
 * only issues one upsert for it), then bulk-upserts insert-only.
 * Returns { inserted, duplicates, total }.
 */
export async function upsertManyOeTireSizes(sizes, source, { sourceRefFor, labelFor, batchSize = 1000 } = {}) {
  const seen = new Set();
  const ops = [];
  let withinBatchDuplicates = 0;

  for (const size of sizes) {
    if (!size?.width || !size?.aspect || !size?.rim) continue;
    const key = `${size.width}|${size.aspect}|${size.rim}`;
    if (seen.has(key)) {
      withinBatchDuplicates++;
      continue;
    }
    seen.add(key);
    const doc = buildOeTireSizeDoc(size, source, {
      sourceRef: sourceRefFor?.(size),
      label: labelFor?.(size),
    });
    ops.push({
      updateOne: {
        filter: { width: doc.width, aspect: doc.aspect, rim: doc.rim },
        update: { $setOnInsert: doc },
        upsert: true,
      },
    });
  }

  let inserted = 0;
  for (let i = 0; i < ops.length; i += batchSize) {
    const batch = ops.slice(i, i + batchSize);
    if (!batch.length) continue;
    const result = await OeTireSize.bulkWrite(batch, { ordered: false });
    inserted += result.upsertedCount || 0;
  }

  if (inserted > 0) await invalidatePrefix("oe-tiresize:");

  const total = sizes.length;
  const duplicates = total - inserted - 0; // rows that already existed or repeated within the batch
  logToFile(
    `[OeTireSize] ${source}: ${inserted} inserted, ${total - inserted} skipped (${withinBatchDuplicates} within-file duplicates), ${total} total`
  );
  return { inserted, duplicates: Math.max(duplicates, 0), total };
}
