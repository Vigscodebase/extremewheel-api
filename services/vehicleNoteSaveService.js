// The actual "write a vehicle note to MongoDB" logic, shared by
//  - the BullMQ worker (normal path), and
//  - the route handlers' inline fallback (when Redis is unavailable),
// so both produce exactly the same result.
import crypto from "crypto";
import VehicleNote from "../models/VehicleNote.js";
import { externalizeVehicleImages } from "../utils/vehicleImageStore.js";

export class SaveError extends Error {
    constructor(status, message) {
        super(message);
        this.name = "SaveError";
        this.status = status;
        // middleware/errorHandler.js only shows err.message when this is set —
        // otherwise an inline-fallback "Vehicle not found." would turn into
        // the generic "Something went wrong".
        this.expose = true;
    }
}

/**
 * The browser tags every save with a random `clientRef`. It's how the page
 * matches a WebSocket message to the save it started, and it makes a create
 * idempotent: the same person sending the same clientRef twice (double click,
 * network retry) always maps to the same vehicle _id, so only one vehicle exists.
 */
export function cleanClientRef(raw) {
    return typeof raw === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : "";
}

export function vehicleIdFromClientRef(userId, clientRef) {
    // 24 hex chars = a valid ObjectId. Derived from user + ref so one person
    // can never collide with another person's (or an existing) vehicle id.
    return crypto.createHash("sha256").update(`${userId}:${clientRef}`).digest("hex").slice(0, 24);
}

// Normalizes the existing/upgraded engine + tyre spec payload so partial
// input (e.g. engine only, no tyre numbers yet) never crashes the write.
export function normalizeSpec(spec) {
    if (!spec || typeof spec !== "object") return undefined;
    const tyre = spec.tyre && typeof spec.tyre === "object" ? spec.tyre : {};
    return {
        engine: typeof spec.engine === "string" ? spec.engine : "",
        tyre: {
            width: tyre.width !== undefined && tyre.width !== "" ? Number(tyre.width) : undefined,
            aspect: tyre.aspect !== undefined && tyre.aspect !== "" ? Number(tyre.aspect) : undefined,
            rim: tyre.rim !== undefined && tyre.rim !== "" ? Number(tyre.rim) : undefined,
        },
    };
}

/**
 * Whitelist the fields a save may carry. Used by the route before enqueueing so
 * the job (which sits in Redis) never contains anything unexpected.
 */
export function pickVehicleInput(body) {
    const {
        name, make, type, model, year, image, beforeImage, afterImage, gallery,
        offsetNotes, existingSpec, upgradedSpec, eventDate, staffNotes,
    } = body || {};
    return {
        name, make, type, model, year, image, beforeImage, afterImage, gallery,
        offsetNotes, existingSpec, upgradedSpec, eventDate, staffNotes,
    };
}

/** Only what the Redis job / WebSocket needs to know about the person saving. */
export function pickUser(user) {
    return { _id: String(user._id), name: user.name, email: user.email, role: user.role };
}

/**
 * @param {object} job
 * @param {"create"|"update"} job.kind
 * @param {string} job.vehicleId   pre-generated _id for create (makes retries idempotent), target _id for update
 * @param {object} job.input       output of pickVehicleInput()
 * @param {object} job.customerField  { skip } | { clear } | { id }  (already resolved + authorised by the route)
 * @param {object} job.user        output of pickUser()
 * @returns the saved Mongoose document (not populated)
 */
export async function saveVehicleNote({ kind, vehicleId, input: rawInput, customerField = { skip: true }, user }) {
    if (kind === "create") {
        // A retried job (worker crashed after the insert, before reporting back)
        // must not create a second vehicle: the _id was fixed when it was queued.
        const already = await VehicleNote.findById(vehicleId);
        if (already) return already;
    }

    // Photos arrive as base64; store them as files and keep only their URLs in
    // MongoDB (utils/vehicleImageStore.js).
    const input = await externalizeVehicleImages(rawInput);

    if (kind === "create") {
        const { staffNotes, gallery, eventDate, existingSpec, upgradedSpec, ...rest } = input;
        const mappedNotes = Array.isArray(staffNotes)
            ? staffNotes.map((n) => ({
                text: n.text,
                authorName: n.authorName || user.name || user.email,
                author: user._id,
                createdAt: n.createdAt ? new Date(n.createdAt) : new Date(),
            }))
            : [];

        return VehicleNote.create({
            _id: vehicleId,
            name: rest.name,
            make: rest.make,
            type: rest.type,
            model: rest.model,
            year: rest.year,
            image: rest.image,
            beforeImage: rest.beforeImage,
            afterImage: rest.afterImage,
            gallery: Array.isArray(gallery) ? gallery : [],
            offsetNotes: rest.offsetNotes,
            staffNotes: mappedNotes,
            existingSpec: normalizeSpec(existingSpec),
            upgradedSpec: normalizeSpec(upgradedSpec),
            eventDate: eventDate ? new Date(eventDate) : undefined,
            ...(customerField.id && { customer: customerField.id }),
            createdBy: user._id,
        });
    }

    if (kind === "update") {
        const { name, make, type, model, year, image, beforeImage, afterImage, gallery, offsetNotes, existingSpec, upgradedSpec, eventDate } = input;
        const vehicle = await VehicleNote.findByIdAndUpdate(
            vehicleId,
            {
                ...(customerField.id && { customer: customerField.id }),
                ...(name && { name }),
                ...(make && { make }),
                ...(type && { type }),
                ...(model && { model }),
                ...(year !== undefined && { year }),
                ...(image !== undefined && { image }),
                ...(beforeImage !== undefined && { beforeImage }),
                ...(afterImage !== undefined && { afterImage }),
                ...(Array.isArray(gallery) && { gallery }),
                ...(offsetNotes !== undefined && { offsetNotes }),
                ...(existingSpec !== undefined && { existingSpec: normalizeSpec(existingSpec) }),
                ...(upgradedSpec !== undefined && { upgradedSpec: normalizeSpec(upgradedSpec) }),
                ...(eventDate !== undefined && { eventDate: eventDate ? new Date(eventDate) : null }),
                ...(customerField.clear && { $unset: { customer: 1 } }),
            },
            { new: true }
        );
        if (!vehicle) throw new SaveError(404, "Vehicle not found.");
        return vehicle;
    }

    throw new SaveError(400, `Unknown save kind "${kind}".`);
}

/** A small, photo-free description of a saved vehicle — safe to push over WebSocket. */
export function summarizeVehicle(doc) {
    const v = typeof doc.toObject === "function" ? doc.toObject() : doc;
    return {
        _id: String(v._id),
        name: v.name,
        make: v.make,
        model: v.model,
        type: v.type,
        year: v.year,
    };
}

/**
 * Turn any error thrown while saving into a message that is safe to show the
 * person (mirrors middleware/errorHandler.js) and say whether retrying could help.
 */
export function describeSaveError(err) {
    if (err instanceof SaveError) return { message: err.message, retriable: false };
    if (err?.name === "ValidationError") {
        return { message: Object.values(err.errors || {})[0]?.message || "Invalid data.", retriable: false };
    }
    if (err?.code === 11000) return { message: "That value is already in use.", retriable: false };
    if (err?.name === "CastError") return { message: "Invalid identifier.", retriable: false };
    if (
        err?.name === "BSONObjectTooLargeError" ||
        err?.code === 10334 ||
        /exceeds maximum|BSONObj size/i.test(err?.message || "")
    ) {
        return {
            message: "The photos on this vehicle are too large to save. Remove a photo or use smaller images and try again.",
            retriable: false,
        };
    }
    // Anything else (network blip, Mongo failover…) is worth another attempt.
    return { message: "Something went wrong on our end.", retriable: true };
}
