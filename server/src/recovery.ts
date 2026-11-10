// Key vault + account recovery.
//
// Why this exists
// ---------------
// Every envelope in `messages` is encrypted to a user's identity
// public key. The matching private key is therefore the ONLY thing
// that can turn the server's stored history back into readable
// messages. Originally that private key was wrapped exactly once —
// under a key derived from the account password — which meant a
// forgotten password was a permanent loss of every message the user
// had ever sent or received. For a messenger whose whole premise is
// "your history is always there", that's the wrong failure mode.
//
// The fix is to allow MORE THAN ONE wrapping of the same private key:
//
//   wrapped_priv      = secretbox(KDF(password,      kdf_salt), priv)
//   wrapped_priv_rec  = secretbox(KDF(recovery_code, rec_salt), priv)
//
// Both unwrap to identical bytes. A password change (or reset) only
// replaces the first wrapper; the private key itself never changes, so
// no history is ever orphaned. The server stores wrappers and never
// sees the password, the recovery code, or the private key.
//
// Authorizing a reset without email
// ---------------------------------
// A reset must prove the requester is the account owner. The strongest
// available proof here is possession of the identity private key —
// which is also exactly the authority that matters, because that key
// is what makes the history readable. So:
//
//   1. Client asks for a challenge with its email.
//   2. Server mints a random nonce and boxes it to the user's public
//      key (nacl.box, ephemeral server keypair).
//   3. Client unwraps the private key with the recovery code, opens
//      the box, and returns the nonce.
//   4. Server matches the nonce and accepts a new password + a fresh
//      password-wrapper for the unchanged private key.
//
// A thief who intercepts step 2 gains nothing: the boxed nonce is
// useless without the private key, and `wrapped_priv_rec` is useless
// without the 128-bit recovery code.

import nacl from "tweetnacl";
import { randomBytes, randomUUID } from "node:crypto";
import { db, type UserRow } from "./db.js";
import { AuthError, findUserByEmail, getUserById } from "./auth.js";

// Challenges are short-lived; a stale one is useless but there's no
// reason to keep it around.
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

const b64 = {
  encode: (b: Uint8Array) => Buffer.from(b).toString("base64"),
  decode: (s: string) => new Uint8Array(Buffer.from(s, "base64")),
};

// ---- vault reads/writes (authed) ----

export async function recoveryStatus(userId: string): Promise<{
  enabled: boolean; updatedAt: number | null;
}> {
  const u = await getUserById(userId);
  return { enabled: !!u?.wrapped_priv_rec, updatedAt: null };
}

// Store (or replace) the recovery wrapper. Called right after signup
// and any time the user re-issues their recovery key from Settings.
export async function putRecoveryWrapper(userId: string, input: {
  wrappedPrivRec: string; recSalt: string;
}): Promise<void> {
  await db.prepare(
    "UPDATE users SET wrapped_priv_rec = ?, rec_salt = ? WHERE id = ?",
  ).run(input.wrappedPrivRec, input.recSalt, userId);
}

// ---- password change (authed, knows the current password) ----
//
// The caller has already proven the old password (auth.ts verifies it)
// and re-wrapped the SAME private key under the new one. All we do is
// swap the hash and the wrapper atomically.
export async function applyNewPassword(userId: string, input: {
  passwordHash: string; wrappedPriv: string; kdfSalt: string;
}): Promise<void> {
  await db.prepare(
    "UPDATE users SET password_hash = ?, wrapped_priv = ?, kdf_salt = ? WHERE id = ?",
  ).run(input.passwordHash, input.wrappedPriv, input.kdfSalt, userId);
  // Evict every pre-change session: bump the account's security
  // version AND hard-revoke all existing refresh tokens. The sv bump
  // closes the access-token window within one request round-trip
  // (the authed middleware rejects any JWT whose sv is below the
  // current value), and the refresh revocation stops new access
  // tokens from being minted off a stale refresh. Fixes QA F01 and
  // the related F02 window.
  const { bumpSecurityAndRevokeAllRefresh } = await import("./auth.js");
  await bumpSecurityAndRevokeAllRefresh(userId);
}

// ---- reset flow ----

export async function mintChallenge(email: string): Promise<{
  challengeId: string;
  serverPublicKey: string;
  boxed: string;          // nacl.box(nonce) → only the private key opens it
  wrappedPrivRec: string; // the recovery-code wrapper the client needs
  recSalt: string;
  publicKey: string;
}> {
  const u = await findUserByEmail(email);
  // Deliberately explicit: an attacker learns only that an address is
  // registered, which the signup form already reveals ("email_taken").
  if (!u) throw new AuthError("not_found", "No account for that email.");
  if (!u.wrapped_priv_rec || !u.rec_salt) {
    throw new AuthError(
      "no_recovery_key",
      "This account has no recovery key yet. Sign in on a device that still works, then set one up in Settings → Account.",
    );
  }

  // The nonce travels as base64 TEXT inside the box: the client's
  // decryptFromPeer decodes UTF-8, so raw random bytes would come back
  // mangled.
  const nonce = randomBytes(32).toString("base64");
  const eph = nacl.box.keyPair();
  const boxNonce = randomBytes(nacl.box.nonceLength);
  const sealed = nacl.box(
    new TextEncoder().encode(nonce),
    new Uint8Array(boxNonce),
    b64.decode(u.public_key),
    eph.secretKey,
  );
  // nonce || ciphertext, matching the client's decryptFromPeer layout.
  const boxed = new Uint8Array(boxNonce.length + sealed.length);
  boxed.set(new Uint8Array(boxNonce), 0);
  boxed.set(sealed, boxNonce.length);

  const id = randomUUID();
  await db.prepare(
    "INSERT INTO recovery_challenges (id, user_id, nonce, created_at, used_at) VALUES (?, ?, ?, ?, NULL)",
  ).run(id, u.id, nonce, Date.now());

  return {
    challengeId: id,
    serverPublicKey: b64.encode(eph.publicKey),
    boxed: b64.encode(boxed),
    wrappedPrivRec: u.wrapped_priv_rec,
    recSalt: u.rec_salt,
    publicKey: u.public_key,
  };
}

// Verify the proof and swap in the new password + wrapper. Returns the
// user row so the caller can issue tokens and sign the device straight
// in — a reset that dumped you back at the login form would just be
// one more chance to get locked out.
export async function completeReset(input: {
  challengeId: string;
  proof: string;          // base64 nonce the client recovered
  passwordHash: string;
  wrappedPriv: string;
  kdfSalt: string;
}): Promise<UserRow> {
  const row = await db.prepare(
    "SELECT * FROM recovery_challenges WHERE id = ?",
  ).get<{ id: string; user_id: string; nonce: string; created_at: number; used_at: number | null }>(
    input.challengeId,
  );
  if (!row) throw new AuthError("bad_challenge", "That reset request is no longer valid.");
  if (row.used_at) throw new AuthError("bad_challenge", "That reset request was already used.");
  if (Date.now() - row.created_at > CHALLENGE_TTL_MS) {
    throw new AuthError("expired_challenge", "That reset request expired — start again.");
  }
  // Constant-time compare of the returned nonce.
  const expected = Buffer.from(row.nonce, "utf8");
  const got = Buffer.from(input.proof, "utf8");
  const ok = expected.length === got.length
    && nacl.verify(new Uint8Array(expected), new Uint8Array(got));
  if (!ok) throw new AuthError("bad_proof", "Recovery key didn't match this account.");

  await db.tx(async () => {
    await db.prepare("UPDATE recovery_challenges SET used_at = ? WHERE id = ?")
      .run(Date.now(), row.id);
    await db.prepare(
      "UPDATE users SET password_hash = ?, wrapped_priv = ?, kdf_salt = ? WHERE id = ?",
    ).run(input.passwordHash, input.wrappedPriv, input.kdfSalt, row.user_id);
  });

  const u = await getUserById(row.user_id);
  if (!u) throw new AuthError("not_found", "Account vanished mid-reset.");
  return u;
}
