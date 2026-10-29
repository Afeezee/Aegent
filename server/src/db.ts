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
  // Phase-2 admin + abuse additions. Both default to the safe state
  // (not admin, not suspended) and are backfilled on existing rows via
  // the ADDED_COLUMNS migration.
  is_admin: number;
  suspended_at: number | null;
  // Profile fields (public-directory info).
  avatar: string | null;
  status_text: string | null;
  status_until: number | null;
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

  -- Discover.
  --
  -- The PUBLIC counterpart of a diary entry. Deliberately a separate
  -- table from diary_entries, because the two have opposite contracts:
  -- a diary entry is sealed and readable only through a per-viewer grant,
  -- whereas a discover post is public by construction and stored in the
  -- clear so it can be aggregated into one global feed across all users.
  -- Mixing a cleartext row into diary_entries would quietly weaken the
  -- "the relay never holds the plaintext" promise for the private path.
  --
  -- A post is created only when the author explicitly chooses "public"
  -- for that entry. The text column holds the 500-char-max body/caption
  -- in the clear; media_json holds the MediaRef (which includes the
  -- content key in the clear — fine, the media is public) for an image
  -- or voice post. The id matches the originating diary entry so re-
  -- publishing is idempotent and deleting the entry finds its public twin.
  CREATE TABLE IF NOT EXISTS discover_posts (
    id          TEXT PRIMARY KEY,
    author_id   TEXT NOT NULL REFERENCES users(id),
    kind        TEXT NOT NULL,             -- 'text' | 'image' | 'voice'
    text        TEXT,                      -- plaintext, <=500 chars
    media_json  TEXT,                      -- JSON MediaRef for image/voice
    created_at  ${BIG} NOT NULL,
    revoked_at  ${BIG}
  );
  CREATE INDEX IF NOT EXISTS idx_discover_created
    ON discover_posts(created_at, id);

  -- Binds a blob to a discover post so readBlobFor can serve it to any
  -- signed-in viewer. A discover post's media is public, so unlike a
  -- diary blob there is no grant to check — presence of the binding is
  -- the authorisation.
  CREATE TABLE IF NOT EXISTS discover_blobs (
    blob_id  TEXT PRIMARY KEY REFERENCES blobs(id),
    post_id  TEXT NOT NULL REFERENCES discover_posts(id)
  );

  -- Business profiles.
  --
  -- A business is a separate entity from a user (mirrors the way the
  -- "groups" table is its own entity rather than a flag on "users"),
  -- owned 1:1 by a user for MVP — the UNIQUE on owner_id enforces
  -- that. A business DM is a normal 1:1 thread with the owner's user
  -- id as peer; nothing in the message/thread rail cares about the
  -- business row, so no new thread kind is needed.
  --
  -- avatar_json is a plaintext MediaRef, like discover_posts.media_json:
  -- the business profile is public by definition (ads surface in the
  -- global Discover feed) so the content key sits in the clear.
  CREATE TABLE IF NOT EXISTS businesses (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL UNIQUE REFERENCES users(id),
    name          TEXT NOT NULL,
    description   TEXT,
    avatar_json   TEXT,
    created_at    ${BIG} NOT NULL,
    updated_at    ${BIG},
    archived_at   ${BIG}
  );
  CREATE INDEX IF NOT EXISTS idx_businesses_owner ON businesses(owner_id);

  -- Products in a business's catalogue. image_json follows the discover
  -- "public MediaRef in the clear" pattern. Soft-deleted via archived_at
  -- so an existing order's items_json still resolves if the business
  -- later removes the product.
  CREATE TABLE IF NOT EXISTS business_products (
    id             TEXT PRIMARY KEY,
    business_id    TEXT NOT NULL REFERENCES businesses(id),
    name           TEXT NOT NULL,
    description    TEXT,
    price_cents    INTEGER NOT NULL,
    currency       TEXT NOT NULL DEFAULT 'USD',
    image_json     TEXT,
    created_at     ${BIG} NOT NULL,
    updated_at     ${BIG},
    archived_at    ${BIG}
  );
  CREATE INDEX IF NOT EXISTS idx_products_business
    ON business_products(business_id, archived_at, created_at);

  -- Local audit trail of checkout attempts, independent of PayPal's own
  -- records. The server is the source of truth for price — we recompute
  -- the total from business_products at order-create time and never
  -- trust a client-sent amount. items_json freezes the sold-at snapshot
  -- so a later price edit doesn't rewrite history.
  CREATE TABLE IF NOT EXISTS business_orders (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    buyer_id          TEXT NOT NULL REFERENCES users(id),
    items_json        TEXT NOT NULL,
    total_cents       INTEGER NOT NULL,
    currency          TEXT NOT NULL,
    paypal_order_id   TEXT,
    status            TEXT NOT NULL DEFAULT 'created',
    created_at        ${BIG} NOT NULL,
    updated_at        ${BIG}
  );
  CREATE INDEX IF NOT EXISTS idx_orders_business
    ON business_orders(business_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_buyer
    ON business_orders(buyer_id, created_at);

  -- Payout ledger. One row per "I want my money, please" request. Status
  -- starts at 'requested' and flips to 'paid' when (and only when) a
  -- PayPal Payouts call lands — until that integration ships, the row
  -- lives at 'requested' and the Earnings view surfaces the pending
  -- balance. paypal_batch_id captures PayPal's own payout-batch id for
  -- the audit trail once the call wires up.
  CREATE TABLE IF NOT EXISTS business_payouts (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    amount_cents      INTEGER NOT NULL,
    currency          TEXT NOT NULL,
    destination       TEXT,
    destination_kind  TEXT,
    status            TEXT NOT NULL DEFAULT 'requested',
    paypal_batch_id   TEXT,
    requested_at      ${BIG} NOT NULL,
    completed_at      ${BIG}
  );
  CREATE INDEX IF NOT EXISTS idx_payouts_business
    ON business_payouts(business_id, requested_at);

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

  -- FCM device tokens, for waking a frozen app. A token is one device;
  -- a user may have several. No message content is ever stored or sent
  -- through here — only the fact that a device should sync.
  CREATE TABLE IF NOT EXISTS device_tokens (
    token        TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    platform     TEXT NOT NULL,
    created_at   ${BIG} NOT NULL,
    last_seen_at ${BIG} NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

  -- Phase 2: metadata-only analytics + user-safety tables.
  --
  -- NON-NEGOTIABLE: nothing below ever carries message plaintext.
  -- session_events is a per-sign-in / per-session-start log so the
  -- admin dashboard can compute DAU, WAU and retention cohorts without
  -- having to infer them from inbox write patterns. kind is one of
  -- login / session_start / token_refresh. device_label is the UA
  -- family string already attached to refresh tokens.
  CREATE TABLE IF NOT EXISTS session_events (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    kind         TEXT NOT NULL,
    device_label TEXT,
    created_at   ${BIG} NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_session_events_user
    ON session_events(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_session_events_time
    ON session_events(created_at);

  -- Client-side crashes / handled exceptions. message and stack are
  -- JavaScript error metadata (never message content). kind is one of
  -- crash / handled / failed_request. user_id is NULL for pre-auth
  -- errors (e.g. a crash on the sign-in screen).
  CREATE TABLE IF NOT EXISTS error_reports (
    id          TEXT PRIMARY KEY,
    user_id     TEXT REFERENCES users(id),
    kind        TEXT NOT NULL,
    message     TEXT,
    stack       TEXT,
    user_agent  TEXT,
    app_version TEXT,
    created_at  ${BIG} NOT NULL,
    resolved_at ${BIG}
  );
  CREATE INDEX IF NOT EXISTS idx_error_reports_time
    ON error_reports(created_at, resolved_at);

  -- One user flagging another. thread_id is a pointer the admin can
  -- cross-reference in their own moderation queue — the server never
  -- decrypts the thread, and the dashboard never displays its contents.
  -- reporter_note is the REPORTERs own free text (their consent to
  -- share it is explicit when they submit the form), not any encrypted
  -- content.
  CREATE TABLE IF NOT EXISTS abuse_reports (
    id                TEXT PRIMARY KEY,
    reporter_id       TEXT NOT NULL REFERENCES users(id),
    reported_user_id  TEXT NOT NULL REFERENCES users(id),
    thread_id         TEXT,
    reason            TEXT NOT NULL,
    reporter_note     TEXT,
    created_at        ${BIG} NOT NULL,
    state             TEXT NOT NULL DEFAULT 'open',
    reviewed_by       TEXT REFERENCES users(id),
    reviewed_at       ${BIG},
    action_taken      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_abuse_reports_state
    ON abuse_reports(state, created_at);
  CREATE INDEX IF NOT EXISTS idx_abuse_reports_reported
    ON abuse_reports(reported_user_id, created_at);

  -- Satisfaction / feature-request / general feedback. rating is 1-5
  -- for NPS-style prompts, NULL for free-text submissions. note is
  -- the users own words.
  CREATE TABLE IF NOT EXISTS feedback (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    kind        TEXT NOT NULL,
    rating      INTEGER,
    note        TEXT,
    created_at  ${BIG} NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_time
    ON feedback(created_at);

  -- Agent usage log — one row per call to /api/agent/turn.
  --
  -- The agent proxy is the one place the server legitimately sees
  -- the plaintext of a prompt (it has to, to forward it to Anthropic).
  -- NO plaintext is persisted. We store only:
  --   outcome      — ok / rate_limited / error (what happened)
  --   tokens_in    — approximate char count of the serialized
  --                  messages array / 4 (a rough token proxy — not
  --                  exact, not meant to be exact).
  -- This gives the admin dashboard a count of how often the agent is
  -- used and by whom. The daily rate limit (10 ok outcomes per user
  -- per UTC day) is enforced by counting rows in this table.
  CREATE TABLE IF NOT EXISTS agent_events (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    outcome     TEXT NOT NULL,
    tokens_in   INTEGER,
    created_at  ${BIG} NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_events_user
    ON agent_events(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_events_time
    ON agent_events(created_at);
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
  // Phase 2: admin + moderation flags + 1:1 message dedupe key.
  // All nullable or defaulted so existing rows survive without a
  // backfill. Postgres treats BOOLEAN natively; SQLite stores it as an
  // INTEGER 0/1 — we use INTEGER for compatibility and treat !=0 as true.
  { table: "users", name: "is_admin", ddl: "ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0" },
  { table: "users", name: "suspended_at", ddl: "ALTER TABLE users ADD COLUMN suspended_at BIGINT" },
  { table: "messages", name: "msg_id", ddl: "ALTER TABLE messages ADD COLUMN msg_id TEXT" },
  // Profile: avatar (small base64 data URI, client-resized), status
  // text + optional expiry. All public-directory info, like display
  // name and handle — not message content, so plain columns are fine.
  { table: "users", name: "avatar", ddl: "ALTER TABLE users ADD COLUMN avatar TEXT" },
  { table: "users", name: "status_text", ddl: "ALTER TABLE users ADD COLUMN status_text TEXT" },
  { table: "users", name: "status_until", ddl: "ALTER TABLE users ADD COLUMN status_until BIGINT" },
  // Commerce Layer Addendum A: commission split on each captured order.
  // These columns are additive — existing rows safely default to a 0 fee
  // (no commission on orders that pre-date the feature), so no backfill
  // is needed. fee_bps is stored per-row so a later rate change doesn't
  // retroactively rewrite history.
  { table: "business_orders", name: "fee_cents", ddl: "ALTER TABLE business_orders ADD COLUMN fee_cents INTEGER NOT NULL DEFAULT 0" },
  { table: "business_orders", name: "net_cents", ddl: "ALTER TABLE business_orders ADD COLUMN net_cents INTEGER NOT NULL DEFAULT 0" },
  { table: "business_orders", name: "fee_bps", ddl: "ALTER TABLE business_orders ADD COLUMN fee_bps INTEGER NOT NULL DEFAULT 0" },
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

  // Admin bootstrap. ADMIN_EMAILS is a comma-separated list set as an
  // env var on the Coolify deploy. Every email in that list gets
  // is_admin=1 on boot — safe to re-run, flipping is_admin=0 for an
  // email NOT on the list IS INTENTIONAL so demotions survive restart.
  // The dashboard's promote/demote endpoints update the same column
  // and the env var reflects the long-term intent.
  const emails = (process.env.ADMIN_EMAILS ?? "").split(",")
    .map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (emails.length > 0) {
    const placeholders = emails.map(() => "?").join(",");
    await db.prepare(
      `UPDATE users SET is_admin = 1 WHERE lower(email) IN (${placeholders})`,
    ).run(...emails);
    console.log(`[aegent] admin bootstrap: ${emails.length} email${emails.length === 1 ? "" : "s"} elevated`);
  }
}
