// utils/imageProcessor.js
//
// The one place that turns an uploaded image into what we store: a WebP file
// on disk, at most 300 KB, referenced from MongoDB by a short URL path.
// Used by the upload middleware (middleware/upload.js) and by the one-time
// base64 -> file migration (scripts/migrateVehicleNoteImages.js).

import sharp from "sharp";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Hard ceiling for every stored image (300 KB).
export const MAX_IMAGE_BYTES = 300 * 1024;

// Longest side kept for *new* uploads. Phone photos are 4000+ px, which is far
// more than a vehicle card / lightbox needs, and it makes the 300 KB target
// reachable at high quality. The migration passes no cap so existing images
// keep their exact pixel size unless they simply cannot fit in 300 KB.
export const UPLOAD_MAX_DIMENSION = 2560;

// Where files live. Set UPLOAD_DIR in .env to point at a persistent volume.
export const UPLOAD_ROOT = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, "..", "uploads");
export const VEHICLE_IMAGE_DIR = path.join(UPLOAD_ROOT, "vehicle-notes");

// What MongoDB stores (and the client receives): the URL path, never a host.
export const VEHICLE_IMAGE_URL_PREFIX = "/uploads/vehicle-notes/";
const STORED_PATH_RE = /^\/uploads\/vehicle-notes\/[a-f0-9]{40}\.webp$/;
export const isStoredImagePath = (value) => typeof value === "string" && STORED_PATH_RE.test(value);

// Highest quality first: an image only gets squeezed as far as it needs to be
// to fit under the limit. Most photos stop at the first step. The floor is 70 -
// below that WebP gets visibly blocky, so a very large photo is scaled down a
// little (below) rather than pushed to a poor quality setting.
const QUALITY_STEPS = [90, 85, 80, 75, 70];
const SHRINK_FACTOR = 0.85;
const MAX_SHRINK_ROUNDS = 16;

export class InvalidImageError extends Error {
  constructor(message = "That file is not a valid image.") {
    super(message);
    this.name = "InvalidImageError";
    this.status = 400;
    this.expose = true;
  }
}

/**
 * Re-encode any supported image (JPEG, PNG, WebP, GIF, AVIF, ...) as WebP no
 * larger than MAX_IMAGE_BYTES.
 *
 * @param {Buffer} input
 * @param {{ maxDimension?: number }} [opts]
 * @returns {Promise<{ buffer: Buffer, width: number, height: number, quality: number, resized: boolean }>}
 */
export async function toWebp(input, { maxDimension } = {}) {
  let meta;
  try {
    meta = await sharp(input, { limitInputPixels: 100_000_000 }).metadata();
  } catch {
    throw new InvalidImageError();
  }
  if (!meta.width || !meta.height) throw new InvalidImageError();

  // EXIF orientation 5-8 means the stored pixels are rotated 90 degrees.
  const swap = meta.orientation >= 5;
  const srcW = swap ? meta.height : meta.width;
  const srcH = swap ? meta.width : meta.height;
  const fit = maxDimension ? Math.min(1, maxDimension / Math.max(srcW, srcH)) : 1;
  const baseWidth = Math.max(1, Math.round(srcW * fit));

  let scale = 1;
  for (let round = 0; round < MAX_SHRINK_ROUNDS; round += 1) {
    const width = Math.max(1, Math.round(baseWidth * scale));
    for (const quality of QUALITY_STEPS) {
      let pipeline = sharp(input, { limitInputPixels: 100_000_000 }).rotate(); // .rotate() applies EXIF orientation
      if (width !== srcW) pipeline = pipeline.resize({ width, withoutEnlargement: true });
      let buffer;
      try {
        buffer = await pipeline.webp({ quality, effort: 4 }).toBuffer();
      } catch {
        throw new InvalidImageError();
      }
      if (buffer.length <= MAX_IMAGE_BYTES) {
        return {
          buffer,
          width,
          height: Math.max(1, Math.round((srcH * width) / srcW)),
          quality,
          resized: width !== srcW,
        };
      }
    }
    scale *= SHRINK_FACTOR;
  }
  throw new InvalidImageError(`Could not reduce that image to ${Math.round(MAX_IMAGE_BYTES / 1024)} KB.`);
}

// Same bytes in -> same file name out, so identical images are stored once
// (the old base64 data had the same photo repeated across several fields).
const sourceHash = (input) => crypto.createHash("sha256").update(input).digest("hex").slice(0, 40);

/**
 * Convert and store one image. Returns { path, bytes, reused } plus { quality, resized, width, height } when newly written.
 */
export async function saveImageAsWebp(input, opts = {}) {
  const name = `${sourceHash(input)}.webp`;
  const filePath = path.join(VEHICLE_IMAGE_DIR, name);
  const urlPath = `${VEHICLE_IMAGE_URL_PREFIX}${name}`;

  // Already stored (same source image uploaded before): nothing to do.
  const existing = await fs.stat(filePath).catch(() => null);
  if (existing) return { path: urlPath, bytes: existing.size, reused: true };

  const result = await toWebp(input, opts);

  await fs.mkdir(VEHICLE_IMAGE_DIR, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, result.buffer);
  await fs.rename(tmp, filePath); // atomic: readers never see a half-written file
  return { path: urlPath, bytes: result.buffer.length, quality: result.quality, resized: result.resized, width: result.width, height: result.height, reused: false };
}

// "data:image/jpeg;base64,...." -> Buffer (null when it is not an image data URL)
export function dataUrlToBuffer(value) {
  if (typeof value !== "string") return null;
  const match = /^data:image\/[a-z0-9.+-]+;base64,/i.exec(value);
  if (!match) return null;
  return Buffer.from(value.slice(match[0].length), "base64");
}

// URL path -> absolute file path (only for paths we generated; blocks traversal).
export function storedPathToFile(urlPath) {
  if (!isStoredImagePath(urlPath)) return null;
  return path.join(VEHICLE_IMAGE_DIR, path.basename(urlPath));
}
