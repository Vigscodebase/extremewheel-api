import mongoose from "mongoose";

const { Schema, model } = mongoose;

// Consolidated "OE tire size" library used by the Plus Size search. Every
// document is one distinct width/aspect/rim combination with its overall
// height / tread width — and the upper/lower tolerance bounds of each —
// precomputed once at write time (rather than recalculated per search), so
// a search can filter with a plain indexed range query instead of loading
// every row and computing tire math in JS.
//
// Populated from three places, all funneling into this one collection:
//   1. tblTireSizes.xls (nWidth/nProfile/nWheel columns) — see
//      utils/tireSizesImporter.js + workers/tireSizesWorker.js
//   2. tblAppGuide-Templatenew.xls's txtTireSize + F18..F22 columns — see
//      utils/appGuideImporter.js (deriveOeTireSizesFromAppGuideRow)
//   3. The Tire Size Option page (TireOption collection) — both an initial
//      backfill (scripts/backfillOeTireSizeFromTireOptions.js) and an
//      ongoing sync every time a preset is created/updated (server.js)
// ...plus a manual .xlsx upload/download on the Plus Size page itself
// (source "manual-upload").
//
// `width`/`aspect`/`rim` together are the natural key — the same tire size
// showing up from two different sources (e.g. imported from tblTireSizes.xls
// AND saved as a Tire Size Option preset) is one row, not two. Upserts
// always use $setOnInsert so a duplicate is silently ignored rather than
// overwriting whatever's already there (see upsertOeTireSize in
// utils/oeTireSizeService.js).
const oeTireSizeSchema = new Schema(
  {
    width: { type: Number, required: true }, // mm
    aspect: { type: Number, required: true }, // %
    rim: { type: Number, required: true }, // inches

    // Precomputed via utils/tireMath.js#tireToleranceLimits — kept in sync
    // with whatever height/tread tolerance was active at insert time.
    overallHeightIn: { type: Number, required: true },
    treadWidthIn: { type: Number, required: true },
    heightUpperLimitIn: { type: Number, required: true },
    heightLowerLimitIn: { type: Number, required: true },
    treadUpperLimitIn: { type: Number, required: true },
    treadLowerLimitIn: { type: Number, required: true },
    heightTolerancePct: { type: Number }, // fraction, e.g. 0.03
    treadTolerancePct: { type: Number },

    // Where this row came from, for traceability/debugging — never used to
    // gate the search itself (every row is a candidate regardless of source).
    source: {
      type: String,
      enum: ["tblTireSizes", "tblAppGuide", "tire-options", "manual-upload"],
      required: true,
    },
    // Free-form pointer back to the origin record — AppGuide sourceId,
    // TireOption _id, or the uploaded file name. Not indexed/queried on.
    sourceRef: { type: String },
    label: { type: String, trim: true }, // e.g. the TireOption preset name, when source is "tire-options"
  },
  { timestamps: true, collection: "oe_tiresize" }
);

// The natural key + dedup guard described above.
oeTireSizeSchema.index({ width: 1, aspect: 1, rim: 1 }, { unique: true });

// The actual access pattern of a plus-size search: narrow by rim (wheel
// diameter) first, then range-filter by overall height.
oeTireSizeSchema.index({ rim: 1, overallHeightIn: 1 });

export default model("OeTireSize", oeTireSizeSchema);
