import mongoose from "mongoose";

const { Schema, model } = mongoose;

// Lightweight, append-only activity log. Two kinds are recorded today:
//   - "tire-comparison": a Tire A vs Tire B (or calculator "convert to")
//     comparison the user ran
//   - "vehicle-search": an Application Guide / Tech Data vehicle lookup
// Kept generic (a single `data` blob) so new activity kinds can be added
// later without another migration. Powers:
//   - Dashboard "Recent tire comparisons" / "Recently searched vehicles" blocks
//   - Reporting & Data Export page (date-range counts + CSV export)
const recentActivitySchema = new Schema(
  {
    type: {
      type: String,
      enum: ["tire-comparison", "vehicle-search"],
      required: true,
      index: true,
    },
    data: {
      type: Schema.Types.Mixed,
      default: {},
    },
    summary: {
      type: String, // pre-rendered human readable label, e.g. "225/65R17 vs 265/70R17"
      trim: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

recentActivitySchema.index({ type: 1, createdAt: -1 });

export default model("RecentActivity", recentActivitySchema);
