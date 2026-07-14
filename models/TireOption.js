import mongoose from "mongoose";

const { Schema, model } = mongoose;

const tireOptionSchema = new Schema(
  {
    label: {
      type: String,
      required: true,
      trim: true,
    },
    width: {
      type: Number,
      required: true,
    },
    aspect: {
      type: Number,
      required: true,
    },
    rim: {
      type: Number,
      required: true,
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

export default model("TireOption", tireOptionSchema);