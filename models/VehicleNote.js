import mongoose from "mongoose";
import { searchTokensPlugin } from "../utils/searchTokens.js";

const { Schema, model } = mongoose;

const vehicleNoteSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Vehicle Notes "Add / Edit vehicle" form field order is:
    // Vehicle Name, Make, Model, Type, Year, Event date.
    // make/model/type are all drawn from the predefined VehicleLookup
    // dropdowns (cascading: make -> model -> type); year is a free-entry
    // vehicle model year, kept distinct from eventDate (the real-world
    // service/install date used elsewhere in the app).
    make: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      trim: true,
    },
    model: {
      type: String,
      required: true,
      trim: true,
    },
    year: {
      type: String,
      trim: true,
    },
    image: {
      type: String,
      default: "", // URL or base64 data URL — kept for backward compatibility (used as the card thumbnail)
    },
    beforeImage: {
      type: String,
      default: "", // "Before" service/install photo
    },
    afterImage: {
      type: String,
      default: "", // "After" service/install photo
    },
    gallery: {
      type: [String],
      default: [], // Additional reference photos (image gallery)
    },
    offsetNotes: {
      type: String,
      default: "", // Free-text wheel offset / fitment reference notes, surfaced on the Tech Data page
      trim: true,
    },
    // "Existing" (before) engine + tyre specification
    existingSpec: {
      engine: { type: String, default: "", trim: true },
      tyre: {
        width: { type: Number },
        aspect: { type: Number },
        rim: { type: Number },
      },
    },
    // "Upgraded" (after) engine + tyre specification
    upgradedSpec: {
      engine: { type: String, default: "", trim: true },
      tyre: {
        width: { type: Number },
        aspect: { type: Number },
        rim: { type: Number },
      },
    },
    // Date tracking — the real-world date the work/entry relates to (service
    // date, install date, inspection date, ...), distinct from createdAt /
    // updatedAt which just track when the *record* was saved.
    eventDate: {
      type: Date,
    },
    // Internal staff notes and comments — part of the "content management"
    // layer for Vehicle Notes. Never shown to guest-level users on the
    // client; staff/admin only. Append-only from the UI (edits create a new
    // entry rather than mutating history), each one time-stamped and
    // attributed to the staff member who wrote it.
    staffNotes: {
      type: [
        {
          text: { type: String, required: true, trim: true },
          authorName: { type: String, trim: true, default: "" },
          author: { type: Schema.Types.ObjectId, ref: "User" },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    // The customer this vehicle belongs to (optional). Populated on reads so
    // the list can show / search / filter by the customer's name.
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
vehicleNoteSchema.plugin(searchTokensPlugin, {
  watch: ["name", "make", "model", "type", "year"],
  fields: (get) => [get("name"), get("make"), get("model"), get("type"), get("year")],
});

// Default list order + cursor seek.
vehicleNoteSchema.index({ createdAt: -1, _id: -1 }, { name: "vn_created_idx" });
// Make -> Model -> Type filters (and each prefix of that chain), newest first.
vehicleNoteSchema.index({ make: 1, model: 1, type: 1, createdAt: -1, _id: -1 }, { name: "vn_make_model_type_created_idx" });
// Year-range filter.
vehicleNoteSchema.index({ year: 1, createdAt: -1, _id: -1 }, { name: "vn_year_created_idx" });
// Customer filter / customer-name search.
vehicleNoteSchema.index({ customer: 1, createdAt: -1, _id: -1 }, { name: "vn_customer_created_idx" });
// Multikey type-ahead search.
vehicleNoteSchema.index({ searchTokens: 1, createdAt: -1, _id: -1 }, { name: "vn_search_tokens_idx" });
// MongoDB text index: whole-word / stemmed fallback when no prefix matches.
vehicleNoteSchema.index(
  { name: "text", make: "text", model: "text", type: "text", year: "text" },
  { name: "vn_text_idx", weights: { name: 10, make: 5, model: 5, type: 3, year: 1 }, default_language: "english" }
);

export default model("VehicleNote", vehicleNoteSchema);