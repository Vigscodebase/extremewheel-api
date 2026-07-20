import mongoose from "mongoose";

const { Schema, model } = mongoose;

const vehicleNoteSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      required: true,
      trim: true,
    },
    model: {
      type: String,
      required: true,
      trim: true,
    },
    image: {
      type: String,
      default: "", // URL or base64 data URL — kept for backward compatibility (used as the card thumbnail)
    },
    beforeImage: {
      type: String,
      default: "", // "Before" service/install photo
    },
    afterImage: {
      type: String,
      default: "", // "After" service/install photo
    },
    gallery: {
      type: [String],
      default: [], // Additional reference photos (image gallery)
    },
    offsetNotes: {
      type: String,
      default: "", // Free-text wheel offset / fitment reference notes, surfaced on the Tech Data page
      trim: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

export default model("VehicleNote", vehicleNoteSchema);