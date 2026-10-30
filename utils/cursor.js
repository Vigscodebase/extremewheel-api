// utils/cursor.js
//
// Opaque, tamper-proof pagination cursors (AES-256-GCM).
//
// A cursor is the "keyset" position of the last row the client has seen
// ({ createdAt, _id }) sealed with AES-GCM, so the client can't read it, edit it
// to jump somewhere else, or replay it against a different list.
//
//   token = base64url( version(1) | iv(12) | authTag(16) | ciphertext )
//
// The cursor is additionally bound — as GCM "additional authenticated data" —
// to the list it belongs to: resource name + the signed-in user + a fingerprint
// of the search / filter params. Decrypting it for any other list, user or
// filter set fails authentication, exactly like a tampered token.
//
// Key: derived from the RSA private key already used for login tokens (see
// deriveKey in utils/jwt.js). Set CURSOR_SECRET (>= 32 chars) in .env to use a
// dedicated secret instead.

import crypto from "crypto";
import { deriveKey } from "./jwt.js";

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const MAX_TOKEN_LEN = 600; // a real cursor is ~120 chars; refuse junk before doing any crypto
const TTL_SECONDS = Number(process.env.CURSOR_TTL_SECONDS) || 12 * 60 * 60;

export class CursorError extends Error {
  constructor(message = "This page link is no longer valid. Reloading from the first page.") {
    super(message);
    this.name = "CursorError";
    this.status = 400;
    this.code = "INVALID_CURSOR";
    this.expose = true;
  }
}

let cachedKey;
function getKey() {
  if (cachedKey) return cachedKey;
  const secret = process.env.CURSOR_SECRET;
  if (secret) {
    if (secret.length < 32) throw new Error("CURSOR_SECRET must be at least 32 characters.");
    cachedKey = Buffer.from(crypto.hkdfSync("sha256", secret, "extremewheel/cursor/v1", "aes-256-gcm", 32));
  } else {
    cachedKey = deriveKey("extremewheel/cursor/aes-256-gcm", 32);
  }
  return cachedKey;
}

const aadOf = ({ scope, userId, fp }) => Buffer.from(`${scope}|${userId}|${fp}`, "utf8");

/** Seals `payload` (plain JSON) into an opaque cursor string. */
export function encodeCursor(payload, ctx) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv, { authTagLength: TAG_LEN });
  cipher.setAAD(aadOf(ctx));
  const body = Buffer.from(JSON.stringify({ ...payload, x: Math.floor(Date.now() / 1000) + TTL_SECONDS }), "utf8");
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

/** Opens a cursor. Throws CursorError for anything that isn't a valid, unexpired cursor for this exact list. */
export function decodeCursor(token, ctx) {
  try {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LEN) throw new Error("bad length");
    const raw = Buffer.from(token, "base64url");
    if (raw.length <= 1 + IV_LEN + TAG_LEN || raw[0] !== VERSION) throw new Error("bad format");

    const iv = raw.subarray(1, 1 + IV_LEN);
    const tag = raw.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
    const ciphertext = raw.subarray(1 + IV_LEN + TAG_LEN);

    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv, { authTagLength: TAG_LEN });
    decipher.setAAD(aadOf(ctx));
    decipher.setAuthTag(tag);
    const body = Buffer.concat([decipher.update(ciphertext), decipher.final()]); // throws if tampered / wrong list / wrong user

    const payload = JSON.parse(body.toString("utf8"));
    if (!payload || typeof payload.x !== "number" || payload.x < Math.floor(Date.now() / 1000)) throw new Error("expired");
    if (!Number.isFinite(payload.t) || typeof payload.i !== "string" || !/^[a-f0-9]{24}$/i.test(payload.i)) throw new Error("bad payload");
    return payload;
  } catch {
    throw new CursorError();
  }
}
