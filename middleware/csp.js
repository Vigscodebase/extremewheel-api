// Content Security Policy for the API.
//
// This server only returns JSON (and private photos), never HTML pages, so the
// right policy for it is the strictest one: nothing may load or run from a response
// that comes from here, and it can't be framed. The browser app (the Vite client)
// has its own, wider policy - see client/csp.js.
//
// .env switches (all optional):
//   CSP_ENABLED=false       turn the header off completely (emergency rollback)
//   CSP_REPORT_ONLY=true    send Content-Security-Policy-Report-Only instead: the
//                           browser reports violations but blocks nothing
//   CSP_REPORT_URI=/csp-report   where browsers POST violation reports
//                           (default "/csp-report", which is mounted below). Behind
//                           a proxy that strips a prefix (nginx "/api/"), set it to
//                           the public path, e.g. CSP_REPORT_URI=/api/csp-report

import express from "express";
import helmet from "helmet";
import logToFile from "../logger.js";

const isOff = (name) => String(process.env[name] || "").trim().toLowerCase() === "false";
const isOn = (name) => String(process.env[name] || "").trim().toLowerCase() === "true";

export const CSP_REPORT_PATH = "/csp-report";

/** The CSP directives for the API. Exported so tests / docs can read them. */
export function apiCspDirectives() {
    const directives = {
        defaultSrc: ["'none'"],   // nothing loads from an API response
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"], // can never be embedded in a frame
    };
    const reportUri = (process.env.CSP_REPORT_URI || CSP_REPORT_PATH).trim();
    if (reportUri) directives.reportUri = [reportUri];
    return directives;
}

/** Drop-in replacement for `helmet()`: every default helmet header + the API CSP. */
export function securityHeaders() {
    if (isOff("CSP_ENABLED")) {
        // Keep the other helmet headers, just no CSP.
        return helmet({ contentSecurityPolicy: false });
    }
    return helmet({
        contentSecurityPolicy: {
            useDefaults: false,
            reportOnly: isOn("CSP_REPORT_ONLY"),
            directives: apiCspDirectives(),
        },
    });
}

// Browsers send reports as application/csp-report (report-uri, the older format) or
// application/reports+json (Reporting API). Neither is plain application/json.
const reportParser = express.json({
    type: ["application/csp-report", "application/reports+json", "application/json"],
    limit: "20kb",
});

const clip = (v, n = 300) => (typeof v === "string" ? v.slice(0, n) : v);

/**
 * POST /csp-report - receives violation reports and writes one log line each.
 * Needs no login (the browser sends it, not the app) and is covered by the
 * API-wide rate limit. The body is untrusted, so it is only logged, never acted on.
 */
export const cspReportRouter = express.Router();
cspReportRouter.post(CSP_REPORT_PATH, reportParser, (req, res) => {
    try {
        const body = req.body || {};
        // Old format: { "csp-report": {...} }. New format: [ { type, body: {...} } ].
        const reports = Array.isArray(body) ? body.map((r) => r && r.body) : [body["csp-report"] || body];
        for (const r of reports.slice(0, 10)) {
            if (!r || typeof r !== "object") continue;
            logToFile(
                `[CSP] violated=${clip(r["violated-directive"] || r.effectiveDirective)} ` +
                `blocked=${clip(r["blocked-uri"] || r.blockedURL)} ` +
                `document=${clip(r["document-uri"] || r.documentURL)} ` +
                `source=${clip(r["source-file"] || r.sourceFile)}:${r["line-number"] ?? r.lineNumber ?? ""} ` +
                `disposition=${clip(r.disposition)}`
            );
        }
    } catch {
        /* a malformed report must never cause an error response */
    }
    res.status(204).end();
});
