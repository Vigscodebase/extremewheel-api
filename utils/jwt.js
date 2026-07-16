import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import logToFile from "../logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Assumes jwt.js lives in utils/, so ".." navigates back to the project root
const rootDir = path.join(__dirname, "..");

let privateKey;
let publicKey;

try {
  privateKey = fs.readFileSync('/etc/extremewheel-secrets/private.pem', 'utf8');
  publicKey = fs.readFileSync('/etc/extremewheel-secrets/public.pem', 'utf8');
} catch (err) {
  console.error("CRITICAL: RSA key files not found. Ensure private.pem and public.pem are in the root directory.");
  logToFile(`[PRIVATE_PUBLIC_KEY] CRITICAL: RSA key files not found. Ensure private.pem and public.pem are in the root directory.`);
  process.exit(1);
}

function signToken(user) {
  return jwt.sign(
    {
      name: user.name,
      email: user.email,
      role: user.role,
    },
    privateKey,
    {
      algorithm: "RS256",
      expiresIn: "10m", // Changed from "15m" to "8h" to keep the user logged in longer
    }
  );
}

function verifyToken(token) {
  return jwt.verify(token, publicKey, {
    algorithms: ["RS256"], // Restrict token validation strictly to RS256
  });
}

export { signToken, verifyToken };