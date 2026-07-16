import mongoose from "mongoose";

const { Schema, model } = mongoose;

// Mirrors the client-provided tblAppGuide-Templatenew.xls workbook (Sheet1).
// Field names keep the source column names (txtYear, txtMake, ...) so the
// import script is a near 1:1 mapping and the sheet can be re-imported by
// anyone without reverse-engineering a renamed schema. Used by:
//   - Tab 3 "Application Guide" cascading Year -> Make -> Model -> Type/Option lookup
//   - Tab 5 "Tech Data" wheel offset chart
const appGuideSchema = new Schema(
  {
    sourceId: { type: Number, index: true, unique: true, sparse: true }, // xlsx column "ID"

    // Cascading dropdown fields (Tab 3)
    txtYear: { type: String, trim: true, index: true },
    txtMake: { type: String, trim: true, index: true },
    txtModel: { type: String, trim: true, index: true },
    txtType: { type: String, trim: true },
    txtOption: { type: String, trim: true },

    // Tire fitment
    txtTireSize: { type: String, trim: true },
    txtOptTireSize: { type: String, trim: true },
    stagFront: { type: String, trim: true },
    stagRear: { type: String, trim: true },
    loadTireSize: { type: String, trim: true },
    speedTireSize: { type: String, trim: true },
    loadOptTireSize: { type: String, trim: true },
    speedOptTireSize: { type: String, trim: true },

    // Staggered fitment options (Tab 5 tech data)
    stag1Front: { type: String, trim: true },
    stag1Rear: { type: String, trim: true },
    stag2Front: { type: String, trim: true },
    stag2Rear: { type: String, trim: true },
    stag3Front: { type: String, trim: true },
    stag3Rear: { type: String, trim: true },
    stag4Front: { type: String, trim: true },
    stag4Rear: { type: String, trim: true },
    loadStagFront: { type: String, trim: true },
    speedStagFront: { type: String, trim: true },
    loadStagRear: { type: String, trim: true },
    speedStagRear: { type: String, trim: true },

    // Wheel/offset data (Tab 5 tech data — wheel offset chart)
    txtBolt: { type: String, trim: true },
    txtLug: { type: String, trim: true },
    txtHub: { type: String, trim: true },
    txtOffset: { type: String, trim: true },
    minOffset: { type: String, trim: true },
    maxOffset: { type: String, trim: true },
    minOffsetRear: { type: String, trim: true },
    maxOffsetRear: { type: String, trim: true },
    wheelCode: { type: String, trim: true },
    bigBrake: { type: String, trim: true },

    // Fitment flags per wheel diameter (F17..F30 in the source sheet)
    fitsByDiameter: {
      type: Map,
      of: Boolean,
      default: undefined,
    },

    // Legacy foreign keys from the source Access/SQL database, kept as-is
    // in case the client's other tools still join on them.
    makeId: { type: Number },
    modelId: { type: Number },
    yearId: { type: Number },
    submodelId: { type: Number },
    optionId: { type: Number },
  },
  { timestamps: true }
);

// Compound index covers the exact cascading-dropdown access pattern used by
// the Application Guide UI (filter by year, then +make, then +model, ...).
appGuideSchema.index({ txtYear: 1, txtMake: 1, txtModel: 1, txtType: 1 });

export default model("AppGuide", appGuideSchema);
