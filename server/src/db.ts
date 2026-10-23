// Storage backend.
//
// Two backends, one async API:
//
//   - Postgres (via `pg`) whenever DATABASE_URL is set — this is the
//     production path, and it's what Railway's Postgres addon provides
//     out of the box. No filesystem to persist; the DB is a real
//     managed service so redeploys never lose data.
//
//   - node:sqlite when DATABASE_URL is absent — the zero-setup local
//     dev path. Writes to `data/aegent.db` under the process CWD.
//
// Callers see the same interface either way: `db.prepare(sql).get()`,
// `.all()`, `.run()`, `db.exec(...)`, `db.tx(async () => {...})`. All
// four are async — the SQLite path just resolves synchronously
// underneath.
//
// SQL is written in a common subset that works on both. `?` placeholders
// get translated to `$1, $2, ...` for pg. `BYTEA`/`BLOB` and
// `BIGINT`/`INTEGER` are papered over inside the schema init.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pgPkg from "pg";
const { Pool, types } = pgPkg;

// node-postgres hands BIGINT (int8, OID 20) back as a STRING, because an
// arbitrary int8 can exceed what a JS number holds exactly. Every
// BIGINT in this schema is either a millisecond timestamp or a byte
// count — both are nowhere near 2^53 — so parsing them as numbers is
// safe and is what every caller already assumes.
//
// Leaving the default in place was a real bug, and a nasty one: it only
// showed up in production. On SQLite (local dev) created_at came back as
// a number, on Postgres as a string, so an envelope drained from the
// relay carried a string timestamp. The client then wrote that string
// into IndexedDB, where the key ordering puts every string AFTER every
// number — so the message was stored, counted, and completely invisible
// to the thread view's numeric range query. Messages that "weren't
// there" on a new device were in many cases sitting in the store with a
// timestamp of the wrong type.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

type Row = Record<string, unknown>;
type Args = readonly unknown[];

export interface Statement {
  get<T = Row>(...args: Args): Promise<T | undefined>;
  all<T = Row>(...args: Args): Promise<T[]>;
  run(...args: Args): Promise<void>;
}

export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): Promise<void>;
  tx<T>(work: () => Promise<T>): Promise<T>;
  backend: "pg" | "sqlite";
}

// ---- shared row types ----

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
  // Second wrapping of the SAME identity private key, this one under a
  // key derived from the user's recovery code. Lets a forgotten
  // password be reset without destroying message history (the private
  // key is what decrypts every stored envelope).
  wrapped_priv_rec: string | null;
  rec_salt: string | null;
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

// Live in-memory presence (last time we saw this user's socket). Not
// persisted; the source of truth is the socket registry.
export const livePresence = new Map<string, number>();

// ---- placeholder translation ----

function toPg(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

// ---- backends ----

function makePgBackend(): Db {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    // Railway's managed Postgres presents a self-signed cert; accept it.
    // If you're on a provider with a trusted chain, set PGSSLMODE=verify.
    ssl: process.env.PGSSLMODE === "disable"
      ? false
      : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX ?? 10),
  });
  pool.on("error", (err) => console.error("[db.pg] pool error:", err.message));

  const prepare = (sql: string): Statement => {
    const text = toPg(sql);
    return {
      async get(...args) {
        const r = await pool.query({ text, values: args as unknown[] });
        return r.rows[0];
      },
      async all(...args) {
        const r = await pool.query({ text, values: args as unknown[] });
        return r.rows;
      },
      async run(...args) {
        await pool.query({ text, values: args as unknown[] });
      },
    };
  };

  return {
    prepare,
    async exec(sql: string) {
      // pg supports multi-statement query strings in a single `query`
      // call as long as no parameters are used — perfect for schema DDL.
      await pool.query(sql);
    },
    async tx<T>(work: () => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await work();
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => { /* ignore */ });
        throw e;
      } finally {
        client.release();
      }
    },
    backend: "pg",
  };
}

function makeSqliteBackend(): Db {
  const DB_PATH = resolve(process.cwd(), "data/aegent.db");
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const sq = new DatabaseSync(DB_PATH);
  sq.exec("PRAGMA journal_mode = WAL;");
  sq.exec("PRAGMA foreign_keys = ON;");

  const prepare = (sql: string): Statement => {
    // SQLite uses `?` natively; no translation needed.
    // Cast to node:sqlite's SQLInputValue — our callers pass strings /
    // numbers / null / Buffer, all of which qualify.
    type SqlIn = string | number | null | bigint | Uint8Array;
    const stmt = sq.prepare(sql);
    return {
      async get(...args) { return stmt.get(...(args as SqlIn[])) as never; },
      async all(...args) { return stmt.all(...(args as SqlIn[])) as never; },
      async run(...args) { stmt.run(...(args as SqlIn[])); },
    };
  };

  return {
    prepare,
    async exec(sql: string) { sq.exec(sql); },
    async tx<T>(work: () => Promise<T>): Promise<T> {
      sq.exec("BEGIN");
      try {
        const out = await work();
        sq.exec("COMMIT");
        return out;
      } catch (e) {
        try { sq.exec("ROLLBACK"); } catch { /* ignore */ }
        throw e;
      }
    },
    backend: "sqlite",
  };
}

export const db: Db = process.env.DATABASE_URL ? makePgBackend() : makeSqliteBackend();
console.log(`[aegent] db backend: ${db.backend}`);

// ---- schema init ----
//
// Two flavors — the type differences between BYTEA / BLOB and
// BIGINT / INTEGER need per-backend DDL, and Postgres has
// `ADD COLUMN IF NOT EXISTS` while SQLite doesn't.

const isPg = db.backend === "pg";
const BYTES = isPg ? "BYTEA" : "BLOB";
const BIG = isPg ? "BIGINT" : "INTEGER";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    email          TEXT UNIQUE NOT NULL,
    phone          TEXT,
    display_name   TEXT NOT NULL,
    handle         TEXT UNIQUE NOT NULL,
    password_hash  TEXT NOT NULL,
    public_key     TEXT NOT NULL,
    wrapped_priv   TEXT NOT NULL,
    kdf_salt       TEXT NOT NULL,
    wrapped_priv_rec TEXT,
    rec_salt         TEXT,
    read_receipts  INTEGER NOT NULL DEFAULT 0,
    presence       INTEGER NOT NULL DEFAULT 0,
    last_seen_at   ${BIG},
    created_at     ${BIG} NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone
    ON users(phone) WHERE phone IS NOT NULL;

  CREATE TABLE IF NOT EXISTS groups (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    created_by   TEXT NOT NULL REFERENCES users(id),
    created_at   ${BIG} NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id),
    joined_at    ${BIG} NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_gm_user ON group_members(user_id);

  CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    sender_id     TEXT NOT NULL REFERENCES users(id),
    recipient_id  TEXT NOT NULL REFERENCES users(id),
    group_id      TEXT REFERENCES groups(id),
    ciphertext    TEXT NOT NULL,
    created_at    ${BIG} NOT NULL,
    delivered_at  ${BIG},
    read_at       ${BIG}
  );
  CREATE INDEX IF NOT EXISTS idx_messages_recipient
    ON messages(recipient_id, delivered_at, created_at);
  -- Keyset-pagination index for the inbox drain: (created_at, id) is a
  -- total order, so a resumable cursor never skips or repeats a row
  -- even when several envelopes share a millisecond.
  CREATE INDEX IF NOT EXISTS idx_messages_drain
    ON messages(recipient_id, created_at, id);

  CREATE TABLE IF NOT EXISTS blobs (
    id           TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL REFERENCES users(id),
    mime         TEXT NOT NULL,
    ciphertext   ${BYTES} NOT NULL,
    byte_size    INTEGER NOT NULL,
    created_at   ${BIG} NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_blobs_owner ON blobs(owner_id, created_at);

  -- Encrypted per-user backup of the client's entire local store. The
  -- server stores nothing but opaque bytes. The key is derived on the
  -- client from the user's recovery phrase (never touches this
  -- process). One row per user; the newest replaces the previous.
  CREATE TABLE IF NOT EXISTS backups (
    user_id      TEXT PRIMARY KEY REFERENCES users(id),
    -- Everything the client shipped: nonce || ciphertext,
    -- schema-versioned inside the plaintext payload.
    ciphertext   ${BYTES} NOT NULL,
    byte_size    INTEGER NOT NULL,
    created_at   ${BIG} NOT NULL
  );

  -- Refresh tokens: long-lived credential, rotated on each use. We
  -- store only the SHA-256 hash so a DB leak doesn't let anyone sign
  -- in as another user; the plaintext token lives only on the device
  -- that received it. The replaced_by column lets us detect reuse: if
  -- a token that's already been rotated out is presented again, we
  -- revoke the entire chain for that device as a stolen-token signal.
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    token_hash    TEXT NOT NULL UNIQUE,
    device_label  TEXT,
    created_at    ${BIG} NOT NULL,
    last_used_at  ${BIG},
    replaced_by   TEXT REFERENCES refresh_tokens(id),
    revoked_at    ${BIG}
  );
  CREATE INDEX IF NOT EXISTS idx_refresh_user
    ON refresh_tokens(user_id, revoked_at);

  -- Proof-of-key challenges for password reset. The server boxes a
  -- random nonce to the user's identity public key; only a client that
  -- can unwrap the private key (via the recovery code) can read it
  -- back. Possession of the private key is exactly the right authority
  -- to reset a password, because that key is what makes the stored
  -- history readable in the first place.
  CREATE TABLE IF NOT EXISTS recovery_challenges (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    nonce       TEXT NOT NULL,
    created_at  ${BIG} NOT NULL,
    used_at     ${BIG}
  );
  CREATE INDEX IF NOT EXISTS idx_recovery_user
    ON recovery_challenges(user_id, created_at);

  -- Diary.
  --
  -- An entry is sealed once with a random per-entry key; diary_grants
  -- holds that key sealed to each person who may read it. Expiry is the
  -- deletion of a grant rather than of content, which is what lets the
  -- author keep the entry forever while a viewer's access ends — the
  -- server never holds the key in the clear either way.
  --
  -- Deliberately separate from the messages table: that one is the rail the
  -- availability guarantee is built on, and a row designed to become
  -- unreadable on schedule inside that accounting would be reported as a
  -- permanent deficit.
  CREATE TABLE IF NOT EXISTS diary_entries (
    id             TEXT PRIMARY KEY,
    author_id      TEXT NOT NULL REFERENCES users(id),
    -- 'YYYY-MM-DD' in the AUTHOR's timezone, computed on their device.
    -- Opaque here: the relay never derives a date.
    day_key        TEXT NOT NULL,
    tz_offset_min  INTEGER NOT NULL,
    seq            INTEGER NOT NULL,
    kind           TEXT NOT NULL,
    body_ct        TEXT NOT NULL,
    created_at     ${BIG} NOT NULL,
    revoked_at     ${BIG}
  );
  CREATE INDEX IF NOT EXISTS idx_diary_author
    ON diary_entries(author_id, created_at, id);

  CREATE TABLE IF NOT EXISTS diary_grants (
    entry_id     TEXT NOT NULL REFERENCES diary_entries(id),
    viewer_id    TEXT NOT NULL REFERENCES users(id),
    -- The entry key, sealed to this viewer. The relay stores it and
    -- cannot open it.
    wrapped_key  TEXT NOT NULL,
    created_at   ${BIG} NOT NULL,
    -- NULL means never: that is the author's own grant, i.e. the archive.
    expires_at   ${BIG},
    seen_at      ${BIG},
    PRIMARY KEY (entry_id, viewer_id)
  );
  CREATE INDEX IF NOT EXISTS idx_diary_grants_viewer
    ON diary_grants(viewer_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_diary_grants_expiry
    ON diary_grants(expires_at);

  -- Binds an uploaded blob to an entry so the blob can be access-
  -- controlled. Chat blobs have no row here and keep their existing
  -- capability model, because their reference lives inside ciphertext
  -- and the relay cannot know who may read them.
  CREATE TABLE IF NOT EXISTS diary_blobs (
    blob_id   TEXT PRIMARY KEY REFERENCES blobs(id),
    entry_id  TEXT NOT NULL REFERENCES diary_entries(id)
  );
  CREATE INDEX IF NOT EXISTS idx_diary_blobs_entry ON diary_blobs(entry_id);

  -- Group moderation.
  --
  -- Invite tokens are stored hashed, the same shape refresh tokens use:
  -- the token in the link is the capability, so a database leak must not
  -- hand out memberships.
  CREATE TABLE IF NOT EXISTS group_invites (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups(id),
    token_hash  TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  ${BIG} NOT NULL,
    expires_at  ${BIG},
    max_uses    INTEGER,
    uses        INTEGER NOT NULL DEFAULT 0,
    revoked_at  ${BIG}
  );
  CREATE INDEX IF NOT EXISTS idx_group_invites_group ON group_invites(group_id);

  CREATE TABLE IF NOT EXISTS group_join_requests (
    group_id     TEXT NOT NULL REFERENCES groups(id),
    user_id      TEXT NOT NULL REFERENCES users(id),
    requested_at ${BIG} NOT NULL,
    state        TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS group_bans (
    group_id   TEXT NOT NULL REFERENCES groups(id),
    user_id    TEXT NOT NULL REFERENCES users(id),
    banned_by  TEXT NOT NULL,
    banned_at  ${BIG} NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );

  -- Membership events. Server-composed metadata with no message content
  -- in it, kept apart from the messages table on purpose: writing these
  -- there with a synthetic sender would pollute search, previews,
  -- unread counts and every agent tool that reads message history.
  CREATE TABLE IF NOT EXISTS group_events (
    id         TEXT PRIMARY KEY,
    group_id   TEXT NOT NULL REFERENCES groups(id),
    seq        ${BIG} NOT NULL,
    kind       TEXT NOT NULL,
    actor_id   TEXT NOT NULL,
    subject_id TEXT,
    data       TEXT,
    created_at ${BIG} NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_group_events_seq ON group_events(group_id, seq);

  -- Group history for people who weren't there yet.
  --
  -- The live rail is per-recipient: one nacl.box envelope per member.
  -- That is why a new member structurally cannot see older messages —
  -- no envelope addressed to them exists, and the relay cannot make one
  -- because it has no key. It is left exactly as it is; it carries the
  -- availability guarantee and is not worth disturbing.
  --
  -- Alongside it, each group send also writes ONE archive row, sealed
  -- with a symmetric epoch key. The epoch key is wrapped per member in
  -- group_epoch_keys, which the relay stores and cannot open. Granting
  -- history to a joiner is then handing them old epoch keys — a few
  -- rows — rather than re-encrypting thousands of messages, and removing
  -- someone rotates the epoch so they cannot read what comes next.
  CREATE TABLE IF NOT EXISTS group_epoch_keys (
    group_id    TEXT NOT NULL REFERENCES groups(id),
    epoch       INTEGER NOT NULL,
    member_id   TEXT NOT NULL REFERENCES users(id),
    wrapped_key TEXT NOT NULL,
    granted_by  TEXT NOT NULL,
    created_at  ${BIG} NOT NULL,
    PRIMARY KEY (group_id, epoch, member_id)
  );
  CREATE INDEX IF NOT EXISTS idx_gek_member ON group_epoch_keys(member_id, group_id);

  CREATE TABLE IF NOT EXISTS group_archive (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups(id),
    epoch       INTEGER NOT NULL,
    sender_id   TEXT NOT NULL,
    msg_id      TEXT NOT NULL,
    ciphertext  TEXT NOT NULL,
    created_at  ${BIG} NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_garchive_drain
    ON group_archive(group_id, created_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_garchive_msg
    ON group_archive(group_id, msg_id);
`;

// Columns added after the first release. Both backends get the same
// idempotent treatment: Postgres has ADD COLUMN IF NOT EXISTS, SQLite
// needs a pragma probe first.
//
// The table names here are interpolated into SQL rather than bound,
// because `PRAGMA table_info(?)` rejects a parameter. That is safe only
// because this list is a hard-coded literal — never build it from input.
type AddedColumn = { table: string; name: string; ddl: string };
const ADDED_COLUMNS: AddedColumn[] = [
  { table: "users", name: "phone", ddl: "ALTER TABLE users ADD COLUMN phone TEXT" },
  { table: "groups", name: "description", ddl: "ALTER TABLE groups ADD COLUMN description TEXT" },
  { table: "groups", name: "avatar_blob", ddl: "ALTER TABLE groups ADD COLUMN avatar_blob TEXT" },
  { table: "groups", name: "updated_at", ddl: "ALTER TABLE groups ADD COLUMN updated_at BIGINT" },
  { table: "groups", name: "join_mode", ddl: "ALTER TABLE groups ADD COLUMN join_mode TEXT NOT NULL DEFAULT 'closed'" },
  { table: "groups", name: "post_policy", ddl: "ALTER TABLE groups ADD COLUMN post_policy TEXT NOT NULL DEFAULT 'all'" },
  { table: "groups", name: "history_policy", ddl: "ALTER TABLE groups ADD COLUMN history_policy TEXT NOT NULL DEFAULT 'none'" },
  { table: "groups", name: "agent_policy", ddl: "ALTER TABLE groups ADD COLUMN agent_policy TEXT NOT NULL DEFAULT 'off'" },
  { table: "groups", name: "epoch", ddl: "ALTER TABLE groups ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0" },
  { table: "group_members", name: "history_from", ddl: "ALTER TABLE group_members ADD COLUMN history_from BIGINT" },
  { table: "group_members", name: "role", ddl: "ALTER TABLE group_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'" },
  { table: "group_members", name: "added_by", ddl: "ALTER TABLE group_members ADD COLUMN added_by TEXT" },
  { table: "group_members", name: "muted_until", ddl: "ALTER TABLE group_members ADD COLUMN muted_until BIGINT" },
  { table: "group_members", name: "left_at", ddl: "ALTER TABLE group_members ADD COLUMN left_at BIGINT" },
  { table: "users", name: "wrapped_priv_rec", ddl: "ALTER TABLE users ADD COLUMN wrapped_priv_rec TEXT" },
  { table: "users", name: "rec_salt", ddl: "ALTER TABLE users ADD COLUMN rec_salt TEXT" },
];

export async function initSchema(): Promise<void> {
  await db.exec(SCHEMA);
  // Idempotent add of the `phone` column for DBs created before it
  // existed. Postgres has ADD COLUMN IF NOT EXISTS; SQLite doesn't, so
  // we probe pragma_table_info first.
  if (isPg) {
    for (const c of ADDED_COLUMNS) {
      await db.exec(c.ddl.replace("ADD COLUMN", "ADD COLUMN IF NOT EXISTS"));
    }
  } else {
    const byTable = new Map<string, AddedColumn[]>();
    for (const c of ADDED_COLUMNS) {
      const list = byTable.get(c.table) ?? [];
      list.push(c);
      byTable.set(c.table, list);
    }
    for (const [table, columns] of byTable) {
      const existing = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      for (const c of columns) {
        if (!existing.some((x) => x.name === c.name)) await db.exec(c.ddl);
      }
    }
  }
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL");

  // Groups created before roles existed have an owner in spirit — the
  // person who made them — but every member defaulted to 'member', which
  // would leave those groups with nobody able to administer them.
  // Idempotent, so it costs one no-op UPDATE per boot.
  await db.exec(`
    UPDATE group_members SET role = 'owner'
     WHERE role = 'member'
       AND user_id = (SELECT g.created_by FROM groups g WHERE g.id = group_members.group_id)
  `);
}
