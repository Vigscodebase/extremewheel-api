import mongoose from "mongoose";
import { searchTokensPlugin } from "../utils/searchTokens.js";

const { Schema, model } = mongoose;

// The only values `modification` accepts (also used by the list filter).
export const MODIFICATION_OPTIONS = ["lifted", "lowered", "stock"];

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
    // HIDDEN: "Type" (vehicle category) is no longer shown in the filter, the
    // search or the Add / Edit form, but the field and its existing data are
    // kept. Not required any more because the form no longer asks for it.
    type: {
      type: String,
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
    // Sub-model / trim (BASE, PREMIUM, TYPE-S ...). Same meaning as txtType /
    // submodelid in tblAppGuide-Templatenew.xlsx.
    submodel: {
      type: String,
      default: "",
      trim: true,
    },
    // Fitment, mirroring the staggered front / rear columns of the same sheet
    // (Stagfront / Stagrear and Minoffset... / Minoffsetrear...).
    // Tire sizes are stored in the sheet's own format: "205 55 16".
    frontTireSize: { type: String, default: "", trim: true },
    rearTireSize: { type: String, default: "", trim: true },
    // Wheel offset (ET) in millimetres; negative values are normal on lifted trucks.
    frontWheelOffset: { type: Number, min: -200, max: 200 },
    rearWheelOffset: { type: Number, min: -200, max: 200 },
    // Predefined checkbox choices. Stored lower-case; the UI shows the labels.
    modification: {
      type: [{ type: String, enum: MODIFICATION_OPTIONS }],
      default: [],
    },
    // Free-text description shown (4-line excerpt) on the list card.
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },
    // When the description was last changed. Empty until it is edited; the
    // card then shows "Created <date>" (createdAt) instead.
    descriptionUpdatedAt: { type: Date },
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
// "type" is deliberately NOT searchable any more (hidden field); submodel and
// modification (Lifted / Lowered / Stock) are. The description is left out of
// the tokens on purpose (hundreds of words would bloat the index) — it is
// covered by the text index below, which is the whole-word fallback.
vehicleNoteSchema.plugin(searchTokensPlugin, {
  watch: ["name", "make", "model", "submodel", "year", "modification"],
  fields: (get) => [get("name"), get("make"), get("model"), get("submodel"), get("year"), get("modification")],
});

// Default list order + cursor seek.
vehicleNoteSchema.index({ createdAt: -1, _id: -1 }, { name: "vn_created_idx" });
// Make -> Model -> Type filters (and each prefix of that chain), newest first.
vehicleNoteSchema.index({ make: 1, model: 1, type: 1, createdAt: -1, _id: -1 }, { name: "vn_make_model_type_created_idx" });
// Year-range filter.
vehicleNoteSchema.index({ year: 1, createdAt: -1, _id: -1 }, { name: "vn_year_created_idx" });
// Customer filter / customer-name search.
vehicleNoteSchema.index({ customer: 1, createdAt: -1, _id: -1 }, { name: "vn_customer_created_idx" });
// Modification (Lifted / Lowered / Stock) checkbox filter — multikey.
vehicleNoteSchema.index({ modification: 1, createdAt: -1, _id: -1 }, { name: "vn_modification_created_idx" });
// Multikey type-ahead search.
vehicleNoteSchema.index({ searchTokens: 1, createdAt: -1, _id: -1 }, { name: "vn_search_tokens_idx" });
// MongoDB text index: whole-word / stemmed fallback when no prefix matches.
vehicleNoteSchema.index(
  { name: "text", make: "text", model: "text", submodel: "text", year: "text", modification: "text", description: "text" },
  {
    name: "vn_text_idx",
    weights: { name: 10, make: 5, model: 5, submodel: 3, modification: 3, description: 2, year: 1 },
    default_language: "english",
  }
);

export default model("VehicleNote", vehicleNoteSchema);