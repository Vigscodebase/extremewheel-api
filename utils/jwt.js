import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import logToFile from "../logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Assumes jwt.js lives in utils/, so ".." navigates back to the project root
const rootDir = path.join(__dirname, "..");

// Key locations are environment-driven so the same code works unchanged
// across local/staging/production without editing source.
const PRIVATE_KEY_PATH = process.env.JWT_PRIVATE_KEY_PATH || "/etc/extremewheel-secrets/private.pem";
const PUBLIC_KEY_PATH = process.env.JWT_PUBLIC_KEY_PATH || "/etc/extremewheel-secrets/public.pem";

/*
 * ============================================================
 * TOKEN EXPIRY - TEMPORARILY DISABLED
 * ============================================================
 *
 * Keeping this here for future use.
 *
 * Previously the token lifetime was environment-driven and defaulted
 * to 10 minutes, working alongside the sliding-session refresh in
 * middleware/auth.js and the /auth/refresh endpoint.
 *
 * With no `expiresIn` passed to jwt.sign below, the JWT has no `exp`
 * claim at all, so jwt.verify never rejects it for expiry — the user
 * stays logged in until they explicitly log out (which just clears
 * the token client-side).
 */
// const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "10m";

let privateKey;
let publicKey;

try {
  privateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  publicKey = fs.readFileSync(PUBLIC_KEY_PATH, 'utf8');
} catch (err) {
  console.error(`CRITICAL: RSA key files not found at ${PRIVATE_KEY_PATH} / ${PUBLIC_KEY_PATH}. Run generate-keys.js or set JWT_PRIVATE_KEY_PATH / JWT_PUBLIC_KEY_PATH.`);
  logToFile(`[PRIVATE_PUBLIC_KEY] CRITICAL: RSA key files not found at ${PRIVATE_KEY_PATH} / ${PUBLIC_KEY_PATH}.`);
  process.exit(1);
}

function signToken(user) {
  return jwt.sign(
    {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
    privateKey,
    {
      algorithm: "RS256",
      // expiresIn: JWT_EXPIRES_IN, // token expiry disabled — see note above
    }
  );
}

function verifyToken(token) {
  return jwt.verify(token, publicKey, {
    algorithms: ["RS256"], // Restrict token validation strictly to RS256
  });
}

export { signToken, verifyToken };