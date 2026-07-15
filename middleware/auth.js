// middleware/auth.js
import User from "../models/User.js";
import Permission from "../models/Permission.js";
import { signToken, verifyToken } from "../utils/jwt.js";

const RENEW_THRESHOLD_SECONDS = 5 * 60; // 5-minute rolling window

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ message: "Not authenticated." });
    }

    const payload = verifyToken(token);

    // OPTIMIZATION: Find by email since 'sub' (ID) is no longer in the token
    const user = await User.findOne({ email: payload.email })
      .select("_id name email role createdAt")
      .lean();

    if (!user) {
      return res.status(401).json({ message: "Session is no longer valid or user account was removed." });
    }

    req.user = user;

    // Rolling session check (now works because expiresIn provides payload.exp)
    const secondsLeft = payload.exp - Math.floor(Date.now() / 1000);
    if (secondsLeft < RENEW_THRESHOLD_SECONDS) {
      res.setHeader("x-refresh-token", signToken(user));
    }

    next();
  } catch (err) {
    return res.status(401).json({ message: "Session expired. Please sign in again." });
  }
}

/**
 * Dynamic validation matching database configuration maps
 * @param {string} requiredKey - The page view or element control key (e.g., "user-management")
 */
export function requirePermission(requiredKey) {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Not authenticated." });
      }

      const userRole = req.user.role;

      // Master Account Bypass
      if (userRole === "admin") return next();

      // Retrieve global access layout matrix
      const doc = await Permission.findOne({ key: "global" }).lean();
      if (!doc) {
        return res.status(500).json({ message: "Authorization system misconfigured. Access maps unavailable." });
      }

      const allowedPages = doc.matrix?.[userRole] || [];
      if (!allowedPages.includes(requiredKey)) {
        return res.status(403).json({
          message: `Access Denied: Your assigned role (${userRole}) lacks clearance for '${requiredKey}'.`
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}