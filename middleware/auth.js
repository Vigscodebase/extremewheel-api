// middleware/auth.js
import mongoose from "mongoose";
import User from "../models/User.js";
import { signToken, verifyToken } from "../utils/jwt.js";
import { ancestorsOf, isKnownPermission } from "../config/permissionCatalog.js";

// const RENEW_THRESHOLD_SECONDS = Number(process.env.JWT_RENEW_THRESHOLD_SECONDS) || 5 * 60; // rolling-refresh window

export const requireAuth = async (req, res, next) => {
  try {
    // 1. Get the token from the request
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      return res.status(401).json({ message: "Not authorized, no token provided." });
    }

    // 2. Verify the token
    const decoded = verifyToken(token);

    /*
     * ============================================================
     * SLIDING SESSION / AUTOMATIC TOKEN REFRESH - TEMPORARILY DISABLED
     * ============================================================
     *
     * Keeping the code here for future use.
     *
     * This used to check how much time was left on the token and,
     * if it was close to expiring, silently issue a new one via the
     * x-refresh-token response header (rolling session).
     */

    /*
    // 3. SLIDING SESSION LOGIC: Check how much time is left
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const timeLeft = decoded.exp - nowInSeconds;

    // If the token is close to expiring, issue a new one (rolling session)
    if (timeLeft < RENEW_THRESHOLD_SECONDS) {
      const newToken = signToken({
        _id: decoded._id, // <-- Add this!
        name: decoded.name,
        email: decoded.email,
        role: decoded.role
      });

      // Attach the new token to the headers
      res.setHeader("x-refresh-token", newToken);

      // CRITICAL: You MUST expose the header, otherwise the browser hides it from Axios!
      res.setHeader("Access-Control-Expose-Headers", "x-refresh-token");
    }
    */

    // 4. Attach user to request and continue
    req.user = decoded; // Or fetch full user from DB if needed: await User.findById(decoded._id)
    next();

  } catch (error) {
    // If the token is already expired, verifyToken throws an error, resulting in a 401
    return res.status(401).json({ message: "Not authorized, token failed or expired." });
  }
};

/**
 * Per-user access, looked up FRESH from the database on every guarded request
 * (and cached on `req.access` so stacked guards only hit the DB once).
 *
 * Permissions belong to the user's email, and the token is deliberately NOT
 * trusted for them: tokens never expire, so a token minted before an admin
 * changed this user's email, role or permissions — or deleted the account —
 * would otherwise keep working with the old grants. Looking the user up by
 * _id each time means those changes take effect on the very next request, and
 * a stale token can never borrow the permissions of whoever later owns its old
 * email address.
 *
 * Resolves to null when the account no longer exists.
 */
export async function loadAccess(req) {
  if (req.access) return req.access;

  const id = req.user?._id || req.user?.id;
  if (!id || !mongoose.isValidObjectId(id)) return null;

  const fresh = await User.findById(id).select("email role permissions").lean();
  if (!fresh) return null;

  req.access = {
    email: fresh.email,
    role: fresh.role,
    // The one role-based rule that remains: an admin account is the master
    // account and always holds every permission (so nobody can be locked out
    // of User Management). Everything else is purely per-user grants.
    isAdmin: fresh.role === "admin",
    permissions: new Set(fresh.permissions || []),
  };
  return req.access;
}

/**
 * True when the user holds `key` AND every ancestor of it (an element
 * permission is meaningless without the page / card it lives in).
 */
export function hasPermission(access, key) {
  if (!access) return false;
  if (access.isAdmin) return true;
  return access.permissions.has(key) && ancestorsOf(key).every((a) => access.permissions.has(a));
}

// Fail at startup (not at request time) if a route is guarded with a key that
// isn't in the catalog — a typo there would otherwise silently lock everyone
// out of the route, or worse, be mistaken for "no guard".
function assertKnownKeys(keys) {
  const unknown = keys.filter((k) => !isKnownPermission(k));
  if (unknown.length) {
    throw new Error(`requirePermission: unknown permission key(s): ${unknown.join(", ")}`);
  }
}

const notAuthorized = (res) =>
  res.status(401).json({ message: "Not authorized, this account no longer exists." });

/**
 * Guard a route by a permission key — a page ("user-management") or an element
 * ("vehicle-notes.delete"). Admin accounts always pass.
 * @param {string} requiredKey
 */
export function requirePermission(requiredKey) {
  assertKnownKeys([requiredKey]);

  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Not authenticated." });
      }

      const access = await loadAccess(req);
      if (!access) return notAuthorized(res);

      if (hasPermission(access, requiredKey)) return next();

      return res.status(403).json({
        message: `Access Denied: your account doesn't have permission for '${requiredKey}'.`,
      });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Same as requirePermission, but passes if the user holds ANY of the given
 * keys. For read-only data that more than one page depends on — e.g. the
 * Make list feeds both Vehicle Notes and Tire Size Option.
 * @param {...string} requiredKeys
 */
export function requireAnyPermission(...requiredKeys) {
  assertKnownKeys(requiredKeys);

  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Not authenticated." });
      }

      const access = await loadAccess(req);
      if (!access) return notAuthorized(res);

      if (requiredKeys.some((key) => hasPermission(access, key))) return next();

      return res.status(403).json({
        message: `Access Denied: your account doesn't have permission for '${requiredKeys.join("' or '")}'.`,
      });
    } catch (err) {
      next(err);
    }
  };
}
