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
  invalidateAdminCache, isAdmin, isSuspended,
  listActiveSessions, loginUser, registerUser, revokeOtherSessions, revokeSession,
  rotateRefreshToken, searchUsers, setPhone, toPublic, updatePrivacy, verifyToken,
} from "./auth.js";
import {
  maybeLogSessionStart, recordAbuseReport, recordErrorReport, recordFeedback,
} from "./analytics.js";
import { adminRouter } from "./admin.js";
import {
  applyNewPassword, completeReset, mintChallenge, putRecoveryWrapper, recoveryStatus,
} from "./recovery.js";
import { db, initSchema, livePresence, type MessageRow, type UserRow } from "./db.js";
import {
  addMember, archiveMessage, banMember, canPost, createGroup, currentEpoch,
  epochsFor, eventsSince, grantEpochKeys, groupById, groupsForUser,
  isMember, listInvites, listRequests, membersOf, membersWithRoles, mintInvite,
  groupArchiveFor, redeemInvite, removeMember, requireRole, resolveRequest, revokeInvite, rotateEpoch,
  setHistoryFrom, setMuted, setRole, settingsOf, unbanMember, updateGroup,
} from "./groups.js";
import { MAX_BLOB_BYTES, readBlob, readBlobFor, storeBlob } from "./blobs.js";
import {
  MAX_AUDIENCE, archiveFor, deleteEntry, editEntryBody, feedFor, granteesOf, markSeen,
  publishEntry, sweepExpiredGrants, updateGrants, viewsOf,
} from "./diary.js";
import { MAX_BACKUP_BYTES, backupMeta, readBackup, saveBackup } from "./backups.js";
import { agentQuota, agentTurn } from "./agent.js";
import { pushEnabled, registerToken, unregisterToken, wake } from "./push.js";

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
app.get("/api/agent/quota", authed, (req, res) => agentQuota(req as AuthedReq, res));

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

// ---- reports + feedback (Phase 2, user-facing writes) ----
//
// The client posts here when:
//   - a top-level exception / network failure happens (/api/reports/error),
//   - a user chooses "Report user" from a chat (/api/reports/abuse),
//   - a user sends feedback / rates the app (/api/feedback).
//
// All three write metadata only (see analytics.ts). The dashboard
// surfacing them lives in Phase 3; this is just the ingest side.

// Error reports MAY arrive without a user (crash on the auth screen),
// so this one isn't gated by `authed`. We still bind the JWT subject
// if a valid Bearer is present so authenticated crashes attribute.
app.post("/api/reports/error", async (req, res) => {
  try {
    const body = z.object({
      kind: z.enum(["crash", "handled", "failed_request"]),
      message: z.string().max(4000).optional(),
      stack: z.string().max(16000).optional(),
      appVersion: z.string().max(60).optional(),
    }).parse(req.body);
    const header = req.header("authorization") ?? "";
    const m = /^Bearer (.+)$/.exec(header);
    let userId: string | null = null;
    if (m) { try { userId = verifyToken(m[1]); } catch { /* anonymous */ } }
    await recordErrorReport({
      userId, kind: body.kind,
      message: body.message, stack: body.stack,
      appVersion: body.appVersion,
      userAgent: req.header("user-agent") ?? null,
    });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.post("/api/reports/abuse", authed, async (req, res) => {
  try {
    const body = z.object({
      reportedUserId: z.string().min(1),
      threadId: z.string().optional(),
      reason: z.enum(["harassment", "spam", "threats", "impersonation", "csam", "other"]),
      reporterNote: z.string().max(4000).optional(),
    }).parse(req.body);
    const id = await recordAbuseReport({
      reporterId: (req as AuthedReq).userId,
      reportedUserId: body.reportedUserId,
      threadId: body.threadId ?? null,
      reason: body.reason,
      reporterNote: body.reporterNote,
    });
    if (!id) return res.status(500).json({ error: "write_failed" });
    res.json({ ok: true, id });
  } catch (e) { handleError(res, e); }
});

app.post("/api/feedback", authed, async (req, res) => {
  try {
    const body = z.object({
      kind: z.enum(["nps", "feature_request", "bug", "general"]),
      rating: z.number().int().min(1).max(5).optional(),
      note: z.string().max(4000).optional(),
    }).parse(req.body);
    await recordFeedback({
      userId: (req as AuthedReq).userId,
      kind: body.kind, rating: body.rating ?? null, note: body.note,
    });
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

// ---- push wake-ups ----

app.post("/api/push/register", authed, async (req, res) => {
  try {
    const body = z.object({
      token: z.string().min(1).max(4096),
      platform: z.string().max(20).optional(),
    }).parse(req.body);
    await registerToken((req as AuthedReq).userId, body.token, body.platform ?? "android");
    res.json({ ok: true, enabled: pushEnabled });
  } catch (e) { handleError(res, e); }
});

app.post("/api/push/unregister", authed, async (req, res) => {
  try {
    const body = z.object({ token: z.string().min(1).max(4096) }).parse(req.body);
    await unregisterToken(body.token);
    res.json({ ok: true });
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
      // Surfaced so the client can gate the Admin dashboard link in
      // Settings. The server still enforces admin-ness on every
      // /api/admin/* request — this is cosmetic only.
      isAdmin: !!u.is_admin,
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
      // A group of one is legitimate now that invite links exist: you
      // create it, then share a link. createGroup always includes the
      // creator, so an empty list is not an empty group.
      memberIds: z.array(z.string()),
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
    for (const g of gs) {
      out.push({ ...g, memberIds: await membersOf(g.id), settings: await settingsOf(g.id) });
    }
    res.json(out);
  } catch (e) { handleError(res, e); }
});

app.get("/api/groups/:id", authed, async (req, res) => {
  try {
    const g = await groupById(req.params.id);
    if (!g || !(await isMember(g.id, (req as AuthedReq).userId))) return res.status(404).json({ error: "not_found" });
    res.json({
      ...g,
      memberIds: await membersOf(g.id),
      members: await membersWithRoles(g.id),
      settings: await settingsOf(g.id),
      myRole: await requireRole(g.id, (req as AuthedReq).userId, "member"),
    });
  } catch (e) { handleError(res, e); }
});

// ---- group administration ----
//
// Every route here goes through requireRole rather than checking
// membership by hand. The previous surface had exactly two ad-hoc checks
// and that is precisely where the holes were.

app.patch("/api/groups/:id", authed, async (req, res) => {
  try {
    const body = z.object({
      name: z.string().min(1).max(80).optional(),
      description: z.string().max(500).nullable().optional(),
      joinMode: z.enum(["closed", "invite", "request"]).optional(),
      postPolicy: z.enum(["all", "admins"]).optional(),
      historyPolicy: z.enum(["none", "all"]).optional(),
      agentPolicy: z.enum(["off", "members"]).optional(),
    }).parse(req.body);
    const uid = (req as AuthedReq).userId;
    await requireRole(req.params.id, uid, "admin");
    await updateGroup(req.params.id, body, uid);
    res.json({ ok: true, settings: await settingsOf(req.params.id) });
  } catch (e) { handleError(res, e); }
});

app.post("/api/groups/:id/members", authed, async (req, res) => {
  try {
    const body = z.object({ userId: z.string().min(1) }).parse(req.body);
    const uid = (req as AuthedReq).userId;
    await requireRole(req.params.id, uid, "admin");
    await addMember(req.params.id, body.userId, uid);
    // Policy decides where their history starts. 'all' means from the
    // beginning — but only for epochs somebody actually grants them, so
    // this is a bound, not a promise the relay can keep on its own.
    const { historyPolicy } = await settingsOf(req.params.id);
    await setHistoryFrom(req.params.id, body.userId, historyPolicy === "all" ? 0 : Date.now());
    res.json({ ok: true, memberIds: await membersOf(req.params.id) });
  } catch (e) { handleError(res, e); }
});

app.delete("/api/groups/:id/members/:uid", authed, async (req, res) => {
  try {
    const me = (req as AuthedReq).userId;
    // Leaving needs no privilege; removing someone else does.
    if (req.params.uid !== me) await requireRole(req.params.id, me, "admin");
    await removeMember(req.params.id, req.params.uid, me);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.post("/api/groups/:id/members/:uid/role", authed, async (req, res) => {
  try {
    const body = z.object({ role: z.enum(["admin", "member"]) }).parse(req.body);
    const me = (req as AuthedReq).userId;
    await requireRole(req.params.id, me, "owner");
    await setRole(req.params.id, req.params.uid, body.role, me);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.post("/api/groups/:id/members/:uid/mute", authed, async (req, res) => {
  try {
    const body = z.object({ minutes: z.number().int().min(0).max(60 * 24 * 30) }).parse(req.body);
    const me = (req as AuthedReq).userId;
    await requireRole(req.params.id, me, "admin");
    await setMuted(req.params.id, req.params.uid, body.minutes ? Date.now() + body.minutes * 60_000 : null, me);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.post("/api/groups/:id/ban/:uid", authed, async (req, res) => {
  try {
    const me = (req as AuthedReq).userId;
    await requireRole(req.params.id, me, "admin");
    await banMember(req.params.id, req.params.uid, me);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.delete("/api/groups/:id/ban/:uid", authed, async (req, res) => {
  try {
    await requireRole(req.params.id, (req as AuthedReq).userId, "admin");
    await unbanMember(req.params.id, req.params.uid);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.post("/api/groups/:id/invites", authed, async (req, res) => {
  try {
    const body = z.object({
      expiresInMinutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
      maxUses: z.number().int().min(1).max(1000).optional(),
    }).parse(req.body ?? {});
    const me = (req as AuthedReq).userId;
    await requireRole(req.params.id, me, "admin");
    const out = await mintInvite(req.params.id, me, {
      expiresInMs: body.expiresInMinutes ? body.expiresInMinutes * 60_000 : undefined,
      maxUses: body.maxUses,
    });
    res.json(out);
  } catch (e) { handleError(res, e); }
});

app.get("/api/groups/:id/invites", authed, async (req, res) => {
  try {
    await requireRole(req.params.id, (req as AuthedReq).userId, "admin");
    res.json(await listInvites(req.params.id));
  } catch (e) { handleError(res, e); }
});

app.delete("/api/groups/:id/invites/:inviteId", authed, async (req, res) => {
  try {
    await requireRole(req.params.id, (req as AuthedReq).userId, "admin");
    await revokeInvite(req.params.id, req.params.inviteId);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

// Redeeming is the only group route that cannot require membership —
// it is how membership begins. The token is the authorisation.
app.post("/api/groups/join", authed, async (req, res) => {
  try {
    const body = z.object({ token: z.string().min(1) }).parse(req.body);
    const out = await redeemInvite(body.token, (req as AuthedReq).userId);
    if (out.state === "joined") {
      const { historyPolicy } = await settingsOf(out.group.id);
      await setHistoryFrom(out.group.id, (req as AuthedReq).userId,
        historyPolicy === "all" ? 0 : Date.now());
    }
    res.json({
      state: out.state,
      group: out.state === "joined"
        ? { ...out.group, memberIds: await membersOf(out.group.id) }
        : { id: out.group.id, name: out.group.name },
    });
  } catch (e) { handleError(res, e); }
});

app.get("/api/groups/:id/requests", authed, async (req, res) => {
  try {
    await requireRole(req.params.id, (req as AuthedReq).userId, "admin");
    res.json(await listRequests(req.params.id));
  } catch (e) { handleError(res, e); }
});

app.post("/api/groups/:id/requests/:uid", authed, async (req, res) => {
  try {
    const body = z.object({ approve: z.boolean() }).parse(req.body);
    const me = (req as AuthedReq).userId;
    await requireRole(req.params.id, me, "admin");
    await resolveRequest(req.params.id, req.params.uid, body.approve, me);
    if (body.approve) {
      const { historyPolicy } = await settingsOf(req.params.id);
      await setHistoryFrom(req.params.id, req.params.uid, historyPolicy === "all" ? 0 : Date.now());
    }
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

// ---- group history ----
//
// The epoch key never reaches this process in the clear. Clients mint
// it, wrap it per member, and hand over the wrappings; the relay decides
// only who may fetch which rows.

app.get("/api/groups/:id/epochs", authed, async (req, res) => {
  try {
    const uid = (req as AuthedReq).userId;
    await requireRole(req.params.id, uid, "member");
    res.json({
      current: await currentEpoch(req.params.id),
      mine: await epochsFor(req.params.id, uid),
    });
  } catch (e) { handleError(res, e); }
});

app.get("/api/groups/:id/epochs/keys", authed, async (req, res) => {
  try {
    const uid = (req as AuthedReq).userId;
    await requireRole(req.params.id, uid, "member");
    const rows = await db.prepare(
      "SELECT epoch, wrapped_key, granted_by FROM group_epoch_keys WHERE group_id = ? AND member_id = ?",
    ).all<{ epoch: number; wrapped_key: string; granted_by: string }>(req.params.id, uid);
    res.json({
      keys: rows.map((r) => ({
        epoch: Number(r.epoch), wrappedKey: r.wrapped_key, grantedBy: r.granted_by,
      })),
    });
  } catch (e) { handleError(res, e); }
});

app.post("/api/groups/:id/epochs/grant", authed, async (req, res) => {
  try {
    const body = z.object({
      grants: z.array(z.object({
        memberId: z.string().min(1),
        epoch: z.number().int().min(0),
        wrappedKey: z.string().min(1),
      })).max(1000),
    }).parse(req.body);
    const uid = (req as AuthedReq).userId;
    await requireRole(req.params.id, uid, "member");
    // You can only hand over epochs you hold yourself — the relay cannot
    // check the key material, but it can check that you had access to it.
    const mine = new Set(await epochsFor(req.params.id, uid));
    for (const g of body.grants) {
      if (!mine.has(g.epoch)) throw new ForbiddenError("not_your_epoch", "You don't hold that key.");
    }
    await grantEpochKeys(req.params.id, uid, body.grants);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.post("/api/groups/:id/epochs/rotate", authed, async (req, res) => {
  try {
    const body = z.object({
      grants: z.array(z.object({
        memberId: z.string().min(1), wrappedKey: z.string().min(1),
      })).max(1000),
    }).parse(req.body);
    const uid = (req as AuthedReq).userId;
    await requireRole(req.params.id, uid, "member");
    res.json({ epoch: await rotateEpoch(req.params.id, uid, body.grants) });
  } catch (e) { handleError(res, e); }
});

app.post("/api/groups/:id/archive", authed, async (req, res) => {
  try {
    const body = z.object({
      epoch: z.number().int().min(0),
      msgId: z.string().min(1),
      ciphertext: z.string().min(1),
      createdAt: z.number().int(),
    }).parse(req.body);
    const uid = (req as AuthedReq).userId;
    if (!(await canPost(req.params.id, uid))) {
      throw new ForbiddenError("not_allowed", "You can't post in that group.");
    }
    await archiveMessage({
      groupId: req.params.id, epoch: body.epoch, senderId: uid,
      msgId: body.msgId, ciphertext: body.ciphertext,
      // The relay owns the clock for the same reason it does elsewhere.
      createdAt: Math.min(body.createdAt, Date.now()),
    });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.get("/api/groups/:id/archive", authed, async (req, res) => {
  try {
    const uid = (req as AuthedReq).userId;
    await requireRole(req.params.id, uid, "member");
    const limit = Number(req.query.limit ?? 200) || 200;
    const rows = await groupArchiveFor(req.params.id, uid, {
      since: Number(req.query.since ?? 0) || 0,
      afterId: String(req.query.afterId ?? "") || undefined,
      limit,
    });
    const last = rows[rows.length - 1];
    res.json({
      messages: rows.map((r) => ({
        id: r.id, epoch: Number(r.epoch), senderId: r.sender_id,
        msgId: r.msg_id, ciphertext: r.ciphertext, createdAt: Number(r.created_at),
      })),
      more: rows.length === limit,
      cursor: last ? { since: Number(last.created_at), afterId: last.id } : null,
    });
  } catch (e) { handleError(res, e); }
});

app.get("/api/groups/:id/events", authed, async (req, res) => {
  try {
    await requireRole(req.params.id, (req as AuthedReq).userId, "member");
    res.json(await eventsSince(req.params.id, Number(req.query.sinceSeq ?? 0) || 0));
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
    const uid = (req as AuthedReq).userId;
    const now = Date.now();
    const stmt = db.prepare("UPDATE messages SET delivered_at = ? WHERE id = ? AND recipient_id = ?");
    // Collect (sender_id, msg_id) for each acked envelope so we can tell
    // the SENDER their message was delivered — keyed by the sender's own
    // msg_id, which is what their local copy is stored under. Skip
    // self-acks (a self-echo's sender IS the recipient) so a device
    // doesn't flash "delivered" at itself.
    const notify: Array<{ senderId: string; msgId: string }> = [];
    await db.tx(async () => {
      for (const id of ids) {
        await stmt.run(now, id, uid);
        const row = await db.prepare(
          "SELECT sender_id, msg_id FROM messages WHERE id = ? AND recipient_id = ?",
        ).get<{ sender_id: string; msg_id: string | null }>(id, uid);
        if (row?.msg_id && row.sender_id !== uid) {
          notify.push({ senderId: row.sender_id, msgId: row.msg_id });
        }
      }
    });
    for (const n of notify) {
      io.to(`u:${n.senderId}`).emit("delivered", { id: n.msgId, at: now });
    }
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
    // `body.ids` are the receiver's LOCAL message ids (= msg_id). Match
    // on the msg_id column scoped to this recipient so we hit the right
    // envelope, then tell the SENDER — keyed by the same msg_id, which
    // is what their local copy is stored under. (The old code matched
    // on the server's envelope id, which the client never has, so read
    // receipts silently never fired.)
    const stmt = db.prepare("UPDATE messages SET read_at = ? WHERE msg_id = ? AND recipient_id = ?");
    const notify: Array<{ senderId: string; msgId: string }> = [];
    await db.tx(async () => {
      for (const msgId of body.ids) {
        await stmt.run(now, msgId, uid);
        const row = await db.prepare(
          "SELECT sender_id FROM messages WHERE msg_id = ? AND recipient_id = ?",
        ).get<{ sender_id: string }>(msgId, uid);
        if (row && row.sender_id !== uid) notify.push({ senderId: row.sender_id, msgId });
      }
    });
    for (const n of notify) {
      io.to(`u:${n.senderId}`).emit("read", { id: n.msgId, at: now, by: uid });
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
    // 404 rather than 403 for a blob the caller may not read: the
    // difference between "gone" and "not yours" is itself information
    // about someone else's diary.
    const b = await readBlobFor(req.params.id, (req as AuthedReq).userId);
    if (!b) return res.status(404).json({ error: "not_found" });
    res.setHeader("content-type", b.mime);
    res.setHeader("x-byte-size", String(b.byte_size));
    res.send(Buffer.from(b.ciphertext));
  } catch (e) { handleError(res, e); }
});

// ---- diary ----
//
// A separate rail from messages on purpose. See diary.ts for why expiry
// is implemented as grant deletion, and why none of this is allowed near
// the envelope ledger.

const diaryGrant = z.object({ viewerId: z.string().min(1), wrappedKey: z.string().min(1) });

app.post("/api/diary/entries", authed, async (req, res) => {
  try {
    const body = z.object({
      id: z.string().min(1).max(100),
      dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      tzOffsetMin: z.number().int().min(-900).max(900),
      seq: z.number().int().min(0),
      kind: z.enum(["text", "media"]),
      createdAt: z.number().int(),
      bodyCt: z.string().min(1),
      authorKey: z.string().min(1),
      grants: z.array(diaryGrant).max(MAX_AUDIENCE),
      blobIds: z.array(z.string()).max(8).optional(),
    }).parse(req.body);

    const authorId = (req as AuthedReq).userId;
    const out = await publishEntry(authorId, { ...body, blobIds: body.blobIds ?? [] });

    // Liveness only: metadata, never the key or the ciphertext. The
    // client treats this as "pull now", the same way live message
    // delivery is an accelerator rather than a source of truth.
    for (const viewerId of await granteesOf(body.id)) {
      if (viewerId === authorId) continue;
      io.to(`u:${viewerId}`).emit("diary", {
        entryId: out.id, authorId, createdAt: out.createdAt, expiresAt: out.expiresAt,
      });
    }
    res.json(out);
  } catch (e) { handleError(res, e); }
});

app.get("/api/diary/feed", authed, async (req, res) => {
  try {
    const entries = await feedFor((req as AuthedReq).userId, {
      since: Number(req.query.since ?? 0) || 0,
      afterId: String(req.query.afterId ?? "") || undefined,
      limit: Number(req.query.limit ?? 50) || 50,
    });
    // Opportunistic and throttled — correctness already comes from every
    // read joining a live grant.
    sweepExpiredGrants().catch(() => { /* hygiene only */ });
    res.json(diaryPage(entries, Number(req.query.limit ?? 50) || 50));
  } catch (e) { handleError(res, e); }
});

app.get("/api/diary/mine", authed, async (req, res) => {
  try {
    const entries = await archiveFor((req as AuthedReq).userId, {
      since: Number(req.query.since ?? 0) || 0,
      afterId: String(req.query.afterId ?? "") || undefined,
      limit: Number(req.query.limit ?? 50) || 50,
    });
    res.json(diaryPage(entries, Number(req.query.limit ?? 50) || 50));
  } catch (e) { handleError(res, e); }
});

app.post("/api/diary/seen", authed, async (req, res) => {
  try {
    const body = z.object({ entryIds: z.array(z.string()).max(200) }).parse(req.body);
    await markSeen((req as AuthedReq).userId, body.entryIds);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.get("/api/diary/entries/:id/views", authed, async (req, res) => {
  try { res.json(await viewsOf((req as AuthedReq).userId, req.params.id)); }
  catch (e) { handleError(res, e); }
});

app.patch("/api/diary/entries/:id", authed, async (req, res) => {
  try {
    const body = z.object({
      bodyCt: z.string().min(1),
      kind: z.enum(["text", "media"]).optional(),
    }).parse(req.body);
    await editEntryBody((req as AuthedReq).userId, req.params.id, body);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.patch("/api/diary/entries/:id/grants", authed, async (req, res) => {
  try {
    const body = z.object({
      add: z.array(diaryGrant).max(MAX_AUDIENCE).optional(),
      remove: z.array(z.string()).max(MAX_AUDIENCE).optional(),
    }).parse(req.body);
    await updateGrants((req as AuthedReq).userId, req.params.id, {
      add: body.add ?? [], remove: body.remove ?? [],
    });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.delete("/api/diary/entries/:id", authed, async (req, res) => {
  try {
    await deleteEntry((req as AuthedReq).userId, req.params.id);
    res.json({ ok: true });
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

// May this socket post into this group? Membership, the group's posting
// policy and any mute, answered once and cached briefly.
async function socketMayPost(
  socket: { data: unknown }, groupId: string, userId: string,
): Promise<boolean> {
  const data = socket.data as SocketData;
  const cache = data.groupCache ?? (data.groupCache = new Map());
  const hit = cache.get(groupId);
  const now = Date.now();
  if (hit && now - hit.at < GROUP_CACHE_TTL_MS) return hit.member;
  const allowed = await canPost(groupId, userId, now);
  cache.set(groupId, { member: allowed, at: now });
  return allowed;
}

// Typing only needs membership — a muted member is still present, and
// hiding that they are typing would be a strange thing to enforce.
async function socketIsMember(
  socket: { data: unknown }, groupId: string, userId: string,
): Promise<boolean> {
  void socket;
  return isMember(groupId, userId);
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
        // Client-generated message id (opaque, non-sensitive). Stored
        // so delivery/read receipts can be correlated back to the
        // sender's own copy, which is keyed by this id rather than by
        // the server's per-recipient envelope id.
        msgId: z.string().max(80).optional(),
        // The moment the sender actually composed this. Live sends pass
        // "now"; a device-backfill re-uploading an old message passes its
        // ORIGINAL time. Honouring it is what stops backfilled history
        // from being re-dated to the upload moment and bunching every
        // sent message together, out of conversation order. Clamped so a
        // fast client clock can't post into the future.
        sentAt: z.number().int().positive().optional(),
      }).parse(raw);

      const recipient = await getUserById(body.recipientId);
      if (!recipient) return ack?.({ ok: false, error: "unknown_recipient" });
      if (body.groupId) {
        // Both checks matter and both must stay. The sender check is the
        // one that was missing: the relay only verified that each named
        // RECIPIENT was a member, so anyone who knew a group id could
        // post into it by addressing real members.
        if (!(await socketMayPost(socket, body.groupId, userId))) {
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
        created_at: body.sentAt ? Math.min(body.sentAt, Date.now()) : Date.now(),
        delivered_at: null,
        read_at: null,
      };
      await db.prepare(
        `INSERT INTO messages (id, sender_id, recipient_id, group_id, ciphertext, created_at, delivered_at, read_at, msg_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      ).run(row.id, row.sender_id, row.recipient_id, row.group_id, row.ciphertext, row.created_at, body.msgId ?? null);

      const envelope = envelopeOf(row);
      io.to(`u:${body.recipientId}`).emit("message", envelope);
      ack?.({ ok: true, envelope });

      // A live socket means the app is open and already draining, so a
      // push would only buzz a phone that's showing the message anyway.
      // Wake only the ones that aren't connected — and never ourselves
      // for the self-copy.
      if (body.recipientId !== userId && !livePresence.has(body.recipientId)) {
        void wake(body.recipientId);
      }
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
  let userId: string;
  try {
    userId = verifyToken(m[1]);
  } catch { return res.status(401).json({ error: "unauthorized" }); }
  (req as AuthedReq).userId = userId;
  // Phase 2: suspension check + session-start analytics. Both are
  // wrapped so a failure in either path cannot deny service: on a
  // database hiccup we fall through to `next()` with no suspension
  // enforcement for that one request, same as before the hook existed.
  (async () => {
    try {
      if (await isSuspended(userId)) {
        return res.status(403).json({ error: "account_suspended" });
      }
    } catch { /* let the request through; suspension re-checked next request */ }
    void maybeLogSessionStart(userId);
    next();
  })();
}

// Gate used by every admin-only endpoint (added in Phase 3). Reuses the
// same cached admin flag the authed middleware would see.
async function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    if (await isAdmin((req as AuthedReq).userId)) return next();
    res.status(403).json({ error: "forbidden" });
  } catch { res.status(403).json({ error: "forbidden" }); }
}
void invalidateAdminCache;

// Phase 3: mount the admin router. Every route under /api/admin/*
// goes through both `authed` (verifies the Bearer) AND `requireAdmin`
// (checks is_admin=1 against the users row). A non-admin hitting any
// admin route gets 403, not 404 — hiding the path is theatre.
app.use("/api/admin", authed, requireAdmin, adminRouter);

// Shapes a diary page the same way the inbox pages, so the client's
// cursor logic reads identically on both rails. `serverNow` is what the
// client uses as its expiry clock — a device whose own clock has moved
// backwards would otherwise resurrect entries it should have dropped.
function diaryPage(
  rows: Array<{ id: string; author_id: string; day_key: string; tz_offset_min: number;
    seq: number; kind: string; body_ct: string; created_at: number;
    wrapped_key: string; expires_at: number | null; seen_at: number | null }>,
  limit: number,
) {
  const last = rows[rows.length - 1];
  return {
    entries: rows.map((r) => ({
      id: r.id,
      authorId: r.author_id,
      dayKey: r.day_key,
      tzOffsetMin: Number(r.tz_offset_min),
      seq: Number(r.seq),
      kind: r.kind,
      bodyCt: r.body_ct,
      wrappedKey: r.wrapped_key,
      createdAt: Number(r.created_at),
      expiresAt: r.expires_at === null ? null : Number(r.expires_at),
      seenAt: r.seen_at === null ? null : Number(r.seen_at),
    })),
    serverNow: Date.now(),
    more: rows.length === limit,
    cursor: last ? { since: Number(last.created_at), afterId: last.id } : null,
  };
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
  if (e instanceof z.ZodError) {
    // Build a friendly single-line message from the first issue instead
    // of handing the client a JSON array it has to parse itself. Prior
    // behaviour showed the raw payload on-screen when something simple
    // like a short password tripped the schema, which looked alarming.
    const first = e.issues[0];
    const field = first?.path?.filter((p) => typeof p === "string").join(".") || "input";
    const message = first ? `${field}: ${first.message}` : "Invalid input";
    return res.status(400).json({ error: "bad_request", message, issues: e.issues });
  }
  console.error(e);
  res.status(500).json({ error: "internal", message: "Something went wrong on our end. Try again." });
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
