// Session bootstrap, the key vault, and the high-level send/receive
// pipeline.
//
// Availability is the first-order requirement here: every message this
// account has ever sent or received must be reachable from any device,
// on demand, forever. Three mechanisms carry that guarantee, and they
// are deliberately independent so no single failure hides history:
//
//   1. Server-side replication. Every send fans out a self-addressed
//      ciphertext copy, so the relay holds the sender's history as well
//      as the recipient's. The relay is the source of truth; local
//      storage is only a cache.
//
//   2. A ledgered, resumable drain. Every envelope the server hands us
//      is recorded in an on-device ledger as ingested-or-pending. The
//      paging cursor can therefore be advanced freely (the ledger
//      dedupes) while anything that failed to ingest is retried on
//      every later drain instead of being skipped forever. A count
//      check against the server catches any divergence and re-drains.
//
//   3. A key vault, not a single wrapper. The identity private key is
//      what makes stored ciphertext readable, so it can be wrapped more
//      than once: always under the password, and optionally under a
//      recovery code the user asks for in Settings. The local store key
//      is derived from the private key rather than the password, so
//      changing or resetting a password re-wraps a key that never
//      changes and cannot cost anybody their history.
//
// Signup deliberately does NOT force a recovery code on anyone: your
// password is your key, which is the whole point, and a mandatory
// "write these words down" screen is friction most people answer by
// screenshotting it into the same phone they'd lose. The recovery code
// exists for people who go looking for it.

import {
  b64, backupKeyFromPrivate, decryptFromPeer, deriveKey, encryptForPeer,
  entropyFromPhrase, generateIdentity,
  initCrypto, newKdfSalt, newRecoveryPhrase, recoveryWrapKey,
  secretBoxOpen, secretBoxSeal, storeKeyFromPrivate,
} from "./crypto.js";
import { startReplication, stopReplication } from "./replication.js";
import {
  api, apiUrl, loadToken, setRefreshToken, setToken,
  type Envelope, type InboxStats, type MeApi, type PublicUser,
} from "./api.js";
import {
  applyDelete, applyEdit, applyReaction, bumpOutboxAttempt, closeStore, dequeueOutbox,
  enqueueOutbox, getContact, getGroup, getMeta, ledgerAllIds, ledgerClear, ledgerCounts,
  ledgerMarkOk, ledgerMarkPending, ledgerPending, ledgerStatus, listOutbox, markDelivered,
  markRead, openStore, outboxCount, rekeyLocalStore, repairTimestamps, saveMediaMessage,
  saveTextMessage, setMeta, upsertContact, upsertGroup, type MediaRef,
} from "./store.js";
import { scheduleAutoBackup } from "./backup.js";
import { connectSocket, disconnectSocket, sendCipher } from "./socket.js";
import { newMsgId, packPayload, unpackPayload, type Payload } from "./protocol.js";

export type Session = {
  user: MeApi;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
};

let CURRENT: Session | null = null;
export function currentSession(): Session | null { return CURRENT; }

// ---- persisted-session keys ----
//
// The JWT alone isn't enough to restore a session — we also need the
// private key (to decrypt inbound messages) and the local-store key
// (to open the encrypted IndexedDB). We persist both in localStorage,
// which on Android's Capacitor WebView lives in app-private storage
// (SharedPreferences-equivalent) — not readable by other apps without
// root. This is MVP-grade session persistence; a production build
// should upgrade to Android Keystore via a Capacitor plugin.
//
// Sign-out clears everything explicitly.

const KEY_PRIV = "aegent.priv";
const KEY_STORE = "aegent.storekey";
const KEY_BACKUP = "aegent.backupkey";

// Drain cursor: the (createdAt, id) keyset position we have paged
// through for this user. Namespaced by userId so switching accounts on
// the same device stays clean. Absence → drain from the beginning of
// time, which is the fresh-install / new-device path.
type Cursor = { since: number; afterId: string } | null;
function KEY_CURSOR(userId: string) { return `aegent.inbox.cursor.${userId}`; }
// Pre-ledger installs stored a bare timestamp watermark under this key.
// It is read once (so an upgrade doesn't re-drain from zero) and then
// ignored.
function KEY_LEGACY_WATERMARK(userId: string) { return `aegent.inbox.watermark.${userId}`; }

function readCursor(userId: string): Cursor {
  try {
    const raw = localStorage.getItem(KEY_CURSOR(userId));
    if (raw) {
      const c = JSON.parse(raw) as Cursor;
      if (c && typeof c.since === "number") return c;
    }
    const legacy = Number(localStorage.getItem(KEY_LEGACY_WATERMARK(userId)) ?? 0) || 0;
    return legacy ? { since: legacy, afterId: "" } : null;
  } catch { return null; }
}
function writeCursor(userId: string, c: Cursor): void {
  try {
    if (c) localStorage.setItem(KEY_CURSOR(userId), JSON.stringify(c));
    else localStorage.removeItem(KEY_CURSOR(userId));
  } catch { /* private browsing / storage full — degrade quietly */ }
}

let CACHED_BACKUP_KEY: Uint8Array | null = null;
export function backupKey(): Uint8Array | null { return CACHED_BACKUP_KEY; }

function persistKeys(privateKey: Uint8Array, storeKey: Uint8Array, backupKey?: Uint8Array | null) {
  try {
    localStorage.setItem(KEY_PRIV, b64.encode(privateKey));
    localStorage.setItem(KEY_STORE, b64.encode(storeKey));
    if (backupKey) {
      localStorage.setItem(KEY_BACKUP, b64.encode(backupKey));
      CACHED_BACKUP_KEY = backupKey;
    }
  } catch { /* private-browsing / storage-full — silently degrade */ }
}
function loadPersistedKeys(): { privateKey: Uint8Array; storeKey: Uint8Array; backupKey?: Uint8Array } | null {
  try {
    const p = localStorage.getItem(KEY_PRIV);
    const s = localStorage.getItem(KEY_STORE);
    if (!p || !s) return null;
    const bk = localStorage.getItem(KEY_BACKUP);
    if (bk) CACHED_BACKUP_KEY = b64.decode(bk);
    return {
      privateKey: b64.decode(p),
      storeKey: b64.decode(s),
      backupKey: bk ? b64.decode(bk) : undefined,
    };
  } catch { return null; }
}
function clearPersistedKeys() {
  try {
    localStorage.removeItem(KEY_PRIV);
    localStorage.removeItem(KEY_STORE);
    localStorage.removeItem(KEY_BACKUP);
    CACHED_BACKUP_KEY = null;
  } catch { /* ignore */ }
}

// ---- local-store key migration ----
//
// Old devices sealed their Dexie rows with a password-derived key; the
// key is now derived from the identity private key so a password change
// can't orphan local history. `openLocalStore` opens with the new key
// and, when a legacy key is available and the store hasn't been
// converted yet, re-seals the existing rows in place.
const META_STOREKEY_VERSION = "storeKeyVersion";
const META_TS_REPAIR = "timestampRepair";

async function openLocalStore(
  userId: string, privateKey: Uint8Array, legacyKey?: Uint8Array | null,
): Promise<Uint8Array> {
  const storeKey = storeKeyFromPrivate(privateKey);
  openStore(userId, storeKey);
  try {
    const version = await getMeta(META_STOREKEY_VERSION);
    if (version !== "2") {
      if (legacyKey && !eqBytes(legacyKey, storeKey)) {
        const r = await rekeyLocalStore(legacyKey);
        console.log(`[session] re-keyed local store: ${r.rekeyed} rows${r.failed ? `, ${r.failed} left for re-sync` : ""}`);
      }
      await setMeta(META_STOREKEY_VERSION, "2");
    }
    // One-time repair for rows written while the relay was serving
    // Postgres BIGINTs as strings — those messages are in the store but
    // sort outside every numeric key range, so they render nowhere.
    if (await getMeta(META_TS_REPAIR) !== "1") {
      const fixed = await repairTimestamps();
      if (fixed > 0) console.log(`[session] repaired ${fixed} row(s) with non-numeric timestamps`);
      await setMeta(META_TS_REPAIR, "1");
    }
  } catch (e) {
    console.warn("[session] store migration skipped:", (e as Error).message);
  }
  return storeKey;
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- inbox drain ----
//
// Paged, ledgered, resumable. Every page is acked in one request, every
// envelope is recorded in the ledger, and the cursor only ever means
// "we have *seen* up to here" — never "we have successfully ingested
// up to here", which is what used to let a transient failure drop a
// message permanently.

const PAGE_SIZE = 300;

// Progress out of the drain, so the UI can show a real count while a
// brand-new device rebuilds an account instead of staring at an empty
// chat list. One listener set, fanned out defensively.
type DrainProgress = { ingested: number; serverTotal: number; reason: string };
const drainListeners = new Set<(p: DrainProgress) => void>();
export function onDrainProgress(cb: (p: DrainProgress) => void): () => void {
  drainListeners.add(cb);
  return () => { drainListeners.delete(cb); };
}
function emitDrainProgress(p: DrainProgress): void {
  for (const cb of drainListeners) {
    try { cb(p); } catch { /* a progress listener must never break a drain */ }
  }
}

let PULL_IN_FLIGHT: Promise<{ pulled: number }> | null = null;

export async function pullInbox(opts: { reason?: string } = {}): Promise<{ pulled: number }> {
  if (!CURRENT) return { pulled: 0 };
  // Coalesce: boot + focus + socket-reconnect otherwise trigger three
  // parallel drains on the same instant.
  if (PULL_IN_FLIGHT) return PULL_IN_FLIGHT;
  PULL_IN_FLIGHT = drain(opts.reason ?? "incremental").finally(() => { PULL_IN_FLIGHT = null; });
  return PULL_IN_FLIGHT;
}

async function drain(reason: string): Promise<{ pulled: number }> {
  const userId = CURRENT!.user.id;
  let pulled = 0;
  let cursor = readCursor(userId);
  let pages = 0;
  // Fetched before the first page purely so progress has a denominator.
  let serverTotal = -1;
  try { serverTotal = (await api.inboxStats()).total; } catch { /* advisory */ }

  // Page forward until the server says there is nothing left. The
  // page limit is a safety valve against a pathological loop, not an
  // expected ceiling: 2000 pages is ~600k envelopes.
  //
  // A failure in here must NOT abort the rest of the drain. Reconciliation
  // below fetches by id and depends on no cursor at all, so it is the one
  // step that can still make progress when paging is broken — exactly the
  // case where a device would otherwise sit at a frozen "N to go" forever,
  // because the status numbers come from a different request that keeps
  // succeeding.
  try {
    for (; pages < 2000; pages++) {
      const page = await api.inbox({
        all: true,
        since: cursor?.since ?? 0,
        afterId: cursor?.afterId ?? undefined,
        limit: PAGE_SIZE,
      });
      if (page.envelopes.length === 0) break;
      pulled += await ingestBatch(page.envelopes);
      if (page.cursor) {
        cursor = { since: Number(page.cursor.since) || 0, afterId: page.cursor.afterId };
        writeCursor(userId, cursor);
      }
      try {
        const counts = await ledgerCounts();
        emitDrainProgress({ ingested: counts.total, serverTotal, reason });
      } catch { /* ignore */ }
      if (!page.more) break;
    }
  } catch (e) {
    console.warn("[drain] paging failed, falling back to reconciliation:", (e as Error).message);
    bumpSkipCounter("paging_failed");
  }

  // Retry anything still pending from this or an earlier drain.
  const retried = await retryPending().catch(() => 0);

  // Reconciliation: ask the relay which envelope ids it holds for us,
  // diff against the ledger, and fetch exactly what's missing by id.
  //
  // This replaces a count comparison that could never converge. Counts
  // answer "how far behind", which is the wrong question when the two
  // sides are counting different things — an account whose history
  // predates the ledger looks permanently behind while missing nothing,
  // and the device re-drains forever trying to close a gap that isn't
  // there. An id diff either converges or names what didn't.
  const recovered = await reconcile(reason);

  writeDiag({ lastPullAt: Date.now(), lastPulled: pulled + retried + recovered, lastReason: reason });
  return { pulled: pulled + retried + recovered };
}

// The exact-accounting pass. Cheap in the common case (one request, and
// the diff is empty), so it runs at the end of every drain.
async function reconcile(reason: string): Promise<number> {
  try {
    const [listing, counts] = await Promise.all([api.inboxIds(), ledgerCounts()]);
    if (listing.truncated) {
      // Very large account: fall back to counts for reporting. The
      // cursor drain above is still exhaustive.
      writeDiag({
        serverTotal: counts.total, localTotal: counts.total,
        pending: counts.pending, missing: 0,
      });
      return 0;
    }
    const have = new Set(await ledgerAllIds());
    const missing = listing.ids.filter((id) => !have.has(id));

    let recovered = 0;
    if (missing.length > 0) {
      console.warn(`[reconcile] ${missing.length} envelope(s) the relay holds are not accounted for — fetching by id (${reason})`);
      for (let i = 0; i < missing.length; i += 200) {
        const chunk = missing.slice(i, i + 200);
        const { envelopes } = await api.inboxFetch(chunk);
        recovered += await ingestBatch(envelopes);
        // An id the relay listed but then declined to hand over would
        // otherwise stay "missing" on every future pass — a phantom
        // deficit that never closes. Record it so the diff converges and
        // the user is told something concrete instead of watching a
        // counter that never moves.
        const returned = new Set(envelopes.map((e) => e.id));
        for (const id of chunk) {
          if (returned.has(id)) continue;
          await ledgerMarkPending(
            { id, senderId: "", recipientId: "", groupId: null, ciphertext: "", createdAt: 0 },
            "not_returned_by_relay",
          ).catch(() => { /* ignore */ });
        }
        try {
          const c = await ledgerCounts();
          emitDrainProgress({ ingested: c.total, serverTotal: listing.ids.length, reason: "reconcile" });
        } catch { /* ignore */ }
      }
    }

    // Re-diff so the number we report is what is true *now*, not what
    // we hoped the repair achieved. Anything still unaccounted for is a
    // real problem and says so rather than hiding behind a count.
    const after = new Set(await ledgerAllIds());
    const stillMissing = listing.ids.filter((id) => !after.has(id)).length;
    const finalCounts = await ledgerCounts();
    writeDiag({
      serverTotal: listing.ids.length,
      localTotal: Math.min(finalCounts.total, listing.ids.length),
      pending: finalCounts.pending,
      missing: stillMissing,
    });
    if (stillMissing > 0) {
      console.warn(`[reconcile] ${stillMissing} envelope(s) could not be retrieved`);
    }
    return recovered;
  } catch (e) {
    console.warn("[reconcile] skipped:", (e as Error).message);
    return 0;
  }
}

// Ingest one page: skip what the ledger already has, ingest the rest,
// then ack the whole page in a single request. The old code issued one
// ack HTTP call per envelope, which made a first-login drain of a few
// thousand messages thousands of round trips.
async function ingestBatch(envelopes: Envelope[]): Promise<number> {
  const toAck: string[] = [];
  let pulled = 0;
  for (const env of envelopes) {
    try {
      const seen = await ledgerStatus(env.id);
      if (seen?.status === "ok") { toAck.push(env.id); continue; }
      const res = await ingestEnvelope(env, { ack: false });
      if (res) { pulled++; toAck.push(env.id); }
    } catch (err) {
      console.warn("[drain] ingest threw", env.id, err);
      await ledgerMarkPending(env, (err as Error).message || "threw").catch(() => { /* ignore */ });
    }
  }
  if (toAck.length) await api.ack(toAck).catch(() => { /* delivery flag is advisory */ });
  return pulled;
}

// Walk the pending ledger. Each row still carries its ciphertext, so a
// retry needs no network round trip beyond whatever the failure
// originally needed (usually a contact lookup).
// An envelope that has failed this many times is not going to start
// working on the next tick — most likely it was encrypted to a key this
// account no longer holds. We stop retrying it and keep reporting it, so
// the user is told "2 messages couldn't be read" instead of watching a
// sync that never finishes.
const MAX_RETRY_ATTEMPTS = 8;

async function retryPending(): Promise<number> {
  let fixed = 0;
  const pending = (await ledgerPending()).filter((r) => r.attempts <= MAX_RETRY_ATTEMPTS);
  if (pending.length === 0) return 0;
  const toAck: string[] = [];
  for (const row of pending) {
    if (!row.raw || !row.raw.ciphertext) continue;
    try {
      const res = await ingestEnvelope(row.raw, { ack: false });
      if (res) { fixed++; toAck.push(row.raw.id); }
    } catch { /* stays pending; next drain tries again */ }
  }
  if (toAck.length) await api.ack(toAck).catch(() => { /* ignore */ });
  if (fixed > 0) console.log(`[drain] recovered ${fixed} previously-stuck message${fixed === 1 ? "" : "s"}`);
  return fixed;
}

// Force-drain: forget the cursor AND the ledger, then pull every
// envelope the server has. Used by Settings → "Re-sync all history" and
// on every sign-in, so a device that joined mid-conversation (or lost
// its local Dexie) rebuilds the whole account. Idempotent — message
// rows are keyed by msgId, so re-ingesting overwrites in place.
export async function fullResyncInbox(): Promise<{ pulled: number }> {
  if (!CURRENT) return { pulled: 0 };
  writeCursor(CURRENT.user.id, null);
  try { await ledgerClear(); } catch { /* store may not be open yet */ }
  return pullInbox({ reason: "full" });
}

// Called from the live-socket handler after a real-time delivery so the
// next drain doesn't re-page over what we already hold. Safe because
// the ledger — not the cursor — is what guarantees completeness.
export function bumpInboxCursor(env: { id: string; createdAt: number }): void {
  if (!CURRENT) return;
  const userId = CURRENT.user.id;
  const createdAt = Number(env.createdAt) || 0;
  const cur = readCursor(userId);
  if (!cur || createdAt > cur.since) {
    writeCursor(userId, { since: createdAt, afterId: env.id });
  }
}

// ---- availability report ----

export type AvailabilityReport = {
  serverTotal: number;
  localLedger: number;
  // Envelopes the relay holds that this device has no record of at all.
  // Exact, from the last reconciliation — not a difference of counts.
  missing: number;
  pending: number;
  queuedOutbound: number;
  newestAt: number | null;
  oldestAt: number | null;
  healthy: boolean;
};

// What Settings → Sync shows. Comparing the server's envelope count with
// the ledger's is the honest answer to "do I actually have all my
// messages on this device?".
export async function availabilityReport(): Promise<AvailabilityReport> {
  const [stats, counts, queued] = await Promise.all([
    api.inboxStats().catch((): InboxStats => ({ total: -1, newestAt: null, oldestAt: null })),
    ledgerCounts().catch(() => ({ ok: 0, pending: 0, total: 0 })),
    outboxCount().catch(() => 0),
  ]);
  // `missing` comes from the last reconciliation, which compared ids
  // rather than totals. Counts are for display only: the relay's total
  // and the ledger's are not the same quantity (the relay counts rows,
  // the ledger counts what this device has processed), and treating a
  // difference between them as "messages are missing" is what produced
  // a permanent, meaningless "122 to go".
  const missing = Math.max(readDiag().missing ?? 0, 0);
  return {
    serverTotal: stats.total,
    localLedger: counts.total,
    missing,
    pending: counts.pending,
    queuedOutbound: queued,
    newestAt: stats.newestAt,
    oldestAt: stats.oldestAt,
    healthy: missing === 0 && counts.pending === 0 && queued === 0,
  };
}

// ---- device-to-device backfill ----
//
// For every message in this device's local store that THIS user sent,
// encrypt a self-copy and send it to the relay. Other devices (same
// account → same private key) then see those messages on their next
// drain, closing the gap for anything sent before self-echo existed.
//
// Nothing leaves as plaintext: the self-copy is encrypted to our own
// public key with our own private key, exactly as sendToPeer does.
// Idempotent — the receiving side dedupes by msgId.
export async function pushLocalHistoryToServer(opts: {
  onProgress?: (done: number, total: number) => void;
} = {}): Promise<{ pushed: number; skipped: number }> {
  if (!CURRENT) return { pushed: 0, skipped: 0 };
  const selfId = CURRENT.user.id;
  const { everyMessage } = await import("./store.js");
  const rows = await everyMessage();
  const mine = rows.filter((m) => m.senderId === selfId && !m.deletedAt);
  const pushedSet = PUSHED_CACHE?.uid === selfId ? PUSHED_CACHE.set : readPushedSet(selfId);
  let pushed = 0, skipped = 0;
  for (let i = 0; i < mine.length; i++) {
    opts.onProgress?.(i, mine.length);
    const m = mine[i];
    const payload = selfCopyPayload(m);
    if (!payload) { skipped++; continue; }
    try {
      const cipher = encryptForPeer(packPayload(payload), CURRENT.publicKey, CURRENT.privateKey);
      const res = await sendCipher(selfId, cipher);
      if (res.ok) { pushed++; pushedSet.add(m.id); } else skipped++;
    } catch { skipped++; }
  }
  writePushedSet(selfId, pushedSet);
  opts.onProgress?.(mine.length, mine.length);
  writeDiag({ lastPushedAt: Date.now(), lastPushed: pushed });
  return { pushed, skipped };
}

// Rebuild the payload a past send would have produced. The msgId stays
// stable so every device dedupes against the row it already has.
function selfCopyPayload(m: {
  id: string; peerId: string; body: string | null; editedBody: string | null;
  caption: string | null; media: MediaRef | null;
}): Payload | null {
  if (m.media) {
    return {
      v: 1, t: "media", msgId: m.id, caption: m.caption ?? undefined,
      media: m.media, _thread: m.peerId,
    } as Payload;
  }
  const body = m.editedBody ?? m.body;
  if (!body) return null;
  return { v: 1, t: "text", msgId: m.id, body, _thread: m.peerId } as Payload;
}

// Which of our own messages the relay already has a self-copy of. Seeded
// from ingested self-echoes too, so a second device never re-uploads the
// history it just downloaded.
function pushedKey(uid: string) { return `aegent.pushed-msgids.${uid}`; }
function readPushedSet(uid: string): Set<string> {
  try { return new Set<string>(JSON.parse(localStorage.getItem(pushedKey(uid)) ?? "[]")); }
  catch { return new Set<string>(); }
}
function writePushedSet(uid: string, s: Set<string>): void {
  try { localStorage.setItem(pushedKey(uid), JSON.stringify([...s])); } catch { /* ignore */ }
}
// Buffered: a full-history drain marks thousands of self-echoes, and
// re-serialising the whole set per message turned that into quadratic
// localStorage writes.
let PUSHED_CACHE: { uid: string; set: Set<string> } | null = null;
let PUSHED_FLUSH: number | null = null;
function markPushed(uid: string, msgId: string): void {
  if (!PUSHED_CACHE || PUSHED_CACHE.uid !== uid) {
    PUSHED_CACHE = { uid, set: readPushedSet(uid) };
  }
  if (PUSHED_CACHE.set.has(msgId)) return;
  PUSHED_CACHE.set.add(msgId);
  if (PUSHED_FLUSH !== null) return;
  PUSHED_FLUSH = setTimeout(() => {
    PUSHED_FLUSH = null;
    if (PUSHED_CACHE) writePushedSet(PUSHED_CACHE.uid, PUSHED_CACHE.set);
  }, 1500) as unknown as number;
}

// Replicate anything that exists only on this device. Awaitable, so the
// replication loop can sequence it against the drain; `scheduleAutoPush`
// is the fire-and-forget wrapper used on the send path.
let AUTO_PUSH_IN_FLIGHT: Promise<{ pushed: number }> | null = null;

// The first cycle of a session sweeps the whole store (it may hold
// messages from a build that predates replication); every cycle after
// that only looks at what's newer than the last one, so the steady-state
// cost is an index lookup rather than a full decrypt pass.
let SWEPT_THIS_SESSION = false;
function copiedThroughKey(uid: string) { return `aegent.cloud-copied-through.${uid}`; }

export function replicateUnpushed(): Promise<{ pushed: number }> {
  if (!CURRENT) return Promise.resolve({ pushed: 0 });
  if (AUTO_PUSH_IN_FLIGHT) return AUTO_PUSH_IN_FLIGHT;
  const uid = CURRENT.user.id;
  AUTO_PUSH_IN_FLIGHT = (async () => {
    let newly = 0;
    try {
      const { everyMessage, outboundSince } = await import("./store.js");
      let through = 0;
      try { through = Number(localStorage.getItem(copiedThroughKey(uid)) ?? 0) || 0; }
      catch { /* ignore */ }
      const rows = SWEPT_THIS_SESSION
        ? await outboundSince(through)
        : await everyMessage();
      SWEPT_THIS_SESSION = true;
      const pushedSet = PUSHED_CACHE?.uid === uid ? PUSHED_CACHE.set : readPushedSet(uid);
      const todo = rows.filter((m) => m.senderId === uid && !m.deletedAt && !pushedSet.has(m.id));
      // Advance the watermark over everything we just considered, even
      // when nothing needed copying — the pushed set remains the
      // authority on what has actually landed.
      const highest = rows.reduce((max, m) => Math.max(max, m.createdAt), through);
      if (highest > through) {
        try { localStorage.setItem(copiedThroughKey(uid), String(highest)); } catch { /* ignore */ }
      }
      if (todo.length === 0) return { pushed: 0 };
      for (const m of todo) {
        const payload = selfCopyPayload(m);
        if (!payload) continue;
        try {
          const cipher = encryptForPeer(packPayload(payload), CURRENT!.publicKey, CURRENT!.privateKey);
          const res = await sendCipher(uid, cipher);
          if (res.ok) { pushedSet.add(m.id); newly++; }
        } catch { /* retry next cycle */ }
      }
      if (newly > 0) {
        writePushedSet(uid, pushedSet);
        console.log(`[replication] cloud-copied ${newly} local message${newly === 1 ? "" : "s"}`);
      }
    } finally { AUTO_PUSH_IN_FLIGHT = null; }
    return { pushed: newly };
  })();
  return AUTO_PUSH_IN_FLIGHT;
}

export function scheduleAutoPush(): void {
  void replicateUnpushed().catch(() => { /* the loop will retry */ });
}

// ---- outbox ----
//
// A send that can't reach the relay is queued, not lost. Flushed on
// boot and on every socket reconnect.
let FLUSH_IN_FLIGHT: Promise<{ sent: number; left: number }> | null = null;

export async function flushOutbox(): Promise<{ sent: number; left: number }> {
  if (!CURRENT) return { sent: 0, left: 0 };
  if (FLUSH_IN_FLIGHT) return FLUSH_IN_FLIGHT;
  FLUSH_IN_FLIGHT = (async () => {
    let sent = 0, left = 0;
    try {
      const rows = await listOutbox();
      for (const row of rows) {
        try {
          const payload = unpackPayload(row.packed);
          const res = await fanOut(row.peerId, row.isGroup, payload);
          if (res.ok) { await dequeueOutbox(row.id); sent++; }
          else { await bumpOutboxAttempt(row.id, res.error); left++; }
        } catch (e) {
          await bumpOutboxAttempt(row.id, (e as Error).message).catch(() => { /* ignore */ });
          left++;
        }
      }
      if (sent > 0) console.log(`[outbox] delivered ${sent} queued message${sent === 1 ? "" : "s"}`);
    } finally { FLUSH_IN_FLIGHT = null; }
    return { sent, left };
  })();
  return FLUSH_IN_FLIGHT;
}

// ---- diagnostics ----

const SYNC_DIAG_KEY = "aegent.sync.diag";
type SyncDiag = {
  lastPullAt?: number; lastPulled?: number; lastReason?: string;
  skipped?: Record<string, number>;
  lastPushedAt?: number; lastPushed?: number;
  serverTotal?: number; localTotal?: number; pending?: number;
  // Exact count of envelopes the relay holds that this device has no
  // record of, as of the last reconciliation.
  missing?: number;
};
function readDiag(): SyncDiag {
  try { return JSON.parse(localStorage.getItem(SYNC_DIAG_KEY) ?? "{}"); }
  catch { return {}; }
}
function writeDiag(patch: Partial<SyncDiag>): void {
  try {
    const cur = readDiag();
    localStorage.setItem(SYNC_DIAG_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch { /* ignore */ }
}
function bumpSkipCounter(reason: string): void {
  const d = readDiag();
  const skipped = { ...(d.skipped ?? {}) };
  skipped[reason] = (skipped[reason] ?? 0) + 1;
  writeDiag({ skipped });
}
export function readSyncDiag(): SyncDiag { return readDiag(); }

// ---- registration / login ----

export async function register(input: {
  email: string; phone?: string; displayName: string; password: string;
}): Promise<{ session: Session }> {
  await initCrypto();
  const id = generateIdentity();
  const salt = newKdfSalt();
  const wrapKey = await deriveKey(input.password, salt, "priv-wrap");
  // One wrapper at signup: the password. Signing in with it on any
  // device unwraps this exact key and the whole history decrypts. A
  // second wrapper (recovery code) is available in Settings for anyone
  // who wants a fallback, but it is never forced at signup.
  const wrappedPriv = secretBoxSeal(wrapKey, id.privateKey);

  const { user, token, refreshToken } = await api.register({
    email: input.email,
    phone: input.phone,
    displayName: input.displayName,
    password: input.password,
    publicKey: b64.encode(id.publicKey),
    wrappedPriv,
    kdfSalt: b64.encode(salt),
    deviceLabel: describeDevice(),
  });
  setToken(token);
  setRefreshToken(refreshToken);
  connectSocket(token);
  const storeKey = await openLocalStore(user.id, id.privateKey);

  const me = await api.me();
  CURRENT = { user: me, privateKey: id.privateKey, publicKey: id.publicKey };
  const bk = backupKeyFromPrivate(id.privateKey);
  persistKeys(id.privateKey, storeKey, bk);
  startReplication();
  return { session: CURRENT };
}

// Called after every successful send to keep the cloud backup fresh AND
// to replicate the message to the user's own inbox so other devices
// pull it. Throttled internally; safe to spam.
export function tickAutoBackup(): void {
  const bk = backupKey();
  const me = CURRENT?.user;
  if (!bk || !me) return;
  scheduleAutoBackup(bk, {
    id: me.id, email: me.email, handle: me.handle,
    displayName: me.displayName, publicKey: me.publicKey,
  });
  scheduleAutoPush();
}

// Re-exported so UI code has one import for "is my history safe".
export { onReplication, replicationState, replicationSummary } from "./replication.js";
export type { ReplicationPhase, ReplicationState } from "./replication.js";

export async function login(input: { email: string; password: string }): Promise<Session> {
  await initCrypto();
  const { token, refreshToken, wrappedPriv, kdfSalt } = await api.login({
    ...input, deviceLabel: describeDevice(),
  });
  const salt = b64.decode(kdfSalt);
  const [wrapKey, legacyStoreKey] = await Promise.all([
    deriveKey(input.password, salt, "priv-wrap"),
    // Only needed to convert a store sealed by an older build.
    deriveKey(input.password, salt, "local-store"),
  ]);
  const privateKey = secretBoxOpen(wrapKey, wrappedPriv);
  setToken(token);
  setRefreshToken(refreshToken);
  connectSocket(token);
  const me = await api.me();
  const storeKey = await openLocalStore(me.id, privateKey, legacyStoreKey);
  CURRENT = { user: me, privateKey, publicKey: b64.decode(me.publicKey) };
  // Backup key is deterministic from the private key, so a login on a
  // brand-new device gets the same key that produced any prior backup.
  const bk = backupKeyFromPrivate(privateKey);
  persistKeys(privateKey, storeKey, bk);
  attemptCloudRestore(bk, me.id, storeKey).catch(() => { /* silent */ });
  // Sign-in force-drains once: every sign-in rebuilds everything this
  // device doesn't yet have, old or new, rather than trusting a local
  // cursor. From here on the replication loop keeps it converged.
  fullResyncInbox()
    .catch((err) => console.warn("[login] force resync failed", err))
    .finally(() => startReplication());
  return CURRENT;
}

// Fetch the encrypted backup with the JWT from login, decrypt with the
// private-key-derived backup key, and merge anything missing into the
// local store. Idempotent.
async function attemptCloudRestore(bk: Uint8Array, userId: string, storeKey: Uint8Array): Promise<void> {
  const t = loadToken();
  if (!t) return;
  const r = await fetch(apiUrl("/api/backup"), {
    headers: { authorization: `Bearer ${t}` },
  });
  if (!r.ok) return; // 404 = no backup yet
  const ct = new Uint8Array(await r.arrayBuffer());
  try {
    const { openBackupCiphertext, rehydrateInto } = await import("./backup.js");
    const payload = openBackupCiphertext(bk, ct);
    await rehydrateInto(payload, { id: userId, storeKey });
  } catch (e) {
    console.warn("[session] cloud restore skipped:", (e as Error).message);
  }
}

// Silent session restore at boot.
export async function tryRestoreSession(): Promise<Session | null> {
  await initCrypto();
  const token = (typeof localStorage !== "undefined") && localStorage.getItem("aegent.token");
  const refresh = (typeof localStorage !== "undefined") && localStorage.getItem("aegent.refresh");
  const keys = loadPersistedKeys();
  if (!keys || (!token && !refresh)) return null;
  if (token) setToken(token);
  if (refresh) setRefreshToken(refresh);
  try {
    const me = await api.me(); // implicitly validates (and auto-refreshes)
    connectSocket(loadToken() ?? "");
    // The persisted store key may predate the private-key derivation;
    // pass it as the legacy key so rows get converted once.
    const storeKey = await openLocalStore(me.id, keys.privateKey, keys.storeKey);
    persistKeys(keys.privateKey, storeKey, keys.backupKey ?? backupKeyFromPrivate(keys.privateKey));
    CURRENT = {
      user: me,
      privateKey: keys.privateKey,
      publicKey: b64.decode(me.publicKey),
    };
    // The replication loop takes it from here: catch-up drain, outbox
    // flush, and cloud-copy of anything local, on a timer and on every
    // reconnect — no user action anywhere in that path.
    startReplication();
    return CURRENT;
  } catch {
    logout();
    return null;
  }
}

export function logout() {
  SWEPT_THIS_SESSION = false;
  stopReplication();
  disconnectSocket();
  closeStore();
  setToken(null);
  setRefreshToken(null);
  clearPersistedKeys();
  CURRENT = null;
}

// ---- key vault: recovery key, password change, password reset ----

// Mint (or re-mint) the recovery key for the signed-in account and
// upload the resulting wrapper. Returns the phrase so the UI can show
// it once; we never store it.
export async function issueRecoveryKey(): Promise<string> {
  if (!CURRENT) throw new Error("no_session");
  const recSalt = newKdfSalt();
  const { phrase, entropy } = newRecoveryPhrase();
  const recKey = await recoveryWrapKey(entropy, recSalt);
  await api.putRecovery({
    wrappedPrivRec: secretBoxSeal(recKey, CURRENT.privateKey),
    recSalt: b64.encode(recSalt),
  });
  return phrase;
}

// Change the password of the signed-in account. The private key is
// re-wrapped, not re-generated, and the local store key doesn't depend
// on the password at all — so nothing in the history moves.
export async function changePassword(input: {
  currentPassword: string; newPassword: string;
}): Promise<void> {
  if (!CURRENT) throw new Error("no_session");
  const salt = newKdfSalt();
  const wrapKey = await deriveKey(input.newPassword, salt, "priv-wrap");
  await api.changePassword({
    currentPassword: input.currentPassword,
    newPassword: input.newPassword,
    wrappedPriv: secretBoxSeal(wrapKey, CURRENT.privateKey),
    kdfSalt: b64.encode(salt),
  });
}

// Reset a forgotten password with the recovery key, then sign in.
//
// The server hands back the recovery wrapper plus a nonce boxed to the
// account's public key. We unwrap the private key with the recovery
// code, open the box to prove possession, and upload a fresh
// password-wrapper for that same private key. Every stored envelope
// stays readable, because the key that reads them never changed.
export async function resetPasswordWithRecoveryKey(input: {
  email: string; recoveryPhrase: string; newPassword: string;
}): Promise<Session> {
  await initCrypto();
  const entropy = entropyFromPhrase(input.recoveryPhrase);
  const ch = await api.recoveryChallenge(input.email);
  const recKey = await recoveryWrapKey(entropy, b64.decode(ch.recSalt));
  let privateKey: Uint8Array;
  try {
    privateKey = secretBoxOpen(recKey, ch.wrappedPrivRec);
  } catch {
    throw new Error("That recovery key doesn't match this account.");
  }
  // Prove we hold the private key by opening the server's box.
  const proof = decryptFromPeer(ch.boxed, b64.decode(ch.serverPublicKey), privateKey);

  const salt = newKdfSalt();
  const wrapKey = await deriveKey(input.newPassword, salt, "priv-wrap");
  const { user, token, refreshToken } = await api.resetPassword({
    challengeId: ch.challengeId,
    proof,
    newPassword: input.newPassword,
    wrappedPriv: secretBoxSeal(wrapKey, privateKey),
    kdfSalt: b64.encode(salt),
    deviceLabel: describeDevice(),
  });

  setToken(token);
  setRefreshToken(refreshToken);
  connectSocket(token);
  const me = await api.me();
  const storeKey = await openLocalStore(me.id, privateKey);
  CURRENT = { user: me, privateKey, publicKey: b64.decode(me.publicKey) };
  const bk = backupKeyFromPrivate(privateKey);
  persistKeys(privateKey, storeKey, bk);
  attemptCloudRestore(bk, me.id, storeKey).catch(() => { /* silent */ });
  fullResyncInbox()
    .catch((err) => console.warn("[reset] force resync failed", err))
    .finally(() => startReplication());
  void user;
  return CURRENT;
}

// ---- device label ----

function describeDevice(): string {
  try {
    const ua = navigator.userAgent;
    const isAndroid = /Android/i.test(ua);
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isMac = /Macintosh/i.test(ua);
    const isWin = /Windows/i.test(ua);
    const isLinux = /Linux/i.test(ua) && !isAndroid;
    const platform = isAndroid ? "Android" : isIOS ? "iOS"
      : isMac ? "macOS" : isWin ? "Windows" : isLinux ? "Linux" : "Unknown";
    const browser = /Firefox\//.test(ua) ? "Firefox"
      : /Edg\//.test(ua) ? "Edge"
      : /Chrome\//.test(ua) ? "Chrome"
      : /Safari\//.test(ua) ? "Safari" : "Browser";
    return `${platform} · ${browser}`;
  } catch { return "Unknown device"; }
}

export async function refreshMe() {
  if (!CURRENT) return;
  CURRENT.user = await api.me();
}

// ---- send / receive ----

// Fan out one payload: an envelope per recipient, plus a self-copy so
// the relay holds the sender's history too. For 1:1 that's two
// envelopes; for a group it's one per member (self included).
async function fanOut(
  targetPeerId: string,
  isGroup: boolean,
  payload: Payload,
): Promise<{ ok: true; envelopeId: string } | { ok: false; error: string }> {
  if (!CURRENT) return { ok: false, error: "no_session" };
  const selfId = CURRENT.user.id;

  // `_thread` lets a self-copy file itself under the right chat on
  // arrival — recipient_id is self, so there's no routing info
  // otherwise. Third-party recipients ignore it.
  const withThread: Payload = { ...payload, _thread: targetPeerId } as Payload;
  const packed = packPayload(withThread);

  let recipients: string[] = [];
  if (isGroup) {
    const g = await getGroup(targetPeerId);
    if (!g) return { ok: false, error: "unknown_group" };
    recipients = Array.from(new Set([...g.memberIds, selfId]));
  } else {
    recipients = Array.from(new Set([targetPeerId, selfId]));
  }
  if (recipients.length === 0) return { ok: false, error: "no_recipients" };

  const selfPubKey = CURRENT.publicKey;
  let firstEnvelopeId: string | undefined;
  let selfCopyLanded = false;
  for (const rid of recipients) {
    let peerPubKey: Uint8Array | null = null;
    if (rid === selfId) {
      peerPubKey = selfPubKey;
    } else {
      const peer = await getContact(rid) ?? await ensureContact(rid);
      if (!peer) continue;
      peerPubKey = b64.decode(peer.publicKey);
    }
    const cipher = encryptForPeer(packed, peerPubKey, CURRENT.privateKey);
    const res = await sendCipher(rid, cipher, isGroup ? targetPeerId : undefined);
    if (!res.ok) return { ok: false, error: res.error };
    if (rid === selfId) selfCopyLanded = true;
    firstEnvelopeId = firstEnvelopeId ?? res.envelope.id;
  }
  // The self-copy is this message's cloud durability; record it so the
  // background replicator doesn't upload a second one.
  const msgId = (payload as { msgId?: string }).msgId;
  if (selfCopyLanded && msgId) markPushed(selfId, msgId);
  return { ok: true, envelopeId: firstEnvelopeId ?? "" };
}

// Kept as the public name used by the agent tools.
export const sendToPeer = fanOut;

// Try to deliver; queue on failure. The caller's message is already in
// the local store by this point, so "offline" costs a delay, never the
// content.
async function deliverOrQueue(
  targetPeerId: string, isGroup: boolean, payload: Payload,
): Promise<{ ok: true; queued: boolean } | { ok: false; error: string }> {
  const res = await fanOut(targetPeerId, isGroup, payload).catch(
    (e): { ok: false; error: string } => ({ ok: false, error: (e as Error).message }),
  );
  if (res.ok) return { ok: true, queued: false };
  // Unrecoverable addressing problems shouldn't sit in a queue forever.
  if (res.error === "no_session" || res.error === "unknown_group" || res.error === "no_recipients") {
    return { ok: false, error: res.error };
  }
  const msgId = (payload as { msgId?: string }).msgId ?? newMsgId();
  await enqueueOutbox({
    id: msgId,
    peerId: targetPeerId,
    isGroup,
    packed: packPayload({ ...payload, _thread: targetPeerId } as Payload),
  });
  console.log(`[outbox] queued ${msgId} (${res.error})`);
  return { ok: true, queued: true };
}

// High-level: persist + fan-out for a text message. Persisting FIRST is
// deliberate — a send that fails must never take the user's words with
// it.
export async function sendText(
  targetPeerId: string, isGroup: boolean, body: string,
  replyTo?: { id: string; preview: string; author: string },
): Promise<{ ok: true; queued?: boolean } | { ok: false; error: string }> {
  if (!CURRENT) return { ok: false, error: "no_session" };
  const payload: Payload = {
    v: 1, t: "text", msgId: newMsgId(), body,
    replyTo: replyTo && { id: replyTo.id, preview: replyTo.preview, author: replyTo.author },
  };
  await saveTextMessage({
    id: payload.msgId,
    peerId: targetPeerId,
    senderId: CURRENT.user.id,
    direction: "out",
    createdAt: Date.now(),
    body,
    replyTo,
  });
  const res = await deliverOrQueue(targetPeerId, isGroup, payload);
  if (!res.ok) return res;
  tickAutoBackup();
  return { ok: true, queued: res.queued };
}

export async function sendMedia(
  targetPeerId: string, isGroup: boolean, media: MediaRef, caption?: string,
  replyTo?: { id: string; preview: string; author: string },
): Promise<{ ok: true; queued?: boolean } | { ok: false; error: string }> {
  if (!CURRENT) return { ok: false, error: "no_session" };
  const payload: Payload = {
    v: 1, t: "media", msgId: newMsgId(), caption, media,
    replyTo: replyTo && { id: replyTo.id, preview: replyTo.preview, author: replyTo.author },
  };
  await saveMediaMessage({
    id: payload.msgId,
    peerId: targetPeerId,
    senderId: CURRENT.user.id,
    direction: "out",
    createdAt: Date.now(),
    caption, media, replyTo,
  });
  const res = await deliverOrQueue(targetPeerId, isGroup, payload);
  if (!res.ok) return res;
  tickAutoBackup();
  return { ok: true, queued: res.queued };
}

export async function sendReaction(
  targetPeerId: string, isGroup: boolean, targetMsgId: string, emoji: string,
) {
  const payload: Payload = { v: 1, t: "reaction", msgId: newMsgId(), targetId: targetMsgId, emoji };
  await applyReaction(targetMsgId, CURRENT!.user.id, emoji);
  await deliverOrQueue(targetPeerId, isGroup, payload);
}

export async function sendEdit(
  targetPeerId: string, isGroup: boolean, targetMsgId: string, body: string,
) {
  const payload: Payload = { v: 1, t: "edit", msgId: newMsgId(), targetId: targetMsgId, body };
  await applyEdit(targetMsgId, body);
  await deliverOrQueue(targetPeerId, isGroup, payload);
}

export async function sendDelete(targetPeerId: string, isGroup: boolean, targetMsgId: string) {
  const payload: Payload = { v: 1, t: "delete", msgId: newMsgId(), targetId: targetMsgId };
  await applyDelete(targetMsgId, CURRENT!.user.id);
  await deliverOrQueue(targetPeerId, isGroup, payload);
}

// ---- receive path ----

// Decode one envelope into the local store. Returns the resolved thread
// so the UI can bump it. Every outcome is recorded in the ledger:
// success means we never process it again, failure means we will.
export async function ingestEnvelope(envIn: {
  id: string; senderId: string; recipientId: string; groupId: string | null;
  ciphertext: string; createdAt: number;
}, opts: { ack?: boolean } = {}): Promise<{ threadId: string; msgId: string } | null> {
  if (!CURRENT) return null;
  // `createdAt` becomes an IndexedDB key, and a relay on Postgres used
  // to send it as a string — which stores fine and then sorts outside
  // every numeric range query, i.e. the message exists but never
  // renders. Normalise at the boundary regardless of relay version.
  const env = { ...envIn, createdAt: Number(envIn.createdAt) || 0 };
  const ack = opts.ack !== false;
  const selfId = CURRENT.user.id;
  const isSelfEcho = env.senderId === selfId;

  // For a self-echo we decrypt with (self-pub, self-priv). For normal
  // inbound we need the sender's public key.
  let peerPubKey: Uint8Array;
  if (isSelfEcho) {
    peerPubKey = CURRENT.publicKey;
  } else {
    // Retry: a single network hiccup during a fresh-device drain used
    // to silently drop that sender's entire history.
    let sender: Awaited<ReturnType<typeof ensureContact>> = null;
    for (let attempt = 0; attempt < 3 && !sender; attempt++) {
      sender = await ensureContact(env.senderId);
      if (!sender && attempt < 2) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
    if (!sender) {
      // NOT dropped: parked in the ledger with its ciphertext so the
      // next drain retries it.
      console.warn("[ingest] contact lookup failed", env.id, "sender:", env.senderId);
      bumpSkipCounter("contact_lookup");
      await ledgerMarkPending(env, "contact_lookup").catch(() => { /* ignore */ });
      return null;
    }
    peerPubKey = b64.decode(sender.publicKey);
  }

  let packed: string;
  try {
    packed = decryptFromPeer(env.ciphertext, peerPubKey, CURRENT.privateKey);
  } catch (e) {
    // A decrypt failure won't fix itself by retrying with the same key,
    // but it might after a key-material repair, so keep the ciphertext
    // and mark it pending rather than acking it into oblivion.
    console.warn("[ingest] decrypt failed", env.id, (e as Error).message);
    bumpSkipCounter("decrypt");
    await ledgerMarkPending(env, "decrypt").catch(() => { /* ignore */ });
    return null;
  }

  let payload: Payload;
  try { payload = unpackPayload(packed); }
  catch (e) {
    bumpSkipCounter("payload");
    await ledgerMarkPending(env, `payload:${(e as Error).message}`).catch(() => { /* ignore */ });
    return null;
  }

  // Thread id: a self-echo is addressed to us, so server routing can't
  // tell us which chat it belongs to — the sender stamped `_thread`.
  const threadId = isSelfEcho
    ? (payload._thread ?? env.groupId ?? env.recipientId)
    : (env.groupId ?? env.senderId);
  const direction: "in" | "out" = isSelfEcho ? "out" : "in";

  // Make sure the thread has a metadata row. Without this, a new device
  // that drains its own sent copies for a chat has the messages but no
  // contact — and the chat list, which is built from contacts, showed
  // nothing at all. This is the bug behind "new device, empty inbox".
  await ensureThreadEntity(threadId, !!env.groupId);

  if (payload.t === "text") {
    await saveTextMessage({
      id: payload.msgId,
      peerId: threadId,
      senderId: env.senderId,
      direction,
      createdAt: env.createdAt,
      body: payload.body,
      replyTo: payload.replyTo ?? null,
    });
  } else if (payload.t === "media") {
    await saveMediaMessage({
      id: payload.msgId,
      peerId: threadId,
      senderId: env.senderId,
      direction,
      createdAt: env.createdAt,
      caption: payload.caption,
      media: payload.media,
      replyTo: payload.replyTo ?? null,
    });
  } else if (payload.t === "reaction") {
    await applyReaction(payload.targetId, env.senderId, payload.emoji);
  } else if (payload.t === "edit") {
    await applyEdit(payload.targetId, payload.body);
  } else if (payload.t === "delete") {
    // The envelope's sender is the authority here — not the payload,
    // which anyone could have written.
    await applyDelete(payload.targetId, env.senderId);
  }

  // A self-echo IS the cloud copy of one of our own sends; remember that
  // so the replicator on this device doesn't upload a duplicate.
  if (isSelfEcho) markPushed(selfId, payload.msgId);

  await ledgerMarkOk(env.id, env.createdAt).catch(() => { /* ignore */ });
  if (ack) await api.ack([env.id]).catch(() => { /* best-effort */ });
  await markDelivered(env.id).catch(() => { /* ignore */ });
  return { threadId, msgId: payload.msgId };
}

// Resolve metadata for a thread id, trying the contact directory first
// and groups second (or the other way around when we have a hint).
// Failure is tolerated: listThreads() lists message-bearing threads even
// without metadata, so history is visible either way.
async function ensureThreadEntity(threadId: string, groupHint: boolean): Promise<void> {
  if (!CURRENT || threadId === CURRENT.user.id) return;
  try {
    if (await getContact(threadId)) return;
    if (await getGroup(threadId)) return;
    if (groupHint) {
      if (await ensureGroup(threadId)) return;
      await ensureContact(threadId);
    } else {
      if (await ensureContact(threadId)) return;
      await ensureGroup(threadId);
    }
  } catch { /* metadata is a nicety; messages are the point */ }
}

export async function ensureContact(id: string): Promise<{ id: string; publicKey: string; displayName: string } | null> {
  const existing = await getContact(id);
  if (existing) return existing;
  try {
    const u = await api.byId(id);
    await upsertContact({
      id: u.id, email: u.email, phone: u.phone ?? null, handle: u.handle,
      displayName: u.displayName, publicKey: u.publicKey,
      lastSeenAt: Date.now(),
      online: u.presence?.online,
    });
    return { id: u.id, publicKey: u.publicKey, displayName: u.displayName };
  } catch { return null; }
}

export async function ensureGroup(id: string) {
  const existing = await getGroup(id);
  if (existing) return existing;
  try {
    const g = await api.getGroup(id);
    for (const mid of g.memberIds) await ensureContact(mid);
    const row = {
      id: g.id, name: g.name, memberIds: g.memberIds,
      createdBy: g.created_by, createdAt: g.created_at,
      lastSeenAt: g.created_at,
    };
    await upsertGroup(row);
    return row;
  } catch { return null; }
}

// ---- external helpers ----
export function myId(): string { return CURRENT!.user.id; }

// Mark reads and notify the server if read receipts are enabled.
export async function reportRead(envelopeIds: string[]) {
  if (envelopeIds.length === 0) return;
  for (const id of envelopeIds) await markRead(id);
  if (CURRENT?.user.settings.readReceipts) {
    try { await api.markRead(envelopeIds); } catch { /* best-effort */ }
  }
}

// Consumed so tree-shaking keeps the type import honest.
export type { PublicUser };
