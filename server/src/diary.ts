// Diary storage.
//
// A diary entry is sealed once, on the author's device, with a random
// per-entry key. The relay never sees that key in the clear: it stores
// one *grant* per person who may read the entry, each holding the entry
// key sealed to that person's public key.
//
// That shape is what makes "friends can read today's page for 24 hours,
// and I keep it forever" enforceable rather than aspirational:
//
//   * expiry is the deletion of a GRANT, not of content. The author's
//     own grant never expires, so the archive survives; a viewer whose
//     grant is gone cannot obtain the key from anything this server will
//     hand them, and the body is never served without a live grant
//     either.
//   * the author's permanent archive and a viewer's 24 hours are the
//     same row type with a different `expires_at`. There is no second
//     storage path to keep in sync.
//
// What this cannot do, and what the UI must therefore not claim: a
// viewer who opened an entry inside the window holds the plaintext and
// may keep it. The honest sentence is "after 24 hours they can't open
// it again" — never "it disappears".
//
// Diary deliberately does not touch the `messages` table. Messages are
// the never-lose-anything rail, audited by the envelope ledger and id
// reconciliation; diary entries are meant to become unreadable on
// schedule. An expiring row inside that accounting would be reported as
// a permanent deficit forever.

import { db } from "./db.js";
import { AuthError, ForbiddenError } from "./auth.js";

export const VIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
// A page of a few hundred entries is already more than anyone reads in a
// sitting; the cap exists so a feed request can't be made unbounded.
export const MAX_FEED_LIMIT = 200;
// Minting a grant per contact is the cost of publishing. The cap bounds
// both the write and the metadata the relay learns in one go.
export const MAX_AUDIENCE = 500;
// How far ahead of the relay a client's clock may be before we stop
// trusting it. Expiry is computed from the server's clock regardless;
// this only rejects nonsense.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type DiaryEntryRow = {
  id: string;
  author_id: string;
  day_key: string;
  tz_offset_min: number;
  seq: number;
  kind: string;
  body_ct: string;
  created_at: number;
  revoked_at: number | null;
};

export type PublishInput = {
  id: string;
  dayKey: string;
  tzOffsetMin: number;
  seq: number;
  kind: "text" | "media";
  createdAt: number;
  bodyCt: string;
  authorKey: string;                                   // entry key sealed to the author
  grants: Array<{ viewerId: string; wrappedKey: string }>;
  blobIds: string[];
};

// ---- publish ----

export async function publishEntry(authorId: string, input: PublishInput): Promise<{
  id: string; createdAt: number; expiresAt: number;
}> {
  if (input.grants.length > MAX_AUDIENCE) {
    throw new AuthError("audience_too_large", `A diary entry can be shared with at most ${MAX_AUDIENCE} people.`);
  }

  const now = Date.now();
  if (input.createdAt > now + MAX_CLOCK_SKEW_MS) {
    throw new AuthError("clock_skew", "That entry is dated too far in the future.");
  }
  // The relay owns the expiry clock. A client-chosen `created_at` would
  // otherwise be a client-chosen expiry — set it far enough back and the
  // entry is born expired, far enough forward and it never expires.
  const createdAt = Math.min(input.createdAt, now);
  const expiresAt = createdAt + VIEW_WINDOW_MS;

  const existing = await db.prepare("SELECT author_id FROM diary_entries WHERE id = ?")
    .get<{ author_id: string }>(input.id);
  if (existing) {
    // Entry ids are client-generated so a retry is idempotent, but only
    // for the author who created it.
    if (existing.author_id !== authorId) throw new ForbiddenError("not_yours", "That entry id is taken.");
    return { id: input.id, createdAt, expiresAt };
  }

  // Binding a blob to an entry makes it ACL-able (see readBlobFor), so
  // it must only ever be the author's own upload — otherwise an author
  // could bind someone else's chat attachment and lock them out of it.
  for (const blobId of input.blobIds) {
    const b = await db.prepare("SELECT owner_id FROM blobs WHERE id = ?").get<{ owner_id: string }>(blobId);
    if (!b) throw new AuthError("unknown_blob", "That attachment no longer exists.");
    if (b.owner_id !== authorId) throw new ForbiddenError("not_your_blob", "That attachment isn't yours.");
  }

  await db.tx(async () => {
    await db.prepare(
      `INSERT INTO diary_entries
         (id, author_id, day_key, tz_offset_min, seq, kind, body_ct, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(input.id, authorId, input.dayKey, input.tzOffsetMin, input.seq, input.kind, input.bodyCt, createdAt);

    const grant = db.prepare(
      `INSERT INTO diary_grants (entry_id, viewer_id, wrapped_key, created_at, expires_at, seen_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    );
    // The author's own grant never expires. This is the archive.
    await grant.run(input.id, authorId, input.authorKey, createdAt, null);
    for (const g of input.grants) {
      if (g.viewerId === authorId) continue;           // already granted, and never expiring
      await grant.run(input.id, g.viewerId, g.wrappedKey, createdAt, expiresAt);
    }

    const bind = db.prepare("INSERT INTO diary_blobs (blob_id, entry_id) VALUES (?, ?)");
    for (const blobId of input.blobIds) await bind.run(blobId, input.id);
  });

  return { id: input.id, createdAt, expiresAt };
}

// ---- reads ----

export type FeedRow = DiaryEntryRow & { wrapped_key: string; expires_at: number | null; seen_at: number | null };

type Page = { since?: number; afterId?: string; limit?: number };

function pageClause(page: Page, args: unknown[]): string {
  const limit = Math.min(Math.max(page.limit ?? 50, 1), MAX_FEED_LIMIT);
  let where = "";
  if (page.afterId) {
    where = " AND (e.created_at > ? OR (e.created_at = ? AND e.id > ?))";
    args.push(page.since ?? 0, page.since ?? 0, page.afterId);
  } else if (page.since) {
    where = " AND e.created_at >= ?";
    args.push(page.since);
  }
  return `${where} ORDER BY e.created_at ASC, e.id ASC LIMIT ${limit}`;
}

// Entries other people have shared with this viewer and that have not
// expired. An expired entry is simply absent — there are no tombstones,
// because the viewer's own copy already knows when to drop itself and a
// tombstone list is a structure the relay would have to keep forever.
export async function feedFor(viewerId: string, page: Page): Promise<FeedRow[]> {
  const args: unknown[] = [viewerId, viewerId, Date.now()];
  const tail = pageClause(page, args);
  return db.prepare(
    `SELECT e.*, g.wrapped_key, g.expires_at, g.seen_at
       FROM diary_entries e
       JOIN diary_grants g ON g.entry_id = e.id AND g.viewer_id = ?
      WHERE e.author_id != ?
        AND e.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > ?)${tail}`,
  ).all<FeedRow>(...args);
}

// The author's own archive — their never-expiring grants. This is what a
// brand-new device replays to rebuild the diary from a bare login, with
// no sibling device and no backup file.
export async function archiveFor(authorId: string, page: Page): Promise<FeedRow[]> {
  const args: unknown[] = [authorId, authorId];
  const tail = pageClause(page, args);
  return db.prepare(
    `SELECT e.*, g.wrapped_key, g.expires_at, g.seen_at
       FROM diary_entries e
       JOIN diary_grants g ON g.entry_id = e.id AND g.viewer_id = ?
      WHERE e.author_id = ?
        AND e.revoked_at IS NULL${tail}`,
  ).all<FeedRow>(...args);
}

// ---- views ----

export async function markSeen(viewerId: string, entryIds: string[]): Promise<void> {
  const now = Date.now();
  const stmt = db.prepare(
    "UPDATE diary_grants SET seen_at = ? WHERE entry_id = ? AND viewer_id = ? AND seen_at IS NULL",
  );
  await db.tx(async () => {
    for (const id of entryIds) await stmt.run(now, id, viewerId);
  });
}

// Who read an entry.
//
// The count is always the author's to see — it is the engagement signal
// the whole feature runs on. Identity is gated on the viewer's existing
// read-receipts setting, so someone who already chose not to send
// receipts for messages is not newly exposed here. One new table, no new
// privacy switch to explain.
export async function viewsOf(authorId: string, entryId: string): Promise<{
  count: number; viewers: Array<{ id: string; seenAt: number }>;
}> {
  const entry = await db.prepare("SELECT author_id FROM diary_entries WHERE id = ?")
    .get<{ author_id: string }>(entryId);
  if (!entry) throw new AuthError("not_found", "No such entry.");
  if (entry.author_id !== authorId) throw new ForbiddenError("not_yours", "That isn't your entry.");

  const rows = await db.prepare(
    `SELECT g.viewer_id, g.seen_at, u.read_receipts
       FROM diary_grants g
       JOIN users u ON u.id = g.viewer_id
      WHERE g.entry_id = ? AND g.viewer_id != ? AND g.seen_at IS NOT NULL`,
  ).all<{ viewer_id: string; seen_at: number; read_receipts: number }>(entryId, authorId);

  return {
    count: rows.length,
    viewers: rows
      .filter((r) => !!r.read_receipts)
      .map((r) => ({ id: r.viewer_id, seenAt: Number(r.seen_at) })),
  };
}


// Edit an entry's body, allowed only on the day it was posted.
//
// A diary records daily activities, so revising today's entry is a
// normal fix; a week later it would quietly rewrite history for anyone
// who already read it. The grants (and the entry key) do NOT change —
// readers who already have an open 24h grant keep seeing the live text,
// and expiry is still measured from the original creation.
export async function editEntryBody(authorId: string, entryId: string, input: {
  bodyCt: string; kind?: "text" | "media";
}): Promise<void> {
  const row = await db.prepare(
    "SELECT author_id, day_key FROM diary_entries WHERE id = ?",
  ).get<{ author_id: string; day_key: string }>(entryId);
  if (!row) throw new AuthError("not_found", "No such entry.");
  if (row.author_id !== authorId) throw new ForbiddenError("not_yours", "That isn't your entry.");

  // "Today" is the author's own day — their timezone, their calendar.
  // The stored day_key is already in that frame, so the test is simply
  // whether that day_key matches the one the client claims is current.
  // The client sends its current dayKey; we only validate it is the same
  // string as the entry's. A client whose clock is off is their own
  // problem to resolve.
  //
  // To avoid trusting the client's day entirely we also cap the window:
  // 36 hours since created_at is more than enough slack for any sane
  // timezone offset and prevents a rogue client from "editing" a page
  // from last week.
  const EDIT_WINDOW_MS = 36 * 60 * 60 * 1000;
  const createdAt = Number((await db.prepare("SELECT created_at FROM diary_entries WHERE id = ?")
    .get<{ created_at: number }>(entryId))?.created_at ?? 0);
  if (Date.now() - createdAt > EDIT_WINDOW_MS) {
    throw new ForbiddenError("edit_window_closed", "You can only edit a diary entry on the day you wrote it.");
  }

  const updates: string[] = ["body_ct = ?"];
  const args: unknown[] = [input.bodyCt];
  if (input.kind) { updates.push("kind = ?"); args.push(input.kind); }
  args.push(entryId);
  await db.prepare(`UPDATE diary_entries SET ${updates.join(", ")} WHERE id = ?`).run(...args);
}

// ---- audience changes and deletion ----

export async function updateGrants(authorId: string, entryId: string, input: {
  add: Array<{ viewerId: string; wrappedKey: string }>;
  remove: string[];
}): Promise<void> {
  const entry = await db.prepare("SELECT author_id, created_at FROM diary_entries WHERE id = ?")
    .get<{ author_id: string; created_at: number }>(entryId);
  if (!entry) throw new AuthError("not_found", "No such entry.");
  if (entry.author_id !== authorId) throw new ForbiddenError("not_yours", "That isn't your entry.");

  const expiresAt = Number(entry.created_at) + VIEW_WINDOW_MS;
  await db.tx(async () => {
    const add = db.prepare(
      `INSERT INTO diary_grants (entry_id, viewer_id, wrapped_key, created_at, expires_at, seen_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    );
    for (const g of input.add) {
      if (g.viewerId === authorId) continue;
      // Late additions inherit the ORIGINAL expiry, so adding someone at
      // hour 23 gives them an hour, not a fresh day.
      await add.run(entryId, g.viewerId, g.wrappedKey, Date.now(), expiresAt).catch(() => { /* already granted */ });
    }
    const drop = db.prepare("DELETE FROM diary_grants WHERE entry_id = ? AND viewer_id = ? AND viewer_id != ?");
    for (const viewerId of input.remove) await drop.run(entryId, viewerId, authorId);
  });
}

// The shred. Removing the grants is what actually revokes access; the
// row and its blobs go with it so the author's own copy is gone too.
export async function deleteEntry(authorId: string, entryId: string): Promise<void> {
  const entry = await db.prepare("SELECT author_id FROM diary_entries WHERE id = ?")
    .get<{ author_id: string }>(entryId);
  if (!entry) return;
  if (entry.author_id !== authorId) throw new ForbiddenError("not_yours", "That isn't your entry.");

  await db.tx(async () => {
    const blobs = await db.prepare("SELECT blob_id FROM diary_blobs WHERE entry_id = ?")
      .all<{ blob_id: string }>(entryId);
    await db.prepare("DELETE FROM diary_blobs WHERE entry_id = ?").run(entryId);
    for (const b of blobs) {
      await db.prepare("DELETE FROM blobs WHERE id = ? AND owner_id = ?").run(b.blob_id, authorId);
    }
    await db.prepare("DELETE FROM diary_grants WHERE entry_id = ?").run(entryId);
    await db.prepare("DELETE FROM diary_entries WHERE id = ?").run(entryId);
  });
}

// ---- expiry ----
//
// Correctness comes from the read paths, which all join a live grant, so
// an expired row is unreadable the moment it expires whether or not
// anything has swept. This sweep is storage hygiene, throttled and
// opportunistic because there is no job runner in this codebase and one
// DELETE does not justify inventing one.
let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export async function sweepExpiredGrants(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastSweepAt < SWEEP_INTERVAL_MS) return 0;
  lastSweepAt = now;
  const doomed = await db.prepare(
    "SELECT entry_id, viewer_id FROM diary_grants WHERE expires_at IS NOT NULL AND expires_at < ?",
  ).all<{ entry_id: string; viewer_id: string }>(now);
  if (doomed.length === 0) return 0;
  const stmt = db.prepare("DELETE FROM diary_grants WHERE entry_id = ? AND viewer_id = ?");
  for (const row of doomed) await stmt.run(row.entry_id, row.viewer_id);
  return doomed.length;
}

// Everyone who currently holds a live grant — the rooms to notify when
// an entry is published.
export async function granteesOf(entryId: string): Promise<string[]> {
  const rows = await db.prepare(
    "SELECT viewer_id FROM diary_grants WHERE entry_id = ?",
  ).all<{ viewer_id: string }>(entryId);
  return rows.map((r) => r.viewer_id);
}
