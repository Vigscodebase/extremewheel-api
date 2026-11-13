// The actual "write a vehicle note to MongoDB" logic, shared by
//  - the BullMQ worker (normal path), and
//  - the route handlers' inline fallback (when Redis is unavailable),
// so both produce exactly the same result.
import crypto from "crypto";
import VehicleNote, { MODIFICATION_OPTIONS } from "../models/VehicleNote.js";
import { externalizeVehicleImages } from "../utils/vehicleImageStore.js";
import { normalizeLookupOptionValue, quickAddVehicleLookupOption } from "../utils/vehicleLookupImporter.js";

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
 * "205/55R16", "205-55-16", "LT265/70R17" or "205 55 16" -> "205 55 16"
 * (the format used in tblAppGuide-Templatenew.xlsx). Empty -> "".
 * Anything that isn't exactly width / aspect / rim is refused.
 */
export function normalizeTireSize(raw) {
    if (raw === undefined || raw === null) return undefined;
    const text = String(raw).trim();
    if (!text) return "";
    const nums = text.match(/\d+/g) || [];
    const [w, a, r] = nums.map(Number);
    const ok = nums.length === 3 && w >= 105 && w <= 495 && a >= 20 && a <= 95 && r >= 10 && r <= 30;
    if (!ok) throw new SaveError(400, `"${text}" is not a valid tire size. Use width / aspect / rim, e.g. 205 55 16.`);
    return `${w} ${a} ${r}`;
}

/** Wheel offset in mm. "" / null clears it (null), undefined = not sent. */
export function normalizeOffset(raw, label) {
    if (raw === undefined) return undefined;
    if (raw === null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < -200 || n > 200) throw new SaveError(400, `${label} must be a number between -200 and 200 (mm).`);
    return Math.round(n);
}

/** Keeps only the known Lifted / Lowered / Stock values, no duplicates. */
export function normalizeModification(raw) {
    if (raw === undefined) return undefined;
    const list = Array.isArray(raw) ? raw : [];
    return [...new Set(list.map((v) => String(v).trim().toLowerCase()))].filter((v) => MODIFICATION_OPTIONS.includes(v));
}

const cleanText = (raw, max) => (raw === undefined ? undefined : String(raw ?? "").trim().slice(0, max));

/**
 * Whitelist the fields a save may carry. Used by the route before enqueueing so
 * the job (which sits in Redis) never contains anything unexpected.
 */
export function pickVehicleInput(body) {
    const {
        name, make, type, model, year, image, beforeImage, afterImage, gallery,
        offsetNotes, existingSpec, upgradedSpec, eventDate, staffNotes,
        submodel, frontTireSize, rearTireSize, frontWheelOffset, rearWheelOffset, modification, description,
    } = body || {};
    return {
        name, make, type, model, year, image, beforeImage, afterImage, gallery,
        offsetNotes, existingSpec, upgradedSpec, eventDate, staffNotes,
        submodel, frontTireSize, rearTireSize, frontWheelOffset, rearWheelOffset, modification, description,
    };
}

/**
 * Checks the new fitment fields BEFORE a save is queued, so a typo such as a
 * malformed tire size is answered with a 400 while the form is still open
 * instead of failing later in the background worker. Returns a message or "".
 */
export function validateVehicleInput(input) {
    try {
        normalizeTireSize(input.frontTireSize);
        normalizeTireSize(input.rearTireSize);
        normalizeOffset(input.frontWheelOffset, "Front wheel offset");
        normalizeOffset(input.rearWheelOffset, "Rear wheel offset");
        return "";
    } catch (err) {
        if (err instanceof SaveError) return err.message;
        throw err;
    }
}

/** Only what the Redis job / WebSocket needs to know about the person saving. */
export function pickUser(user) {
    return { _id: String(user._id), name: user.name, email: user.email, role: user.role };
}

// Which vehicle-note fields feed which dropdown list (models/VehicleLookupOption.js).
const LOOKUP_OPTION_SOURCES = [
    { kind: "submodel", fields: ["submodel"] },
    { kind: "tire-size", fields: ["frontTireSize", "rearTireSize"] },
    { kind: "wheel-offset", fields: ["frontWheelOffset", "rearWheelOffset"] },
];
const LOOKUP_OPTION_FIELDS = LOOKUP_OPTION_SOURCES.flatMap((s) => s.fields);

/**
 * Makes sure every Submodel / Tire size / Wheel offset value that was just saved
 * on a vehicle is also a choice in the matching dropdown list.
 *
 * This used to be done only by the browser, after the save finished, and failures
 * were swallowed — so a closed tab, a missed WebSocket message or a failed request
 * left the vehicle holding a value that the dropdown didn't list (the dropdown then
 * showed it as a lone "orphan" row with no delete button).
 *
 * Same rules as before: staff and admin only (they are the only roles that may
 * grow the lists), and on an edit only values that actually CHANGED are added, so
 * saving an old vehicle never brings back a value someone deleted from the list.
 * Never throws — the vehicle itself is already saved.
 */
async function rememberLookupOptions(saved, previous, user) {
    try {
        if (!user || (user.role !== "staff" && user.role !== "admin")) return;
        const wanted = new Map();
        for (const { kind, fields } of LOOKUP_OPTION_SOURCES) {
            for (const field of fields) {
                const value = normalizeLookupOptionValue(kind, saved?.[field]);
                if (!value) continue;
                if (previous && normalizeLookupOptionValue(kind, previous[field]) === value) continue;
                wanted.set(`${kind}|${value}`, { kind, value });
            }
        }
        for (const { kind, value } of wanted.values()) {
            await quickAddVehicleLookupOption(kind, value);
        }
    } catch (err) {
        console.error(`[VehicleNotes] Couldn't add saved values to the dropdown lists: ${err.message}`);
    }
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
        const description = cleanText(rest.description, 2000);
        const frontOffset = normalizeOffset(rest.frontWheelOffset, "Front wheel offset");
        const rearOffset = normalizeOffset(rest.rearWheelOffset, "Rear wheel offset");
        const mappedNotes = Array.isArray(staffNotes)
            ? staffNotes.map((n) => ({
                text: n.text,
                authorName: n.authorName || user.name || user.email,
                author: user._id,
                createdAt: n.createdAt ? new Date(n.createdAt) : new Date(),
            }))
            : [];

        const created = await VehicleNote.create({
            _id: vehicleId,
            name: rest.name,
            make: rest.make,
            type: rest.type,
            model: rest.model,
            year: rest.year,
            submodel: cleanText(rest.submodel, 80),
            frontTireSize: normalizeTireSize(rest.frontTireSize),
            rearTireSize: normalizeTireSize(rest.rearTireSize),
            ...(frontOffset !== null && frontOffset !== undefined && { frontWheelOffset: frontOffset }),
            ...(rearOffset !== null && rearOffset !== undefined && { rearWheelOffset: rearOffset }),
            modification: normalizeModification(rest.modification) || [],
            description,
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
        await rememberLookupOptions(created, null, user);
        return created;
    }

    if (kind === "update") {
        const {
            name, make, type, model, year, image, beforeImage, afterImage, gallery, offsetNotes, existingSpec, upgradedSpec, eventDate,
            submodel, frontTireSize, rearTireSize, frontWheelOffset, rearWheelOffset, modification, description,
        } = input;

        // The card shows "Updated <date>" only once the description really
        // changed, so compare with what is stored before writing.
        const nextDescription = cleanText(description, 2000);
        let descriptionChanged = false;
        if (nextDescription !== undefined) {
            const current = await VehicleNote.findById(vehicleId).select("description").lean();
            if (!current) throw new SaveError(404, "Vehicle not found.");
            descriptionChanged = (current.description || "") !== nextDescription;
        }
        const frontOffset = normalizeOffset(frontWheelOffset, "Front wheel offset");
        const rearOffset = normalizeOffset(rearWheelOffset, "Rear wheel offset");
        // What the vehicle held before this save — see rememberLookupOptions().
        const previous = await VehicleNote.findById(vehicleId).select(LOOKUP_OPTION_FIELDS.join(" ")).lean();
        const unset = {
            ...(customerField.clear && { customer: 1 }),
            ...(frontOffset === null && { frontWheelOffset: 1 }),
            ...(rearOffset === null && { rearWheelOffset: 1 }),
        };

        const vehicle = await VehicleNote.findByIdAndUpdate(
            vehicleId,
            {
                ...(customerField.id && { customer: customerField.id }),
                ...(name && { name }),
                ...(make && { make }),
                ...(type && { type }),
                ...(model && { model }),
                ...(year !== undefined && { year }),
                ...(submodel !== undefined && { submodel: cleanText(submodel, 80) }),
                ...(frontTireSize !== undefined && { frontTireSize: normalizeTireSize(frontTireSize) }),
                ...(rearTireSize !== undefined && { rearTireSize: normalizeTireSize(rearTireSize) }),
                ...(typeof frontOffset === "number" && { frontWheelOffset: frontOffset }),
                ...(typeof rearOffset === "number" && { rearWheelOffset: rearOffset }),
                ...(modification !== undefined && { modification: normalizeModification(modification) }),
                ...(nextDescription !== undefined && { description: nextDescription }),
                ...(descriptionChanged && { descriptionUpdatedAt: new Date() }),
                ...(image !== undefined && { image }),
                ...(beforeImage !== undefined && { beforeImage }),
                ...(afterImage !== undefined && { afterImage }),
                ...(Array.isArray(gallery) && { gallery }),
                ...(offsetNotes !== undefined && { offsetNotes }),
                ...(existingSpec !== undefined && { existingSpec: normalizeSpec(existingSpec) }),
                ...(upgradedSpec !== undefined && { upgradedSpec: normalizeSpec(upgradedSpec) }),
                ...(eventDate !== undefined && { eventDate: eventDate ? new Date(eventDate) : null }),
                ...(Object.keys(unset).length && { $unset: unset }),
            },
            { new: true }
        );
        if (!vehicle) throw new SaveError(404, "Vehicle not found.");
        await rememberLookupOptions(vehicle, previous, user);
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
        submodel: v.submodel,
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
