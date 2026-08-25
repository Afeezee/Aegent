// SQLite store.
//
// Design invariant: every content column here is opaque ciphertext or
// public directory metadata. Nothing here — not message bodies, not
// group names, not attachment bytes, not reactions — is ever plaintext
// that Aegent could read. The server relays. The client understands.
//
// What's public metadata (and why it's OK):
//   - user id, email, display name, public key  → the directory has to
//     be searchable
//   - group id, member ids, timestamps          → the server has to fan
//     out messages, so it must know who is in a group
//   - envelope routing (sender, recipient, timestamp) → routing needs it
//
// What's ciphertext (opaque):
//   - message bodies (per-recipient envelopes)
//   - blob bytes (media)
//   - group display names, when the client chooses to keep them private

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DB_PATH = resolve(process.cwd(), "data/aegent.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    email          TEXT UNIQUE NOT NULL,
    -- Optional phone number in E.164 form ("+" + digits). Unique when set;
    -- NULL is allowed for accounts that never add one.
    phone          TEXT,
    display_name   TEXT NOT NULL,
    handle         TEXT UNIQUE NOT NULL,       -- @-handle for search / invite links
    password_hash  TEXT NOT NULL,              -- Argon2id, server auth only
    public_key     TEXT NOT NULL,              -- base64 Curve25519
    wrapped_priv   TEXT NOT NULL,              -- private key wrapped by password-derived key
    kdf_salt       TEXT NOT NULL,
    -- Privacy toggles are per-user booleans; defaults chosen for privacy.
    read_receipts  INTEGER NOT NULL DEFAULT 0, -- send read receipts (off by default)
    presence       INTEGER NOT NULL DEFAULT 0, -- share online/last-seen (off by default)
    last_seen_at   INTEGER,
    created_at     INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;

  CREATE TABLE IF NOT EXISTS groups (
    id           TEXT PRIMARY KEY,
    -- Group display name is plaintext on the server so members can join
    -- via link and see what they were invited to before decryption is
    -- possible. Individual chat *contents* remain ciphertext.
    name         TEXT NOT NULL,
    created_by   TEXT NOT NULL REFERENCES users(id),
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id),
    joined_at    INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_gm_user ON group_members(user_id);

  CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    sender_id     TEXT NOT NULL REFERENCES users(id),
    recipient_id  TEXT NOT NULL REFERENCES users(id),
    -- If part of a group send, the group id (public routing info); NULL
    -- for a direct 1:1. Clients still get one envelope per recipient.
    group_id      TEXT REFERENCES groups(id),
    -- Opaque envelope: base64(nonce || nacl.box(plaintext, recipient_pub, sender_priv)).
    -- The plaintext inside is JSON (see shared/protocol.ts on the
    -- client) and can carry a text body, a media reference, a reply
    -- pointer, an edit, a delete, or a reaction. The server never
    -- distinguishes those cases.
    ciphertext    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    delivered_at  INTEGER,
    read_at       INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_messages_recipient
    ON messages(recipient_id, delivered_at, created_at);

  CREATE TABLE IF NOT EXISTS blobs (
    id           TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL REFERENCES users(id),
    -- MIME type sent by the uploader. Not used server-side for anything
    -- content-aware; kept so clients can pre-size players/previews.
    mime         TEXT NOT NULL,
    -- Raw ciphertext bytes of the media. The content key is delivered
    -- separately, inside an E2E-encrypted message envelope.
    ciphertext   BLOB NOT NULL,
    byte_size    INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_blobs_owner ON blobs(owner_id, created_at);
`);

// Idempotent migration: for accounts created before the `phone` column,
// add it in-place. SQLite has no "ADD COLUMN IF NOT EXISTS", so we
// probe pragma_table_info and only ALTER when it isn't there. Safe to
// run every boot.
try {
  const columns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "phone")) {
    db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL");
  }
} catch (e) {
  console.warn("[aegent] phone-column migration skipped:", (e as Error).message);
}

// Live in-memory presence (last time we saw this user's socket).
// Persisted-to-DB only when they disconnect, and only if they've opted
// in to `presence`. Otherwise their last_seen_at stays NULL and other
// clients see "offline / no presence".
export const livePresence = new Map<string, number>();

export type UserRow = {
  id: string;
  email: string;
  phone: string | null;
  display_name: string;
  handle: string;
  password_hash: string;
  public_key: string;
  wrapped_priv: string;
  kdf_salt: string;
  read_receipts: number;
  presence: number;
  last_seen_at: number | null;
  created_at: number;
};

export type MessageRow = {
  id: string;
  sender_id: string;
  recipient_id: string;
  group_id: string | null;
  ciphertext: string;
  created_at: number;
  delivered_at: number | null;
  read_at: number | null;
};

export type GroupRow = {
  id: string;
  name: string;
  created_by: string;
  created_at: number;
};

export type BlobRow = {
  id: string;
  owner_id: string;
  mime: string;
  ciphertext: Uint8Array;
  byte_size: number;
  created_at: number;
};
