// WebSocket endpoint (/ws) that pushes "your vehicle save is queued / processing
// / done / failed" messages to the browser the moment the worker reports them.
//
// Auth: the browser first calls the normal, JWT-protected
// POST /vehicle-notes/ws-ticket and gets a random one-time ticket (30 s, stored
// in Redis). It then opens ws://…/ws?ticket=…. That way the long-lived JWT never
// appears in a URL / proxy log, and we don't need to duplicate the JWT logic.
import crypto from "crypto";
import { WebSocketServer } from "ws";
import logToFile from "../logger.js";
import { createRedis, closeRedis, getRedis, withTimeout, SAVE_EVENTS_CHANNEL } from "../config/queue.js";

const WS_PATH = "/ws";
const TICKET_TTL_SECONDS = 30;
const HEARTBEAT_MS = 30000;
const ticketKey = (t) => `ws-ticket:${t}`;

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

export function attachSocketServer(httpServer) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
    /** userId -> Set<WebSocket> (a person may have several tabs open) */
    const socketsByUser = new Map();

    httpServer.on("upgrade", async (req, socket, head) => {
        try {
            const url = new URL(req.url, "http://localhost");
            if (url.pathname !== WS_PATH) return socket.destroy();

            const userId = await redeemTicket(url.searchParams.get("ticket"));
            if (!userId) {
                socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
                return socket.destroy();
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

    // Relay worker events to that user's sockets only.
    const subscriber = createRedis("subscriber");
    // Queued by the client until it is connected, and re-applied after a reconnect.
    subscriber.subscribe(SAVE_EVENTS_CHANNEL, (raw) => {
        let evt;
        try { evt = JSON.parse(raw); } catch { return; }
        const targets = socketsByUser.get(String(evt.userId));
        if (!targets) return;
        const { userId, ...payload } = evt; // don't echo internal routing info
        const msg = JSON.stringify({ type: "vehicle-save", ...payload });
        for (const ws of targets) if (ws.readyState === ws.OPEN) ws.send(msg);
    }).catch((err) => logToFile(`[WS] subscribe failed: ${err.message}`));

    // Drop half-open connections (laptop lid closed, Wi-Fi gone) and keep
    // idle connections alive through proxies / load balancers.
    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            if (!ws.isAlive) { ws.terminate(); continue; }
            ws.isAlive = false;
            ws.ping();
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
