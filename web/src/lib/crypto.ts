// Client-side crypto — the single API surface for every operation that
// touches key material or plaintext. Swapping in MLS (per spec §5.1)
// later means reimplementing the functions here without changing any
// caller.
//
// Primitives:
//   - tweetnacl (Curve25519 + XSalsa20-Poly1305) via nacl.box for
//     peer-to-peer messaging; same primitive as NaCl and original
//     Signal builds; audited, small, no build headaches.
//   - nacl.secretbox for wrapping the private key, the local store,
//     and media blobs (with a fresh per-blob content key).
//   - hash-wasm's Argon2id for password → key derivation (pure WASM).
//   - nacl.hash (SHA-512), truncated, for recovery-code checksum.
//
// Intentional limits:
//   - No forward secrecy per-message. MLS solves this; production must
//     swap before shipping.
//   - No group ratchet — group chat is n × (1:1) fan-out.

import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { argon2id } from "hash-wasm";

let ready: Promise<void> | null = null;
export function initCrypto(): Promise<void> {
  if (!ready) ready = Promise.resolve();
  return ready;
}

// ---- encoding ----

export const b64 = {
  encode: (bytes: Uint8Array) => naclUtil.encodeBase64(bytes),
  decode: (s: string) => naclUtil.decodeBase64(s),
};
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- identity ----

export type IdentityKeys = { publicKey: Uint8Array; privateKey: Uint8Array };

export function generateIdentity(): IdentityKeys {
  const kp = nacl.box.keyPair();
  return { publicKey: kp.publicKey, privateKey: kp.secretKey };
}

// ---- password KDF ----
// Same password, domain-separated outputs.

const KDF_KEY_LEN = 32;
const KDF_OPTS = { iterations: 3, memorySize: 65536, parallelism: 1 };

export function newKdfSalt(): Uint8Array {
  return nacl.randomBytes(16);
}

export async function deriveKey(
  password: string,
  salt: Uint8Array,
  context: "priv-wrap" | "local-store" | "rec-wrap",
): Promise<Uint8Array> {
  const raw = await argon2id({
    password: `${context}:${password}`,
    salt,
    ...KDF_OPTS,
    hashLength: KDF_KEY_LEN,
    outputType: "binary",
  });
  return raw as Uint8Array;
}

// Key that wraps the identity private key under the user's recovery
// code. Same Argon2id parameters as the password path, different
// domain-separation context, and the input is the 128-bit entropy of
// the code rather than a human-chosen secret.
export async function recoveryWrapKey(
  entropy: Uint8Array, salt: Uint8Array,
): Promise<Uint8Array> {
  return deriveKey(b64.encode(entropy), salt, "rec-wrap");
}

// Local-store key, derived from the identity private key instead of the
// password.
//
// Deriving it from the password tied every row on disk to a secret the
// user is allowed to change: a password change (or a reset) silently
// turned the whole local history into "<corrupt>". The private key, by
// contrast, is fixed for the life of the account — the same property
// that already makes `backupKeyFromPrivate` work — so this key survives
// password changes, and re-wrapping the private key under a new
// password leaves local storage completely untouched.
export function storeKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  const ctx = new TextEncoder().encode("aegent:local-store:v2");
  const material = new Uint8Array(ctx.length + privateKey.length);
  material.set(ctx, 0);
  material.set(privateKey, ctx.length);
  return nacl.hash(material).slice(0, 32);
}

// ---- symmetric wrap (secretbox) ----

export function secretBoxSeal(key: Uint8Array, plaintext: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(plaintext, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0); out.set(ct, nonce.length);
  return b64.encode(out);
}

export function secretBoxOpen(key: Uint8Array, wrapped: string): Uint8Array {
  const buf = b64.decode(wrapped);
  const nonce = buf.slice(0, nacl.secretbox.nonceLength);
  const ct = buf.slice(nacl.secretbox.nonceLength);
  const pt = nacl.secretbox.open(ct, nonce, key);
  if (!pt) throw new Error("decrypt_failed");
  return pt;
}

// Raw-bytes variants for media (avoid base64 round-trips on hot path).
export function secretBoxSealBytes(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(plaintext, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0); out.set(ct, nonce.length);
  return out;
}

export function secretBoxOpenBytes(key: Uint8Array, wrapped: Uint8Array): Uint8Array {
  const nonce = wrapped.slice(0, nacl.secretbox.nonceLength);
  const ct = wrapped.slice(nacl.secretbox.nonceLength);
  const pt = nacl.secretbox.open(ct, nonce, key);
  if (!pt) throw new Error("decrypt_failed");
  return pt;
}

// ---- E2E messaging (nacl.box) ----

export function encryptForPeer(
  plaintext: string,
  peerPublicKey: Uint8Array,
  myPrivateKey: Uint8Array,
): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ct = nacl.box(enc.encode(plaintext), nonce, peerPublicKey, myPrivateKey);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0); out.set(ct, nonce.length);
  return b64.encode(out);
}

export function decryptFromPeer(
  ciphertext: string,
  peerPublicKey: Uint8Array,
  myPrivateKey: Uint8Array,
): string {
  const buf = b64.decode(ciphertext);
  const nonce = buf.slice(0, nacl.box.nonceLength);
  const ct = buf.slice(nacl.box.nonceLength);
  const pt = nacl.box.open(ct, nonce, peerPublicKey, myPrivateKey);
  if (!pt) throw new Error("decrypt_failed");
  return dec.decode(pt);
}

// ---- byte-level box ----
//
// `encryptForPeer` is string-in/string-out, which is right for message
// payloads but wrong for wrapping a raw 32-byte key: round-tripping key
// material through base64 and UTF-8 works by accident rather than by
// design. These are the same primitive without the text assumption.

export function boxSealBytes(
  plaintext: Uint8Array,
  peerPublicKey: Uint8Array,
  myPrivateKey: Uint8Array,
): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ct = nacl.box(plaintext, nonce, peerPublicKey, myPrivateKey);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0); out.set(ct, nonce.length);
  return b64.encode(out);
}

export function boxOpenBytes(
  wrapped: string,
  peerPublicKey: Uint8Array,
  myPrivateKey: Uint8Array,
): Uint8Array {
  const buf = b64.decode(wrapped);
  const nonce = buf.slice(0, nacl.box.nonceLength);
  const ct = buf.slice(nacl.box.nonceLength);
  const pt = nacl.box.open(ct, nonce, peerPublicKey, myPrivateKey);
  if (!pt) throw new Error("decrypt_failed");
  return pt;
}

// ---- media content key ----
// One key per attachment; delivered inside the E2E-encrypted message.
export function newContentKey(): Uint8Array {
  return nacl.randomBytes(nacl.secretbox.keyLength);
}

// One key per diary entry. Named apart from `newContentKey` because the
// two have different lifetimes and different revocation stories: a
// content key lives inside a message forever, while an entry key is the
// thing a diary grant hands out and later withholds.
export function newEntryKey(): Uint8Array {
  return nacl.randomBytes(nacl.secretbox.keyLength);
}

// ---- recovery code ----
// 128-bit entropy + 1-byte SHA-512 checksum → base32 in 5-char groups.
// Prototype note: production would swap for BIP-39 words for typo
// tolerance. Same 128-bit strength.

const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Crockford-ish; no I/O/L/0/1

export function newRecoveryPhrase(): { phrase: string; entropy: Uint8Array } {
  const entropy = nacl.randomBytes(16);
  return { phrase: phraseFromEntropy(entropy), entropy };
}

function phraseFromEntropy(entropy: Uint8Array): string {
  const check = nacl.hash(entropy)[0];
  const buf = new Uint8Array(17);
  buf.set(entropy, 0); buf[16] = check;
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  while (bits.length % 5 !== 0) bits += "0";
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out.match(/.{1,5}/g)!.join("-");
}

export function entropyFromPhrase(phrase: string): Uint8Array {
  const clean = phrase.toUpperCase().replace(/[^A-Z2-9]/g, "");
  if (clean.length < 28) throw new Error("recovery code too short");
  let bits = "";
  for (const c of clean) {
    const v = B32.indexOf(c);
    if (v < 0) throw new Error(`invalid character: ${c}`);
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes = new Uint8Array(17);
  for (let i = 0; i < 17; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const entropy = bytes.slice(0, 16);
  if (bytes[16] !== nacl.hash(entropy)[0]) {
    throw new Error("checksum mismatch — did you mistype?");
  }
  return entropy;
}

export function identityFromRecovery(entropy: Uint8Array): IdentityKeys {
  const seed = nacl.hash(entropy).slice(0, 32);
  const kp = nacl.box.keyPair.fromSecretKey(seed);
  return { publicKey: kp.publicKey, privateKey: kp.secretKey };
}

// Backup encryption key, deterministic from the identity private key.
// The private key is available at register AND at login (unwrapped from
// wrapped_priv with the password), so this scheme lets *any* login on
// *any* device automatically re-derive the same backup key — no
// recovery-phrase prompt needed for restore.
//
// Uses a distinct KDF context prefix so a compromise of the backup key
// doesn't reveal the private key or the message-encryption key.
export function backupKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  const ctx = new TextEncoder().encode("aegent:backup:v2");
  const material = new Uint8Array(ctx.length + privateKey.length);
  material.set(ctx, 0);
  material.set(privateKey, ctx.length);
  return nacl.hash(material).slice(0, 32);
}

// Kept for the small number of installs that ran the v1 phrase-derived
// path. New installs won't produce v1 backups; if we see one at restore
// time we'd need to fall back to this. Callers should try both.
export function backupKeyFromRecovery(entropy: Uint8Array): Uint8Array {
  const ctx = new TextEncoder().encode("aegent:backup:v1");
  const material = new Uint8Array(ctx.length + entropy.length);
  material.set(ctx, 0);
  material.set(entropy, ctx.length);
  return nacl.hash(material).slice(0, 32);
}
