import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { searchTokensPlugin } from "../utils/searchTokens.js";

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  name: {
    type: String,
    trim: true,
    default: "",
  },
  password: {
    type: String,
    required: true,
    select: false, // never return password hashes by default
  },
  role: {
    type: String,
    enum: ["admin", "staff", "guest"],
    default: "guest",
  },
  // Page + element permissions granted to THIS user (see
  // config/permissionCatalog.js). They belong to the user's email: changing the
  // email resets this to [] (see PUT /users/:id), and new accounts start with
  // none. Admin accounts ignore this list — they always have full access.
  permissions: {
    type: [String],
    default: [],
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  // --- Forgot password ---
  // Only a SHA-256 hash of the reset token is ever stored (never the raw
  // token), so a database leak alone can't be used to reset an account.
  resetPasswordTokenHash: {
    type: String,
    select: false,
  },
  resetPasswordExpires: {
    type: Date,
    select: false,
  },
});

// FIXED: Removed the 'next' parameter and the next() calls
userSchema.pre("save", async function () {
  if (!this.isModified("password")) {
    return; // Simply return to skip hashing
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// --- Search & pagination indexes -------------------------------------------
// (User.createIndexes() runs at startup in server.js, so these are built
// automatically; scripts/search-indexes.mongosh.js creates the same ones.)
userSchema.plugin(searchTokensPlugin, {
  watch: ["name", "email"],
  fields: (get) => [get("name"), get("email")],
});
userSchema.index({ createdAt: -1, _id: -1 }, { name: "us_created_idx" });
userSchema.index({ searchTokens: 1, createdAt: -1, _id: -1 }, { name: "us_search_tokens_idx" });
userSchema.index(
  { name: "text", email: "text" },
  { name: "us_text_idx", weights: { name: 10, email: 5 }, default_language: "english" }
);

const User = mongoose.model("User", userSchema);

export default User;