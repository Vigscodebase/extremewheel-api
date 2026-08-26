import mongoose from "mongoose";

const { Schema, model } = mongoose;

// Predefined values for the Vehicle Notes "Year" dropdown. Kept as its own
// flat list rather than a field on VehicleLookup because the source
// spreadsheet (vehicle_notes_database.xlsx) has no year column tied to
// specific make/model rows — if a "year" column is ever added to that sheet,
// the importer collects its distinct values in here (see
// utils/vehicleLookupImporter.js). It also grows whenever someone types a
// new year into the Vehicle Notes "Add / Edit vehicle" form (see
// POST /vehicle-lookup/quick-add-year) so the dropdown builds itself up from
// real usage even if the spreadsheet never gets a year column at all.
const vehicleLookupYearSchema = new Schema(
  {
    year: { type: String, trim: true, required: true, unique: true, index: true },
  },
  { timestamps: true }
);

export default model("VehicleLookupYear", vehicleLookupYearSchema);
