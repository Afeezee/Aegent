// Authenticates a session and manages the public directory.
//
// Password hashes prove identity to the server; they don't decrypt
// anything. Message keys are derived from the same password on the
// client with a different KDF context, and the server never sees the
// plaintext password beyond hashing it into an unusable form.
// Hashing uses hash-wasm's Argon2id — pure WASM, no native build.

import { argon2id, argon2Verify } from "hash-wasm";
import jwt from "jsonwebtoken";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db, type UserRow } from "./db.js";
import { logSessionEvent } from "./analytics.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-only-do-not-use-in-production";
// Short-lived access token; the refresh token lives much longer and
// rotates on every use. The client auto-refreshes before the UI ever
// sees a 401, so this short TTL is invisible under normal use.
const TOKEN_TTL = "7d";
// Refresh TTL: 180 days. Rotated on every use; a device that goes
// idle longer than this has to sign in again.
const REFRESH_TTL_MS = 180 * 86400_000;

const ARGON_OPTS = { iterations: 3, memorySize: 65536, parallelism: 1 };

async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    ...ARGON_OPTS,
    hashLength: 32,
    outputType: "encoded",
  });
}

async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try { return await argon2Verify({ password, hash }); }
  catch { return false; }
}

// Exposed so the recovery flow can hash a replacement password and
// re-verify the current one without duplicating the Argon2 params.
export async function hashNewPassword(password: string): Promise<string> {
  return hashPassword(password);
}
export async function checkPassword(userId: string, password: string): Promise<boolean> {
  const row = await db.prepare("SELECT password_hash FROM users WHERE id = ?")
    .get<{ password_hash: string }>(userId);
  if (!row) return false;
  return verifyPassword(row.password_hash, password);
}

// Issue a fresh access + refresh pair for a user row. Used by login and
// by a completed password reset (which signs the device straight in —
// bouncing a just-recovered user back to the login form is one more
// chance for them to get locked out).
export async function issueTokens(userId: string, deviceLabel?: string): Promise<{
  token: string; refreshToken: string;
}> {
  return { token: sign(userId), refreshToken: await issueRefreshToken(userId, deviceLabel) };
}

// ---- registration / login ----

export async function registerUser(input: {
  email: string;
  phone?: string | null;
  displayName: string;
  password: string;
  publicKey: string;
  wrappedPriv: string;
  kdfSalt: string;
  // Second wrapper of the same private key, under the recovery code
  // generated on-device at signup. Optional only so older clients keep
  // working; the current client always sends it.
  wrappedPrivRec?: string;
  recSalt?: string;
  deviceLabel?: string;
}): Promise<{ user: PublicUser; token: string; refreshToken: string; handle: string }> {
  const email = input.email.toLowerCase().trim();
  const phone = input.phone ? normalizePhone(input.phone) : null;

  const existing = await db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) throw new AuthError("email_taken", "That email is already registered.");
  if (phone) {
    const clash = await db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
    if (clash) throw new AuthError("phone_taken", "That phone number is already registered.");
  }

  const passwordHash = await hashPassword(input.password);
  const id = randomUUID();
  const handle = await allocateHandle(input.displayName);
  const now = Date.now();

  await db.prepare(
    `INSERT INTO users
       (id, email, phone, display_name, handle, password_hash, public_key,
        wrapped_priv, kdf_salt, wrapped_priv_rec, rec_salt,
        read_receipts, presence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
  ).run(
    id, email, phone, input.displayName, handle,
    passwordHash, input.publicKey, input.wrappedPriv, input.kdfSalt,
    input.wrappedPrivRec ?? null, input.recSalt ?? null, now,
  );

  const user = await getUserById(id);
  if (!user) throw new AuthError("insert_failed", "Registration failed unexpectedly.");
  const refreshToken = await issueRefreshToken(id, input.deviceLabel);
  // Analytics (metadata-only, fail-safe inside logSessionEvent).
  void logSessionEvent(id, "login", input.deviceLabel);
  return { user: toPublic(user), token: sign(id), refreshToken, handle };
}

export async function loginUser(input: {
  email: string; password: string; deviceLabel?: string;
}): Promise<{
  user: PublicUser; token: string; refreshToken: string;
  wrappedPriv: string; kdfSalt: string; hasRecoveryKey: boolean;
}> {
  const email = input.email.toLowerCase().trim();
  const row = await db.prepare("SELECT * FROM users WHERE email = ?").get<UserRow>(email);

  const fail = () => { throw new AuthError("bad_credentials", "Wrong email or password."); };
  if (!row) {
    await hashPassword(input.password); // uniform timing
    return fail();
  }
  const ok = await verifyPassword(row.password_hash, input.password);
  if (!ok) return fail();

  const refreshToken = await issueRefreshToken(row.id, input.deviceLabel);
  void logSessionEvent(row.id, "login", input.deviceLabel);
  return {
    user: toPublic(row),
    token: sign(row.id),
    refreshToken,
    wrappedPriv: row.wrapped_priv,
    kdfSalt: row.kdf_salt,
    hasRecoveryKey: !!row.wrapped_priv_rec,
  };
}

// ---- refresh tokens ----

type RefreshRow = {
  id: string;
  user_id: string;
  token_hash: string;
  device_label: string | null;
  created_at: number;
  last_used_at: number | null;
  replaced_by: string | null;
  revoked_at: number | null;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function issueRefreshToken(userId: string, deviceLabel?: string): Promise<string> {
  // 32 bytes of entropy, base64url-encoded. The plaintext is handed
  // to the device and never written to disk server-side.
  const raw = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const now = Date.now();
  await db.prepare(
    `INSERT INTO refresh_tokens
       (id, user_id, token_hash, device_label, created_at, last_used_at, replaced_by, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(id, userId, hashToken(raw), deviceLabel ?? null, now);
  // The token the client receives: <id>.<raw>. Combining the id lets
  // us look the row up without scanning the whole table.
  return `${id}.${raw}`;
}

export async function rotateRefreshToken(presented: string): Promise<{
  userId: string; accessToken: string; refreshToken: string;
}> {
  const dot = presented.indexOf(".");
  if (dot < 0) throw new AuthError("bad_refresh", "Bad refresh token.");
  const id = presented.slice(0, dot);
  const raw = presented.slice(dot + 1);
  const row = await db.prepare(
    "SELECT * FROM refresh_tokens WHERE id = ?",
  ).get<RefreshRow>(id);
  if (!row || row.token_hash !== hashToken(raw)) {
    throw new AuthError("bad_refresh", "Bad refresh token.");
  }
  if (row.revoked_at) throw new AuthError("revoked", "Session revoked.");
  // Expiry.
  if (Date.now() - row.created_at > REFRESH_TTL_MS) {
    await db.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?")
      .run(Date.now(), row.id);
    throw new AuthError("expired", "Session expired, sign in again.");
  }
  // Reuse detection: if this row has already been replaced, someone
  // just presented a stolen rotated-out copy. Revoke the whole chain
  // for this device/user.
  if (row.replaced_by) {
    await revokeChainFrom(row.id);
    throw new AuthError("reuse", "Session invalidated — please sign in.");
  }
  // Rotate: new row + mark old as replaced + rewrite the chain head.
  const now = Date.now();
  const newRaw = randomBytes(32).toString("base64url");
  const newId = randomUUID();
  await db.tx(async () => {
    await db.prepare(
      `INSERT INTO refresh_tokens
         (id, user_id, token_hash, device_label, created_at, last_used_at, replaced_by, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run(newId, row.user_id, hashToken(newRaw), row.device_label, now);
    await db.prepare(
      "UPDATE refresh_tokens SET last_used_at = ?, replaced_by = ? WHERE id = ?",
    ).run(now, newId, row.id);
  });
  void logSessionEvent(row.user_id, "token_refresh", row.device_label);
  return {
    userId: row.user_id,
    accessToken: sign(row.user_id),
    refreshToken: `${newId}.${newRaw}`,
  };
}

// ---- admin + moderation helpers ----

// Lightweight row-level checks for the authed middleware and admin
// endpoint gates. Cached briefly so a request stream from one user
// doesn't hammer users for the same two flags.
type AdminCache = { isAdmin: boolean; suspendedAt: number | null; at: number };
const ADMIN_CACHE_MS = 30 * 1000;
const adminCache = new Map<string, AdminCache>();

async function fetchAdminFlags(userId: string): Promise<AdminCache> {
  const hit = adminCache.get(userId);
  if (hit && Date.now() - hit.at < ADMIN_CACHE_MS) return hit;
  const row = await db.prepare(
    "SELECT is_admin, suspended_at FROM users WHERE id = ?",
  ).get<{ is_admin: number; suspended_at: number | null }>(userId);
  const fresh: AdminCache = {
    isAdmin: !!row?.is_admin,
    suspendedAt: row?.suspended_at ?? null,
    at: Date.now(),
  };
  adminCache.set(userId, fresh);
  return fresh;
}

export async function isAdmin(userId: string): Promise<boolean> {
  return (await fetchAdminFlags(userId)).isAdmin;
}
export async function isSuspended(userId: string): Promise<boolean> {
  return (await fetchAdminFlags(userId)).suspendedAt !== null;
}
// Admin-only mutations below bust the cache for the affected user so
// a promotion / suspension takes effect on their next request.
export function invalidateAdminCache(userId: string): void {
  adminCache.delete(userId);
}

async function revokeChainFrom(startId: string): Promise<void> {
  const now = Date.now();
  // Walk forward through replaced_by links and mark each revoked.
  // Chains are rotated per request; depth is small in practice.
  let cur: string | null = startId;
  for (let i = 0; i < 100 && cur; i++) {
    const r: { id: string; replaced_by: string | null } | undefined = await db.prepare(
      "SELECT id, replaced_by FROM refresh_tokens WHERE id = ?",
    ).get<{ id: string; replaced_by: string | null }>(cur);
    if (!r) break;
    await db.prepare(
      "UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).run(now, r.id);
    cur = r.replaced_by;
  }
}

export async function listActiveSessions(userId: string): Promise<Array<{
  id: string; deviceLabel: string | null; createdAt: number; lastUsedAt: number | null;
}>> {
  // The newest unrevoked row of each chain is a "live" session. The
  // easiest proxy for that: rows that are not revoked and have NO
  // other row pointing at them via replaced_by. We select all
  // unrevoked rows, then filter out ones that appear as a
  // replaced_by elsewhere.
  const rows = await db.prepare(
    `SELECT id, device_label, created_at, last_used_at, replaced_by
       FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL`,
  ).all<{
    id: string; device_label: string | null;
    created_at: number; last_used_at: number | null; replaced_by: string | null;
  }>(userId);
  const replaced = new Set(rows.filter((r) => r.replaced_by).map((r) => r.replaced_by as string));
  return rows
    .filter((r) => !replaced.has(r.id))
    .map((r) => ({
      id: r.id,
      deviceLabel: r.device_label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }))
    .sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));
}

export async function revokeOtherSessions(userId: string, keepRefresh: string): Promise<number> {
  const dot = keepRefresh.indexOf(".");
  const keepId = dot > 0 ? keepRefresh.slice(0, dot) : "";
  // Walk the whole chain forward from keepId so we don't accidentally
  // revoke the predecessors of the token the user is still holding.
  const keep = new Set<string>();
  let cur: string | null = keepId;
  for (let i = 0; i < 100 && cur; i++) {
    keep.add(cur);
    const r: { replaced_by: string | null } | undefined = await db.prepare(
      "SELECT replaced_by FROM refresh_tokens WHERE id = ?",
    ).get<{ replaced_by: string | null }>(cur);
    cur = r?.replaced_by ?? null;
  }
  const all = await db.prepare(
    "SELECT id FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL",
  ).all<{ id: string }>(userId);
  const now = Date.now();
  let revoked = 0;
  for (const r of all) {
    if (keep.has(r.id)) continue;
    await db.prepare(
      "UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?",
    ).run(now, r.id);
    revoked++;
  }
  return revoked;
}

export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  await db.prepare(
    "UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
  ).run(Date.now(), sessionId, userId);
}

export function verifyToken(token: string): string {
  const payload = jwt.verify(token, JWT_SECRET) as { sub: string };
  return payload.sub;
}

// ---- directory lookups ----

export async function getUserById(id: string): Promise<UserRow | undefined> {
  return db.prepare("SELECT * FROM users WHERE id = ?").get<UserRow>(id);
}

export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  return db.prepare("SELECT * FROM users WHERE email = ?").get<UserRow>(email.toLowerCase());
}

export async function findUserByHandle(handle: string): Promise<UserRow | undefined> {
  const h = handle.replace(/^@/, "").toLowerCase();
  return db.prepare("SELECT * FROM users WHERE lower(handle) = ?").get<UserRow>(h);
}

export async function findUserByPhone(rawPhone: string): Promise<UserRow | undefined> {
  try {
    const phone = normalizePhone(rawPhone);
    return db.prepare("SELECT * FROM users WHERE phone = ?").get<UserRow>(phone);
  } catch { return undefined; }
}

// Discovery is deliberate, not browsable.
//
// You find someone by an identifier they chose to share: their exact
// phone number, their exact email, or their @handle. What you CANNOT do
// is type a name or a fragment of an email and enumerate strangers —
// the old substring match over display_name and email turned the
// directory into a people-search engine, which is the opposite of
// private. Names are never a search key.
//
// Handle is matched by prefix, because a handle is a public,
// self-chosen address (the thing you put on a card or in a bio) and
// prefix completion is how people actually type an @mention. Email and
// phone must be exact: knowing a fragment of someone's email should
// never surface them.
export async function searchUsers(q: string, excludeId: string): Promise<PublicUser[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];

  // A phone number: exact match only.
  if (/^\+?\d[\d\s()\-.]{5,}$/.test(trimmed)) {
    try {
      const phone = normalizePhone(trimmed);
      const row = await db.prepare(
        "SELECT * FROM users WHERE phone = ? AND id != ?",
      ).get<UserRow>(phone, excludeId);
      return row ? [toPublic(row)] : [];
    } catch { return []; }
  }

  // A full email address: exact match only.
  if (trimmed.includes("@") && /\.[a-z]{2,}$/i.test(trimmed)) {
    const row = await db.prepare(
      "SELECT * FROM users WHERE lower(email) = ? AND id != ?",
    ).get<UserRow>(trimmed.toLowerCase(), excludeId);
    return row ? [toPublic(row)] : [];
  }

  // Otherwise treat it as a handle and match it EXACTLY. A handle is a
  // public, self-chosen address, but it is auto-derived from the display
  // name, so prefix matching would quietly turn it back into name search
  // — type "jon" and surface every Jonathan. Exact-only means you have
  // to know the identifier someone chose to share.
  const handle = trimmed.toLowerCase().replace(/^@/, "");
  if (!/^[a-z0-9_.]{1,30}$/.test(handle)) return [];
  const row = await db.prepare(
    "SELECT * FROM users WHERE lower(handle) = ? AND id != ?",
  ).get<UserRow>(handle, excludeId);
  return row ? [toPublic(row)] : [];
}

// ---- privacy toggles ----

export async function updatePrivacy(userId: string, patch: { readReceipts?: boolean; presence?: boolean }) {
  const cur = await getUserById(userId);
  if (!cur) return;
  await db.prepare(
    "UPDATE users SET read_receipts = ?, presence = ? WHERE id = ?",
  ).run(
    patch.readReceipts !== undefined ? (patch.readReceipts ? 1 : 0) : cur.read_receipts,
    patch.presence !== undefined ? (patch.presence ? 1 : 0) : cur.presence,
    userId,
  );
}

// ---- phone ----

export async function setPhone(userId: string, rawPhone: string | null) {
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (phone) {
    const clash = await db.prepare(
      "SELECT id FROM users WHERE phone = ? AND id != ?",
    ).get(phone, userId);
    if (clash) throw new AuthError("phone_taken", "That phone number is already registered.");
  }
  await db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(phone, userId);
}

export function normalizePhone(raw: string): string {
  const cleaned = raw.trim().replace(/[\s()\-.]/g, "");
  const m = /^\+?(\d{7,20})$/.exec(cleaned);
  if (!m) throw new AuthError("bad_phone", "Enter a valid international phone number (e.g. +234701…).");
  return "+" + m[1];
}

// ---- helpers ----

export type PublicUser = {
  id: string;
  email: string;
  phone: string | null;
  displayName: string;
  handle: string;
  publicKey: string;
  presence?: { online: boolean; lastSeenAt: number | null };
};

export function toPublic(u: UserRow, live?: Map<string, number>): PublicUser {
  const out: PublicUser = {
    id: u.id, email: u.email, phone: u.phone ?? null,
    displayName: u.display_name,
    handle: u.handle, publicKey: u.public_key,
  };
  if (u.presence) {
    const isOnline = live?.has(u.id) ?? false;
    out.presence = { online: isOnline, lastSeenAt: u.last_seen_at };
  }
  return out;
}

function sign(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

async function allocateHandle(displayName: string): Promise<string> {
  const base = displayName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "user";
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = attempt === 0 ? base : `${base}${Math.floor(Math.random() * 9000 + 1000)}`;
    const clash = await db.prepare("SELECT 1 FROM users WHERE lower(handle) = ?").get(candidate);
    if (!clash) return candidate;
  }
  return `${base}${randomUUID().slice(0, 6)}`;
}

export class AuthError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

// Authorization failures are not bad requests. Reporting "you may not do
// that" as a 400 makes every client treat a permission problem as a
// malformed payload, which is how a missing check stays invisible.
export class ForbiddenError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
