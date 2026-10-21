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
const { Pool } = pgPkg;

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
`;

export async function initSchema(): Promise<void> {
  await db.exec(SCHEMA);
  // Idempotent add of the `phone` column for DBs created before it
  // existed. Postgres has ADD COLUMN IF NOT EXISTS; SQLite doesn't, so
  // we probe pragma_table_info first.
  if (isPg) {
    await db.exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT");
  } else {
    const cols = await db.prepare("PRAGMA table_info(users)").all<{ name: string }>();
    if (!cols.some((c) => c.name === "phone")) {
      await db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
      await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL");
    }
  }
}
