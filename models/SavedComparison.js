import mongoose from "mongoose";

const { Schema, model } = mongoose;

// A tire comparison saved from the Tire Size Comparison page's "Save
// comparison" popup. Deliberately its own collection — it is NOT a Vehicle
// Note, so saving a comparison never adds to (or shows up on) the Vehicle
// Notes page. What it shares with Vehicle Notes is only the reference data it
// points at: the Make / Model / Type / Year dropdown lists (stored here as
// plain strings, like VehicleNote does) and the Customer collection
// (`customer` is a ref to the same Customer documents the Vehicle Notes
// customer dropdown reads).
//
// It is a plain comparison, so there is one engine spec and one tyre spec for
// the vehicle — not the Existing / Upgraded pair a Vehicle Note carries.
const tireSchema = new Schema(
  {
    width: { type: Number, required: true },
    aspect: { type: Number, required: true },
    rim: { type: Number, required: true },
  },
  { _id: false }
);

const savedComparisonSchema = new Schema(
  {
    // --- Vehicle details (same fields / meaning as VehicleNote) ---
    name: { type: String, required: true, trim: true },
    make: { type: String, required: true, trim: true, index: true },
    model: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true },
    year: { type: String, trim: true },
    engine: { type: String, default: "", trim: true },
    tyre: {
      width: { type: Number },
      aspect: { type: Number },
      rim: { type: Number },
    },
    gallery: { type: [String], default: [] }, // base64 data URLs, like VehicleNote.gallery

    // The customer this comparison was saved for (optional). Same Customer
    // documents as Vehicle Notes; populated on reads for staff / admin only.
    customer: { type: Schema.Types.ObjectId, ref: "Customer", index: true },

    // --- The comparison itself ---
    comparison: {
      tireA: { type: tireSchema, required: true },
      tireB: { type: tireSchema, required: true },
      diffPct: { type: Number },
      summary: { type: String, trim: true }, // e.g. "225/65R17 vs 265/70R17"
    },

    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

savedComparisonSchema.index({ createdAt: -1 });

export default model("SavedComparison", savedComparisonSchema);
