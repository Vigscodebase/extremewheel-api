// models/Permission.js
import mongoose from "mongoose";

const permissionSchema = new mongoose.Schema({
  key: {
    type: String,
    default: "global",
    unique: true,
  },
  // The Map type allows dynamic string keys. 
  // It will store data like: { "admin": ["dashboard"], "new_role": ["users"] }
  matrix: {
    type: Map,
    of: [String],
    default: {}
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
});

export default mongoose.model("Permission", permissionSchema);