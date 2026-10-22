// config/permissionCatalog.js
//
// Single source of truth (server side) for every permission key.
//
// Access is granted PER USER, keyed by the user's (unique) email — there is no
// role-based permission matrix any more. A user's grants live on their User
// document (`permissions: [String]`). Two kinds of key exist:
//
//   - PAGE keys    e.g. "vehicle-notes"       -> may open the page / call its API
//   - ELEMENT keys e.g. "vehicle-notes.edit"  -> may use one control on that page
//
// Element keys form a tree under their page (and sometimes under another
// element: the Vehicle Notes database buttons sit under the database card). A
// key only counts when EVERY ancestor is also granted, so revoking a page
// automatically switches off everything inside it.
//
// The client mirrors this list in client/src/utils/permissions.js — when you
// add a key, add it in both places (and give the route/button a guard).

// Pages shown in the sidebar and returned by GET /navigation.
export const NAV_PAGES = [
    { key: "dashboard", label: "Dashboard", path: "/dashboard", icon: "LayoutDashboard" },
    { key: "tire-calculator", label: "Tire Size Calculator", path: "/tire-calculator", icon: "Calculator" },
    { key: "tire-comparison", label: "Tire Size Comparison", path: "/tire-comparison", icon: "Scale" },
    { key: "plus-size", label: "Plus Size Options", path: "/plus-size", icon: "TrendingUp" },
    { key: "tire-options", label: "Tire Size Option", path: "/tire-options", icon: "SlidersHorizontal" },
    { key: "tech-data", label: "Tech Data", path: "/tech-data", icon: "Wrench" },
    { key: "vehicle-notes", label: "Vehicle Notes", path: "/vehicle-notes", icon: "Car" },
    { key: "reports", label: "Reporting & Data Export", path: "/reports", icon: "FileBarChart" },
    { key: "user-management", label: "User Management", path: "/user-management", icon: "Users" },
];

// Valid page keys that are not in the sidebar / permissions screen (the
// Application Guide route still exists but is hidden from the UI). They can
// still be held by a user (e.g. carried over by the migration script) and are
// preserved when an admin saves that user's permissions from the UI.
export const HIDDEN_PAGE_KEYS = ["application-guide"];

const el = (key, label, parent) => ({ key, label, parent });

// Element-level permissions, in the order they appear in the permissions UI.
export const ELEMENT_PERMISSIONS = [
    // Dashboard — one per tile
    el("dashboard.tile.total-users", "Total users", "dashboard"),
    el("dashboard.tile.vehicle-notes", "Vehicle notes count", "dashboard"),
    el("dashboard.tile.tire-presets", "Tire presets count", "dashboard"),
    el("dashboard.tile.quick-access", "Quick access", "dashboard"),
    el("dashboard.tile.tire-showroom", "Tire showroom", "dashboard"),
    el("dashboard.tile.recent-vehicles", "Recently added vehicles", "dashboard"),
    el("dashboard.tile.users-by-role", "Users by role", "dashboard"),
    el("dashboard.tile.recent-comparisons", "Recent tire comparisons", "dashboard"),
    el("dashboard.tile.recent-vehicle-searches", "Recently searched vehicles", "dashboard"),
    el("dashboard.tile.recent-plus-size", "Recent plus-size saves", "dashboard"),
    el("dashboard.tile.reports", "Reports", "dashboard"),

    // Tire Size Comparison
    el("tire-comparison.save", "Save comparison button", "tire-comparison"),

    // Plus Size Options
    el("plus-size.download", "Download OE library button", "plus-size"),
    el("plus-size.upload", "Upload OE sizes button", "plus-size"),

    // Tech Data — only the second tab (CSV import / export)
    el("tech-data.csv-tab", "CSV import / export tab", "tech-data"),

    // Vehicle Notes
    el("vehicle-notes.add", "Add vehicle button", "vehicle-notes"),
    el("vehicle-notes.edit", "Edit button (on each vehicle)", "vehicle-notes"),
    el("vehicle-notes.delete", "Delete button (on each vehicle)", "vehicle-notes"),
    el("vehicle-notes.database", "Vehicle Notes database", "vehicle-notes"),
    el("vehicle-notes.database.download", "Download database button", "vehicle-notes.database"),
    el("vehicle-notes.database.upload", "Upload database button", "vehicle-notes.database"),

    // Reports
    el("reports.download", "Download CSV button", "reports"),
];

export const PERMISSIONS = [
    ...NAV_PAGES.map((p) => ({ key: p.key, label: p.label, parent: null })),
    ...HIDDEN_PAGE_KEYS.map((key) => ({ key, label: key, parent: null })),
    ...ELEMENT_PERMISSIONS,
];

export const ALL_PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

const KNOWN = new Set(ALL_PERMISSION_KEYS);
const PARENT_OF = new Map(PERMISSIONS.map((p) => [p.key, p.parent]));

export const isKnownPermission = (key) => KNOWN.has(key);

// Every key above `key`, nearest first. [] for a page key (or an unknown key).
export function ancestorsOf(key) {
    const chain = [];
    let parent = PARENT_OF.get(key);
    while (parent) {
        chain.push(parent);
        parent = PARENT_OF.get(parent);
    }
    return chain;
}

/**
 * Turn whatever the client sent into a clean list of grants:
 *   - non-array / non-string entries are ignored
 *   - unknown keys are dropped (so a typo can never become a stored "grant")
 *   - an element whose page (or parent element) isn't also granted is dropped
 *   - duplicates removed; result is in catalog order
 */
export function sanitizePermissions(input) {
    const requested = new Set(
        (Array.isArray(input) ? input : [])
            .filter((k) => typeof k === "string")
            .map((k) => k.trim())
            .filter((k) => KNOWN.has(k))
    );
    return ALL_PERMISSION_KEYS.filter(
        (key) => requested.has(key) && ancestorsOf(key).every((a) => requested.has(a))
    );
}
