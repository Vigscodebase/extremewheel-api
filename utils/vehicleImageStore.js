// Vehicle photos live on disk, not inside MongoDB.
//
// The browser sends photos as base64 data URLs. Before a vehicle is written to
// the database, every data URL is turned into a small .webp file and replaced by
// its URL ("/uploads/vehicle-notes/<sha1>.webp"), so documents stay a few KB and
// a MongoDB export (mongoexport / mongodump) no longer contains image data.
//
//   files:  $UPLOAD_DIR/vehicle-notes/<sha1>.webp   (default: server/uploads/…)
//   URL:    /uploads/vehicle-notes/<sha1>.webp      (served by express.static in
//                                                    server.js, or by nginx)
//
// The name is the SHA-1 of the uploaded bytes, so the same photo is stored once
// and re-running a save (worker retry) just finds the file already there.
// Anything that is not a data URL (an existing "/uploads/…" URL) is left alone.
// If a photo can't be converted it is kept as it was — a photo is never lost.
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import logToFile from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUBDIR = "vehicle-notes";
const URL_PREFIX = `/uploads/${SUBDIR}/`;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_EDGE = 2000; // the browser already shrinks photos to 1600 px; this only guards other clients
const WEBP_QUALITY = 82;
const CONCURRENCY = 4;
const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,/i;

/** Root folder that /uploads maps to (same variable your nginx comment mentions). */
export const uploadRoot = () => (process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.resolve(__dirname, "..", "uploads"));

export const isDataUrl = (value) => typeof value === "string" && DATA_URL.test(value);

/** data URL -> "/uploads/vehicle-notes/<sha1>.webp". Non data-URL values come back unchanged. */
export async function storeImage(value) {
    if (!isDataUrl(value)) return value;
    try {
        const head = DATA_URL.exec(value)[0];
        const original = Buffer.from(value.slice(head.length), "base64");
        if (original.length === 0 || original.length > MAX_INPUT_BYTES) return value;

        const name = `${crypto.createHash("sha1").update(original).digest("hex")}.webp`;
        const dir = path.join(uploadRoot(), SUBDIR);
        const file = path.join(dir, name);
        const url = `${URL_PREFIX}${name}`;

        try {
            await fs.access(file);
            return url; // same photo already stored
        } catch { /* not there yet */ }

        const webp = await sharp(original, { limitInputPixels: 100e6 })
            .rotate() // honour the camera's orientation flag
            .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
            .webp({ quality: WEBP_QUALITY })
            .toBuffer();

        await fs.mkdir(dir, { recursive: true });
        // Write to a temp name, then rename: a half-written file is never served.
        const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        await fs.writeFile(tmp, webp);
        await fs.rename(tmp, file);
        return url;
    } catch (err) {
        logToFile(`[ImageStore] could not store photo, keeping it inline: ${err.message}`);
        return value;
    }
}

// Small worker pool so a vehicle with 20 photos doesn't decode 20 images at once.
async function mapLimit(items, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                out[i] = await fn(items[i]);
            }
        })
    );
    return out;
}

/** Returns a copy of a vehicle input with every photo field (image, beforeImage, afterImage, gallery) stored as a file. */
export async function externalizeVehicleImages(input) {
    const next = { ...input };
    for (const field of ["image", "beforeImage", "afterImage"]) {
        if (isDataUrl(next[field])) next[field] = await storeImage(next[field]);
    }
    if (Array.isArray(next.gallery)) next.gallery = await mapLimit(next.gallery, storeImage);
    return next;
}
