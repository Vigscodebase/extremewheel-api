// One-time backfill: fills the hidden `searchTokens` array (the multikey
// type-ahead index) on rows that already exist.
//
// New and edited rows are handled automatically by the searchTokens plugin
// (utils/searchTokens.js); this only needs to run once after deploying, and
// again if you ever bulk-load rows with insertMany / bulkWrite / mongoimport
// (those bypass the plugin).
//
// Safe to re-run — it simply recomputes the tokens. It streams the collection
// and writes in batches of 500, so it is fine for 100k+ rows.
//
// Usage:  node scripts/backfillSearchTokens.js          (or: npm run backfill:search-tokens)
//         node scripts/backfillSearchTokens.js --force  (also rewrite rows that already have tokens)
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import dotenv from "dotenv";
dotenv.config({ path: path.join(__dirname, "../.env") });

import mongoose from "mongoose";
import connectDB from "../config/db.js";
import { buildTokens, tireSizeWords } from "../utils/searchTokens.js";
import VehicleNote from "../models/VehicleNote.js";
import SavedComparison from "../models/SavedComparison.js";
import TireOption from "../models/TireOption.js";
import Customer from "../models/Customer.js";
import User from "../models/User.js";

const BATCH = 500;
const force = process.argv.includes("--force");

// One entry per searchable collection. `fields` must mirror the plugin config in the model.
const TARGETS = [
  { Model: VehicleNote, project: "name make model type year", fields: (d) => [d.name, d.make, d.model, d.type, d.year] },
  {
    Model: SavedComparison,
    project: "name make model type year comparison",
    fields: (d) => [
      d.name, d.make, d.model, d.type, d.year,
      tireSizeWords(d.comparison?.tireA?.width, d.comparison?.tireA?.aspect, d.comparison?.tireA?.rim),
      tireSizeWords(d.comparison?.tireB?.width, d.comparison?.tireB?.aspect, d.comparison?.tireB?.rim),
    ],
  },
  { Model: TireOption, project: "label width aspect rim", fields: (d) => [d.label, tireSizeWords(d.width, d.aspect, d.rim)] },
  { Model: Customer, project: "fullName", fields: (d) => [d.fullName] },
  { Model: User, project: "name email", fields: (d) => [d.name, d.email] },
];

async function backfill({ Model, project, fields }) {
  const filter = force ? {} : { searchTokens: { $exists: false } };
  let ops = [];
  let done = 0;

  const flush = async () => {
    if (!ops.length) return;
    await Model.bulkWrite(ops, { ordered: false });
    done += ops.length;
    ops = [];
  };

  for await (const doc of Model.find(filter).select(project).lean().cursor()) {
    ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { searchTokens: buildTokens(fields(doc).flat()) } } } });
    if (ops.length >= BATCH) await flush();
  }
  await flush();
  console.log(`  ${Model.modelName}: ${done} row(s) updated`);
}

async function run() {
  await connectDB();
  console.log(force ? "Rebuilding searchTokens on every row…" : "Filling searchTokens on rows that don't have them yet…");
  for (const target of TARGETS) await backfill(target);
  await mongoose.disconnect();
  console.log("Done.");
}

run().catch(async (err) => {
  console.error("Backfill failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
