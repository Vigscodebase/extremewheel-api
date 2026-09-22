import mongoose from "mongoose";

const { Schema, model } = mongoose;

// Makes that exist in the predefined Make dropdown without necessarily having
// any Model/Type rows under them in VehicleLookup.
//
// VehicleLookup can't hold a make on its own (make, model and type are all
// required there), but an admin can add a brand new Make from the Tire Size
// Option preset popup, where there is no Model/Type to pair it with. Those
// makes are stored here so they still show up in the Make dropdown (see
// GET /vehicle-lookup/makes, which merges both collections) and can be
// deleted again from it.
//
// Also used to keep a make alive when the last Model/Type row under it is
// deleted — removing a model must never silently remove its make.
const vehicleLookupMakeSchema = new Schema(
  {
    make: { type: String, trim: true, required: true, unique: true },
  },
  { timestamps: true }
);

export default model("VehicleLookupMake", vehicleLookupMakeSchema);
