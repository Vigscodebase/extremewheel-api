import mongoose from "mongoose";
import bcrypt from "bcryptjs";

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
  createdAt: {
    type: Date,
    default: Date.now,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
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

const User = mongoose.model("User", userSchema);

export default User;