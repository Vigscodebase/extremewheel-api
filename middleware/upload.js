// middleware/upload.js
//
// Image uploads: multer receives the multipart request (in memory, with hard
// limits), then sharp re-encodes every file as WebP <= 300 KB and stores it.
// Nothing is ever saved as base64.
//
//   uploadImages        -> expects field "images" (1-20 files)
//   uploadSingleImage   -> expects field "image"  (1 file)
//   processUploadedImages -> converts + saves; sets req.processedImages = ["/uploads/...webp", ...]

import multer from "multer";
import { saveImageAsWebp, UPLOAD_MAX_DIMENSION, InvalidImageError } from "../utils/imageProcessor.js";

export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
// Cap on the *incoming* file. It is re-encoded to <= 300 KB afterwards.
export const MAX_UPLOAD_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 20;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_INPUT_BYTES, files: MAX_FILES_PER_REQUEST },
  fileFilter(req, file, cb) {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
      return cb(new InvalidImageError("Only image files (JPEG, PNG, WebP, GIF or AVIF) can be uploaded."));
    }
    cb(null, true);
  },
});

// Turns multer's own errors into friendly 400s instead of a generic 500.
const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: `Each image must be ${Math.round(MAX_UPLOAD_INPUT_BYTES / 1024 / 1024)} MB or smaller.`,
  LIMIT_FILE_COUNT: `You can upload at most ${MAX_FILES_PER_REQUEST} images at a time.`,
  LIMIT_UNEXPECTED_FILE: "Unexpected upload field.",
};
const wrap = (middleware) => (req, res, next) =>
  middleware(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ message: MULTER_MESSAGES[err.code] || "Upload failed." });
    }
    return next(err);
  });

export const uploadImages = wrap(upload.array("images", MAX_FILES_PER_REQUEST));
export const uploadSingleImage = wrap(upload.single("image"));

export async function processUploadedImages(req, res, next) {
  try {
    const files = req.files || (req.file ? [req.file] : []);
    if (files.length === 0) {
      return res.status(400).json({ message: "No image was uploaded." });
    }
    const paths = [];
    for (const file of files) {
      try {
        const saved = await saveImageAsWebp(file.buffer, { maxDimension: UPLOAD_MAX_DIMENSION });
        paths.push(saved.path);
      } catch (err) {
        if (err instanceof InvalidImageError) {
          return res.status(400).json({ message: `"${file.originalname}" is not a valid image.` });
        }
        throw err;
      }
    }
    req.processedImages = paths;
    next();
  } catch (err) {
    next(err);
  }
}
