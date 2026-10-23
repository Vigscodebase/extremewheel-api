// server.js
import express from "express";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";
import helmet from "helmet";
import compression from "compression";
import crypto from "crypto";
import mongoose from "mongoose";

import logToFile from "./logger.js";
import connectDB from "./config/db.js";
import errorHandler from "./middleware/errorHandler.js";
import rateLimit from "express-rate-limit";

// Models
import User from "./models/User.js";
import TireOption from "./models/TireOption.js";
import VehicleNote from "./models/VehicleNote.js";
import Customer from "./models/Customer.js";
import SavedComparison from "./models/SavedComparison.js";
import VehicleLookup from "./models/VehicleLookup.js";
import VehicleLookupYear from "./models/VehicleLookupYear.js";
import VehicleLookupMake from "./models/VehicleLookupMake.js";
import Role from "./models/Role.js";
import AppGuide from "./models/AppGuide.js";
import RecentActivity from "./models/RecentActivity.js";
import OeTireSize from "./models/OeTireSize.js";

// Middleware
import { requireAuth, requirePermission, requireAnyPermission, loadAccess, hasPermission } from "./middleware/auth.js";
import { NAV_PAGES, ALL_PERMISSION_KEYS, HIDDEN_PAGE_KEYS, sanitizePermissions } from "./config/permissionCatalog.js";
import { signToken } from "./utils/jwt.js";
import { cached, invalidatePrefix } from "./config/redis.js";
import { tireToleranceLimits } from "./utils/tireMath.js";
import { parseCsv, toCsv } from "./utils/csv.js";
import { parseCustomerInput } from "./utils/customerFields.js";
import { upsertOeTireSize } from "./utils/oeTireSizeService.js";
import { importOeTireSizeWorkbook, buildOeTireSizeWorkbook, fetchAllOeTireSizesForExport } from "./utils/oeTireSizeExcel.js";
import {
    importVehicleLookupWorkbook,
    buildVehicleLookupWorkbook,
    quickAddVehicleLookup,
    quickAddVehicleLookupYear,
    addVehicleLookupMake,
    deleteVehicleLookupMake,
    deleteVehicleLookupModel,
    deleteVehicleLookupType,
    deleteVehicleLookupYear,
} from "./utils/vehicleLookupImporter.js";

dotenv.config({ debug: true });

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(compression());
app.use(helmet());

// CORS is opt-in: unset CORS_ORIGINS (the default) keeps the current
// same-origin-only behavior exactly as before. Set a comma-separated list
// in .env to allow specific browser origins (e.g. a separate marketing site
// or a mobile shell) without touching this file again.
const corsOrigins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
if (corsOrigins.length > 0) {
    const cors = (await import("cors")).default;
    // exposedHeaders: ["x-refresh-token"] // part of the disabled automatic token refresh system
    app.use(cors({ origin: corsOrigins, credentials: true }));
}

app.use(express.json({ limit: "50mb" }));
app.set('trust proxy', 1);

// General API-wide rate limit (defense in depth alongside the stricter
// auth-only limiter below).
const apiLimiter = rateLimit({
    windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
    max: Number(process.env.API_RATE_LIMIT_MAX) || 300,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(apiLimiter);

// Request logger middleware
app.use((req, res, next) => {
    const start = Date.now();
    const route = `${req.method} ${req.originalUrl}`;
    logToFile(`[API] START ${route}`);

    res.on("finish", () => {
        const duration = Date.now() - start;
        const msg = `[API] END   ${route} - ${res.statusCode} (${duration}ms)`;
        logToFile(msg);
    });
    next();
});

const initializeApp = async () => {
    await connectDB();
    try {
        await User.createIndexes();
        logToFile(`[DB] ✅ User unique indexes verified/created`);

        if (typeof updateScraperConfigFile === 'function') {
            await updateScraperConfigFile();
        }
        if (typeof startScraper === 'function') {
            startScraper();
        }
    } catch (error) {
        logToFile(`[App] ❌ Failed during initialization: ${error.message}`);
        process.exit(1);
    }
};

app.get("/health", (req, res) => {
    res.json({
        ok: true,
        uptime: process.uptime(),
    });
});

// ==========================================
// ROUTER DEFINITIONS
// ==========================================

// --- Auth Routes ---
const authRouter = express.Router();
const authLimiter = rateLimit({
    windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many attempts. Please try again in a few minutes." },
});
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

authRouter.post("/register", authLimiter, async (req, res, next) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ message: "Name, email and password are required." });
        }
        if (!EMAIL_RE.test(email)) {
            return res.status(400).json({ message: "Enter a valid email address." });
        }
        if (password.length < 8) {
            return res.status(400).json({ message: "Password must be at least 8 characters." });
        }

        const existing = await User.findOne({ email: email.toLowerCase() });
        if (existing) {
            return res.status(409).json({ message: "An account with that email already exists." });
        }

        const user = await User.create({ name, email, password, role: "guest" });
        const token = signToken({
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role
        });
        res.status(201).json({ token });
    } catch (err) {
        next(err);
    }
});

// --- Forgot password ---
// Issues a short-lived, single-use reset token. Only a hash of the token is
// stored on the user document; the raw token only ever exists in the email
// link (or, if no SMTP transport is configured, in the server log) so it
// can't be replayed from a database dump alone.
const RESET_TOKEN_EXPIRES_MS = Number(process.env.RESET_PASSWORD_EXPIRES_MS) || 60 * 60 * 1000; // 1 hour
const hashResetToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

authRouter.post("/forgot-password", authLimiter, async (req, res, next) => {
    try {
        const { email } = req.body;
        if (!email || !EMAIL_RE.test(email)) {
            return res.status(400).json({ message: "Enter a valid email address." });
        }

        const user = await User.findOne({ email: email.toLowerCase() });
        // Always return the same response whether or not the account exists,
        // so this endpoint can't be used to enumerate registered emails.
        if (user) {
            const rawToken = crypto.randomBytes(32).toString("hex");
            user.resetPasswordTokenHash = hashResetToken(rawToken);
            user.resetPasswordExpires = new Date(Date.now() + RESET_TOKEN_EXPIRES_MS);
            await user.save();

            const resetUrl = `${process.env.CLIENT_APP_URL || ""}/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}`;

            if (process.env.SMTP_HOST) {
                try {
                    const nodemailer = await import("nodemailer");
                    const transporter = nodemailer.default.createTransport({
                        host: process.env.SMTP_HOST,
                        port: Number(process.env.SMTP_PORT) || 587,
                        secure: process.env.SMTP_SECURE === "true",
                        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
                    });
                    await transporter.sendMail({
                        from: process.env.SMTP_FROM || "no-reply@extremewheel.app",
                        to: user.email,
                        subject: "Reset your ExtremeWheel password",
                        text: `Reset your password: ${resetUrl}\n\nThis link expires in ${Math.round(RESET_TOKEN_EXPIRES_MS / 60000)} minutes. If you didn't request this, you can ignore this email.`,
                    });
                } catch (mailErr) {
                    // Never let an email-transport failure block the response or
                    // leak whether the account exists; just log it server-side.
                    console.error("[forgot-password] email send failed:", mailErr.message);
                    logToFile?.(`[forgot-password] email send failed for ${user.email}: ${mailErr.message}`);
                }
            } else {
                // Dev/staff fallback with no SMTP configured — the link is
                // logged server-side rather than silently dropped.
                console.log(`[forgot-password] SMTP not configured. Reset link for ${user.email}: ${resetUrl}`);
            }
        }

        res.json({ message: "If an account exists for that email, a reset link has been sent." });
    } catch (err) { next(err); }
});

authRouter.post("/reset-password", authLimiter, async (req, res, next) => {
    try {
        const { email, token, password } = req.body;
        if (!email || !token || !password) {
            return res.status(400).json({ message: "Email, token and new password are required." });
        }
        if (password.length < 8) {
            return res.status(400).json({ message: "Password must be at least 8 characters." });
        }

        const user = await User.findOne({ email: email.toLowerCase() }).select("+resetPasswordTokenHash +resetPasswordExpires");
        if (!user || !user.resetPasswordTokenHash || !user.resetPasswordExpires) {
            return res.status(400).json({ message: "This reset link is invalid or has expired." });
        }
        if (user.resetPasswordExpires.getTime() < Date.now()) {
            return res.status(400).json({ message: "This reset link is invalid or has expired." });
        }
        if (hashResetToken(token) !== user.resetPasswordTokenHash) {
            return res.status(400).json({ message: "This reset link is invalid or has expired." });
        }

        user.password = password; // re-hashed by the pre-save hook
        user.resetPasswordTokenHash = undefined;
        user.resetPasswordExpires = undefined;
        await user.save();

        res.json({ message: "Password updated. You can now sign in." });
    } catch (err) { next(err); }
});

authRouter.post("/login", authLimiter, async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: "Email and password are required." });
        }

        const user = await User.findOne({ email: email.toLowerCase() }).select("+password");
        if (!user) {
            return res.status(401).json({ message: "Invalid email or password." });
        }

        const valid = await user.comparePassword(password);
        if (!valid) {
            return res.status(401).json({ message: "Invalid email or password." });
        }

        const token = signToken({
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role
        });

        // Return ONLY the token. No user object.
        res.json({ token });
    } catch (err) {
        next(err);
    }
});

/*
 * ============================================================
 * SILENT REFRESH ENDPOINT - TEMPORARILY DISABLED
 * ============================================================
 *
 * Keeping the route here for future use.
 *
 * Because requireAuth succeeded, the current token was valid, and this
 * simply issued a fresh one to extend the session (paired with the
 * client's heartbeat + the sliding-session logic in middleware/auth.js).
 */

/*
authRouter.post("/refresh", requireAuth, async (req, res, next) => {
    try {
        const token = signToken({
            _id: req.user._id,
            name: req.user.name,
            email: req.user.email,
            role: req.user.role
        });

        res.json({ token });
    } catch (err) {
        next(err);
    }
});
*/

authRouter.get("/me", requireAuth, async (req, res) => {
    const { name, email, role } = req.user;
    res.json({ user: { name, email, role } });
});

// --- User Routes ---
const userRouter = express.Router();
userRouter.use(requireAuth, requirePermission("user-management"));

userRouter.get("/", requireAuth, async (req, res, next) => {
    try {
        const users = await User.find().sort({ createdAt: -1 });
        res.json({ users });
    } catch (err) { next(err); }
});

userRouter.post("/", requireAuth, async (req, res, next) => {
    try {
        const { name, email, password, role } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ message: "Name, email and password are required." });
        }
        const existing = await User.findOne({ email: email.toLowerCase() });
        if (existing) {
            return res.status(409).json({ message: "An account with that email already exists." });
        }
        const user = await User.create({ name, email, password, role: role || "guest", createdBy: req.user._id });
        res.status(201).json({ user });
    } catch (err) { next(err); }
});

userRouter.put("/:id", requireAuth, async (req, res, next) => {
    try {
        const { name, email, role, password } = req.body;
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: "User not found." });

        // Permissions belong to the email address. If the email changes, this
        // may be a different person (or a reassigned mailbox), so whatever the
        // old address was granted is wiped and an admin has to grant access
        // again for the new one.
        let permissionsReset = false;
        if (typeof email === "string" && email.trim()) {
            const nextEmail = email.trim().toLowerCase();
            if (!EMAIL_RE.test(nextEmail)) {
                return res.status(400).json({ message: "Enter a valid email address." });
            }
            if (nextEmail !== user.email) {
                const taken = await User.exists({ email: nextEmail, _id: { $ne: user._id } });
                if (taken) return res.status(409).json({ message: "An account with that email already exists." });
                permissionsReset = (user.permissions || []).length > 0;
                user.email = nextEmail;
                user.permissions = [];
            }
        }

        if (name) user.name = name;
        if (role) user.role = role;
        if (password) user.password = password;
        await user.save();
        res.json({ user, permissionsReset });
    } catch (err) { next(err); }
});

userRouter.delete("/:id", requireAuth, async (req, res, next) => {
    try {
        const loggedInUserId = req.user?._id || req.user?.id;
        console.log(loggedInUserId)

        if (!loggedInUserId) {
            return res.status(401).json({ message: "Authentication required or user data malformed." });
        }

        if (req.params.id === loggedInUserId.toString()) {
            return res.status(400).json({ message: "You can't delete your own account while signed in." });
        }

        const user = await User.findByIdAndDelete(req.params.id);

        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

// --- Permission Routes ---
// Access is granted PER USER, keyed by the user's unique email, and stored on
// the User document (keys live in config/permissionCatalog.js). There is no
// role-based matrix any more; the only role rule left is that an admin account
// always has everything.
const permissionRouter = express.Router();

// The signed-in user's own grants — what the client uses to decide which pages,
// dashboard tiles and buttons to show. Read fresh from the database, so a
// change an admin just made applies without the user having to sign in again.
permissionRouter.get("/me", requireAuth, async (req, res, next) => {
    try {
        const access = await loadAccess(req);
        if (!access) {
            return res.status(401).json({ message: "Not authorized, this account no longer exists." });
        }
        res.json({
            email: access.email,
            isAdmin: access.isAdmin,
            permissions: access.isAdmin ? ALL_PERMISSION_KEYS : [...access.permissions],
        });
    } catch (err) { next(err); }
});

// Replace one user's grants. The body must name the email the admin was looking
// at: permissions are granted to an email address, so if that user's email was
// changed in the meantime (which resets their permissions) the save is refused
// rather than silently granting access to whoever holds the account now.
permissionRouter.put("/users/:id", requireAuth, requirePermission("user-management"), async (req, res, next) => {
    try {
        const { email, permissions } = req.body;

        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).json({ message: "User not found." });
        }
        if (typeof email !== "string" || !email.trim()) {
            return res.status(400).json({ message: "email is required — permissions are granted to an email address." });
        }
        if (!Array.isArray(permissions)) {
            return res.status(400).json({ message: "permissions must be an array of permission keys." });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const existing = await User.findById(req.params.id).select("email role permissions");
        if (!existing) return res.status(404).json({ message: "User not found." });
        if (existing.role === "admin") {
            return res.status(400).json({ message: "Admin accounts always have full access." });
        }
        if (existing.email !== normalizedEmail) {
            return res.status(409).json({ message: "This user's email has changed. Reload the page and review their access again." });
        }

        // Grants for pages that are hidden from the permissions screen are not
        // editable there, so keep whatever the user already holds.
        const keptHidden = (existing.permissions || []).filter((k) => HIDDEN_PAGE_KEYS.includes(k));
        const next = sanitizePermissions([...permissions, ...keptHidden]);

        // Matching on the email in the filter makes the check above atomic: if
        // the email changed between the read and this write, nothing is saved.
        const updated = await User.findOneAndUpdate(
            { _id: existing._id, email: normalizedEmail },
            { $set: { permissions: next } },
            { new: true }
        ).select("name email role permissions");
        if (!updated) {
            return res.status(409).json({ message: "This user's email has changed. Reload the page and review their access again." });
        }

        res.json({
            user: { _id: updated._id, name: updated.name, email: updated.email, role: updated.role, permissions: updated.permissions },
        });
    } catch (err) { next(err); }
});

// --- Vehicle Notes Routes ---
const vehicleNoteRouter = express.Router();
vehicleNoteRouter.use(requireAuth, requirePermission("vehicle-notes"));

// Customer name / email / phone are personal data, so — like the internal staff
// notes — they are only ever sent to staff and admin. Everyone else gets the
// vehicle without its customer.
const canViewCustomers = (req) => req.user.role === "staff" || req.user.role === "admin";

vehicleNoteRouter.get("/", requireAuth, async (req, res, next) => {
    try {
        let query = VehicleNote.find().sort({ createdAt: -1 });
        query = canViewCustomers(req)
            ? query.populate("customer", "fullName email phone")
            : query.select("-customer");
        const vehicles = await query;
        res.json({ vehicles });
    } catch (err) { next(err); }
});

// Single vehicle — backs the read-only detail page (/vehicle-notes/:id).
// Internal staff notes and the creator's name are staff/admin only; anyone
// else gets them stripped here (the client hides them for the same roles).
vehicleNoteRouter.get("/:id", async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).json({ message: "Vehicle not found." });
        }
        const vehicle = await VehicleNote.findById(req.params.id)
            .populate("createdBy", "name")
            .populate("customer", "fullName email phone")
            .lean();
        if (!vehicle) return res.status(404).json({ message: "Vehicle not found." });

        const canSeeInternal = req.user.role === "staff" || req.user.role === "admin";
        if (!canSeeInternal) {
            vehicle.staffNotes = [];
            delete vehicle.createdBy;
            delete vehicle.customer;
        }
        res.json({ vehicle });
    } catch (err) { next(err); }
});

// Normalizes the existing/upgraded engine + tyre spec payload so partial
// input (e.g. engine only, no tyre numbers yet) never crashes the write.
function normalizeSpec(spec) {
    if (!spec || typeof spec !== "object") return undefined;
    const tyre = spec.tyre && typeof spec.tyre === "object" ? spec.tyre : {};
    return {
        engine: typeof spec.engine === "string" ? spec.engine : "",
        tyre: {
            width: tyre.width !== undefined && tyre.width !== "" ? Number(tyre.width) : undefined,
            aspect: tyre.aspect !== undefined && tyre.aspect !== "" ? Number(tyre.aspect) : undefined,
            rim: tyre.rim !== undefined && tyre.rim !== "" ? Number(tyre.rim) : undefined,
        },
    };
}

// Reads the optional `customer` field of a create/update body.
//   undefined        -> { skip: true }   field not sent, leave as is
//   "" / null        -> { clear: true }  detach the customer
//   a customer id    -> { id }           attach that customer (must exist)
// Only staff and admin may touch it at all.
async function resolveCustomerField(req, customer) {
    if (customer === undefined) return { skip: true };
    if (!canViewCustomers(req)) {
        // A non-staff save that carries an empty customer field isn't trying
        // to change anything — only an actual assignment is refused.
        if (customer === null || customer === "") return { skip: true };
        return { error: { status: 403, message: "Only staff and admin can assign a customer." } };
    }
    if (customer === null || customer === "") return { clear: true };
    if (typeof customer !== "string" || !mongoose.isValidObjectId(customer)) {
        return { error: { status: 400, message: "Invalid customer." } };
    }
    const exists = await Customer.exists({ _id: customer });
    if (!exists) return { error: { status: 400, message: "That customer no longer exists." } };
    return { id: customer };
}

vehicleNoteRouter.post("/", requireAuth, requirePermission("vehicle-notes.add"), async (req, res, next) => {
    try {
        const { name, make, type, model, year, image, beforeImage, afterImage, gallery, offsetNotes, existingSpec, upgradedSpec, eventDate, staffNotes, customer } = req.body;

        if (!name || !make || !model || !type) {
            return res.status(400).json({ message: "Vehicle name, make, model and type are required." });
        }

        const customerField = await resolveCustomerField(req, customer);
        if (customerField.error) return res.status(customerField.error.status).json({ message: customerField.error.message });

        // Map initial staff notes securely if provided during "Add Vehicle"
        let mappedNotes = [];
        if (Array.isArray(staffNotes)) {
            mappedNotes = staffNotes.map(n => ({
                text: n.text,
                authorName: n.authorName || req.user.name || req.user.email,
                author: req.user._id,
                createdAt: n.createdAt ? new Date(n.createdAt) : new Date()
            }));
        }

        const vehicle = await VehicleNote.create({
            name,
            make,
            type,
            model,
            year,
            image,
            beforeImage,
            afterImage,
            gallery: Array.isArray(gallery) ? gallery : [],
            offsetNotes,
            staffNotes: mappedNotes,
            existingSpec: normalizeSpec(existingSpec),
            upgradedSpec: normalizeSpec(upgradedSpec),
            eventDate: eventDate ? new Date(eventDate) : undefined,
            ...(customerField.id && { customer: customerField.id }),
            createdBy: req.user._id,
        });
        if (canViewCustomers(req)) await vehicle.populate("customer", "fullName email phone");
        else vehicle.customer = undefined;
        res.status(201).json({ vehicle });
    } catch (err) { next(err); }
});

vehicleNoteRouter.put("/:id", requireAuth, requirePermission("vehicle-notes.edit"), async (req, res, next) => {
    try {
        const { name, make, type, model, year, image, beforeImage, afterImage, gallery, offsetNotes, existingSpec, upgradedSpec, eventDate, customer } = req.body;

        const customerField = await resolveCustomerField(req, customer);
        if (customerField.error) return res.status(customerField.error.status).json({ message: customerField.error.message });

        const vehicle = await VehicleNote.findByIdAndUpdate(
            req.params.id,
            {
                ...(customerField.id && { customer: customerField.id }),
                ...(name && { name }),
                ...(make && { make }),
                ...(type && { type }),
                ...(model && { model }),
                ...(year !== undefined && { year }),
                ...(image !== undefined && { image }),
                ...(beforeImage !== undefined && { beforeImage }),
                ...(afterImage !== undefined && { afterImage }),
                ...(Array.isArray(gallery) && { gallery }),
                ...(offsetNotes !== undefined && { offsetNotes }),
                ...(existingSpec !== undefined && { existingSpec: normalizeSpec(existingSpec) }),
                ...(upgradedSpec !== undefined && { upgradedSpec: normalizeSpec(upgradedSpec) }),
                ...(eventDate !== undefined && { eventDate: eventDate ? new Date(eventDate) : null }),
                ...(customerField.clear && { $unset: { customer: 1 } }),
            },
            { new: true }
        );
        if (!vehicle) return res.status(404).json({ message: "Vehicle not found." });
        if (canViewCustomers(req)) await vehicle.populate("customer", "fullName email phone");
        else vehicle.customer = undefined;
        res.json({ vehicle });
    } catch (err) { next(err); }
});

// --- Internal staff notes & comments ---
// Part of the internal content-management layer for Vehicle Notes: any
// authenticated staff/admin user with vehicle-notes access can leave a
// timestamped, attributed note. Guests can reach this router at all only if
// granted the "vehicle-notes" permission, but as a defense-in-depth measure
// staff notes are additionally blocked for the "guest" role outright.
const requireStaffOrAdmin = (req, res, next) => {
    if (req.user.role === "guest") {
        return res.status(403).json({ message: "Internal staff notes are restricted to staff and admin accounts." });
    }
    next();
};

// Strict role check (not the per-user permissions that requirePermission()
// reads) — for an operation that must always be admin-only no matter what has
// been granted to individual users. Used by the customer edit / delete routes
// below.
const requireAdmin = (req, res, next) => {
    if (req.user.role !== "admin") {
        return res.status(403).json({ message: "This action is restricted to admin accounts." });
    }
    next();
};

// Strictly the "staff" and "admin" roles — unlike requireStaffOrAdmin above,
// which only turns away "guest" and would therefore also let through any
// custom role created in User Management. See tireOptionRouter below.
const requireStaffOrAdminOnly = (req, res, next) => {
    if (req.user.role !== "staff" && req.user.role !== "admin") {
        return res.status(403).json({ message: "This action is restricted to staff and admin accounts." });
    }
    next();
};

vehicleNoteRouter.post("/:id/notes", requireStaffOrAdmin, async (req, res, next) => {
    try {
        const { text } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ message: "Note text is required." });
        const vehicle = await VehicleNote.findByIdAndUpdate(
            req.params.id,
            {
                $push: {
                    staffNotes: {
                        text: text.trim(),
                        authorName: req.user.name || req.user.email,
                        author: req.user._id,
                        createdAt: new Date(),
                    },
                },
            },
            { new: true }
        );
        if (!vehicle) return res.status(404).json({ message: "Vehicle not found." });
        res.status(201).json({ vehicle });
    } catch (err) { next(err); }
});

vehicleNoteRouter.delete("/:id/notes/:noteId", requireStaffOrAdmin, async (req, res, next) => {
    try {
        const vehicle = await VehicleNote.findByIdAndUpdate(
            req.params.id,
            { $pull: { staffNotes: { _id: req.params.noteId } } },
            { new: true }
        );
        if (!vehicle) return res.status(404).json({ message: "Vehicle not found." });
        res.json({ vehicle });
    } catch (err) { next(err); }
});

// Adding / removing a gallery photo changes the vehicle, so it needs the same
// permission as the Edit button.
vehicleNoteRouter.post("/:id/gallery", requireAuth, requirePermission("vehicle-notes.edit"), async (req, res, next) => {
    try {
        const { image } = req.body;
        if (!image) return res.status(400).json({ message: "image is required." });
        const vehicle = await VehicleNote.findByIdAndUpdate(
            req.params.id,
            { $push: { gallery: image } },
            { new: true }
        );
        if (!vehicle) return res.status(404).json({ message: "Vehicle not found." });
        res.json({ vehicle });
    } catch (err) { next(err); }
});

vehicleNoteRouter.delete("/:id/gallery", requireAuth, requirePermission("vehicle-notes.edit"), async (req, res, next) => {
    try {
        const { image } = req.body;
        if (!image) return res.status(400).json({ message: "image is required." });
        const vehicle = await VehicleNote.findByIdAndUpdate(
            req.params.id,
            { $pull: { gallery: image } },
            { new: true }
        );
        if (!vehicle) return res.status(404).json({ message: "Vehicle not found." });
        res.json({ vehicle });
    } catch (err) { next(err); }
});

vehicleNoteRouter.delete("/:id", requireAuth, requirePermission("vehicle-notes.delete"), async (req, res, next) => {
    try {
        const vehicle = await VehicleNote.findByIdAndDelete(req.params.id);
        if (!vehicle) return res.status(404).json({ message: "Vehicle not found." });
        res.json({ success: true });
    } catch (err) { next(err); }
});

// --- Customer Routes ---
// Customers that a vehicle note can be attached to (see models/Customer.js).
// Everything here is personal data, so the whole router is limited to the
// staff and admin roles (strict role check, not per-user permissions — same
// reasoning as requireStaffOrAdminOnly above):
//   - list / add: staff and admin
//   - edit / delete: admin only
// Email and phone are unique; a clash is reported per field.
const customerRouter = express.Router();
customerRouter.use(requireAuth, requireStaffOrAdminOnly);

// Which unique field (if any) already belongs to a *different* customer.
async function findCustomerConflict({ email, phone }, excludeId) {
    const or = [];
    if (email) or.push({ email });
    if (phone) or.push({ phone });
    if (or.length === 0) return null;
    const filter = { $or: or };
    if (excludeId) filter._id = { $ne: excludeId };
    const hit = await Customer.findOne(filter).select("email phone").lean();
    if (!hit) return null;
    if (email && hit.email === email) return "A customer with this email already exists.";
    return "A customer with this phone number already exists.";
}

// A unique-index violation that slipped past findCustomerConflict (two
// requests racing) — turn it into the same per-field message.
function duplicateKeyMessage(err) {
    if (err?.code !== 11000) return null;
    const field = Object.keys(err.keyPattern || err.keyValue || {})[0];
    if (field === "email") return "A customer with this email already exists.";
    if (field === "phone") return "A customer with this phone number already exists.";
    return "A customer with these details already exists.";
}

customerRouter.get("/", async (req, res, next) => {
    try {
        const customers = await Customer.find()
            .select("fullName email phone")
            .collation({ locale: "en", strength: 2 })
            .sort({ fullName: 1 })
            .lean();
        res.json({ customers });
    } catch (err) { next(err); }
});

customerRouter.post("/", async (req, res, next) => {
    try {
        const parsed = parseCustomerInput(req.body);
        if (parsed.error) return res.status(400).json({ message: parsed.error });

        const conflict = await findCustomerConflict(parsed.value);
        if (conflict) return res.status(409).json({ message: conflict });

        const customer = await Customer.create({ ...parsed.value, createdBy: req.user._id });
        res.status(201).json({
            customer: { _id: customer._id, fullName: customer.fullName, email: customer.email, phone: customer.phone },
        });
    } catch (err) {
        const dup = duplicateKeyMessage(err);
        if (dup) return res.status(409).json({ message: dup });
        next(err);
    }
});

customerRouter.put("/:id", requireAdmin, async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).json({ message: "Customer not found." });
        }
        // Full replace of the three editable fields — the form always sends all three.
        const parsed = parseCustomerInput(req.body);
        if (parsed.error) return res.status(400).json({ message: parsed.error });

        const conflict = await findCustomerConflict(parsed.value, req.params.id);
        if (conflict) return res.status(409).json({ message: conflict });

        const customer = await Customer.findByIdAndUpdate(
            req.params.id,
            { $set: parsed.value },
            { new: true, runValidators: true }
        ).select("fullName email phone").lean();
        if (!customer) return res.status(404).json({ message: "Customer not found." });
        res.json({ customer });
    } catch (err) {
        const dup = duplicateKeyMessage(err);
        if (dup) return res.status(409).json({ message: dup });
        next(err);
    }
});

// Deleting a customer detaches them from any vehicle notes (and saved tire
// comparisons) that pointed at them (the vehicles themselves are kept) so nothing is left referencing a
// customer that no longer exists.
customerRouter.delete("/:id", requireAdmin, async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).json({ message: "Customer not found." });
        }
        const customer = await Customer.findByIdAndDelete(req.params.id);
        if (!customer) return res.status(404).json({ message: "Customer not found." });
        const detached = await VehicleNote.updateMany({ customer: customer._id }, { $unset: { customer: 1 } });
        // Saved tire comparisons can point at a customer too — detach those as well.
        const detachedComparisons = await SavedComparison.updateMany({ customer: customer._id }, { $unset: { customer: 1 } });
        res.json({
            success: true,
            detachedVehicles: detached.modifiedCount ?? 0,
            detachedComparisons: detachedComparisons.modifiedCount ?? 0,
        });
    } catch (err) { next(err); }
});

// --- Saved Comparison Routes ---
// Backs the "Save comparison" popup on the Tire Size Comparison page. Stored in
// its own collection (models/SavedComparison.js), separate from Vehicle Notes.
// The vehicle details use the same Make / Model / Type / Year lists and the
// same Customer documents as Vehicle Notes, and are validated the same way:
// vehicle name, make, model and type are required; the customer is optional
// and, like on Vehicle Notes, only staff and admin may attach one.
const savedComparisonRouter = express.Router();
savedComparisonRouter.use(requireAuth, requirePermission("tire-comparison.save"));

// One side of the comparison: width / aspect / rim must all be positive numbers.
function parseComparisonTire(tire) {
    if (!tire || typeof tire !== "object") return null;
    const out = { width: Number(tire.width), aspect: Number(tire.aspect), rim: Number(tire.rim) };
    return Object.values(out).every((n) => Number.isFinite(n) && n > 0) ? out : null;
}

savedComparisonRouter.post("/", async (req, res, next) => {
    try {
        const { name, make, model, type, year, engine, tyre, gallery, customer, tireA, tireB, diffPct } = req.body;

        if (!name || !make || !model || !type) {
            return res.status(400).json({ message: "Vehicle name, make, model and type are required." });
        }
        const a = parseComparisonTire(tireA);
        const b = parseComparisonTire(tireB);
        if (!a || !b) {
            return res.status(400).json({ message: "Both tires need a valid width, aspect and rim." });
        }

        const customerField = await resolveCustomerField(req, customer);
        if (customerField.error) return res.status(customerField.error.status).json({ message: customerField.error.message });

        // normalizeSpec is the Vehicle Notes helper: tolerant of a blank engine
        // or partly-filled tyre numbers.
        const spec = normalizeSpec({ engine, tyre });
        const diff = Number(diffPct);

        const saved = await SavedComparison.create({
            name,
            make,
            model,
            type,
            year,
            engine: spec?.engine ?? "",
            tyre: spec?.tyre,
            gallery: Array.isArray(gallery) ? gallery.filter((g) => typeof g === "string") : [],
            ...(customerField.id && { customer: customerField.id }),
            comparison: {
                tireA: a,
                tireB: b,
                diffPct: Number.isFinite(diff) ? diff : undefined,
                summary: `${a.width}/${a.aspect}R${a.rim} vs ${b.width}/${b.aspect}R${b.rim}`,
            },
            createdBy: req.user._id,
        });
        if (canViewCustomers(req)) await saved.populate("customer", "fullName email phone");
        else saved.customer = undefined;
        res.status(201).json({ comparison: saved });
    } catch (err) { next(err); }
});

// --- Vehicle Lookup Routes (predefined Make/Model/Type dropdown data) ---
// Backs the cascading Make -> Model -> Type dropdowns on the Vehicle Notes
// "Add / Edit vehicle" form, and the Make dropdown on the Tire Size Option
// preset popup. Read access matches vehicle-notes. Downloading and uploading
// the whole table are separate per-user permissions
// (vehicle-notes.database.download / .upload) — an upload wipes and
// re-populates the reference table for every user, so grant it sparingly.
//
// Writing to the reference lists (adding and deleting Makes, Models, Types
// and Years) is limited to the staff and admin roles — requireStaffOrAdminOnly
// rather than per-user permissions, so the shared lists can only ever be
// edited by staff and admin accounts. The UI gates the same way:
// see `isStaffOrAdmin` in pages/vehiclenotes.jsx and `canManagePresets` in
// pages/tiresizeoption.jsx.
const vehicleLookupRouter = express.Router();

const VEHICLE_LOOKUP_CACHE_TTL_SECONDS = Number(process.env.VEHICLE_LOOKUP_CACHE_TTL_SECONDS) || 3600;

// The Make list is read by two pages — Vehicle Notes and Tire Size Option —
// so it's readable with access to either one. Registered ahead of the
// router-level vehicle-notes guard below so a role that has Tire Size Option
// but not Vehicle Notes can still fill in the preset form's Make dropdown.
// Merges the Make/Model/Type table with makes that were added on their own
// (see models/VehicleLookupMake.js).
vehicleLookupRouter.get("/makes", requireAuth, requireAnyPermission("vehicle-notes", "tire-options", "tire-comparison.save"), async (req, res, next) => {
    try {
        const makes = await cached("vehicle-lookup:makes", VEHICLE_LOOKUP_CACHE_TTL_SECONDS, async () => {
            const [fromLookup, standalone] = await Promise.all([
                VehicleLookup.distinct("make"),
                VehicleLookupMake.distinct("make"),
            ]);
            return Array.from(new Set([...fromLookup, ...standalone])).filter(Boolean).sort();
        });
        res.json({ makes });
    } catch (err) { next(err); }
});

// The Save comparison popup on the Tire Size Comparison page uses the same
// Make / Model / Type / Year dropdowns, so those four read-only lists are also
// readable with "tire-comparison.save". Everything else on this router
// (export, import, quick-add, delete) still needs Vehicle Notes access.
const lookupReadGuard = requireAnyPermission("vehicle-notes", "tire-comparison.save");
const lookupFullGuard = requirePermission("vehicle-notes");
vehicleLookupRouter.use(requireAuth, (req, res, next) => {
    const isListRead = req.method === "GET" && ["/models", "/types", "/years"].includes(req.path);
    return (isListRead ? lookupReadGuard : lookupFullGuard)(req, res, next);
});

vehicleLookupRouter.get("/models", async (req, res, next) => {
    try {
        const { make } = req.query;
        if (!make) return res.status(400).json({ message: "make is required." });
        const models = await cached(`vehicle-lookup:models:${make}`, VEHICLE_LOOKUP_CACHE_TTL_SECONDS, () =>
            VehicleLookup.distinct("model", { make }).then((m) => m.filter(Boolean).sort())
        );
        res.json({ models });
    } catch (err) { next(err); }
});

vehicleLookupRouter.get("/types", async (req, res, next) => {
    try {
        const { make, model } = req.query;
        const query = {};
        if (make) query.make = make;
        if (model) query.model = model;
        const cacheKey = `vehicle-lookup:types:${make || ""}:${model || ""}`;
        const types = await cached(cacheKey, VEHICLE_LOOKUP_CACHE_TTL_SECONDS, () =>
            VehicleLookup.distinct("type", query).then((t) => t.filter(Boolean).sort())
        );
        res.json({ types });
    } catch (err) { next(err); }
});

// Independent of make/model/type — see models/VehicleLookupYear.js for why.
// Sorted numerically where possible (plain 4-digit years) and falls back to
// alphabetical for anything else (e.g. a free-text "2015-2020" range value).
vehicleLookupRouter.get("/years", async (req, res, next) => {
    try {
        const years = await cached("vehicle-lookup:years", VEHICLE_LOOKUP_CACHE_TTL_SECONDS, () =>
            VehicleLookupYear.distinct("year").then((y) =>
                y.filter(Boolean).sort((a, b) => {
                    const na = Number(a), nb = Number(b);
                    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
                    return String(a).localeCompare(String(b));
                })
            )
        );
        res.json({ years });
    } catch (err) { next(err); }
});

vehicleLookupRouter.get("/export", requirePermission("vehicle-notes.database.download"), async (req, res, next) => {
    try {
        const rows = await VehicleLookup.find().sort({ make: 1, model: 1 }).lean();
        const buffer = buildVehicleLookupWorkbook(rows);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="vehicle-notes-database-${Date.now()}.xlsx"`);
        res.send(buffer);
    } catch (err) { next(err); }
});

vehicleLookupRouter.post("/import", requirePermission("vehicle-notes.database.upload"), async (req, res, next) => {
    try {
        const { fileBase64 } = req.body;
        if (!fileBase64 || typeof fileBase64 !== "string") {
            return res.status(400).json({ message: "fileBase64 (the .xlsx file, base64-encoded) is required." });
        }
        const buffer = Buffer.from(fileBase64, "base64");
        const result = await importVehicleLookupWorkbook(buffer);
        res.json(result);
    } catch (err) { next(err); }
});

// Adds one Make/Model/Type combo to the predefined list — this is what lets
// someone filling out the Vehicle Notes form type a brand new value instead
// of picking from the dropdown, and have it become a real dropdown option
// from then on. Staff and admin only, so the shared lists can't be grown by
// anyone else. Upserts, so submitting an existing combo again is a harmless
// no-op.
vehicleLookupRouter.post("/quick-add", requireStaffOrAdminOnly, async (req, res, next) => {
    try {
        const { make, model, type } = req.body;
        if (!make || !model || !type) {
            return res.status(400).json({ message: "make, model and type are all required." });
        }
        await quickAddVehicleLookup({ make: String(make).trim(), model: String(model).trim(), type: String(type).trim() });
        res.json({ ok: true });
    } catch (err) { next(err); }
});

// Same idea, for the independent Year dropdown — and gated the same way, so
// Year is no longer the one list any authenticated user could grow.
vehicleLookupRouter.post("/quick-add-year", requireStaffOrAdminOnly, async (req, res, next) => {
    try {
        const { year } = req.body;
        if (!year) return res.status(400).json({ message: "year is required." });
        await quickAddVehicleLookupYear(String(year).trim());
        res.json({ ok: true });
    } catch (err) { next(err); }
});

// Adds a Make on its own — the Tire Size Option preset popup only has a Make
// to pick (no Model/Type), so this is how "+ Add new preset name…" there
// becomes a real dropdown option. That popup is a staff-and-admin tool (the
// preset itself is created under requireStaffOrAdminOnly), so this matches.
// Upserts.
vehicleLookupRouter.post("/make", requireStaffOrAdminOnly, async (req, res, next) => {
    try {
        const make = typeof req.body?.make === "string" ? req.body.make.trim() : "";
        if (!make) return res.status(400).json({ message: "make is required." });
        await addVehicleLookupMake(make);
        res.json({ ok: true });
    } catch (err) { next(err); }
});

// Delete a Make / Model / Type / Year from the dropdown data — staff and
// admin. Values come from the query string and are only accepted as plain
// strings: these go straight into a deleteMany() filter, so an object like
// ?make[$ne]=x must never reach it. Already-saved Vehicle Notes and tire
// presets keep the make/model/type/year text they were saved with.
const queryString = (value) => (typeof value === "string" ? value.trim() : "");

// Removes the Make and everything under it (its Models and Types). This is
// also what "delete a preset name" on the Tire Size Option popup calls — the
// preset name dropdown is this same shared Make list.
vehicleLookupRouter.delete("/make", requireStaffOrAdminOnly, async (req, res, next) => {
    try {
        const make = queryString(req.query.make);
        if (!make) return res.status(400).json({ message: "make is required." });
        const removed = await deleteVehicleLookupMake(make);
        if (!removed) return res.status(404).json({ message: "Make not found." });
        res.json({ ok: true, removed });
    } catch (err) { next(err); }
});

// Removes one Model (and its Types) from under a Make; the Make stays.
vehicleLookupRouter.delete("/model", requireStaffOrAdminOnly, async (req, res, next) => {
    try {
        const make = queryString(req.query.make);
        const model = queryString(req.query.model);
        if (!make || !model) return res.status(400).json({ message: "make and model are required." });
        const removed = await deleteVehicleLookupModel(make, model);
        if (!removed) return res.status(404).json({ message: "Model not found." });
        res.json({ ok: true, removed });
    } catch (err) { next(err); }
});

// Removes one Type from a Make + Model; the Make stays.
vehicleLookupRouter.delete("/type", requireStaffOrAdminOnly, async (req, res, next) => {
    try {
        const make = queryString(req.query.make);
        const model = queryString(req.query.model);
        const type = queryString(req.query.type);
        if (!make || !model || !type) return res.status(400).json({ message: "make, model and type are required." });
        const removed = await deleteVehicleLookupType(make, model, type);
        if (!removed) return res.status(404).json({ message: "Type not found." });
        res.json({ ok: true, removed });
    } catch (err) { next(err); }
});

// Removes one Year from the independent Year list. Nothing cascades — a Year
// has no Models or Types under it (see models/VehicleLookupYear.js).
vehicleLookupRouter.delete("/year", requireStaffOrAdminOnly, async (req, res, next) => {
    try {
        const year = queryString(req.query.year);
        if (!year) return res.status(400).json({ message: "year is required." });
        const removed = await deleteVehicleLookupYear(year);
        if (!removed) return res.status(404).json({ message: "Year not found." });
        res.json({ ok: true, removed });
    } catch (err) { next(err); }
});

// --- Tire Options Routes ---
// Create/update/delete are limited to the staff and admin roles (see
// requireStaffOrAdminOnly above) — everyone with tire-options page access
// can still browse the library (used by the Calculator/Comparison/Plus Size
// pages), but only staff and admin can add to, edit, or remove from the
// shared preset list itself.
//
// A preset has no free-text name: it's named after the Make picked from the
// dropdown, so `label` always mirrors `make` (label stays on the document
// because the Calculator, Comparison, Tech Data and suggestion chips all
// read it).
const tireOptionRouter = express.Router();

tireOptionRouter.get("/", requireAuth, async (req, res, next) => {
    try {
        const options = await TireOption.find().sort({ createdAt: -1 });
        res.json({ options });
    } catch (err) { next(err); }
});

tireOptionRouter.post("/", requireAuth, requireStaffOrAdminOnly, async (req, res, next) => {
    try {
        const { label, make, width, aspect, rim } = req.body;
        const cleanMake = typeof make === "string" ? make.trim() : "";
        // The Make is the preset's name; `label` is only honored as a
        // fallback for a caller that doesn't send a make.
        const cleanLabel = cleanMake || (typeof label === "string" ? label.trim() : "");
        if (!cleanLabel || !width || !aspect || !rim) {
            return res.status(400).json({ message: "All fields are required." });
        }
        const option = await TireOption.create({ label: cleanLabel, make: cleanMake, width, aspect, rim, createdBy: req.user._id });

        // Keep oe_tiresize in sync with the Tire Size Option library — insert
        // only (see upsertOeTireSize), so a size that's already on file from
        // another source is left untouched.
        upsertOeTireSize(
            { width: option.width, aspect: option.aspect, rim: option.rim },
            "tire-options",
            { sourceRef: option._id, label: option.label }
        ).catch((err) => logToFile(`[OeTireSize] sync from TireOption create failed: ${err.message}`));

        res.status(201).json({ option });
    } catch (err) { next(err); }
});

tireOptionRouter.put("/:id", requireAuth, requireStaffOrAdminOnly, async (req, res, next) => {
    try {
        const { label, make, width, aspect, rim } = req.body;
        const update = {};
        if (make !== undefined) update.make = typeof make === "string" ? make.trim() : "";
        // Name follows the Make; `label` on its own only applies when no make is being set.
        if (update.make) update.label = update.make;
        else if (typeof label === "string" && label.trim()) update.label = label.trim();
        if (width) update.width = width;
        if (aspect) update.aspect = aspect;
        if (rim) update.rim = rim;

        const option = await TireOption.findByIdAndUpdate(req.params.id, update, { new: true });
        if (!option) return res.status(404).json({ message: "Preset not found." });

        // A width/aspect/rim edit can introduce a size oe_tiresize hasn't
        // seen yet — sync it the same way the create route does.
        upsertOeTireSize(
            { width: option.width, aspect: option.aspect, rim: option.rim },
            "tire-options",
            { sourceRef: option._id, label: option.label }
        ).catch((err) => logToFile(`[OeTireSize] sync from TireOption update failed: ${err.message}`));

        res.json({ option });
    } catch (err) { next(err); }
});

tireOptionRouter.delete("/:id", requireAuth, requireStaffOrAdminOnly, async (req, res, next) => {
    try {
        const option = await TireOption.findByIdAndDelete(req.params.id);
        if (!option) return res.status(404).json({ message: "Preset not found." });
        res.json({ success: true });
    } catch (err) { next(err); }
});

// --- Plus Size Recommendation Routes ---
const plusSizeRouter = express.Router();
plusSizeRouter.use(requireAuth, requirePermission("plus-size"));

const PLUS_SIZE_HEIGHT_TOLERANCE_PCT = Number(process.env.PLUS_SIZE_HEIGHT_TOLERANCE_PCT) || 0.03;
const PLUS_SIZE_TREAD_TOLERANCE_PCT = Number(process.env.PLUS_SIZE_TREAD_TOLERANCE_PCT) || 0.15;

plusSizeRouter.post("/search", async (req, res, next) => {
    try {
        const { width, aspect, rim } = req.body;
        // TEMPORARILY DISABLED — targetRim / heightTolerancePct /
        // treadTolerancePct / sortBy overrides from the request body.
        // Reason: the frontend controls for these (Target rim, Height
        // tolerance, Tread width tolerance, Sort results by on the Plus
        // Size page) have a bug where clearing/leaving the tolerance
        // fields blank sends heightTolerancePct/treadTolerancePct as 0
        // instead of omitting them, since Number("") === 0 in JS — so the
        // search silently ran at a 0% tolerance (effectively "exact float
        // match only") and always came back empty. Disabling the override
        // path here (in step with the matching frontend fields, also
        // commented out in pages/plussizeoptions.jsx) makes every search
        // fall back to the server's own defaults below, every time,
        // matching the original spec: OE width/aspect/rim in, its
        // own height range computed, then a straight match against
        // oe_tiresize with no manual overrides. Re-enable by uncommenting
        // this destructure and the two blocks below once the frontend
        // fields are fixed to send `undefined` (not `0`/`""`) when empty.
        // const { targetRim, heightTolerancePct, treadTolerancePct, sortBy } = req.body;
        const oe = { width: Number(width), aspect: Number(aspect), rim: Number(rim) };
        if (!oe.width || !oe.aspect || !oe.rim) {
            return res.status(400).json({ message: "OE width, aspect and rim are required." });
        }

        // Client can narrow/widen the tolerance windows per search; falls back
        // to the server-configured defaults when not supplied.
        // TEMPORARILY DISABLED — see the note above; always use the server
        // defaults for now instead of reading an override from the client.
        // const heightTolPct = Number.isFinite(Number(heightTolerancePct)) && heightTolerancePct !== ""
        //     ? Math.max(0, Number(heightTolerancePct))
        //     : PLUS_SIZE_HEIGHT_TOLERANCE_PCT * 100;
        // const treadTolPct = Number.isFinite(Number(treadTolerancePct)) && treadTolerancePct !== ""
        //     ? Math.max(0, Number(treadTolerancePct))
        //     : PLUS_SIZE_TREAD_TOLERANCE_PCT * 100;
        const heightTolPct = PLUS_SIZE_HEIGHT_TOLERANCE_PCT * 100;
        const treadTolPct = PLUS_SIZE_TREAD_TOLERANCE_PCT * 100;

        // Step 1: run the OE size through the exact same worksheet formulas
        // used to precompute every oe_tiresize row — overall height, tread
        // width, and the upper/lower bound of each at the requested
        // tolerance (e.g. height x 1.03 / x 0.97 for a 3% window).
        const oeLimits = tireToleranceLimits(oe, {
            heightTolerance: heightTolPct / 100,
            treadTolerance: treadTolPct / 100,
        });
        const oeHeight = oeLimits.overallHeightIn;
        const oeTread = oeLimits.treadWidthIn;

        // Step 2: only once the OE's own height range is known, query
        // oe_tiresize for rows whose precomputed overallHeightIn falls
        // between that lower and upper limit — an indexed range query
        // against the library (see OeTireSize's {rim,overallHeightIn}
        // index) instead of loading every row and computing tire math
        // per-candidate.
        const query = {
            overallHeightIn: { $gte: oeLimits.heightLowerLimitIn, $lte: oeLimits.heightUpperLimitIn },
        };
        // TEMPORARILY DISABLED — targetRim narrowing (see note above).
        // if (targetRim) query.rim = Number(targetRim);
        const heightMatches = await OeTireSize.find(query).lean();

        // Step 3: tread width — diff vs the OE from the precomputed treadWidthIn (display + ranking only, NOT a filter)
        // already stored on each candidate (no re-derivation needed).
        const withinTolerance = heightMatches
            .map((c) => {
                const heightDiffPct = ((c.overallHeightIn - oeHeight) / oeHeight) * 100;
                const treadDiffPct = ((c.treadWidthIn - oeTread) / oeTread) * 100;
                return {
                    _id: c._id,
                    label: c.label || "",
                    width: c.width,
                    aspect: c.aspect,
                    rim: c.rim,
                    source: c.source,
                    overallHeightIn: Number(c.overallHeightIn.toFixed(3)),
                    treadWidthIn: Number(c.treadWidthIn.toFixed(3)),
                    heightDiffPct: Number(heightDiffPct.toFixed(3)),
                    treadDiffPct: Number(treadDiffPct.toFixed(3)),
                };
            })
            // TEMPORARILY DISABLED — tread width is NOT a filter. Per the spec the
            // match is decided by the overall-height range (lower/upper limit)
            // alone; tread width is still calculated and shown (and still feeds
            // the "closest first" ranking below), but a size is never dropped for
            // it. With this filter on, e.g. 305/35R20 (height -0.249%, well inside
            // the +/-3% window) was hidden for a 265/55R17 OE because its tread was
            // 15.094% off vs the 15% limit. Re-enable by uncommenting:
            // .filter((r) => Math.abs(r.treadDiffPct) <= treadTolPct)
            .map((r) => ({
                ...r,
                // Percentage-difference ranking score: combined closeness to OE
                // across both height and tread, smaller is better.
                combinedDiffPct: Number((Math.abs(r.heightDiffPct) + Math.abs(r.treadDiffPct)).toFixed(3)),
            }));

        // "Closest matches (difference closest to zero) displayed first" —
        // sort ascending on |diff|, so the #1 rank is always the nearest
        // match, not just the first survivor of the tolerance filters above.
        // TEMPORARILY DISABLED — sortBy override (see note above); always
        // sort by the combined height+tread closeness for now.
        // const sortKey = { height: "heightDiffPct", tread: "treadDiffPct", combined: "combinedDiffPct" }[sortBy] || "combinedDiffPct";
        const sortKey = "combinedDiffPct";
        withinTolerance.sort((a, b) => Math.abs(a[sortKey]) - Math.abs(b[sortKey]));
        const results = withinTolerance.map((r, i) => ({ ...r, rank: i + 1 }));

        res.json({
            oe: {
                ...oe,
                // 4dp, not 3 — precise enough that formatInches() on the client
                // (which itself always shows 4dp) displays the real computed
                // value instead of a zero-padded 3dp one (28.4760 vs the actual
                // 28.4764). This is the OE's own height/tread, never rounded
                // for the tolerance window below — see tireToleranceLimits().
                overallHeightIn: Number(oeHeight.toFixed(4)),
                treadWidthIn: Number(oeTread.toFixed(4)),
                // The actual window this search queried against — sending it
                // back lets the tolerance cards on the Plus Size page display
                // exactly what was used, instead of re-deriving it client-side
                // from the (rounded) overallHeightIn above, which is what
                // produced the ~0.0001" drift off the worksheet noticed
                // earlier (28.4760-based lower/upper vs the true
                // 28.4764-based ones). buildToleranceWindow() in
                // plussizeoptions.jsx already prefers these fields when present.
                heightLowerLimitIn: Number(oeLimits.heightLowerLimitIn.toFixed(4)),
                heightUpperLimitIn: Number(oeLimits.heightUpperLimitIn.toFixed(4)),
                treadLowerLimitIn: Number(oeLimits.treadLowerLimitIn.toFixed(4)),
                treadUpperLimitIn: Number(oeLimits.treadUpperLimitIn.toFixed(4)),
            },
            tolerances: { heightPct: heightTolPct, treadPct: treadTolPct },
            sortBy: sortKey,
            results,
        });
    } catch (err) { next(err); }
});

// --- OE tire size library upload/download (oe_tiresize) ---
// Same "base64 .xlsx in the JSON body" shape as /vehicle-lookup/import, and
// the same buffer-download shape as /vehicle-lookup/export — see
// utils/oeTireSizeExcel.js. Upload is insert-only (a duplicate width/
// aspect/rim is left exactly as it is, never overwritten). Upload and download
// are each their own per-user permission (plus-size.upload / plus-size.download).
plusSizeRouter.post("/oe-tiresize/import", requirePermission("plus-size.upload"), async (req, res, next) => {
    try {
        const { fileBase64, fileName } = req.body;
        if (!fileBase64 || typeof fileBase64 !== "string") {
            return res.status(400).json({ message: "fileBase64 (the .xlsx file, base64-encoded) is required." });
        }
        const buffer = Buffer.from(fileBase64, "base64");
        const result = await importOeTireSizeWorkbook(buffer, { fileName });
        res.json(result);
    } catch (err) { next(err); }
});

plusSizeRouter.get("/oe-tiresize/export", requirePermission("plus-size.download"), async (req, res, next) => {
    try {
        const rows = await fetchAllOeTireSizesForExport();
        const buffer = buildOeTireSizeWorkbook(rows);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="oe-tiresize-${Date.now()}.xlsx"`);
        res.send(buffer);
    } catch (err) { next(err); }
});

plusSizeRouter.post("/save", async (req, res, next) => {
    try {
        const { oe, match, tolerances, summary } = req.body;
        if (!oe || !match) {
            return res.status(400).json({ message: "oe and match are required." });
        }
        const activity = await RecentActivity.create({
            type: "plus-size",
            data: { oe, match, tolerances },
            summary:
                summary ||
                `${oe.width}/${oe.aspect}R${oe.rim} → ${match.width}/${match.aspect}R${match.rim} (${match.label || "plus-size match"})`,
            createdBy: req.user._id,
        });
        res.status(201).json({ activity });
    } catch (err) { next(err); }
});

// --- Recent Activity Routes ---
const activityRouter = express.Router();
activityRouter.use(requireAuth);

activityRouter.post("/tire-comparison", requirePermission("tire-comparison.save"), async (req, res, next) => {
    try {
        const { tireA, tireB, diffPct, summary } = req.body;
        if (!tireA || !tireB) {
            return res.status(400).json({ message: "tireA and tireB are required." });
        }
        const activity = await RecentActivity.create({
            type: "tire-comparison",
            data: { tireA, tireB, diffPct },
            summary: summary || `${tireA.width}/${tireA.aspect}R${tireA.rim} vs ${tireB.width}/${tireB.aspect}R${tireB.rim}`,
            createdBy: req.user._id,
        });
        res.status(201).json({ activity });
    } catch (err) { next(err); }
});

activityRouter.post("/vehicle-search", async (req, res, next) => {
    try {
        const { year, make, model, type, option, summary } = req.body;
        if (!year || !make || !model) {
            return res.status(400).json({ message: "year, make and model are required." });
        }
        const activity = await RecentActivity.create({
            type: "vehicle-search",
            data: { year, make, model, type, option },
            summary: summary || `${year} ${make} ${model}${type ? ` — ${type}` : ""}`,
            createdBy: req.user._id,
        });
        res.status(201).json({ activity });
    } catch (err) { next(err); }
});

activityRouter.get("/recent", async (req, res, next) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 5, 20);
        const [tireComparisons, vehicleSearches, plusSizeSaves] = await Promise.all([
            RecentActivity.find({ type: "tire-comparison" }).sort({ createdAt: -1 }).limit(limit).lean(),
            RecentActivity.find({ type: "vehicle-search" }).sort({ createdAt: -1 }).limit(limit).lean(),
            RecentActivity.find({ type: "plus-size" }).sort({ createdAt: -1 }).limit(limit).lean(),
        ]);
        res.json({ tireComparisons, vehicleSearches, plusSizeSaves });
    } catch (err) { next(err); }
});

// Cross-feature "did you already save something like this?" lookup, used by
// the Tire Size Calculator / Comparison / Option / Plus Size pages to
// surface matching saved presets, past comparisons and vehicle notes
// (with before/after photos + existing/upgraded engine & tyre spec) right
// under a freshly computed result.
activityRouter.get("/suggestions", async (req, res, next) => {
    try {
        const width = Number(req.query.width);
        const aspect = Number(req.query.aspect);
        const rim = Number(req.query.rim);
        if (!width || !aspect || !rim) {
            return res.status(400).json({ message: "width, aspect and rim are required." });
        }

        const [presets, comparisons, plusSizeSaves, vehicles] = await Promise.all([
            TireOption.find({ width, aspect, rim }).limit(6).lean(),
            RecentActivity.find({
                type: "tire-comparison",
                $or: [
                    { "data.tireA.width": width, "data.tireA.aspect": aspect, "data.tireA.rim": rim },
                    { "data.tireB.width": width, "data.tireB.aspect": aspect, "data.tireB.rim": rim },
                ],
            })
                .sort({ createdAt: -1 })
                .limit(6)
                .lean(),
            RecentActivity.find({
                type: "plus-size",
                $or: [
                    { "data.oe.width": width, "data.oe.aspect": aspect, "data.oe.rim": rim },
                    { "data.match.width": width, "data.match.aspect": aspect, "data.match.rim": rim },
                ],
            })
                .sort({ createdAt: -1 })
                .limit(6)
                .lean(),
            VehicleNote.find({
                $or: [
                    { "existingSpec.tyre.width": width, "existingSpec.tyre.aspect": aspect, "existingSpec.tyre.rim": rim },
                    { "upgradedSpec.tyre.width": width, "upgradedSpec.tyre.aspect": aspect, "upgradedSpec.tyre.rim": rim },
                ],
            })
                .limit(6)
                .lean(),
        ]);

        res.json({ presets, comparisons, plusSizeSaves, vehicles });
    } catch (err) { next(err); }
});

// --- Dashboard Routes ---
const dashboardRouter = express.Router();
dashboardRouter.use(requireAuth, requirePermission("dashboard"));

dashboardRouter.get("/summary", requireAuth, async (req, res, next) => {
    try {
        const [
            totalUsers,
            totalVehicles,
            tirePresets,
            roleAgg,
            recentVehicles,
            recentTireComparisons,
            recentVehicleSearches,
            recentPlusSizeSaves,
            reportsTotal,
            reportsLast7Days,
        ] = await Promise.all([
            User.countDocuments(),
            VehicleNote.countDocuments(),
            TireOption.countDocuments(),
            User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
            VehicleNote.find().sort({ createdAt: -1 }).limit(5).select("name type model"),
            RecentActivity.find({ type: "tire-comparison" }).sort({ createdAt: -1 }).limit(5).lean(),
            RecentActivity.find({ type: "vehicle-search" }).sort({ createdAt: -1 }).limit(5).lean(),
            RecentActivity.find({ type: "plus-size" }).sort({ createdAt: -1 }).limit(5).lean(),
            RecentActivity.countDocuments(),
            RecentActivity.countDocuments({ createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }),
        ]);

        const usersByRole = { admin: 0, staff: 0, guest: 0 };
        roleAgg.forEach((r) => {
            if (r._id in usersByRole) {
                usersByRole[r._id] = r.count;
            }
        });

        // Each dashboard tile has its own permission (dashboard.tile.*). The
        // data behind a tile is only sent to users who may see that tile —
        // hiding a card in the UI alone would still leave its numbers in the
        // API response.
        const can = (tile) => hasPermission(req.access, `dashboard.tile.${tile}`);
        const summary = {};

        if (can("total-users")) summary.totalUsers = totalUsers;
        if (can("vehicle-notes")) summary.totalVehicles = totalVehicles;
        if (can("tire-presets")) summary.tirePresets = tirePresets;
        if (can("users-by-role")) summary.usersByRole = usersByRole;
        if (can("recent-vehicles")) summary.recentVehicles = recentVehicles;
        if (can("recent-comparisons")) summary.recentTireComparisons = recentTireComparisons;
        if (can("recent-vehicle-searches")) summary.recentVehicleSearches = recentVehicleSearches;
        if (can("recent-plus-size")) summary.recentPlusSizeSaves = recentPlusSizeSaves;
        if (can("reports")) summary.reportsSummary = { totalActivity: reportsTotal, last7Days: reportsLast7Days };

        // The Tire showroom previews the most recently compared size. It gets its
        // own field so it doesn't depend on (or expose) the comparisons list.
        if (can("tire-showroom")) {
            const latest = recentTireComparisons[0]?.data;
            const tire = latest?.tireB || latest?.tireA;
            if (tire?.width && tire?.rim) {
                summary.showroomTire = { width: tire.width, aspect: tire.aspect, rim: tire.rim };
            }
        }

        res.json(summary);
    } catch (err) { next(err); }
});

// --- Role Routes ---
const roleRouter = express.Router();
roleRouter.use(requireAuth);

roleRouter.get("/", requireAuth, async (req, res, next) => {
    try {
        const roles = await Role.find()
            .select("role_key role_name is_system -_id")
            .sort({ createdAt: 1 })
            .lean();

        res.json({ roles });
    } catch (err) {
        next(err);
    }
});

roleRouter.post("/", requirePermission("user-management"), async (req, res, next) => {
    try {
        const { role_key, role_name } = req.body;

        if (!role_key || !role_name) {
            return res.status(400).json({ message: "role_key and role_name are required." });
        }

        const formattedKey = role_key.toLowerCase().replace(/\s+/g, '_');

        const existing = await Role.findOne({ role_key: formattedKey });
        if (existing) {
            return res.status(409).json({ message: "A role with this key already exists." });
        }

        const role = await Role.create({ role_key: formattedKey, role_name });
        res.status(201).json({ role });
    } catch (err) {
        next(err);
    }
});

// --- Navigation Routes ---
const navigationRouter = express.Router();
navigationRouter.use(requireAuth);

navigationRouter.get("/", (req, res, next) => {
    try {
        res.json({ nav: NAV_PAGES });
    } catch (err) {
        next(err);
    }
});

// --- Application Guide Routes ---
const appGuideRouter = express.Router();
appGuideRouter.use(requireAuth);

appGuideRouter.use(requireAnyPermission("application-guide", "tech-data"));
const APP_GUIDE_CACHE_TTL_SECONDS = Number(process.env.APP_GUIDE_CACHE_TTL_SECONDS) || 3600;

appGuideRouter.get("/years", async (req, res, next) => {
    try {
        const years = await cached("app-guide:years", APP_GUIDE_CACHE_TTL_SECONDS, () =>
            AppGuide.distinct("txtYear").then((y) => y.filter(Boolean).sort().reverse())
        );
        res.json({ years });
    } catch (err) { next(err); }
});

appGuideRouter.get("/makes", async (req, res, next) => {
    try {
        const { year } = req.query;
        if (!year) return res.status(400).json({ message: "year is required." });
        const makes = await cached(`app-guide:makes:${year}`, APP_GUIDE_CACHE_TTL_SECONDS, () =>
            AppGuide.distinct("txtMake", { txtYear: year }).then((m) => m.filter(Boolean).sort())
        );
        res.json({ makes });
    } catch (err) { next(err); }
});

appGuideRouter.get("/models", async (req, res, next) => {
    try {
        const { year, make } = req.query;
        if (!year || !make) return res.status(400).json({ message: "year and make are required." });
        const models = await cached(`app-guide:models:${year}:${make}`, APP_GUIDE_CACHE_TTL_SECONDS, () =>
            AppGuide.distinct("txtModel", { txtYear: year, txtMake: make }).then((m) => m.filter(Boolean).sort())
        );
        res.json({ models });
    } catch (err) { next(err); }
});

appGuideRouter.get("/types", async (req, res, next) => {
    try {
        const { year, make, model } = req.query;
        if (!year || !make || !model) return res.status(400).json({ message: "year, make and model are required." });
        const types = await cached(`app-guide:types:${year}:${make}:${model}`, APP_GUIDE_CACHE_TTL_SECONDS, async () => {
            const rows = await AppGuide.find({ txtYear: year, txtMake: make, txtModel: model })
                .select("txtType txtOption -_id")
                .lean();
            const seen = new Set();
            return rows
                .map((r) => ({ type: r.txtType, option: r.txtOption }))
                .filter((r) => {
                    const k = `${r.type}|${r.option}`;
                    if (seen.has(k)) return false;
                    seen.add(k);
                    return true;
                });
        });
        res.json({ types });
    } catch (err) { next(err); }
});

appGuideRouter.get("/fitment", async (req, res, next) => {
    try {
        const { year, make, model, type, option } = req.query;
        if (!year || !make || !model || !type) {
            return res.status(400).json({ message: "year, make, model and type are required." });
        }
        const query = { txtYear: year, txtMake: make, txtModel: model, txtType: type };
        if (option) query.txtOption = option;

        const cacheKey = `app-guide:fitment:${year}:${make}:${model}:${type}:${option || ""}`;
        const fitment = await cached(cacheKey, APP_GUIDE_CACHE_TTL_SECONDS, () =>
            AppGuide.find(query).lean()
        );
        res.json({ fitment });
    } catch (err) { next(err); }
});

const TECH_DATA_CSV_COLUMNS = [
    { key: "txtYear", label: "Year" },
    { key: "txtMake", label: "Make" },
    { key: "txtModel", label: "Model" },
    { key: "txtType", label: "Type" },
    { key: "txtOption", label: "Option" },
    { key: "txtTireSize", label: "Tire Size" },
    { key: "txtOptTireSize", label: "Optional Tire Size" },
    { key: "txtBolt", label: "Bolt Pattern" },
    { key: "txtLug", label: "Lug" },
    { key: "txtHub", label: "Hub Bore" },
    { key: "txtOffset", label: "Offset" },
    { key: "minOffset", label: "Min Offset" },
    { key: "maxOffset", label: "Max Offset" },
    { key: "minOffsetRear", label: "Min Offset Rear" },
    { key: "maxOffsetRear", label: "Max Offset Rear" },
    { key: "wheelCode", label: "Wheel Code" },
    { key: "bigBrake", label: "Big Brake" },
];

// The Tech Data "CSV import / export" tab: both directions need its permission.
appGuideRouter.get("/export", requirePermission("tech-data.csv-tab"), async (req, res, next) => {
    try {
        const { year, make, model } = req.query;
        const query = {};
        if (year) query.txtYear = year;
        if (make) query.txtMake = make;
        if (model) query.txtModel = model;

        const rows = await AppGuide.find(query).limit(20000).lean();
        const csv = toCsv(TECH_DATA_CSV_COLUMNS, rows);

        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="tech-data-export-${Date.now()}.csv"`);
        res.send(csv);
    } catch (err) { next(err); }
});

appGuideRouter.post("/import", requirePermission("tech-data.csv-tab"), async (req, res, next) => {
    try {
        const { csv } = req.body;
        if (!csv || typeof csv !== "string") {
            return res.status(400).json({ message: "csv (raw CSV text) is required." });
        }

        const labelToKey = Object.fromEntries(TECH_DATA_CSV_COLUMNS.map((c) => [c.label, c.key]));
        const rows = parseCsv(csv);

        let processed = 0;
        let skipped = 0;
        const batch = [];

        for (const row of rows) {
            const doc = {};
            for (const [label, value] of Object.entries(row)) {
                const key = labelToKey[label.trim()];
                if (!key) continue;
                if (value === "" || value === undefined || value === null) continue;
                doc[key] = value.trim();
            }

            if (!doc.txtYear || !doc.txtMake || !doc.txtModel || !doc.txtType) {
                skipped++;
                continue;
            }

            batch.push({
                updateOne: {
                    filter: {
                        txtYear: doc.txtYear,
                        txtMake: doc.txtMake,
                        txtModel: doc.txtModel,
                        txtType: doc.txtType,
                        txtOption: doc.txtOption || "",
                    },
                    update: { $set: doc },
                    upsert: true,
                },
            });
            processed++;
        }

        if (batch.length) {
            await AppGuide.bulkWrite(batch, { ordered: false });
            await invalidatePrefix("app-guide:");
        }

        res.json({ processed, skipped, total: rows.length });
    } catch (err) { next(err); }
});

// --- Reporting & Data Export Routes ---
const reportsRouter = express.Router();
reportsRouter.use(requireAuth, requirePermission("reports"));

const parseDateRange = (req) => {
    const { from, to } = req.query;
    const range = {};
    if (from) range.$gte = new Date(from);
    if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        range.$lte = end;
    }
    return Object.keys(range).length ? range : null;
};

reportsRouter.get("/summary", async (req, res, next) => {
    try {
        const range = parseDateRange(req);
        const createdAtFilter = range ? { createdAt: range } : {};

        const [vehiclesAdded, tireComparisons, vehicleSearches, tirePresetsAdded] = await Promise.all([
            VehicleNote.countDocuments(createdAtFilter),
            RecentActivity.countDocuments({ type: "tire-comparison", ...createdAtFilter }),
            RecentActivity.countDocuments({ type: "vehicle-search", ...createdAtFilter }),
            TireOption.countDocuments(createdAtFilter),
        ]);

        res.json({
            range: { from: req.query.from || null, to: req.query.to || null },
            vehiclesAdded,
            tireComparisons,
            vehicleSearches,
            tirePresetsAdded,
        });
    } catch (err) { next(err); }
});

const REPORT_EXPORTERS = {
    vehicles: {
        columns: [
            { key: "name", label: "Name" },
            { key: "make", label: "Make" },
            { key: "model", label: "Model" },
            { key: "type", label: "Type" },
            { key: "year", label: "Year" },
            { key: (r) => (r.eventDate ? new Date(r.eventDate).toISOString() : ""), label: "Event Date" },
            { key: (r) => (r.createdAt ? new Date(r.createdAt).toISOString() : ""), label: "Created At" },
        ],
        fetch: (filter) => VehicleNote.find(filter).sort({ createdAt: -1 }).lean(),
    },
    "tire-comparisons": {
        columns: [
            { key: "summary", label: "Comparison" },
            { key: (r) => r.data?.diffPct ?? "", label: "Speedo Diff %" },
            { key: (r) => (r.createdAt ? new Date(r.createdAt).toISOString() : ""), label: "Created At" },
        ],
        fetch: (filter) => RecentActivity.find({ type: "tire-comparison", ...filter }).sort({ createdAt: -1 }).lean(),
    },
    "vehicle-searches": {
        columns: [
            { key: "summary", label: "Vehicle Search" },
            { key: (r) => (r.createdAt ? new Date(r.createdAt).toISOString() : ""), label: "Created At" },
        ],
        fetch: (filter) => RecentActivity.find({ type: "vehicle-search", ...filter }).sort({ createdAt: -1 }).lean(),
    },
    "tire-options": {
        columns: [
            { key: "label", label: "Preset" },
            { key: "width", label: "Width" },
            { key: "aspect", label: "Aspect" },
            { key: "rim", label: "Rim" },
            { key: (r) => (r.createdAt ? new Date(r.createdAt).toISOString() : ""), label: "Created At" },
        ],
        fetch: (filter) => TireOption.find(filter).sort({ createdAt: -1 }).lean(),
    },
};

reportsRouter.get("/export", requirePermission("reports.download"), async (req, res, next) => {
    try {
        const { type } = req.query;
        const exporter = REPORT_EXPORTERS[type];
        if (!exporter) {
            return res.status(400).json({ message: `Unknown report type. Use one of: ${Object.keys(REPORT_EXPORTERS).join(", ")}` });
        }

        const range = parseDateRange(req);
        const rows = await exporter.fetch(range ? { createdAt: range } : {});
        const csv = toCsv(exporter.columns, rows);

        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="${type}-report-${Date.now()}.csv"`);
        res.send(csv);
    } catch (err) { next(err); }
});

app.use("/auth", authRouter);
app.use("/users", userRouter);
app.use("/permissions", permissionRouter);
app.use("/vehicle-notes", vehicleNoteRouter);
app.use("/customers", customerRouter);
app.use("/saved-comparisons", savedComparisonRouter);
app.use("/vehicle-lookup", vehicleLookupRouter);
app.use("/tire-options", tireOptionRouter);
app.use("/plus-size", plusSizeRouter);
app.use("/dashboard", dashboardRouter);
app.use("/activity", activityRouter);
app.use("/reports", reportsRouter);
app.use("/roles", roleRouter);
app.use("/app-guide", appGuideRouter);
app.use("/navigation", navigationRouter);

app.use((req, res) => {
    res.status(404).json({ message: "Not found." });
});

app.use(errorHandler);

initializeApp()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`[server] The extremewheel api server is running on port ${PORT}`);
        });
    })
    .catch((err) => {
        console.error("[server] failed to start:", err.message);
        process.exit(1);
    });