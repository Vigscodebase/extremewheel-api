// utils/seedAdmin.js
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// 1. Manually resolve the path to the root directory's .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

// 2. Import your internal files AFTER dotenv is configured
import connectDB from "../config/db.js";
import User from "../models/User.js";
import Role from "../models/Role.js";

// Note: logToFile won't work cleanly in a standalone CLI script unless imported properly.
// Replaced with console.log for the seeder.
async function seed() {
  await connectDB();

  // 1. Seed Dynamic Roles using optimized BulkWrite
  const rolesArray = [
    { role_key: "admin", role_name: "Administrator", is_system: true },
    { role_key: "staff", role_name: "Staff", is_system: true },
    { role_key: "guest", role_name: "Guest", is_system: true }
  ];

  await Role.bulkWrite(
    rolesArray.map(role => ({
      updateOne: {
        filter: { role_key: role.role_key },
        update: { $set: role },
        upsert: true
      }
    }))
  );
  console.log("[seed] ✅ System roles verified/seeded.");

  // 2. Seed Master Admin
  const email = "admin@clickmatix.com".toLowerCase();
  const existing = await User.findOne({ email });

  if (existing) {
    console.log(`[seed] ℹ️ ${email} already exists — nothing to do.`);
    process.exit(0);
  }

  await User.create({
    name: "Admin",
    email,
    password: "admin@123",
    role: "admin", // Matches role_key
  });

  console.log(`[seed] ✅ Created admin account ${email}. Sign in and change the password immediately.`);
  process.exit(0);
}

seed().catch((err) => {
  console.error("[seed] ❌ Error:", err);
  process.exit(1);
});