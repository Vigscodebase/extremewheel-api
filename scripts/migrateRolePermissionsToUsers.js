// One-time migration: run once after deploying per-user (per-email) permissions.
//
// WHY THIS IS NEEDED
// -------------------
// Access used to be controlled by a role-based matrix stored in the
// `permissions` collection ({ staff: [pages…], guest: [pages…] }), plus a handful
// of hard-coded role checks on individual buttons. Access is now stored on each
// User document (`permissions: [String]`), keyed by that user's unique email,
// and the matrix is no longer read at all. A fresh deploy would therefore leave
// every non-admin account with NO access until an admin re-grants everything.
//
// This script gives each existing non-admin user exactly what their role could
// do before, so nothing is lost or newly granted on rollout:
//   - the pages their role's old matrix listed
//   - the element permissions that used to follow from their role:
//       dashboard tiles        every tile, except "Total users" / "Users by role"
//                              (were admin-only) and "Quick access" (staff only)
//       save comparison        everyone with Tire Size Comparison
//       plus-size download     everyone with Plus Size Options
//       plus-size upload       staff only
//       tech-data CSV tab      everyone except guests
//       vehicle add/edit/del   everyone with Vehicle Notes
//       vehicle database       staff only (card + download + upload)
//       reports download       everyone with Reporting
//   Admin accounts are skipped — they always have full access.
//
// After this, an admin can fine-tune each user in User Management → Permissions.
//
// SAFE TO RE-RUN: users who already have permissions are left alone (unless
// --force). The old `permissions` collection is NOT dropped — once you're happy
// with the result you can remove it by hand (db.permissions.drop()).
//
// Usage:
//   node scripts/migrateRolePermissionsToUsers.js --dry-run   # show what would change
//   node scripts/migrateRolePermissionsToUsers.js             # apply
//   node scripts/migrateRolePermissionsToUsers.js --force     # also overwrite users who already have permissions
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import dotenv from "dotenv";
dotenv.config({ path: path.join(__dirname, "../.env") });

import mongoose from "mongoose";
import connectDB from "../config/db.js";
import User from "../models/User.js";
import { sanitizePermissions } from "../config/permissionCatalog.js";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

// What the old code seeded when no matrix had been saved yet. Used only if the
// `permissions` collection has no document.
const LEGACY_DEFAULT_MATRIX = {
  staff: [
    "dashboard",
    "tire-calculator",
    "tire-comparison",
    "tire-options",
    "plus-size",
    "application-guide",
    "tech-data",
    "vehicle-notes",
    "reports",
  ],
  guest: ["dashboard", "tire-calculator", "tire-comparison"],
};

const ALL_TILES = [
  "vehicle-notes",
  "tire-presets",
  "tire-showroom",
  "recent-vehicles",
  "recent-comparisons",
  "recent-vehicle-searches",
  "recent-plus-size",
  "reports",
];

// The element permissions a user with `role` and these pages used to have.
export function legacyPermissionsFor(role, pages) {
  const has = (page) => pages.includes(page);
  const isStaff = role === "staff";
  const grants = [...pages];

  if (has("dashboard")) {
    grants.push(...ALL_TILES.map((t) => `dashboard.tile.${t}`));
    if (isStaff) grants.push("dashboard.tile.quick-access");
  }
  if (has("tire-comparison")) grants.push("tire-comparison.save");
  if (has("plus-size")) {
    grants.push("plus-size.download");
    if (isStaff) grants.push("plus-size.upload");
  }
  if (has("tech-data") && role !== "guest") grants.push("tech-data.csv-tab");
  if (has("vehicle-notes")) {
    grants.push("vehicle-notes.add", "vehicle-notes.edit", "vehicle-notes.delete");
    if (isStaff) {
      grants.push(
        "vehicle-notes.database",
        "vehicle-notes.database.download",
        "vehicle-notes.database.upload"
      );
    }
  }
  if (has("reports")) grants.push("reports.download");

  return sanitizePermissions(grants);
}

async function run() {
  await connectDB();
  console.log(`[migrate-permissions] Connected.${DRY_RUN ? " (dry run — nothing will be written)" : ""}`);

  // The Permission model no longer exists, so read the old document straight
  // from the collection.
  const legacyDoc = await mongoose.connection.db.collection("permissions").findOne({ key: "global" });
  const matrix = legacyDoc?.matrix || LEGACY_DEFAULT_MATRIX;
  console.log(
    legacyDoc
      ? "[migrate-permissions] Using the role matrix saved in the database."
      : "[migrate-permissions] No saved role matrix found — using the old built-in defaults."
  );

  const users = await User.find({ role: { $ne: "admin" } }).select("email role permissions");
  let migrated = 0;
  let skipped = 0;

  for (const user of users) {
    if (!FORCE && (user.permissions || []).length > 0) {
      skipped++;
      console.log(`  skip      ${user.email} (${user.role}) — already has ${user.permissions.length} permission(s)`);
      continue;
    }

    const pages = Array.isArray(matrix[user.role]) ? matrix[user.role] : [];
    const next = legacyPermissionsFor(user.role, pages);

    console.log(`  ${DRY_RUN ? "would set" : "set      "} ${user.email} (${user.role}) → ${next.length} permission(s)`);
    if (!DRY_RUN) {
      await User.updateOne({ _id: user._id }, { $set: { permissions: next } });
    }
    migrated++;
  }

  console.log(
    `[migrate-permissions] Done. ${migrated} user(s) ${DRY_RUN ? "would be " : ""}migrated, ${skipped} skipped.`
  );
  await mongoose.disconnect();
  process.exit(0);
}

// Only run when executed directly, so the mapping above can be imported in tests.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  run().catch((err) => {
    console.error("[migrate-permissions] ❌ Error:", err);
    process.exit(1);
  });
}
