import mongoose from "mongoose";

const { Schema, model } = mongoose;

// Master Make/Model/Type reference data, sourced from the client-provided
// "vehicle notes database.xlsx" (Sheet1 columns: make, model, notes,
// category — "notes", "Edit" and "Delete" are UI-only leftovers from the
// source spreadsheet and are intentionally never imported).
//
// Powers the predefined dropdowns on the Vehicle Notes "Add / Edit vehicle"
// form (Make -> Model -> Type, cascading) so entries stay consistent with a
// single source of truth. Kept up to date the same way the Application
// Guide "Tech Data" sheet is: download the current table, edit it, and
// re-upload from the Vehicle Notes page (see /vehicle-lookup/export and
// /vehicle-lookup/import).
const vehicleLookupSchema = new Schema(
  {
    make: { type: String, trim: true, required: true, index: true },
    model: { type: String, trim: true, required: true, index: true },
    // Mirrors the source sheet's "category" column (CARS / TRUCKS-SUV /
    // VAN-MINI VAN, ...) — this is exactly what the Vehicle Notes form's
    // "Type" dropdown draws from.
    type: { type: String, trim: true, required: true, index: true },
  },
  { timestamps: true }
);

// A given (make, model) is almost always exactly one category in the source
// data — but not guaranteed (e.g. a model sold as both a car and an SUV
// trim), so this is a compound uniqueness key rather than make+model alone.
vehicleLookupSchema.index({ make: 1, model: 1, type: 1 }, { unique: true });

export default model("VehicleLookup", vehicleLookupSchema);
