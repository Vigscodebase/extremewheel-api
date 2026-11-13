// Fills the Submodel / Tire size / Wheel offset dropdown lists
// (models/VehicleLookupOption.js) with the values that already exist on saved
// vehicle notes.
//
// The API already does this by itself at startup while the lists are completely
// empty, so you normally never need this. Run it by hand to pull in values that
// were saved since (it upserts; nothing is ever removed). Note that a value you
// deliberately deleted from a list comes back if a vehicle note still uses it.
//
// Usage:  node scripts/seedVehicleLookupOptions.js   (or: npm run seed:vehicle-lookup-options)
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import dotenv from "dotenv";
dotenv.config({ path: path.join(__dirname, "../.env") });

import mongoose from "mongoose";
import connectDB from "../config/db.js";
import { seedVehicleLookupOptionsFromNotes } from "../utils/vehicleLookupImporter.js";

async function main() {
  await connectDB();
  const added = await seedVehicleLookupOptionsFromNotes();
  console.log(`Done — ${added} value(s) added.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
