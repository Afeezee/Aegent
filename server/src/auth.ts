// Authenticates a session and manages the public directory.
//
// The password hash here proves you own the account; it does *not* let
// the server decrypt anything. Message keys are derived from the same
// password on the client with a different KDF context, and the server
// never sees the plaintext password beyond hashing it into an unusable
// form. Hashing uses hash-wasm's Argon2id — pure WASM, no native build.

import { argon2id, argon2Verify } from "hash-wasm";
import jwt from "jsonwebtoken";
import { randomBytes, randomUUID } from "node:crypto";
import { db, type UserRow } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-only-do-not-use-in-production";
const TOKEN_TTL = "30d";

// Interactive-tier limits — ~64 MiB, 3 iterations, 1 lane. Comfortable
// under a second on modern hardware; a production build could go to
// moderate limits if the login flow can afford it.
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

// ---- registration / login ----

export async function registerUser(input: {
  email: string;
  phone?: string | null;
  displayName: string;
  password: string;
  publicKey: string;
  wrappedPriv: string;
  kdfSalt: string;
}): Promise<{ user: PublicUser; token: string; handle: string }> {
  const email = input.email.toLowerCase().trim();
  const phone = input.phone ? normalizePhone(input.phone) : null;

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) throw new AuthError("email_taken", "That email is already registered.");
  if (phone) {
    const clash = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
    if (clash) throw new AuthError("phone_taken", "That phone number is already registered.");
  }

  const passwordHash = await hashPassword(input.password);
  const id = randomUUID();
  const handle = await allocateHandle(input.displayName);
  const now = Date.now();

  db.prepare(
    `INSERT INTO users
       (id, email, phone, display_name, handle, password_hash, public_key,
        wrapped_priv, kdf_salt, read_receipts, presence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
  ).run(
    id, email, phone, input.displayName, handle,
    passwordHash, input.publicKey, input.wrappedPriv, input.kdfSalt, now,
  );

  const user = getUserById(id)!;
  return { user: toPublic(user), token: sign(id), handle };
}

// Set/clear the phone number on the current user. Enforces the unique
// constraint here so we can return a friendly error instead of an
// SQLITE_CONSTRAINT.
export function setPhone(userId: string, rawPhone: string | null) {
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (phone) {
    const clash = db.prepare(
      "SELECT id FROM users WHERE phone = ? AND id != ?",
    ).get(phone, userId);
    if (clash) throw new AuthError("phone_taken", "That phone number is already registered.");
  }
  db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(phone, userId);
}

// Very light E.164 canonicalizer — a real deployment would use libphonenumber
// with the user's country hint. Here we accept "+" + digits, strip separators,
// and require ≥7 digits so obvious garbage doesn't stick.
export function normalizePhone(raw: string): string {
  const cleaned = raw.trim().replace(/[\s()\-.]/g, "");
  const m = /^\+?(\d{7,20})$/.exec(cleaned);
  if (!m) throw new AuthError("bad_phone", "Enter a valid international phone number (e.g. +234701…).");
  return "+" + m[1];
}

export async function loginUser(input: { email: string; password: string }):
  Promise<{ user: PublicUser; token: string; wrappedPriv: string; kdfSalt: string }> {
  const email = input.email.toLowerCase().trim();
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;

  const fail = () => { throw new AuthError("bad_credentials", "Wrong email or password."); };
  if (!row) {
    await hashPassword(input.password); // uniform timing
    return fail();
  }
  const ok = await verifyPassword(row.password_hash, input.password);
  if (!ok) return fail();

  return {
    user: toPublic(row),
    token: sign(row.id),
    wrappedPriv: row.wrapped_priv,
    kdfSalt: row.kdf_salt,
  };
}

export function verifyToken(token: string): string {
  const payload = jwt.verify(token, JWT_SECRET) as { sub: string };
  return payload.sub;
}

// ---- directory lookups ----

export function getUserById(id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function findUserByEmail(email: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as UserRow | undefined;
}

export function findUserByHandle(handle: string): UserRow | undefined {
  const h = handle.replace(/^@/, "").toLowerCase();
  return db.prepare("SELECT * FROM users WHERE lower(handle) = ?").get(h) as UserRow | undefined;
}

export function findUserByPhone(rawPhone: string): UserRow | undefined {
  try {
    const phone = normalizePhone(rawPhone);
    return db.prepare("SELECT * FROM users WHERE phone = ?").get(phone) as UserRow | undefined;
  } catch { return undefined; }
}

export function searchUsers(q: string, excludeId: string): PublicUser[] {
  // If the query looks like a phone number, do a normalized-equality match
  // — LIKE across "+2347..." with a mix of hyphens, spaces, and country
  // codes gets noisy fast.
  const trimmed = q.trim();
  if (/^\+?\d[\d\s()\-.]{5,}$/.test(trimmed)) {
    try {
      const phone = normalizePhone(trimmed);
      const row = db.prepare(
        "SELECT * FROM users WHERE phone = ? AND id != ?",
      ).get(phone, excludeId) as UserRow | undefined;
      return row ? [toPublic(row)] : [];
    } catch { return []; }
  }

  const like = `%${trimmed.toLowerCase().replace(/^@/, "")}%`;
  const rows = db.prepare(
    `SELECT * FROM users
       WHERE id != ?
         AND (lower(email) LIKE ? OR lower(display_name) LIKE ? OR lower(handle) LIKE ?)
       ORDER BY display_name LIMIT 20`,
  ).all(excludeId, like, like, like) as UserRow[];
  return rows.map((u) => toPublic(u));
}

// ---- privacy toggles ----

export function updatePrivacy(userId: string, patch: { readReceipts?: boolean; presence?: boolean }) {
  const cur = getUserById(userId);
  if (!cur) return;
  db.prepare(
    "UPDATE users SET read_receipts = ?, presence = ? WHERE id = ?",
  ).run(
    patch.readReceipts !== undefined ? (patch.readReceipts ? 1 : 0) : cur.read_receipts,
    patch.presence !== undefined ? (patch.presence ? 1 : 0) : cur.presence,
    userId,
  );
}

// ---- helpers ----

export type PublicUser = {
  id: string;
  email: string;
  phone: string | null;
  displayName: string;
  handle: string;
  publicKey: string;
  // Privacy-respecting: only echoed when the target has opted in.
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

// Handles are derived from display name; on collision we append a small
// random suffix. Case-preserving in DB, case-insensitive in matching.
async function allocateHandle(displayName: string): Promise<string> {
  const base = displayName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "user";
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = attempt === 0 ? base : `${base}${Math.floor(Math.random() * 9000 + 1000)}`;
    const clash = db.prepare("SELECT 1 FROM users WHERE lower(handle) = ?").get(candidate);
    if (!clash) return candidate;
  }
  return `${base}${randomUUID().slice(0, 6)}`;
}

export class AuthError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
