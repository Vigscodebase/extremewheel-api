// utils/vehicleNoteImages.js
// Validation + clean-up helpers for the image fields on a VehicleNote.

import fs from "fs/promises";
import VehicleNote from "../models/VehicleNote.js";
import { isStoredImagePath, storedPathToFile } from "./imageProcessor.js";

const SINGLE_FIELDS = ["image", "beforeImage", "afterImage"];

// Every image reference on a vehicle, as a Set of URL paths.
export function collectImagePaths(vehicle) {
  const found = new Set();
  if (!vehicle) return found;
  for (const field of SINGLE_FIELDS) if (vehicle[field]) found.add(vehicle[field]);
  for (const photo of vehicle.gallery || []) if (photo) found.add(photo);
  return found;
}

// Returns an error message when a create / update body tries to save anything
// other than an image that was uploaded through the upload endpoint (so no
// base64 data URLs and no arbitrary external URLs), otherwise null.
export function validateImageFields({ image, beforeImage, afterImage, gallery }) {
  const message = "Images must be uploaded as files (JPEG, PNG, WebP, GIF or AVIF). Base64 image data is not accepted.";
  for (const value of [image, beforeImage, afterImage]) {
    if (value === undefined || value === null || value === "") continue;
    if (!isStoredImagePath(value)) return message;
  }
  if (gallery !== undefined) {
    if (!Array.isArray(gallery)) return "Gallery must be a list of uploaded images.";
    if (!gallery.every(isStoredImagePath)) return message;
  }
  return null;
}

// Paths present in `before` but no longer in `after`.
export function removedImagePaths(before, after) {
  const still = collectImagePaths(after);
  return [...collectImagePaths(before)].filter((p) => !still.has(p));
}

// Deletes files that no vehicle references any more. Identical photos share one
// file (same content -> same name), so a file is only removed once the last
// vehicle using it lets go. Never throws: a leftover file is harmless.
export async function deleteUnreferencedImages(paths) {
  for (const urlPath of new Set(paths)) {
    try {
      const file = storedPathToFile(urlPath);
      if (!file) continue;
      const inUse = await VehicleNote.exists({
        $or: [{ image: urlPath }, { beforeImage: urlPath }, { afterImage: urlPath }, { gallery: urlPath }],
      });
      if (!inUse) await fs.unlink(file).catch(() => {});
    } catch {
      /* ignore */
    }
  }
}
