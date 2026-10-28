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
    // The customer this preset is for (optional). Points at the shared
    // Customer collection — the same customers Vehicle Notes uses, managed
    // through the one /customers API. Only the link lives on the preset, so it
    // is saved with the tire option data; the customer's own details live in
    // the Customer collection. Populated on reads (staff/admin only).
    customer: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      index: true,
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