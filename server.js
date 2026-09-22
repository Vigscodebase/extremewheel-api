// server.js
import express from "express";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";
import helmet from "helmet";
import compression from "compression";
import crypto from "crypto";

import logToFile from "./logger.js";
import connectDB from "./config/db.js";
import errorHandler from "./middleware/errorHandler.js";
import rateLimit from "express-rate-limit";

// Models
import User from "./models/User.js";
import Permission from "./models/Permission.js";
import TireOption from "./models/TireOption.js";
import VehicleNote from "./models/VehicleNote.js";
import VehicleLookup from "./models/VehicleLookup.js";
import VehicleLookupYear from "./models/VehicleLookupYear.js";
import VehicleLookupMake from "./models/VehicleLookupMake.js";
import Role from "./models/Role.js";
import AppGuide from "./models/AppGuide.js";
import RecentActivity from "./models/RecentActivity.js";

// Middleware
import { requireAuth, requirePermission, requireAnyPermission } from "./middleware/auth.js";
import { signToken } from "./utils/jwt.js";
import { cached, invalidatePrefix } from "./config/redis.js";
import { tireOverallHeightInches, tireTreadWidthInches } from "./utils/tireMath.js";
import { parseCsv, toCsv } from "./utils/csv.js";
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
    app.use(cors({ origin: corsOrigins, credentials: true, exposedHeaders: ["x-refresh-token"] }));
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

// --- NEW SILENT REFRESH ENDPOINT ---
authRouter.post("/refresh", requireAuth, async (req, res, next) => {
    try {
        // Because requireAuth succeeded, the current token is valid. 
        // We simply issue a fresh one to extend their session.
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

        if (name) user.name = name;
        if (email) user.email = email;
        if (role) user.role = role;
        if (password) user.password = password;
        await user.save();
        res.json({ user });
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

// --- Shared page/navigation registry ---
const NAV_PAGES = [
    { key: "dashboard", label: "Dashboard", path: "/dashboard", icon: "LayoutDashboard" },
    { key: "tire-calculator", label: "Tire Size Calculator", path: "/tire-calculator", icon: "Calculator" },
    { key: "tire-comparison", label: "Tire Size Comparison", path: "/tire-comparison", icon: "Scale" },
    { key: "tire-options", label: "Tire Size Option", path: "/tire-options", icon: "SlidersHorizontal" },
    { key: "plus-size", label: "Plus Size Options", path: "/plus-size", icon: "TrendingUp" },
    { key: "tech-data", label: "Tech Data", path: "/tech-data", icon: "Wrench" },
    { key: "vehicle-notes", label: "Vehicle Notes", path: "/vehicle-notes", icon: "Car" },
    { key: "reports", label: "Reporting & Data Export", path: "/reports", icon: "FileBarChart" },
    { key: "user-management", label: "User Management", path: "/user-management", icon: "Users" }
];
const ALL_PAGE_KEYS = NAV_PAGES.map((p) => p.key);

// --- Permission Routes ---
const permissionRouter = express.Router();
const DEFAULTS = {
    key: "global",
    matrix: {
        admin: ALL_PAGE_KEYS,
        staff: [
            "dashboard",
            "tire-calculator",
            "tire-comparison",
            "tire-options",
            "plus-size",
            "application-guide",
            "tech-data",
            "vehicle-notes",
            "reports",
        ],
        guest: ["dashboard", "tire-calculator", "tire-comparison"],
    }
};

const getOrCreatePermissions = async () => {
    let doc = await Permission.findOne({ key: "global" });
    if (!doc) doc = await Permission.create(DEFAULTS);

    if (JSON.stringify(doc.matrix.get("admin") || []) !== JSON.stringify(ALL_PAGE_KEYS)) {
        doc.matrix.set("admin", ALL_PAGE_KEYS);
        await doc.save();
    }

    return doc;
};

permissionRouter.get("/", requireAuth, async (req, res, next) => {
    try {
        const doc = await getOrCreatePermissions();
        res.json({ permissions: doc.matrix.toJSON() });
    } catch (err) { next(err); }
});

permissionRouter.put("/", requireAuth, requirePermission("user-management"), async (req, res, next) => {
    try {
        const { matrix } = req.body;

        if (!matrix || typeof matrix !== "object") {
            return res.status(400).json({ message: "A valid 'matrix' object is required." });
        }

        const doc = await getOrCreatePermissions();
        matrix.admin = ALL_PAGE_KEYS;

        doc.matrix = matrix;
        doc.updatedAt = new Date();
        doc.updatedBy = req.user._id;

        await doc.save();

        res.json({ permissions: doc.matrix.toJSON() });
    } catch (err) { next(err); }
});

// --- Vehicle Notes Routes ---
const vehicleNoteRouter = express.Router();
vehicleNoteRouter.use(requireAuth, requirePermission("vehicle-notes"));

vehicleNoteRouter.get("/", requireAuth, async (req, res, next) => {
    try {
        const vehicles = await VehicleNote.find().sort({ createdAt: -1 });
        res.json({ vehicles });
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

vehicleNoteRouter.post("/", requireAuth, async (req, res, next) => {
    try {
        const { name, make, type, model, year, image, beforeImage, afterImage, gallery, offsetNotes, existingSpec, upgradedSpec, eventDate, staffNotes } = req.body;

        if (!name || !make || !model || !type) {
            return res.status(400).json({ message: "Vehicle name, make, model and type are required." });
        }

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
            createdBy: req.user._id,
        });
        res.status(201).json({ vehicle });
    } catch (err) { next(err); }
});

vehicleNoteRouter.put("/:id", requireAuth, async (req, res, next) => {
    try {
        const { name, make, type, model, year, image, beforeImage, afterImage, gallery, offsetNotes, existingSpec, upgradedSpec, eventDate } = req.body;
        const vehicle = await VehicleNote.findByIdAndUpdate(
            req.params.id,
            {
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
            },
            { new: true }
        );
        if (!vehicle) return res.status(404).json({ message: "Vehicle not found." });
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

// Strict role check (not the configurable per-role Permission matrix that
// requirePermission() reads) — for an operation that must always be
// admin-only regardless of how the Permission matrix is configured for other
// roles. Nothing uses it at the moment: the vehicle-lookup writes it used to
// guard are now staff-and-admin (requireStaffOrAdminOnly). Kept so an
// endpoint can be tightened back to admin-only without rewriting the guard.
// eslint-disable-next-line no-unused-vars
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

vehicleNoteRouter.post("/:id/gallery", requireAuth, async (req, res, next) => {
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

vehicleNoteRouter.delete("/:id/gallery", requireAuth, async (req, res, next) => {
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

vehicleNoteRouter.delete("/:id", requireAuth, async (req, res, next) => {
    try {
        const vehicle = await VehicleNote.findByIdAndDelete(req.params.id);
        if (!vehicle) return res.status(404).json({ message: "Vehicle not found." });
        res.json({ success: true });
    } catch (err) { next(err); }
});

// --- Vehicle Lookup Routes (predefined Make/Model/Type dropdown data) ---
// Backs the cascading Make -> Model -> Type dropdowns on the Vehicle Notes
// "Add / Edit vehicle" form, and the Make dropdown on the Tire Size Option
// preset popup. Read access matches vehicle-notes; only staff/admin can
// replace the table via upload (same restriction as the internal staff notes
// endpoints above), since an upload wipes and re-populates the whole
// reference table for every user.
//
// Writing to the reference lists (adding and deleting Makes, Models, Types
// and Years) is limited to the staff and admin roles — requireStaffOrAdminOnly
// rather than the configurable Permission matrix, so a custom role created in
// User Management can never edit the shared lists. The UI gates the same way:
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
vehicleLookupRouter.get("/makes", requireAuth, requireAnyPermission("vehicle-notes", "tire-options"), async (req, res, next) => {
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

vehicleLookupRouter.use(requireAuth, requirePermission("vehicle-notes"));

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

vehicleLookupRouter.get("/export", async (req, res, next) => {
    try {
        const rows = await VehicleLookup.find().sort({ make: 1, model: 1 }).lean();
        const buffer = buildVehicleLookupWorkbook(rows);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="vehicle-notes-database-${Date.now()}.xlsx"`);
        res.send(buffer);
    } catch (err) { next(err); }
});

vehicleLookupRouter.post("/import", requireStaffOrAdmin, async (req, res, next) => {
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
        const { width, aspect, rim, targetRim, heightTolerancePct, treadTolerancePct, sortBy } = req.body;
        const oe = { width: Number(width), aspect: Number(aspect), rim: Number(rim) };
        if (!oe.width || !oe.aspect || !oe.rim) {
            return res.status(400).json({ message: "OE width, aspect and rim are required." });
        }

        // Client can narrow/widen the tolerance windows per search; falls back
        // to the server-configured defaults when not supplied.
        const heightTolPct = Number.isFinite(Number(heightTolerancePct)) && heightTolerancePct !== ""
            ? Math.max(0, Number(heightTolerancePct))
            : PLUS_SIZE_HEIGHT_TOLERANCE_PCT * 100;
        const treadTolPct = Number.isFinite(Number(treadTolerancePct)) && treadTolerancePct !== ""
            ? Math.max(0, Number(treadTolerancePct))
            : PLUS_SIZE_TREAD_TOLERANCE_PCT * 100;

        const oeHeight = tireOverallHeightInches(oe);
        const oeTread = tireTreadWidthInches(oe);

        // --- Stage 1: matching wheel diameter ---
        // Filter the tire database down to the requested target rim (wheel
        // diameter) first. If no target rim was given, every diameter in the
        // library is a candidate, but this stays the first stage of the
        // pipeline so a future "search all plus-size-appropriate diameters"
        // feature can plug in here without touching stages 2/3.
        const diameterQuery = {};
        if (targetRim) diameterQuery.rim = Number(targetRim);
        const diameterMatches = await TireOption.find(diameterQuery).lean();

        // --- Stage 2: falling within the calculated height range ---
        // Only overall-height is computed/checked here; tread width is
        // deliberately NOT calculated yet, since it's the more expensive/less
        // decisive filter and there's no point computing it for a candidate
        // that's already outside the acceptable height range.
        const heightMatches = diameterMatches
            .map((c) => {
                const height = tireOverallHeightInches(c);
                const heightDiffPct = ((height - oeHeight) / oeHeight) * 100;
                return { candidate: c, height, heightDiffPct };
            })
            .filter((c) => Math.abs(c.heightDiffPct) <= heightTolPct);

        // --- Stage 3: tread width, calculated only for height-range survivors ---
        const withinTolerance = heightMatches
            .map(({ candidate: c, height, heightDiffPct }) => {
                const tread = tireTreadWidthInches(c);
                const treadDiffPct = ((tread - oeTread) / oeTread) * 100;
                return {
                    _id: c._id,
                    label: c.label,
                    width: c.width,
                    aspect: c.aspect,
                    rim: c.rim,
                    overallHeightIn: Number(height.toFixed(3)),
                    treadWidthIn: Number(tread.toFixed(3)),
                    heightDiffPct: Number(heightDiffPct.toFixed(3)),
                    treadDiffPct: Number(treadDiffPct.toFixed(3)),
                };
            })
            .filter((r) => Math.abs(r.treadDiffPct) <= treadTolPct)
            .map((r) => ({
                ...r,
                // Percentage-difference ranking score: combined closeness to OE
                // across both height and tread, smaller is better.
                combinedDiffPct: Number((Math.abs(r.heightDiffPct) + Math.abs(r.treadDiffPct)).toFixed(3)),
            }));

        const sortKey = { height: "heightDiffPct", tread: "treadDiffPct", combined: "combinedDiffPct" }[sortBy] || "combinedDiffPct";
        withinTolerance.sort((a, b) => Math.abs(a[sortKey]) - Math.abs(b[sortKey]));
        const results = withinTolerance.map((r, i) => ({ ...r, rank: i + 1 }));

        res.json({
            oe: { ...oe, overallHeightIn: Number(oeHeight.toFixed(3)), treadWidthIn: Number(oeTread.toFixed(3)) },
            tolerances: { heightPct: heightTolPct, treadPct: treadTolPct },
            sortBy: sortKey,
            results,
        });
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

activityRouter.post("/tire-comparison", async (req, res, next) => {
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

        res.json({
            totalUsers,
            totalVehicles,
            tirePresets,
            usersByRole,
            recentVehicles,
            recentTireComparisons,
            recentVehicleSearches,
            recentPlusSizeSaves,
            reportsSummary: { totalActivity: reportsTotal, last7Days: reportsLast7Days },
        });
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

const requireAppGuideOrTechData = async (req, res, next) => {
    try {
        if (req.user?.role === "admin") return next();
        const doc = await Permission.findOne({ key: "global" }).lean();
        const allowed = doc?.matrix?.[req.user.role] || [];
        if (allowed.includes("application-guide") || allowed.includes("tech-data")) {
            return next();
        }
        return res.status(403).json({
            message: `Access Denied: Your assigned role (${req.user.role}) lacks clearance for 'application-guide' or 'tech-data'.`,
        });
    } catch (err) { next(err); }
};
appGuideRouter.use(requireAppGuideOrTechData);
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

appGuideRouter.get("/export", async (req, res, next) => {
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

appGuideRouter.post("/import", async (req, res, next) => {
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

reportsRouter.get("/export", async (req, res, next) => {
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