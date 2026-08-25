// Aegent relay server.
//
// Responsibilities, and only these:
//   1. Registration / authentication, and the public directory (id →
//      handle, display name, public key).
//   2. Store ciphertext-only message envelopes for offline delivery.
//   3. Relay live messages between connected sockets.
//   4. Store encrypted media blobs (opaque bytes) and hand them back on
//      request.
//   5. Group *routing*: track membership so a client can send one
//      envelope per member with one API call.
//   6. Presence, when a user opts in.
//
// Not a responsibility, ever: reading message content. Every content
// column in the DB is opaque.

import "dotenv/config";
import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server as SocketServer } from "socket.io";
import { z } from "zod";
import {
  AuthError, findUserByEmail, findUserByHandle, getUserById,
  loginUser, registerUser, searchUsers, toPublic, updatePrivacy, verifyToken,
} from "./auth.js";
import { db, livePresence, type MessageRow, type UserRow } from "./db.js";
import { addMember, createGroup, groupById, groupsForUser, isMember, membersOf } from "./groups.js";
import { MAX_BLOB_BYTES, readBlob, storeBlob } from "./blobs.js";
import { agentTurn } from "./agent.js";

const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
// Blob upload uses raw bytes; content-type is echoed as a header.
app.use("/api/blobs", express.raw({ type: "*/*", limit: MAX_BLOB_BYTES + 1024 }));

// Healthcheck — no auth, no state. Used by Railway / load balancers.
app.get("/healthz", (_req, res) => res.json({
  ok: true,
  ts: Date.now(),
  llm: !!process.env.ANTHROPIC_API_KEY, // clients can render an LLM badge if true
}));

// LLM agent proxy — keeps the API key server-side. The client uses this
// only for the LLM call itself; retrieval/tool execution stays on-device.
app.post("/api/agent/turn", authed, (req, res) => agentTurn(req as AuthedReq, res));

// ---- registration / auth ----

const registerBody = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(80),
  password: z.string().min(8),
  publicKey: z.string().min(1),
  wrappedPriv: z.string().min(1),
  kdfSalt: z.string().min(1),
});
app.post("/api/register", async (req, res) => {
  try { res.json(await registerUser(registerBody.parse(req.body))); }
  catch (e) { handleError(res, e); }
});

const loginBody = z.object({ email: z.string().email(), password: z.string() });
app.post("/api/login", async (req, res) => {
  try { res.json(await loginUser(loginBody.parse(req.body))); }
  catch (e) { handleError(res, e); }
});

// ---- current user + privacy ----

app.get("/api/me", authed, (req, res) => {
  const u = getUserById((req as AuthedReq).userId);
  if (!u) return res.status(404).json({ error: "not_found" });
  res.json({
    ...toPublic(u, livePresence),
    settings: {
      readReceipts: !!u.read_receipts,
      presence: !!u.presence,
    },
  });
});

app.patch("/api/me/settings", authed, (req, res) => {
  const body = z.object({
    readReceipts: z.boolean().optional(),
    presence: z.boolean().optional(),
  }).parse(req.body);
  updatePrivacy((req as AuthedReq).userId, body);
  res.json({ ok: true });
});

// ---- directory ----

app.get("/api/users/search", authed, (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.json([]);
  res.json(searchUsers(q, (req as AuthedReq).userId));
});

app.get("/api/users/by-email/:email", authed, (req, res) => {
  const u = findUserByEmail(req.params.email);
  if (!u) return res.status(404).json({ error: "not_found" });
  res.json(toPublic(u, livePresence));
});

app.get("/api/users/by-handle/:handle", authed, (req, res) => {
  const u = findUserByHandle(req.params.handle);
  if (!u) return res.status(404).json({ error: "not_found" });
  res.json(toPublic(u, livePresence));
});

app.get("/api/users/:id", authed, (req, res) => {
  const u = getUserById(req.params.id);
  if (!u) return res.status(404).json({ error: "not_found" });
  res.json(toPublic(u, livePresence));
});

// ---- groups ----

app.post("/api/groups", authed, (req, res) => {
  const body = z.object({
    name: z.string().min(1).max(80),
    memberIds: z.array(z.string()).min(1),
  }).parse(req.body);
  const g = createGroup({
    name: body.name,
    createdBy: (req as AuthedReq).userId,
    memberIds: body.memberIds,
  });
  res.json({ ...g, memberIds: membersOf(g.id) });
});

app.get("/api/groups", authed, (req, res) => {
  const gs = groupsForUser((req as AuthedReq).userId);
  res.json(gs.map((g) => ({ ...g, memberIds: membersOf(g.id) })));
});

app.get("/api/groups/:id", authed, (req, res) => {
  const g = groupById(req.params.id);
  if (!g || !isMember(g.id, (req as AuthedReq).userId)) return res.status(404).json({ error: "not_found" });
  res.json({ ...g, memberIds: membersOf(g.id) });
});

app.post("/api/groups/:id/join", authed, (req, res) => {
  const g = groupById(req.params.id);
  if (!g) return res.status(404).json({ error: "not_found" });
  addMember(g.id, (req as AuthedReq).userId);
  res.json({ ...g, memberIds: membersOf(g.id) });
});

// ---- inbox + ack ----

app.get("/api/inbox", authed, (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM messages
       WHERE recipient_id = ? AND delivered_at IS NULL
       ORDER BY created_at ASC`,
  ).all((req as AuthedReq).userId) as MessageRow[];
  res.json(rows.map(envelopeOf));
});

app.post("/api/ack", authed, (req, res) => {
  const ids = z.array(z.string()).parse(req.body?.ids ?? []);
  if (ids.length === 0) return res.json({ ok: true });
  const now = Date.now();
  const stmt = db.prepare("UPDATE messages SET delivered_at = ? WHERE id = ? AND recipient_id = ?");
  db.exec("BEGIN");
  try {
    for (const id of ids) stmt.run(now, id, (req as AuthedReq).userId);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  res.json({ ok: true });
});

// A "read" is a client-attested event. We record the timestamp for the
// sender's UI and relay it live to them, *only* if the sender has read
// receipts enabled (their toggle). Otherwise the read stays local.
app.post("/api/read", authed, (req, res) => {
  const body = z.object({ ids: z.array(z.string()) }).parse(req.body);
  const uid = (req as AuthedReq).userId;
  const me = getUserById(uid);
  if (!me?.read_receipts) return res.json({ ok: true, sent: 0 });
  const now = Date.now();
  const stmt = db.prepare("UPDATE messages SET read_at = ? WHERE id = ? AND recipient_id = ?");
  db.exec("BEGIN");
  try {
    for (const id of body.ids) stmt.run(now, id, uid);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  // Notify senders — one push per message id since senders may differ.
  for (const id of body.ids) {
    const row = db.prepare("SELECT sender_id FROM messages WHERE id = ?").get(id) as { sender_id: string } | undefined;
    if (row) io.to(`u:${row.sender_id}`).emit("read", { id, at: now, by: uid });
  }
  res.json({ ok: true, sent: body.ids.length });
});

// ---- blobs (encrypted media) ----

app.post("/api/blobs", authed, (req, res) => {
  const mime = req.header("x-mime") || "application/octet-stream";
  const bytes = req.body as Buffer;
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
    return res.status(400).json({ error: "empty_body" });
  }
  try {
    const { id, size } = storeBlob({ ownerId: (req as AuthedReq).userId, mime, ciphertext: bytes });
    res.json({ id, size });
  } catch (e) {
    if ((e as Error).message === "blob_too_large") return res.status(413).json({ error: "too_large" });
    handleError(res, e);
  }
});

app.get("/api/blobs/:id", authed, (req, res) => {
  const b = readBlob(req.params.id);
  if (!b) return res.status(404).json({ error: "not_found" });
  res.setHeader("content-type", b.mime);
  res.setHeader("x-byte-size", String(b.byte_size));
  res.send(Buffer.from(b.ciphertext));
});

// ---- WebSocket: live relay ----

const httpServer = createServer(app);
export const io = new SocketServer(httpServer, { cors: { origin: "*" } });

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) throw new Error("missing_token");
    (socket.data as { userId: string }).userId = verifyToken(token);
    next();
  } catch { next(new Error("unauthorized")); }
});

io.on("connection", (socket) => {
  const userId = (socket.data as { userId: string }).userId;
  livePresence.set(userId, Date.now());
  socket.join(`u:${userId}`);
  broadcastPresence(userId, true);

  // Send an envelope. The client may include a group_id (public routing
  // info); we still expect one send() call per recipient (each with the
  // ciphertext encrypted to that specific recipient's public key).
  socket.on("send", (raw, ack) => {
    try {
      const body = z.object({
        recipientId: z.string(),
        ciphertext: z.string().min(1),
        groupId: z.string().optional(),
      }).parse(raw);

      const recipient = getUserById(body.recipientId);
      if (!recipient) return ack?.({ ok: false, error: "unknown_recipient" });
      if (body.groupId && !isMember(body.groupId, body.recipientId)) {
        return ack?.({ ok: false, error: "not_group_member" });
      }

      const row: MessageRow = {
        id: randomUUID(),
        sender_id: userId,
        recipient_id: body.recipientId,
        group_id: body.groupId ?? null,
        ciphertext: body.ciphertext,
        created_at: Date.now(),
        delivered_at: null,
        read_at: null,
      };
      db.prepare(
        `INSERT INTO messages (id, sender_id, recipient_id, group_id, ciphertext, created_at, delivered_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(row.id, row.sender_id, row.recipient_id, row.group_id, row.ciphertext, row.created_at);

      const envelope = envelopeOf(row);
      io.to(`u:${body.recipientId}`).emit("message", envelope);
      ack?.({ ok: true, envelope });
    } catch (err) {
      ack?.({ ok: false, error: (err as Error).message });
    }
  });

  // Typing indicator — bounded routing only, no persistence.
  socket.on("typing", (payload: { recipientId?: string; groupId?: string }) => {
    if (payload.recipientId) {
      io.to(`u:${payload.recipientId}`).emit("typing", { from: userId, groupId: payload.groupId });
    } else if (payload.groupId) {
      for (const uid of membersOf(payload.groupId)) {
        if (uid !== userId) io.to(`u:${uid}`).emit("typing", { from: userId, groupId: payload.groupId });
      }
    }
  });

  socket.on("disconnect", () => {
    livePresence.delete(userId);
    // Persist last_seen only for users who opted in to presence.
    const u = getUserById(userId);
    if (u?.presence) {
      db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(Date.now(), userId);
    }
    broadcastPresence(userId, false);
  });
});

function broadcastPresence(userId: string, online: boolean) {
  const u = getUserById(userId);
  if (!u?.presence) return;
  // Broadcast presence updates to any online user — the client will
  // ignore updates for people it doesn't have as a contact.
  io.emit("presence", { userId, online, at: Date.now() });
}

// ---- HTTP helpers ----

type AuthedReq = express.Request & { userId: string };

function authed(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.header("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return res.status(401).json({ error: "unauthorized" });
  try {
    (req as AuthedReq).userId = verifyToken(m[1]);
    next();
  } catch { res.status(401).json({ error: "unauthorized" }); }
}

function envelopeOf(m: MessageRow) {
  return {
    id: m.id,
    senderId: m.sender_id,
    recipientId: m.recipient_id,
    groupId: m.group_id,
    ciphertext: m.ciphertext,
    createdAt: m.created_at,
  };
}

function handleError(res: express.Response, e: unknown) {
  if (e instanceof AuthError) return res.status(400).json({ error: e.code, message: e.message });
  if (e instanceof z.ZodError) return res.status(400).json({ error: "bad_request", issues: e.issues });
  console.error(e);
  res.status(500).json({ error: "internal" });
}

// keep TS happy — referenced elsewhere
export type _UserRow = UserRow;

// ---- serve the SPA (single-origin production deploy) ----
// In dev the web/ package is served by Vite on :5173 and proxies /api to
// this process; in a production build we serve the built SPA from here so
// the client's `location.origin` naturally points at the same host as the
// relay. If web/dist doesn't exist (e.g. during a server-only dev run),
// we silently skip this — no error, no phantom route.
const SPA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(SPA_DIR)) {
  app.use(express.static(SPA_DIR));
  // History-mode fallback: anything that isn't an API/WS call gets index.html.
  app.get(/^\/(?!api|socket\.io).*/, (_req, res) => {
    res.sendFile(resolve(SPA_DIR, "index.html"));
  });
  console.log(`[aegent] serving SPA from ${SPA_DIR}`);
}

httpServer.listen(PORT, () => {
  console.log(`[aegent] relay listening on http://localhost:${PORT}`);
});
