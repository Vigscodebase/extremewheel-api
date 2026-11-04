// middleware/auth.js
import mongoose from "mongoose";
import User from "../models/User.js";
import { signToken, verifyToken } from "../utils/jwt.js";
import { ALL_PERMISSION_KEYS, ancestorsOf, isKnownPermission } from "../config/permissionCatalog.js";

// const RENEW_THRESHOLD_SECONDS = Number(process.env.JWT_RENEW_THRESHOLD_SECONDS) || 5 * 60; // rolling-refresh window

const BEARER = /^Bearer\s+(\S+)$/i;

const unauthorized = (res, message) => {
  res.set("WWW-Authenticate", 'Bearer realm="api"');
  return res.status(401).json({ message });
};

/**
 * AUTHENTICATE. Proves who is calling and loads their CURRENT account.
 *
 * The JWT is only used to find out WHICH account is calling. Everything else
 * (role, email, name, permissions) is read from the database on every request,
 * because login tokens never expire: a token minted before an admin demoted the
 * user, changed their email, or deleted the account would otherwise keep its old
 * role forever. `req.user` is therefore built from the database, never from the
 * token, so every `req.user.role` check in the app is automatically fresh.
 *
 * A token is also refused if it was issued before the account's
 * `tokensValidAfter` (set when the password, email or role changes), so changing
 * or resetting a password signs out every device that was using the old one.
 *
 * Idempotent: server.js runs this once as a gate in front of every non-public
 * route; the router-level / route-level calls then pass straight through.
 */
export const requireAuth = async (req, res, next) => {
  try {
    if (req.user && req.access) return next();

    // 1. Get the token from the request
    const match = BEARER.exec(req.headers.authorization || "");
    if (!match) return unauthorized(res, "Not authorized, no token provided.");

    // 2. Verify the token (signature; RS256 only — see utils/jwt.js)
    let decoded;
    try {
      decoded = verifyToken(match[1]);
    } catch {
      return unauthorized(res, "Not authorized, token failed or expired.");
    }
    const id = decoded?._id || decoded?.id;
    if (!id || !mongoose.isValidObjectId(id)) {
      return unauthorized(res, "Not authorized, token failed or expired.");
    }

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

    // 4. Load the CURRENT account. A database error is a 500 (via next(err)),
    //    not a 401: clients that sign the user out on 401 must not do so just
    //    because the database hiccuped.
    const fresh = await User.findById(id)
      .select("name email role permissions +tokensValidAfter")
      .lean();
    if (!fresh) return notAuthorized(res);

    if (fresh.tokensValidAfter) {
      const validAfter = Math.floor(new Date(fresh.tokensValidAfter).getTime() / 1000);
      if (!(decoded.iat >= validAfter)) {
        return unauthorized(res, "Not authorized, please sign in again.");
      }
    }

    // 5. Attach the CURRENT user (same shape the token used to give) and their
    //    access, so the permission guards below don't query again.
    req.user = { _id: String(fresh._id), name: fresh.name, email: fresh.email, role: fresh.role };
    req.access = buildAccess(fresh);
    next();
  } catch (error) {
    next(error);
  }
};

function buildAccess(user) {
  return {
    email: user.email,
    role: user.role,
    // The one role-based rule that remains: an admin account is the master
    // account and always holds every permission (so nobody can be locked out
    // of User Management). Everything else is purely per-user grants.
    isAdmin: user.role === "admin",
    permissions: new Set(user.permissions || []),
  };
}

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

  req.access = buildAccess(fresh);
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

function notAuthorized(res) {
  return unauthorized(res, "Not authorized, this account no longer exists.");
}

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

// Every top-level page key ("dashboard", "vehicle-notes", …) — i.e. every
// permission that is not an element inside a page.
const PAGE_KEYS = ALL_PERMISSION_KEYS.filter((k) => ancestorsOf(k).length === 0);

/**
 * For shared helper endpoints that several pages read (recent activity, the
 * tire preset list, …): the caller must have been granted at least ONE page.
 * An account with no grants at all (a fresh self-registered "guest") gets 403
 * instead of being treated as "any logged-in user is fine". Admins always pass.
 */
export const requireAnyPage = async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Not authenticated." });

    const access = await loadAccess(req);
    if (!access) return notAuthorized(res);

    if (PAGE_KEYS.some((key) => hasPermission(access, key))) return next();

    return res.status(403).json({
      message: "Access Denied: your account hasn't been granted access to any page.",
    });
  } catch (err) {
    next(err);
  }
};
