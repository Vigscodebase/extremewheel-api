// middleware/auth.js
import User from "../models/User.js";
import Permission from "../models/Permission.js";
import { signToken, verifyToken } from "../utils/jwt.js";

const RENEW_THRESHOLD_SECONDS = 5 * 60; // 5-minute rolling window

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

    // 3. SLIDING SESSION LOGIC: Check how much time is left
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const timeLeft = decoded.exp - nowInSeconds;

    // If the token expires in less than 5 minutes (300 seconds), issue a new one
    if (timeLeft < 300) {
      // Re-sign using the data already in the token payload
      const newToken = signToken({
        name: decoded.name,
        email: decoded.email,
        role: decoded.role
      });

      // Attach the new token to the headers
      res.setHeader("x-refresh-token", newToken);

      // CRITICAL: You MUST expose the header, otherwise the browser hides it from Axios!
      res.setHeader("Access-Control-Expose-Headers", "x-refresh-token");
    }

    // 4. Attach user to request and continue
    req.user = decoded; // Or fetch full user from DB if needed: await User.findById(decoded._id)
    next();

  } catch (error) {
    // If the token is already expired, verifyToken throws an error, resulting in a 401
    return res.status(401).json({ message: "Not authorized, token failed or expired." });
  }
};

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