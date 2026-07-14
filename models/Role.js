import mongoose from "mongoose";

const { Schema, model } = mongoose;

const roleSchema = new Schema(
    {
        role_key: {
            type: String,
            required: true,
            unique: true
        },
        role_name: {
            type: String,
            required: true
        },
        is_system: {
            type: Boolean,
            default: false
        }
    },
    { timestamps: true }
);

const Role = model("Role", roleSchema);

export default Role;