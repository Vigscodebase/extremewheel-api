import mongoose from "mongoose";
import { searchTokensPlugin, tireSizeWords } from "../utils/searchTokens.js";

const { Schema, model } = mongoose;

const tireOptionSchema = new Schema(
  {
    label: {
      type: String,
      required: true,
      trim: true,
    },
    width: {
      type: Number,
      required: true,
    },
    aspect: {
      type: Number,
      required: true,
    },
    rim: {
      type: Number,
      required: true,
    },
    // The customer this preset is for (optional). Points at the shared
    // Customer collection — the same customers Vehicle Notes uses, managed
    // through the one /customers API. Only the link lives on the preset, so it
    // is saved with the tire option data; the customer's own details live in
    // the Customer collection. Populated on reads (staff/admin only).
    customer: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

// --- Search & pagination indexes -------------------------------------------
// autoIndex is off (config/db.js), so these are created with
// scripts/search-indexes.mongosh.js. Names must match that script.
//
// Type-ahead: hidden multikey array of word prefixes (see utils/searchTokens.js).
// The preset name plus its size, so "225/65", "65r17" or "toy" all find it.
tireOptionSchema.plugin(searchTokensPlugin, {
  watch: ["label", "width", "aspect", "rim"],
  fields: (get) => [get("label"), tireSizeWords(get("width"), get("aspect"), get("rim"))],
});

tireOptionSchema.index({ createdAt: -1, _id: -1 }, { name: "to_created_idx" });
tireOptionSchema.index({ customer: 1, createdAt: -1, _id: -1 }, { name: "to_customer_created_idx" });
tireOptionSchema.index({ searchTokens: 1, createdAt: -1, _id: -1 }, { name: "to_search_tokens_idx" });
tireOptionSchema.index({ label: "text" }, { name: "to_text_idx", default_language: "english" });

export default model("TireOption", tireOptionSchema);