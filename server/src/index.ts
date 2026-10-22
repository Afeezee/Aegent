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
  AuthError, ForbiddenError,
  checkPassword, findUserByEmail, findUserByHandle, findUserByPhone, getUserById,
  hashNewPassword, issueTokens,
  listActiveSessions, loginUser, registerUser, revokeOtherSessions, revokeSession,
  rotateRefreshToken, searchUsers, setPhone, toPublic, updatePrivacy, verifyToken,
} from "./auth.js";
import {
  applyNewPassword, completeReset, mintChallenge, putRecoveryWrapper, recoveryStatus,
} from "./recovery.js";
import { db, initSchema, livePresence, type MessageRow, type UserRow } from "./db.js";
import { createGroup, groupById, groupsForUser, isMember, membersOf } from "./groups.js";
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
  wrappedPrivRec: z.string().min(1).optional(),
  recSalt: z.string().min(1).optional(),
  deviceLabel: z.string().max(120).optional(),
});
app.post("/api/register", async (req, res) => {
  try { res.json(await registerUser(registerBody.parse(req.body))); }
  catch (e) { handleError(res, e); }
});

const loginBody = z.object({
  email: z.string().email(), password: z.string(),
  deviceLabel: z.string().max(120).optional(),
});
app.post("/api/login", async (req, res) => {
  try { res.json(await loginUser(loginBody.parse(req.body))); }
  catch (e) { handleError(res, e); }
});

app.post("/api/refresh", async (req, res) => {
  try {
    const body = z.object({ refreshToken: z.string().min(1) }).parse(req.body);
    const r = await rotateRefreshToken(body.refreshToken);
    res.json({ token: r.accessToken, refreshToken: r.refreshToken });
  } catch (e) { handleError(res, e); }
});

app.get("/api/sessions", authed, async (req, res) => {
  try { res.json(await listActiveSessions((req as AuthedReq).userId)); }
  catch (e) { handleError(res, e); }
});

app.post("/api/sessions/revoke-others", authed, async (req, res) => {
  try {
    const body = z.object({ keepRefresh: z.string().min(1) }).parse(req.body);
    const n = await revokeOtherSessions((req as AuthedReq).userId, body.keepRefresh);
    res.json({ revoked: n });
  } catch (e) { handleError(res, e); }
});

app.post("/api/sessions/:id/revoke", authed, async (req, res) => {
  try {
    await revokeSession((req as AuthedReq).userId, req.params.id);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

// ---- key vault + account recovery ----
//
// The identity private key is what makes stored history readable, so it
// gets wrapped twice: once under the password, once under a recovery
// code. These routes manage the second wrapper and the reset that uses
// it. See recovery.ts for the threat model.

app.get("/api/me/recovery", authed, async (req, res) => {
  try { res.json(await recoveryStatus((req as AuthedReq).userId)); }
  catch (e) { handleError(res, e); }
});

app.put("/api/me/recovery", authed, async (req, res) => {
  try {
    const body = z.object({
      wrappedPrivRec: z.string().min(1),
      recSalt: z.string().min(1),
    }).parse(req.body);
    await putRecoveryWrapper((req as AuthedReq).userId, body);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

// Change password while signed in. The client re-wraps the SAME private
// key under the new password and sends the new wrapper with it, so no
// message ever becomes unreadable.
app.post("/api/password/change", authed, async (req, res) => {
  try {
    const body = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8),
      wrappedPriv: z.string().min(1),
      kdfSalt: z.string().min(1),
    }).parse(req.body);
    const uid = (req as AuthedReq).userId;
    if (!(await checkPassword(uid, body.currentPassword))) {
      throw new AuthError("bad_credentials", "Current password is wrong.");
    }
    await applyNewPassword(uid, {
      passwordHash: await hashNewPassword(body.newPassword),
      wrappedPriv: body.wrappedPriv,
      kdfSalt: body.kdfSalt,
    });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

// Step 1 of a reset: hand back the recovery wrapper plus a nonce boxed
// to the account's public key. Unauthenticated by necessity — the whole
// point is that the user can't sign in. Both returned secrets are inert
// without the user's 128-bit recovery code.
app.post("/api/recovery/challenge", async (req, res) => {
  try {
    const body = z.object({ email: z.string().email() }).parse(req.body);
    res.json(await mintChallenge(body.email));
  } catch (e) { handleError(res, e); }
});

// Step 2: the proof is the nonce, which only the identity private key
// could have revealed. On success we also sign the device in.
app.post("/api/password/reset", async (req, res) => {
  try {
    const body = z.object({
      challengeId: z.string().min(1),
      proof: z.string().min(1),
      newPassword: z.string().min(8),
      wrappedPriv: z.string().min(1),
      kdfSalt: z.string().min(1),
      deviceLabel: z.string().max(120).optional(),
    }).parse(req.body);
    const u = await completeReset({
      challengeId: body.challengeId,
      proof: body.proof,
      passwordHash: await hashNewPassword(body.newPassword),
      wrappedPriv: body.wrappedPriv,
      kdfSalt: body.kdfSalt,
    });
    const tokens = await issueTokens(u.id, body.deviceLabel);
    res.json({ user: toPublic(u, livePresence), ...tokens });
  } catch (e) { handleError(res, e); }
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

// Joining by group id is closed.
//
// This route used to admit any authenticated caller who knew (or guessed)
// a group's UUID — no invite, no approval, no role check. Group ids
// travel in deep links, so that made the link itself a permanent
// membership capability for anyone who ever saw it.
//
// Nothing in the shipped client calls this (`api.joinGroup` has no call
// sites), so failing closed breaks no existing flow. Token-based
// redemption arrives with the Groups work; until then this answers
// legibly rather than 404-ing, so an older build shows "you need an
// invite" instead of "this group is gone".
app.post("/api/groups/:id/join", authed, async (_req, res) => {
  res.status(403).json({
    error: "invites_required",
    message: "Groups can only be joined with an invite from a member.",
  });
});

// ---- inbox + ack ----

app.get("/api/inbox", authed, async (req, res) => {
  try {
    const uid = (req as AuthedReq).userId;
    // Drain semantics.
    //
    // `all=true` is the availability path: every envelope ever
    // addressed to this user (delivered or not, self-echoes included),
    // which is what a brand-new device needs to rebuild the account's
    // whole history. Without `all` we return only undelivered rows.
    //
    // Paging is keyset, not offset: (created_at, id) is a total order,
    // so a cursor resumes exactly where it stopped even when many
    // envelopes share a millisecond and even if the set grows
    // underneath us. The previous unbounded response meant a few
    // thousand messages arrived as one multi-megabyte JSON the client
    // had to ingest in a single shot — precisely when history looked
    // "cut off".
    const wantAll = String(req.query.all ?? "") === "true";
    const since = Number(req.query.since ?? 0) || 0;
    const afterId = String(req.query.afterId ?? "");
    const limit = Math.min(Math.max(Number(req.query.limit ?? 400) || 400, 1), 1000);

    const where: string[] = ["recipient_id = ?"];
    const args: unknown[] = [uid];
    if (!wantAll) where.push("delivered_at IS NULL");
    if (afterId) {
      where.push("(created_at > ? OR (created_at = ? AND id > ?))");
      args.push(since, since, afterId);
    } else if (since) {
      where.push("created_at >= ?");
      args.push(since);
    }

    const rows = await db.prepare(
      `SELECT * FROM messages
         WHERE ${where.join(" AND ")}
         ORDER BY created_at ASC, id ASC
         LIMIT ${limit}`,
    ).all<MessageRow>(...args);

    const last = rows[rows.length - 1];
    res.json({
      envelopes: rows.map(envelopeOf),
      // `more` lets the client page without guessing.
      more: rows.length === limit,
      cursor: last ? { since: Number(last.created_at), afterId: last.id } : null,
    });
  } catch (e) { handleError(res, e); }
});

// Exact reconciliation: the ids of every envelope addressed to this
// user. The client diffs this against its own ledger to learn precisely
// which envelopes it is missing, then asks for those by id.
//
// Counting was not good enough. A count says "you are 122 behind" but
// not *which* 122, so a device whose history predates the ledger — or
// which holds envelopes its paging cursor can no longer reach — can sit
// at a permanent, unfixable deficit while in fact missing nothing. An id
// diff converges or names exactly what didn't.
app.get("/api/inbox/ids", authed, async (req, res) => {
  try {
    const uid = (req as AuthedReq).userId;
    // Ids are ~36 bytes each. The cap keeps the response sane for very
    // large accounts; past it the client falls back to count comparison.
    const MAX_IDS = 20000;
    const rows = await db.prepare(
      `SELECT id FROM messages
         WHERE recipient_id = ?
         ORDER BY created_at ASC, id ASC
         LIMIT ${MAX_IDS + 1}`,
    ).all<{ id: string }>(uid);
    const truncated = rows.length > MAX_IDS;
    res.json({
      ids: rows.slice(0, MAX_IDS).map((r) => r.id),
      truncated,
    });
  } catch (e) { handleError(res, e); }
});

// Fetch specific envelopes by id — the repair half of reconciliation.
// Ordering and cursors are irrelevant here, which is the point: an
// envelope that no cursor can reach is still retrievable by id.
app.post("/api/inbox/fetch", authed, async (req, res) => {
  try {
    const body = z.object({ ids: z.array(z.string()).min(1).max(300) }).parse(req.body);
    const uid = (req as AuthedReq).userId;
    const out: ReturnType<typeof envelopeOf>[] = [];
    for (const id of body.ids) {
      const row = await db.prepare(
        "SELECT * FROM messages WHERE id = ? AND recipient_id = ?",
      ).get<MessageRow>(id, uid);
      if (row) out.push(envelopeOf(row));
    }
    res.json({ envelopes: out });
  } catch (e) { handleError(res, e); }
});

// Availability watchdog. The client compares these counts against what
// it actually holds locally; any shortfall triggers reconciliation
// instead of waiting for the user to notice missing messages.
app.get("/api/inbox/stats", authed, async (req, res) => {
  try {
    const uid = (req as AuthedReq).userId;
    const row = await db.prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS newest, MIN(created_at) AS oldest
         FROM messages WHERE recipient_id = ?`,
    ).get<{ n: number | string; newest: number | null; oldest: number | null }>(uid);
    res.json({
      total: Number(row?.n ?? 0),
      newestAt: row?.newest ? Number(row.newest) : null,
      oldestAt: row?.oldest ? Number(row.oldest) : null,
    });
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

// Per-socket membership cache.
//
// A group send is one envelope per member, so checking membership on
// every envelope would turn a 256-member group into 512 round trips to
// Postgres for a single message. Thirty seconds of staleness means a
// member removed mid-conversation can post for a few more seconds — an
// acceptable trade against making every group message quadratic.
const GROUP_CACHE_TTL_MS = 30_000;
type SocketData = { userId: string; groupCache?: Map<string, { member: boolean; at: number }> };

async function socketIsMember(
  socket: { data: unknown }, groupId: string, userId: string,
): Promise<boolean> {
  const data = socket.data as SocketData;
  const cache = data.groupCache ?? (data.groupCache = new Map());
  const hit = cache.get(groupId);
  const now = Date.now();
  if (hit && now - hit.at < GROUP_CACHE_TTL_MS) return hit.member;
  const member = await isMember(groupId, userId);
  cache.set(groupId, { member, at: now });
  return member;
}

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
      if (body.groupId) {
        // Both checks matter and both must stay. The sender check is the
        // one that was missing: the relay only verified that each named
        // RECIPIENT was a member, so anyone who knew a group id could
        // post into it by addressing real members.
        if (!(await socketIsMember(socket, body.groupId, userId))) {
          return ack?.({ ok: false, error: "not_group_member" });
        }
        if (!(await isMember(body.groupId, body.recipientId))) {
          return ack?.({ ok: false, error: "recipient_not_member" });
        }
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
      // Same hole as `send`: anyone who knew a group id could broadcast
      // into it, here without even naming a recipient.
      if (!(await socketIsMember(socket, payload.groupId, userId))) return;
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
    // Explicitly numeric. db.ts already teaches pg to parse int8 as a
    // number, but this value becomes an IndexedDB key on the client,
    // where a string would sort outside every numeric range query and
    // make the message invisible. Too important to leave implicit.
    createdAt: Number(m.created_at),
  };
}

function handleError(res: express.Response, e: unknown) {
  if (e instanceof ForbiddenError) return res.status(403).json({ error: e.code, message: e.message });
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
