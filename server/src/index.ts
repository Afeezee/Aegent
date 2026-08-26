// Aegent relay server.
//
// Responsibilities:
//   1. Registration / authentication + public directory (id → handle,
//      display name, public key, optional phone).
//   2. Store ciphertext-only message envelopes for offline delivery.
//   3. Relay live messages between connected sockets.
//   4. Store encrypted media blobs (opaque bytes).
//   5. Group *routing* — track membership so a client can send one
//      envelope per member via a single call.
//   6. Presence, when a user opts in.
//   7. Serve the built SPA in production for single-origin deploys.
//
// Not a responsibility, ever: read message content. Every content
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
  AuthError, findUserByEmail, findUserByHandle, findUserByPhone, getUserById,
  loginUser, registerUser, searchUsers, setPhone, toPublic, updatePrivacy, verifyToken,
} from "./auth.js";
import { db, initSchema, livePresence, type MessageRow, type UserRow } from "./db.js";
import { addMember, createGroup, groupById, groupsForUser, isMember, membersOf } from "./groups.js";
import { MAX_BLOB_BYTES, readBlob, storeBlob } from "./blobs.js";
import { MAX_BACKUP_BYTES, backupMeta, readBackup, saveBackup } from "./backups.js";
import { agentTurn } from "./agent.js";

const PORT = Number(process.env.PORT ?? 8787);

const app = express();

// CORS: allow the browser deploy (any origin — we're auth'd via bearer
// token, not cookies, so credential-cross-origin isn't a concern) and
// the Capacitor WebView origins (https://localhost on Android, and
// capacitor://localhost on iOS). This is a wide-open allow for a
// prototype; production should allowlist explicit origins here.
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  credentials: false,
}));
app.use(express.json({ limit: "2mb" }));
app.use("/api/blobs", express.raw({ type: "*/*", limit: MAX_BLOB_BYTES + 1024 }));
app.use("/api/backup", express.raw({ type: "application/octet-stream", limit: MAX_BACKUP_BYTES + 1024 }));

// Healthcheck — no auth, no state. Used by Railway / load balancers.
app.get("/healthz", (_req, res) => res.json({
  ok: true,
  ts: Date.now(),
  llm: !!process.env.ANTHROPIC_API_KEY,
  db: db.backend,
}));

// LLM agent proxy — keeps the API key server-side.
app.post("/api/agent/turn", authed, (req, res) => agentTurn(req as AuthedReq, res));

// ---- registration / auth ----

const registerBody = z.object({
  email: z.string().email(),
  phone: z.string().min(1).max(30).optional(),
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

app.get("/api/me", authed, async (req, res) => {
  try {
    const u = await getUserById((req as AuthedReq).userId);
    if (!u) return res.status(404).json({ error: "not_found" });
    res.json({
      ...toPublic(u, livePresence),
      settings: {
        readReceipts: !!u.read_receipts,
        presence: !!u.presence,
      },
    });
  } catch (e) { handleError(res, e); }
});

app.patch("/api/me/settings", authed, async (req, res) => {
  try {
    const body = z.object({
      readReceipts: z.boolean().optional(),
      presence: z.boolean().optional(),
    }).parse(req.body);
    await updatePrivacy((req as AuthedReq).userId, body);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.put("/api/me/phone", authed, async (req, res) => {
  try {
    const body = z.object({ phone: z.string().nullable() }).parse(req.body);
    await setPhone((req as AuthedReq).userId, body.phone);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

// ---- directory ----

app.get("/api/users/search", authed, async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.json([]);
    res.json(await searchUsers(q, (req as AuthedReq).userId));
  } catch (e) { handleError(res, e); }
});

app.get("/api/users/by-email/:email", authed, async (req, res) => {
  try {
    const u = await findUserByEmail(req.params.email);
    if (!u) return res.status(404).json({ error: "not_found" });
    res.json(toPublic(u, livePresence));
  } catch (e) { handleError(res, e); }
});

app.get("/api/users/by-handle/:handle", authed, async (req, res) => {
  try {
    const u = await findUserByHandle(req.params.handle);
    if (!u) return res.status(404).json({ error: "not_found" });
    res.json(toPublic(u, livePresence));
  } catch (e) { handleError(res, e); }
});

app.get("/api/users/by-phone/:phone", authed, async (req, res) => {
  try {
    const u = await findUserByPhone(req.params.phone);
    if (!u) return res.status(404).json({ error: "not_found" });
    res.json(toPublic(u, livePresence));
  } catch (e) { handleError(res, e); }
});

app.get("/api/users/:id", authed, async (req, res) => {
  try {
    const u = await getUserById(req.params.id);
    if (!u) return res.status(404).json({ error: "not_found" });
    res.json(toPublic(u, livePresence));
  } catch (e) { handleError(res, e); }
});

app.post("/api/users/lookup-phones", authed, async (req, res) => {
  try {
    // Real phone contact lists are large — 500 per request is a comfortable
    // upper bound; the client should still chunk beyond that.
    const body = z.object({ phones: z.array(z.string()).max(500) }).parse(req.body);
    const found: Array<ReturnType<typeof toPublic>> = [];
    for (const raw of body.phones) {
      if (!raw || !raw.trim()) continue;
      const u = await findUserByPhone(raw);
      if (u && u.id !== (req as AuthedReq).userId) found.push(toPublic(u, livePresence));
    }
    res.json(found);
  } catch (e) { handleError(res, e); }
});

// ---- groups ----

app.post("/api/groups", authed, async (req, res) => {
  try {
    const body = z.object({
      name: z.string().min(1).max(80),
      memberIds: z.array(z.string()).min(1),
    }).parse(req.body);
    const g = await createGroup({
      name: body.name,
      createdBy: (req as AuthedReq).userId,
      memberIds: body.memberIds,
    });
    res.json({ ...g, memberIds: await membersOf(g.id) });
  } catch (e) { handleError(res, e); }
});

app.get("/api/groups", authed, async (req, res) => {
  try {
    const gs = await groupsForUser((req as AuthedReq).userId);
    const out = [];
    for (const g of gs) out.push({ ...g, memberIds: await membersOf(g.id) });
    res.json(out);
  } catch (e) { handleError(res, e); }
});

app.get("/api/groups/:id", authed, async (req, res) => {
  try {
    const g = await groupById(req.params.id);
    if (!g || !(await isMember(g.id, (req as AuthedReq).userId))) return res.status(404).json({ error: "not_found" });
    res.json({ ...g, memberIds: await membersOf(g.id) });
  } catch (e) { handleError(res, e); }
});

app.post("/api/groups/:id/join", authed, async (req, res) => {
  try {
    const g = await groupById(req.params.id);
    if (!g) return res.status(404).json({ error: "not_found" });
    await addMember(g.id, (req as AuthedReq).userId);
    res.json({ ...g, memberIds: await membersOf(g.id) });
  } catch (e) { handleError(res, e); }
});

// ---- inbox + ack ----

app.get("/api/inbox", authed, async (req, res) => {
  try {
    const rows = await db.prepare(
      `SELECT * FROM messages
         WHERE recipient_id = ? AND delivered_at IS NULL
         ORDER BY created_at ASC`,
    ).all<MessageRow>((req as AuthedReq).userId);
    res.json(rows.map(envelopeOf));
  } catch (e) { handleError(res, e); }
});

app.post("/api/ack", authed, async (req, res) => {
  try {
    const ids = z.array(z.string()).parse(req.body?.ids ?? []);
    if (ids.length === 0) return res.json({ ok: true });
    const now = Date.now();
    const stmt = db.prepare("UPDATE messages SET delivered_at = ? WHERE id = ? AND recipient_id = ?");
    await db.tx(async () => {
      for (const id of ids) await stmt.run(now, id, (req as AuthedReq).userId);
    });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.post("/api/read", authed, async (req, res) => {
  try {
    const body = z.object({ ids: z.array(z.string()) }).parse(req.body);
    const uid = (req as AuthedReq).userId;
    const me = await getUserById(uid);
    if (!me?.read_receipts) return res.json({ ok: true, sent: 0 });
    const now = Date.now();
    const stmt = db.prepare("UPDATE messages SET read_at = ? WHERE id = ? AND recipient_id = ?");
    await db.tx(async () => {
      for (const id of body.ids) await stmt.run(now, id, uid);
    });
    for (const id of body.ids) {
      const row = await db.prepare("SELECT sender_id FROM messages WHERE id = ?").get<{ sender_id: string }>(id);
      if (row) io.to(`u:${row.sender_id}`).emit("read", { id, at: now, by: uid });
    }
    res.json({ ok: true, sent: body.ids.length });
  } catch (e) { handleError(res, e); }
});

// ---- blobs ----

app.post("/api/blobs", authed, async (req, res) => {
  try {
    const mime = req.header("x-mime") || "application/octet-stream";
    const bytes = req.body as Buffer;
    if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
      return res.status(400).json({ error: "empty_body" });
    }
    const { id, size } = await storeBlob({ ownerId: (req as AuthedReq).userId, mime, ciphertext: bytes });
    res.json({ id, size });
  } catch (e) {
    if ((e as Error).message === "blob_too_large") return res.status(413).json({ error: "too_large" });
    handleError(res, e);
  }
});

// ---- encrypted per-user backup (opaque bytes; see backups.ts) ----

app.put("/api/backup", authed, async (req, res) => {
  try {
    const bytes = req.body as Buffer;
    if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
      return res.status(400).json({ error: "empty_body" });
    }
    const out = await saveBackup((req as AuthedReq).userId, bytes);
    res.json({ ok: true, ...out });
  } catch (e) {
    if ((e as Error).message === "backup_too_large") return res.status(413).json({ error: "too_large" });
    handleError(res, e);
  }
});

app.get("/api/backup", authed, async (req, res) => {
  try {
    const row = await readBackup((req as AuthedReq).userId);
    if (!row) return res.status(404).json({ error: "no_backup" });
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("x-backup-created-at", String(row.createdAt));
    res.setHeader("x-byte-size", String(row.bytes.byteLength));
    res.send(row.bytes);
  } catch (e) { handleError(res, e); }
});

app.get("/api/backup/meta", authed, async (req, res) => {
  try {
    const m = await backupMeta((req as AuthedReq).userId);
    if (!m) return res.status(404).json({ error: "no_backup" });
    res.json(m);
  } catch (e) { handleError(res, e); }
});

// Restore path — unauthenticated. The client derives its public key
// deterministically from the user's recovery phrase, looks itself up
// with that public key, and gets the ciphertext backup back. The
// backup is opaque bytes encrypted with a key that only the phrase
// can derive; leaking it here is cryptographically harmless.
//
// A small size/timing side channel (which handles have backups, and
// roughly how big) remains — acceptable for the pilot; hide behind
// a rate limiter for public launches.
app.post("/api/backup/by-pubkey", async (req, res) => {
  try {
    const body = z.object({ publicKey: z.string().min(1) }).parse(req.body);
    const row = await db.prepare(
      "SELECT id FROM users WHERE public_key = ?",
    ).get<{ id: string }>(body.publicKey);
    if (!row) return res.status(404).json({ error: "not_found" });
    const backup = await readBackup(row.id);
    if (!backup) return res.status(404).json({ error: "no_backup" });
    res.json({
      backup: backup.bytes.toString("base64"),
      createdAt: backup.createdAt,
    });
  } catch (e) { handleError(res, e); }
});

app.get("/api/blobs/:id", authed, async (req, res) => {
  try {
    const b = await readBlob(req.params.id);
    if (!b) return res.status(404).json({ error: "not_found" });
    res.setHeader("content-type", b.mime);
    res.setHeader("x-byte-size", String(b.byte_size));
    res.send(Buffer.from(b.ciphertext));
  } catch (e) { handleError(res, e); }
});

// ---- WebSocket relay ----

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
  broadcastPresence(userId, true).catch(() => { /* ignore */ });

  socket.on("send", async (raw, ack) => {
    try {
      const body = z.object({
        recipientId: z.string(),
        ciphertext: z.string().min(1),
        groupId: z.string().optional(),
      }).parse(raw);

      const recipient = await getUserById(body.recipientId);
      if (!recipient) return ack?.({ ok: false, error: "unknown_recipient" });
      if (body.groupId && !(await isMember(body.groupId, body.recipientId))) {
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
      await db.prepare(
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

  socket.on("typing", async (payload: { recipientId?: string; groupId?: string }) => {
    if (payload.recipientId) {
      io.to(`u:${payload.recipientId}`).emit("typing", { from: userId, groupId: payload.groupId });
    } else if (payload.groupId) {
      for (const uid of await membersOf(payload.groupId)) {
        if (uid !== userId) io.to(`u:${uid}`).emit("typing", { from: userId, groupId: payload.groupId });
      }
    }
  });

  socket.on("disconnect", async () => {
    livePresence.delete(userId);
    const u = await getUserById(userId);
    if (u?.presence) {
      await db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(Date.now(), userId);
    }
    broadcastPresence(userId, false).catch(() => { /* ignore */ });
  });
});

async function broadcastPresence(userId: string, online: boolean) {
  const u = await getUserById(userId);
  if (!u?.presence) return;
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

// ---- serve the SPA in production ----
const SPA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(SPA_DIR)) {
  app.use(express.static(SPA_DIR));
  app.get(/^\/(?!api|socket\.io).*/, (_req, res) => {
    res.sendFile(resolve(SPA_DIR, "index.html"));
  });
  console.log(`[aegent] serving SPA from ${SPA_DIR}`);
}

// ---- boot ----
async function boot() {
  await initSchema();
  httpServer.listen(PORT, () => {
    console.log(`[aegent] relay listening on http://localhost:${PORT}`);
  });
}
boot().catch((e) => {
  console.error("[aegent] boot failed:", e);
  process.exit(1);
});
