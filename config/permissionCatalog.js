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
// Element keys form a tree under their page (and can sit under another
// element). A key only counts when EVERY ancestor is also granted, so revoking
// a page automatically switches off everything inside it.
//
// The client mirrors this list in client/src/utils/permissions.js — when you
// add a key, add it in both places (and give the route/button a guard).

// Pages shown in the sidebar and returned by GET /navigation.
export const NAV_PAGES = [
    { key: "dashboard", label: "Dashboard", path: "/dashboard", icon: "LayoutDashboard" },
    { key: "tire-calculator", label: "Tire Size Calculator", path: "/tire-calculator", icon: "Calculator" },
    { key: "tire-comparison", label: "Tire Size Comparison", path: "/tire-comparison", icon: "Scale" },
    { key: "plus-size", label: "Plus Size Options", path: "/plus-size", icon: "TrendingUp" },
    // { key: "tire-options", label: "Tire Size Option", path: "/tire-options", icon: "SlidersHorizontal" }, // hidden: Tire Size Option is switched off (see HIDDEN_PAGE_KEYS)
    { key: "tech-data", label: "Tech Data", path: "/tech-data", icon: "Wrench" },
    { key: "vehicle-notes", label: "Vehicle Notes", path: "/vehicle-notes", icon: "Car" },
    { key: "reports", label: "Reporting & Data Export", path: "/reports", icon: "FileBarChart" },
    { key: "user-management", label: "User Management", path: "/user-management", icon: "Users" },
];

// Valid page keys that are not in the sidebar / permissions screen (the
// Application Guide route still exists but is hidden from the UI). They can
// still be held by a user (e.g. carried over by the migration script) and are
// preserved when an admin saves that user's permissions from the UI.
//
// "tire-options" (Tire Size Option) lives here too while that feature is switched
// off: it's out of the sidebar and the permissions screen, but the key stays
// valid (the guards on its — currently unmounted — routes still reference it, and
// an unknown key makes the server refuse to start) and any grant a user already
// holds is kept, so turning the feature back on doesn't mean re-granting anyone.
// To bring it back: move it back into NAV_PAGES and remove it from this list.
export const HIDDEN_PAGE_KEYS = ["application-guide", "tire-options"];

const el = (key, label, parent) => ({ key, label, parent });

// Element-level permissions, in the order they appear in the permissions UI.
export const ELEMENT_PERMISSIONS = [
    // Dashboard — one per tile
    el("dashboard.tile.total-users", "Total users", "dashboard"),
    el("dashboard.tile.vehicle-notes", "Vehicle notes count", "dashboard"),
    // el("dashboard.tile.tire-presets", "Tire presets count", "dashboard"), // hidden: see HIDDEN_ELEMENT_PERMISSIONS
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

    // Vehicle Notes
    el("vehicle-notes.add", "Add vehicle button", "vehicle-notes"),
    el("vehicle-notes.edit", "Edit button (on each vehicle)", "vehicle-notes"),
    el("vehicle-notes.delete", "Delete button (on each vehicle)", "vehicle-notes"),

    // Reporting & Data Export — the per-report CSV downloads, plus the data
    // library import / export buttons that used to sit on Plus Size Options,
    // Tech Data and Vehicle Notes. Those keys keep their original names on
    // purpose (renaming would orphan every grant already stored on a user);
    // only their parent changed, so they now need the Reports page instead of
    // the page they used to live on.
    el("reports.download", "Download report CSV buttons", "reports"),
    el("plus-size.download", "Download OE library button", "reports"),
    el("plus-size.upload", "Upload OE sizes button", "reports"),
    el("tech-data.csv-tab", "Tech Data CSV download / upload buttons", "reports"),
    el("vehicle-notes.database.download", "Download database button", "reports"),
    el("vehicle-notes.database.upload", "Upload database button", "reports"),
];

// Element permissions that are switched off in the UI (not on the permissions
// screen, no control rendered) but must stay valid and be preserved on save, for
// the same reason as HIDDEN_PAGE_KEYS. To bring one back, move it back into
// ELEMENT_PERMISSIONS (and into the client mirror).
export const HIDDEN_ELEMENT_PERMISSIONS = [
    el("dashboard.tile.tire-presets", "Tire presets count", "dashboard"),
    // The Vehicle Notes database card moved to Reporting & Data Export, so this
    // no longer gates anything. Kept valid so existing grants aren't discarded.
    el("vehicle-notes.database", "Vehicle Notes database", "vehicle-notes"),
];
export const HIDDEN_ELEMENT_KEYS = HIDDEN_ELEMENT_PERMISSIONS.map((e) => e.key);

export const PERMISSIONS = [
    ...NAV_PAGES.map((p) => ({ key: p.key, label: p.label, parent: null })),
    ...HIDDEN_PAGE_KEYS.map((key) => ({ key, label: key, parent: null })),
    ...ELEMENT_PERMISSIONS,
    ...HIDDEN_ELEMENT_PERMISSIONS,
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
