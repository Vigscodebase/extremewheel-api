import mongoose from "mongoose";

const { Schema, model } = mongoose;

// Predefined values for the Vehicle Notes dropdowns that aren't Make / Model /
// Type / Year: Submodel, Tire size and Wheel offset.
//
// One flat collection keyed by `kind` instead of three near-identical ones.
// Like the Year list, none of these cascade off another field.
//
//   kind "submodel"     -> the Submodel dropdown            e.g. "BASE", "TYPE-S"
//   kind "tire-size"    -> Front AND Rear tire size         e.g. "205 55 16"
//   kind "wheel-offset" -> Front AND Rear wheel offset (mm) e.g. "35", "-12"
//
// Front and rear share one list on purpose: a size or offset that exists for the
// front axle is almost always wanted for the rear one too, so adding it once makes
// it pickable in both. (To split them, add "front-tire-size" etc. to
// VEHICLE_LOOKUP_OPTION_KINDS below and point the client dropdowns at the new kinds.)
//
// Values are stored as strings in their canonical form (see
// normalizeLookupOptionValue in utils/vehicleLookupImporter.js).
export const VEHICLE_LOOKUP_OPTION_KINDS = ["submodel", "tire-size", "wheel-offset"];

const vehicleLookupOptionSchema = new Schema(
  {
    kind: { type: String, enum: VEHICLE_LOOKUP_OPTION_KINDS, required: true },
    value: { type: String, trim: true, required: true },
  },
  { timestamps: true }
);

vehicleLookupOptionSchema.index({ kind: 1, value: 1 }, { unique: true });

export default model("VehicleLookupOption", vehicleLookupOptionSchema);
