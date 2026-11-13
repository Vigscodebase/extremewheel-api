// WebSocket endpoint (/ws): ONE socket per browser tab, used for every live push.
//
//   { type: "ready" }                 sent once after the upgrade succeeds
//   { type: "hb" }                    heartbeat (lets the browser detect a dead link)
//   { type: "vehicle-save", ... }     a background Vehicle Note save changed state
//   { type: "permissions-changed" }   an admin changed THIS user's access -> re-fetch /permissions/me
//   { type: "session-revoked" }       account deleted / password, email or role changed -> sign out
//   { type: "resync" }                this server lost its Redis subscription for a while -> re-fetch
//
// Nothing sensitive ever travels over the socket: permission events are only a
// "something changed" nudge. The browser then re-reads the real data over its
// normal, JWT-protected HTTPS API, so the server stays the single source of truth.
//
// Auth: the browser first calls the normal, JWT-protected POST /realtime/ticket
// and gets a random one-time ticket (30 s, stored in Redis). It then opens
// ws://…/ws?ticket=…. That way the long-lived JWT never appears in a URL / proxy
// log, and we don't need to duplicate the JWT logic.
//
// Env (all optional):
//   WS_ALLOWED_ORIGINS  comma-separated browser origins allowed to open the socket
//                       (falls back to CORS_ORIGINS; when both are empty the check is skipped
//                       and the one-time ticket is the only gate)
//   WS_MAX_PER_USER     max simultaneous sockets per account (default 10 - tabs / devices)
import crypto from "crypto";
import { WebSocketServer } from "ws";
import logToFile from "../logger.js";
import {
    createRedis,
    closeRedis,
    getRedis,
    withTimeout,
    SAVE_EVENTS_CHANNEL,
    PERMISSION_EVENTS_CHANNEL,
} from "../config/queue.js";

const WS_PATH = "/ws";
const TICKET_TTL_SECONDS = 30;
const HEARTBEAT_MS = 30000;
const CLOSE_SESSION_REVOKED = 4401; // the browser must NOT reconnect after this one
const ticketKey = (t) => `ws-ticket:${t}`;

const allowedOrigins = () =>
    (process.env.WS_ALLOWED_ORIGINS || process.env.CORS_ORIGINS || "")
        .split(",")
        .map((o) => o.trim().replace(/\/+$/, ""))
        .filter(Boolean);

const maxPerUser = () => Number(process.env.WS_MAX_PER_USER) || 10;

/** Called by an authenticated route. Returns a one-time ticket for `user`. */
export async function issueWsTicket(user) {
    const ticket = crypto.randomBytes(24).toString("hex");
    await withTimeout(getRedis().set(ticketKey(ticket), String(user._id), { EX: TICKET_TTL_SECONDS }), 3000, "ticket save");
    return ticket;
}

async function redeemTicket(ticket) {
    if (!/^[a-f0-9]{48}$/.test(ticket || "")) return null;
    // GET + DEL in one transaction: a ticket works exactly once.
    const [userId] = await withTimeout(getRedis().multi().get(ticketKey(ticket)).del(ticketKey(ticket)).exec(), 3000, "ticket check");
    return typeof userId === "string" && userId ? userId : null;
}

function refuse(socket, status, text) {
    try {
        socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch { /* already gone */ }
    socket.destroy();
}

export function attachSocketServer(httpServer) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
    /** userId -> Set<WebSocket> (a person may have several tabs open) */
    const socketsByUser = new Map();

    httpServer.on("upgrade", async (req, socket, head) => {
        // A raw socket with no 'error' listener would crash the process on a reset.
        socket.on("error", () => { });
        try {
            const url = new URL(req.url, "http://localhost");
            if (url.pathname !== WS_PATH) return socket.destroy();

            // Browsers always send Origin on a WebSocket handshake and it can't be
            // forged by page script, so this stops OTHER websites from driving a
            // visitor's browser into opening a socket here.
            const allowed = allowedOrigins();
            const origin = req.headers.origin;
            if (allowed.length && origin && !allowed.includes(String(origin).replace(/\/+$/, ""))) {
                logToFile(`[WS] refused origin ${origin}`);
                return refuse(socket, 403, "Forbidden");
            }

            const userId = await redeemTicket(url.searchParams.get("ticket"));
            if (!userId) return refuse(socket, 401, "Unauthorized");

            if ((socketsByUser.get(userId)?.size || 0) >= maxPerUser()) {
                return refuse(socket, 429, "Too Many Requests");
            }

            wss.handleUpgrade(req, socket, head, (ws) => {
                ws.userId = userId;
                ws.isAlive = true;
                ws.on("pong", () => { ws.isAlive = true; });
                ws.on("error", () => { });
                ws.on("close", () => {
                    const set = socketsByUser.get(userId);
                    set?.delete(ws);
                    if (set && set.size === 0) socketsByUser.delete(userId);
                });
                if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
                socketsByUser.get(userId).add(ws);
                ws.send(JSON.stringify({ type: "ready" }));
            });
        } catch (err) {
            logToFile(`[WS] upgrade failed: ${err.message}`);
            socket.destroy();
        }
    });

    const sendTo = (userId, message, { close } = {}) => {
        const targets = socketsByUser.get(String(userId));
        if (!targets) return;
        for (const ws of [...targets]) {
            if (ws.readyState !== ws.OPEN) continue;
            ws.send(message);
            if (close) ws.close(close.code, close.reason);
        }
    };

    const broadcast = (message) => {
        for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(message);
    };

    const subscriber = createRedis("subscriber");

    // If this process loses its Redis subscription for a while, events published
    // in the gap are gone for good. When the link comes back, tell every browser
    // on this instance to re-read its permissions instead of trusting what it has.
    let subscriberWasDown = false;
    subscriber.on("error", () => { subscriberWasDown = true; });
    subscriber.on("ready", () => {
        if (!subscriberWasDown) return;
        subscriberWasDown = false;
        broadcast(JSON.stringify({ type: "resync" }));
    });

    // Relay worker events to that user's sockets only.
    // Queued by the client until it is connected, and re-applied after a reconnect.
    subscriber.subscribe(SAVE_EVENTS_CHANNEL, (raw) => {
        let evt;
        try { evt = JSON.parse(raw); } catch { return; }
        const { userId, ...payload } = evt; // don't echo internal routing info
        sendTo(userId, JSON.stringify({ type: "vehicle-save", ...payload }));
    }).catch((err) => logToFile(`[WS] subscribe failed: ${err.message}`));

    // Admin changed somebody's access -> nudge that somebody's browser(s).
    subscriber.subscribe(PERMISSION_EVENTS_CHANNEL, (raw) => {
        let evt;
        try { evt = JSON.parse(raw); } catch { return; }
        if (!evt?.userId) return;
        if (evt.type === "permissions-changed") {
            sendTo(evt.userId, JSON.stringify({ type: "permissions-changed" }));
        } else if (evt.type === "session-revoked") {
            sendTo(evt.userId, JSON.stringify({ type: "session-revoked" }), {
                close: { code: CLOSE_SESSION_REVOKED, reason: "session revoked" },
            });
        }
    }).catch((err) => logToFile(`[WS] permission subscribe failed: ${err.message}`));

    // Drop half-open connections (laptop lid closed, Wi-Fi gone) and keep
    // idle connections alive through proxies / load balancers. The "hb" text
    // message is for the BROWSER: it can't see protocol-level pings, so without
    // it a dead link looks exactly like a quiet one.
    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            if (!ws.isAlive) { ws.terminate(); continue; }
            ws.isAlive = false;
            ws.ping();
            if (ws.readyState === ws.OPEN) ws.send('{"type":"hb"}');
        }
    }, HEARTBEAT_MS);
    heartbeat.unref();

    return {
        async close() {
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.close(1001, "Server restarting");
            wss.close();
            await closeRedis(subscriber);
        },
    };
}
