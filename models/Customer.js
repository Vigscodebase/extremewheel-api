import mongoose from "mongoose";

const { Schema, model } = mongoose;

// A customer a vehicle note can be attached to (see VehicleNote.customer).
//
// Email and phone are each unique across all customers. Both are stored in a
// normalised form so that "John@Example.com " and "john@example.com" — or
// "(555) 123-4567" and "555-123-4567" — can't slip in as two different
// customers. The normalisation itself lives in utils/customerFields.js and is
// applied by the routes before anything reaches the database; the unique
// indexes below are the final safety net against races.
const customerSchema = new Schema(
  {
    fullName: {
      type: String,
      required: [true, "Full name is required."],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required."],
      trim: true,
      lowercase: true,
      unique: true,
    },
    phone: {
      type: String,
      required: [true, "Phone is required."],
      trim: true,
      unique: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

// Case-insensitive name lookups / sorting for the dropdown.
customerSchema.index({ fullName: 1 });

export default model("Customer", customerSchema);
