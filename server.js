// server.js
import express from "express";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";
import helmet from "helmet";
import compression from "compression";

import logToFile from "./logger.js";
import connectDB from "./config/db.js";
import errorHandler from "./middleware/errorHandler.js";
import rateLimit from "express-rate-limit";

// Models
import User from "./models/User.js";
import Permission from "./models/Permission.js";
import TireOption from "./models/TireOption.js";
import VehicleNote from "./models/VehicleNote.js";
import Role from "./models/Role.js";
import AppGuide from "./models/AppGuide.js";

// Middleware
import { requireAuth, requirePermission } from "./middleware/auth.js";
import { signToken } from "./utils/jwt.js";
import { cached } from "./config/redis.js";

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
// const corsOrigins = (process.env.CORS_ORIGINS || "")
//     .split(",")
//     .map((o) => o.trim())
//     .filter(Boolean);
// if (corsOrigins.length > 0) {
//     const cors = (await import("cors")).default;
//     app.use(cors({ origin: corsOrigins, credentials: true, exposedHeaders: ["x-refresh-token"] }));
// }

app.use(express.json({ limit: "2mb" }));
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
        const token = signToken(user);
        const { _id, name: userName, email: userEmail, role, createdAt } = user;

        res.status(201).json({ token, user: { _id, name: userName, email: userEmail, role, createdAt } });
    } catch (err) {
        next(err);
    }
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

        const token = signToken(user);

        // Return ONLY the token. No user object.
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
        // 1. Safely grab the ID, whether your auth middleware uses '_id' or 'id'
        const loggedInUserId = req.user?._id || req.user?.id;

        // 2. Ensure we actually have a logged-in user ID to compare against
        if (!loggedInUserId) {
            return res.status(401).json({ message: "Authentication required or user data malformed." });
        }

        // 3. Compare safely
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
// Single source of truth for every page key + its nav metadata, used by both
// the permissions matrix (below) and the /navigation router. Previously this
// list was duplicated in two places and could drift out of sync; now it's
// defined once and derived everywhere else.
const NAV_PAGES = [
    { key: "dashboard", label: "Dashboard", path: "/dashboard", icon: "LayoutDashboard" },
    { key: "user-management", label: "User Management", path: "/user-management", icon: "Users" },
    { key: "tire-comparison", label: "Tire Size Comparison", path: "/tire-comparison", icon: "Scale" },
    { key: "tire-options", label: "Tire Size Option", path: "/tire-options", icon: "SlidersHorizontal" },
    { key: "vehicle-notes", label: "Vehicle Notes", path: "/vehicle-notes", icon: "Car" },
];
const ALL_PAGE_KEYS = NAV_PAGES.map((p) => p.key);

// --- Permission Routes ---
const permissionRouter = express.Router();
const DEFAULTS = {
    key: "global",
    matrix: {
        admin: ALL_PAGE_KEYS,
        staff: ["dashboard", "tire-comparison", "tire-options", "vehicle-notes"],
        guest: ["dashboard", "tire-comparison"],
    }
};

const getOrCreatePermissions = async () => {
    let doc = await Permission.findOne({ key: "global" });
    if (!doc) doc = await Permission.create(DEFAULTS);
    return doc;
};

permissionRouter.get("/", requireAuth, async (req, res, next) => {
    try {
        const doc = await getOrCreatePermissions();
        res.json({ permissions: Object.fromEntries(doc.matrix) });
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

        res.json({ permissions: Object.fromEntries(doc.matrix) });
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

vehicleNoteRouter.post("/", requireAuth, async (req, res, next) => {
    try {
        const { name, type, model, image } = req.body;
        if (!name || !type || !model) {
            return res.status(400).json({ message: "Name, type and model are required." });
        }
        const vehicle = await VehicleNote.create({ name, type, model, image, createdBy: req.user._id });
        res.status(201).json({ vehicle });
    } catch (err) { next(err); }
});

vehicleNoteRouter.put("/:id", requireAuth, async (req, res, next) => {
    try {
        const { name, type, model, image } = req.body;
        const vehicle = await VehicleNote.findByIdAndUpdate(
            req.params.id,
            { ...(name && { name }), ...(type && { type }), ...(model && { model }), ...(image !== undefined && { image }) },
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

// --- Tire Options Routes ---
const tireOptionRouter = express.Router();
tireOptionRouter.use(requireAuth, requirePermission("tire-options"));

tireOptionRouter.get("/", requireAuth, async (req, res, next) => {
    try {
        const options = await TireOption.find().sort({ createdAt: -1 });
        res.json({ options });
    } catch (err) { next(err); }
});

tireOptionRouter.post("/", requireAuth, async (req, res, next) => {
    try {
        const { label, width, aspect, rim } = req.body;
        if (!label || !width || !aspect || !rim) {
            return res.status(400).json({ message: "All fields are required." });
        }
        const option = await TireOption.create({ label, width, aspect, rim, createdBy: req.user._id });
        res.status(201).json({ option });
    } catch (err) { next(err); }
});

tireOptionRouter.put("/:id", requireAuth, async (req, res, next) => {
    try {
        const { label, width, aspect, rim } = req.body;
        const option = await TireOption.findByIdAndUpdate(
            req.params.id,
            { ...(label && { label }), ...(width && { width }), ...(aspect && { aspect }), ...(rim && { rim }) },
            { new: true }
        );
        if (!option) return res.status(404).json({ message: "Preset not found." });
        res.json({ option });
    } catch (err) { next(err); }
});

tireOptionRouter.delete("/:id", requireAuth, async (req, res, next) => {
    try {
        const option = await TireOption.findByIdAndDelete(req.params.id);
        if (!option) return res.status(404).json({ message: "Preset not found." });
        res.json({ success: true });
    } catch (err) { next(err); }
});

// --- Dashboard Routes ---
const dashboardRouter = express.Router();
dashboardRouter.use(requireAuth, requirePermission("dashboard"));

dashboardRouter.get("/summary", requireAuth, async (req, res, next) => {
    try {
        const [totalUsers, totalVehicles, tirePresets, roleAgg, recentVehicles] = await Promise.all([
            User.countDocuments(),
            VehicleNote.countDocuments(),
            TireOption.countDocuments(),
            User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
            VehicleNote.find().sort({ createdAt: -1 }).limit(5).select("name type model"),
        ]);

        const usersByRole = { admin: 0, staff: 0, guest: 0 };
        roleAgg.forEach((r) => {
            if (r._id in usersByRole) {
                usersByRole[r._id] = r.count;
            }
        });

        res.json({ totalUsers, totalVehicles, tirePresets, usersByRole, recentVehicles });
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
        // Served from the single NAV_PAGES registry above. Move this to a DB
        // collection later (admin-editable menus) without touching callers —
        // the response shape stays the same.
        res.json({ nav: NAV_PAGES });
    } catch (err) {
        next(err);
    }
});

// --- Application Guide Routes (Tab 3 cascading lookup + Tab 5 tech data) ---
// Read-heavy, rarely-changing reference data imported from the client's
// tblAppGuide xlsx (see scripts/importAppGuide.js), so every list here is
// cached in Redis for APP_GUIDE_CACHE_TTL_SECONDS and only re-hits Mongo on
// a cache miss or after a re-import invalidates the "app-guide:" prefix.
const appGuideRouter = express.Router();
appGuideRouter.use(requireAuth);
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

// Full fitment + wheel-offset record for the final Year/Make/Model/Type
// selection — this is what Tab 5's tech data / offset chart renders.
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


app.use("/auth", authRouter);
app.use("/users", userRouter);
app.use("/permissions", permissionRouter);
app.use("/vehicle-notes", vehicleNoteRouter);
app.use("/tire-options", tireOptionRouter);
app.use("/dashboard", dashboardRouter);
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