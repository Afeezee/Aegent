// Local, encrypted-at-rest client store.
//
// IndexedDB (via Dexie) is the on-device home for everything Aegent
// needs to reason about locally: contacts, groups, messages, media
// references, reactions, and reminders. Every message row's `body`
// and `caption` sits on disk as ciphertext (`body_ct`, `caption_ct`)
// wrapped by an in-memory key derived from the user's password with
// the "local-store" KDF context. The key never touches disk. Closing
// the tab tears it down; unlock requires re-entering the password.
//
// Reads decrypt on demand. Every persisted view (thread, search, agent
// tools) uses `openMessage()` which handles the unwrap so callers see
// plain fields.

import Dexie, { type Table } from "dexie";
import { secretBoxOpen, secretBoxSeal } from "./crypto.js";
import { embed, tokenize } from "./embeddings.js";

// ---- schema ----

export type ContactRow = {
  id: string;
  email: string;
  phone: string | null;
  handle: string;
  displayName: string;
  publicKey: string;
  lastSeenAt: number;
  online?: boolean;
};

export type GroupRow = {
  id: string;
  name: string;
  memberIds: string[];
  createdAt: number;
  createdBy: string;
  lastSeenAt: number;
};

export type MediaRef = {
  kind: "image" | "video" | "audio" | "voice" | "file";
  blobId: string;
  mime: string;
  byteSize: number;
  durationMs?: number;
  width?: number;
  height?: number;
  filename?: string;
  contentKey: string; // base64
  // Locally-produced Whisper transcript (voice notes only). Rides
  // along inside the E2E-encrypted payload — server never sees it.
  // Receivers get it without having to run Whisper themselves.
  transcript?: string;
};

export type StoredMessage = {
  // Message-level identity — the client-generated id (same across all
  // per-recipient envelopes for one send).
  id: string;
  // For 1:1 this is the peer id. For groups this is the group id (so
  // `peerId` uniformly names the *thread*).
  peerId: string;
  direction: "in" | "out";
  senderId: string; // needed for groups (who wrote it)
  createdAt: number;

  // Encrypted-at-rest content. `body_ct` may be null for pure media.
  body_ct: string | null;
  caption_ct: string | null;
  media: MediaRef | null;

  replyTo: { id: string; preview: string; author: string } | null;
  editedBody_ct: string | null;   // if set, replaces body_ct on display
  deletedAt: number | null;       // if set, render as tombstone
  reactions: Record<string, string[]>; // emoji → [userId, ...]

  // Delivery/read state (tracked locally for the sender's UI).
  deliveredAt: number | null;
  readAt: number | null;

  // Search index (unencrypted; the whole DB is protected by the OS
  // account, and search would be useless if we couldn't index).
  tokens: string;
  embedding: number[];
};

export type ReminderRow = { id: string; text: string; whenIso: string; createdAt: number };

// ---- envelope ledger ----
//
// One row per envelope the server has ever handed us, successful or
// not. This is the backbone of the availability guarantee:
//
//   * exact dedupe — an envelope is ingested at most once, so a drain
//     can safely overlap, repeat, or restart;
//   * durable retry — an envelope that failed to ingest (sender's key
//     not resolvable yet, decrypt error, store write interrupted)
//     keeps its ciphertext here and is retried on every later drain
//     instead of being silently skipped forever;
//   * an exact local count to compare against the server's, which is
//     what lets the client notice it is missing history at all.
//
// Keeping `raw` costs nothing in privacy terms: it is the same opaque
// ciphertext the relay already stores, and it is dropped the moment the
// envelope ingests cleanly.
export type EnvelopeLedgerRow = {
  id: string;                      // server envelope id
  createdAt: number;               // server timestamp (cursor ordering)
  status: "ok" | "pending";
  reason: string | null;           // why it is still pending
  attempts: number;
  raw: {
    id: string; senderId: string; recipientId: string;
    groupId: string | null; ciphertext: string; createdAt: number;
  } | null;
};

// ---- outbox ----
//
// A send that cannot reach the relay (offline, socket still handshaking,
// server restarting) used to surface as a toast and vanish — the user's
// typed message was gone. Now it lands here first and is flushed on
// every reconnect, so composing while offline is lossless. The packed
// payload is sealed with the local-store key, so a queued message is no
// more exposed at rest than a delivered one.
export type OutboxRow = {
  id: string;            // msgId — stable, so dedupe works end to end
  peerId: string;
  isGroup: boolean;
  packed_ct: string;     // sealed packPayload() output
  createdAt: number;
  attempts: number;
  lastError: string | null;
};

export type ScheduledBackup = {
  id: string;
  peerId: string;         // thread to back up (contact id or group id)
  peerLabel: string;      // cached at scheduling time for the reminder text
  recipientEmail: string;
  whenIso: string;
  createdAt: number;
  note?: string;
};

// One turn of the on-device agent conversation. Kept per-user in the
// same encrypted-at-rest Dexie so refreshing / closing the app doesn't
// lose the history. Confirm cards aren't persisted — replaying them
// would be misleading; we only persist the you/thought/reply/error
// slices plus a hint that a card was shown.
export type AgentTurnRow = {
  id: string;
  createdAt: number;
  kind: "you" | "thought" | "reply" | "error" | "confirm_placeholder";
  text: string;
};

class AegentDB extends Dexie {
  contacts!: Table<ContactRow, string>;
  groups!: Table<GroupRow, string>;
  messages!: Table<StoredMessage, string>;
  reminders!: Table<ReminderRow, string>;
  scheduledBackups!: Table<ScheduledBackup, string>;
  agentTurns!: Table<AgentTurnRow, string>;
  envelopes!: Table<EnvelopeLedgerRow, string>;
  outbox!: Table<OutboxRow, string>;
  meta!: Table<{ k: string; v: string }, string>;

  constructor(userId: string) {
    super(`aegent-${userId}`);
    this.version(1).stores({
      contacts: "id, email, handle, displayName, lastSeenAt",
      groups: "id, name, lastSeenAt",
      messages: "id, peerId, direction, createdAt, [peerId+createdAt]",
      reminders: "id, whenIso, createdAt",
      meta: "k",
    });
    // v2: add scheduledBackups table. Dexie's schema migration is
    // additive — existing stores are preserved.
    this.version(2).stores({
      contacts: "id, email, phone, handle, displayName, lastSeenAt",
      scheduledBackups: "id, whenIso, peerId",
    });
    // v3: agent conversation history — per-user Dexie means each
    // account keeps its own transcript, no cross-account leakage.
    this.version(3).stores({
      agentTurns: "id, createdAt",
    });
    // v4: the envelope ledger and the outbox — see the type comments
    // above. Both are additive, so existing stores migrate untouched.
    this.version(4).stores({
      envelopes: "id, status, createdAt",
      outbox: "id, createdAt",
    });
  }
}

let LOCAL_STORE_KEY: Uint8Array | null = null;
let DB: AegentDB | null = null;

export function openStore(userId: string, key: Uint8Array) {
  LOCAL_STORE_KEY = key;
  DB = new AegentDB(userId);
  return DB;
}
export function closeStore() {
  LOCAL_STORE_KEY = null;
  DB?.close();
  DB = null;
}
function requireDb(): AegentDB {
  if (!DB || !LOCAL_STORE_KEY) throw new Error("store_not_open");
  return DB;
}

// ---- contacts ----

export async function upsertContact(c: ContactRow) {
  await requireDb().contacts.put(c);
}
export async function listContacts(): Promise<ContactRow[]> {
  return (await requireDb().contacts.toArray())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}
export async function getContact(id: string): Promise<ContactRow | undefined> {
  return requireDb().contacts.get(id);
}
export async function setContactPresence(id: string, online: boolean, at: number) {
  await requireDb().contacts.where("id").equals(id).modify({ online, lastSeenAt: at });
}

// ---- groups ----

export async function upsertGroup(g: GroupRow) {
  await requireDb().groups.put(g);
}
export async function listGroups(): Promise<GroupRow[]> {
  return (await requireDb().groups.toArray())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}
export async function getGroup(id: string): Promise<GroupRow | undefined> {
  return requireDb().groups.get(id);
}

// ---- thread listing (all conversations, direct + group) ----

export type Thread = {
  peerId: string;
  isGroup: boolean;
  title: string;
  subtitle: string;   // preview of last message, decrypted
  updatedAt: number;
  unread: number;
  online?: boolean;
  memberIds?: string[];
};

// Threads used to be enumerated purely from the contacts and groups
// tables, which meant a conversation whose metadata we did not happen
// to hold was invisible even with every one of its messages sitting in
// the store. That is exactly what a new device hits: it drains its own
// sent copies for a chat, has no contact row for the peer yet, and
// shows an empty inbox. Thread discovery is therefore driven by the
// messages themselves, with contacts/groups supplying names on top.
export async function listThreads(): Promise<Thread[]> {
  const contacts = await listContacts();
  const groups = await listGroups();
  const threads: Thread[] = [];
  const named = new Set<string>([...contacts.map((c) => c.id), ...groups.map((g) => g.id)]);

  for (const c of contacts) {
    const last = await lastMessageIn(c.id);
    threads.push({
      peerId: c.id,
      isGroup: false,
      title: c.displayName,
      subtitle: last ? previewOf(last) : "New conversation — say hello",
      updatedAt: last?.createdAt ?? c.lastSeenAt,
      unread: await unreadCount(c.id),
      online: c.online,
    });
  }
  for (const g of groups) {
    const last = await lastMessageIn(g.id);
    threads.push({
      peerId: g.id,
      isGroup: true,
      title: g.name,
      subtitle: last ? previewOf(last, { includeSender: true }) : "New group — start the conversation",
      updatedAt: last?.createdAt ?? g.lastSeenAt,
      unread: await unreadCount(g.id),
      memberIds: g.memberIds,
    });
  }
  // Safety net: any thread with messages but no metadata row still gets
  // listed, so history is never hidden behind a missing contact. The
  // name fills itself in as soon as the directory lookup succeeds.
  for (const id of await distinctThreadIds()) {
    if (named.has(id)) continue;
    const last = await lastMessageIn(id);
    if (!last) continue;
    threads.push({
      peerId: id,
      isGroup: false,
      title: "Recovered chat",
      subtitle: previewOf(last),
      updatedAt: last.createdAt,
      unread: await unreadCount(id),
    });
  }
  return threads.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function lastMessageIn(peerId: string): Promise<OpenedMessage | undefined> {
  const rows = await requireDb().messages
    .where("[peerId+createdAt]")
    .between([peerId, 0], [peerId, Date.now() + 1])
    .reverse()
    .limit(1)
    .toArray();
  const raw = rows[0];
  return raw ? openMessage(raw) : undefined;
}

async function unreadCount(peerId: string): Promise<number> {
  return requireDb().messages
    .where("peerId").equals(peerId)
    .and((m) => m.direction === "in" && m.readAt === null && m.deletedAt === null)
    .count();
}

// ---- messages ----

export type OpenedMessage = Omit<StoredMessage, "body_ct" | "caption_ct" | "editedBody_ct"> & {
  body: string | null;
  caption: string | null;
  editedBody: string | null;
};

export function openMessage(m: StoredMessage): OpenedMessage {
  const key = LOCAL_STORE_KEY!;
  const dec = (ct: string | null): string | null => {
    if (!ct) return null;
    try { return new TextDecoder().decode(secretBoxOpen(key, ct)); }
    catch { return "<corrupt>"; }
  };
  return {
    ...m,
    body: dec(m.body_ct),
    caption: dec(m.caption_ct),
    editedBody: dec(m.editedBody_ct),
  };
}

export async function saveTextMessage(input: {
  id: string;
  peerId: string;
  senderId: string;
  direction: "in" | "out";
  createdAt: number;
  body: string;
  replyTo?: { id: string; preview: string; author: string } | null;
}): Promise<OpenedMessage> {
  const stored = mkStored({
    ...input,
    body_ct: sealText(input.body),
    caption_ct: null,
    media: null,
  });
  stored.tokens = tokenize(input.body).join(" ");
  stored.embedding = embed(input.body);
  await requireDb().messages.put(stored);
  await bumpThread(input.peerId, input.createdAt);
  return openMessage(stored);
}

export async function saveMediaMessage(input: {
  id: string;
  peerId: string;
  senderId: string;
  direction: "in" | "out";
  createdAt: number;
  caption?: string;
  media: MediaRef;
  replyTo?: { id: string; preview: string; author: string } | null;
}): Promise<OpenedMessage> {
  const stored = mkStored({
    ...input,
    body_ct: null,
    caption_ct: input.caption ? sealText(input.caption) : null,
    media: input.media,
  });
  // Voice-note transcripts (Whisper-produced, ride along in the E2E
  // payload) contribute to the search index too, so "find that voice
  // note about the invoice" resolves via `search_messages`.
  const searchText = [
    input.caption ?? "",
    input.media.filename ?? "",
    input.media.kind,
    input.media.transcript ?? "",
  ].join(" ");
  stored.tokens = tokenize(searchText).join(" ");
  stored.embedding = embed(searchText);
  await requireDb().messages.put(stored);
  await bumpThread(input.peerId, input.createdAt);
  return openMessage(stored);
}

// Merge a patch into a message's media ref. Used by voice-note
// transcription (stores the transcript on the message so it survives
// re-open and appears under the waveform). Also re-indexes the
// message's search tokens so a `search_messages` hit can find voice
// notes by their transcript.
export async function updateMessageMedia(
  msgId: string,
  patch: Partial<MediaRef>,
): Promise<OpenedMessage | null> {
  const row = await requireDb().messages.get(msgId);
  if (!row || !row.media) return null;
  const nextMedia: MediaRef = { ...row.media, ...patch };
  // Rebuild the search index text to include the transcript.
  const opened = openMessage(row);
  const searchText = [
    opened.caption ?? "",
    nextMedia.filename ?? "",
    nextMedia.kind,
    nextMedia.transcript ?? "",
  ].filter(Boolean).join(" ");
  await requireDb().messages.update(msgId, {
    media: nextMedia,
    tokens: tokenize(searchText).join(" "),
    embedding: embed(searchText),
  });
  const fresh = await requireDb().messages.get(msgId);
  return fresh ? openMessage(fresh) : null;
}

// Reactions arrive as tiny E2E messages; we merge them into the target.
export async function applyReaction(targetId: string, userId: string, emoji: string) {
  const target = await requireDb().messages.get(targetId);
  if (!target) return;
  const map = target.reactions || {};
  const users = new Set(map[emoji] ?? []);
  if (users.has(userId)) users.delete(userId); else users.add(userId);
  const next: Record<string, string[]> = { ...map };
  if (users.size === 0) delete next[emoji];
  else next[emoji] = Array.from(users);
  await requireDb().messages.update(targetId, { reactions: next });
}

export async function applyEdit(targetId: string, newBody: string) {
  const target = await requireDb().messages.get(targetId);
  if (!target) return;
  await requireDb().messages.update(targetId, { editedBody_ct: sealText(newBody) });
}

// May `by` tombstone this message?
//
// Only its author. A `delete` payload used to be honoured on the sender's
// bare assertion, with no check at all, so anyone who knew a message id
// could erase it on your device — not only in groups, where every member
// sees every id, but in 1:1 chats, including messages you sent yourself.
//
// Kept as a pure function so the rule is testable without a database,
// and so there is exactly one place to change when group admins gain the
// right to remove other people's messages. That will NOT arrive as a
// payload: with no signing keys, a recipient cannot verify a claim of
// adminship, so it has to come as a server-attested group event.
export function mayDelete(target: { senderId: string }, by: string): boolean {
  return target.senderId === by;
}

export async function applyDelete(targetId: string, by: string) {
  const target = await requireDb().messages.get(targetId);
  if (!target) return;
  if (!mayDelete(target, by)) {
    console.warn("[store] refused delete of", targetId, "requested by", by);
    return;
  }
  await requireDb().messages.update(targetId, {
    deletedAt: Date.now(),
    body_ct: null,
    caption_ct: null,
    editedBody_ct: null,
  });
}

export async function markThreadRead(peerId: string): Promise<string[]> {
  const now = Date.now();
  const toMark: string[] = [];
  await requireDb().messages
    .where("peerId").equals(peerId)
    .and((m) => m.direction === "in" && m.readAt === null)
    .modify((m) => { m.readAt = now; toMark.push(m.id); });
  return toMark;
}

export async function markDelivered(id: string, at = Date.now()) {
  await requireDb().messages.update(id, { deliveredAt: at });
}
export async function markRead(id: string, at = Date.now()) {
  await requireDb().messages.update(id, { readAt: at });
}

// ---- thread reads ----

export async function threadWith(peerId: string, limit = 500): Promise<OpenedMessage[]> {
  // Return the NEWEST `limit` messages (oldest-first in the result).
  // The old impl returned the oldest N via .limit() on an ascending
  // index — that silently lost history for threads above the cap.
  const rows = await requireDb().messages
    .where("[peerId+createdAt]")
    .between([peerId, 0], [peerId, Date.now() + 1])
    .reverse()
    .limit(limit)
    .toArray();
  return rows.reverse().map(openMessage);
}

// Pagination for the chat view: load `limit` messages strictly older
// than `beforeCreatedAt`. Used when the user scrolls near the top of
// the stream. Returns oldest-first so the caller can prepend.
export async function threadBefore(
  peerId: string, beforeCreatedAt: number, limit = 200,
): Promise<OpenedMessage[]> {
  const rows = await requireDb().messages
    .where("[peerId+createdAt]")
    .between([peerId, 0], [peerId, beforeCreatedAt], true, false)
    .reverse()
    .limit(limit)
    .toArray();
  return rows.reverse().map(openMessage);
}

export async function threadMessageCount(peerId: string): Promise<number> {
  return requireDb().messages
    .where("[peerId+createdAt]")
    .between([peerId, 0], [peerId, Date.now() + 1])
    .count();
}

// Outbound messages newer than a watermark.
//
// The replication loop runs every few seconds, and asking it to decrypt
// the entire store each time to find un-replicated messages would make
// a long history cost real battery. `createdAt` is indexed, so in the
// steady state this touches a handful of rows and decrypts only those.
export async function outboundSince(afterCreatedAt: number): Promise<OpenedMessage[]> {
  const rows = await requireDb().messages
    .where("createdAt").above(afterCreatedAt)
    .and((m) => m.direction === "out" && m.deletedAt === null)
    .toArray();
  return rows.map(openMessage);
}

export async function everyMessage(): Promise<OpenedMessage[]> {
  const rows = await requireDb().messages.toArray();
  return rows.map(openMessage);
}

// ---- reminders (local-only for the prototype) ----

export async function saveReminder(text: string, whenIso: string) {
  await requireDb().reminders.put({
    id: crypto.randomUUID(),
    text, whenIso, createdAt: Date.now(),
  });
}
export async function listReminders(): Promise<ReminderRow[]> {
  return (await requireDb().reminders.toArray())
    .sort((a, b) => a.whenIso.localeCompare(b.whenIso));
}
export async function deleteReminder(id: string) {
  await requireDb().reminders.delete(id);
}

// ---- agent conversation history ----

export async function appendAgentTurn(row: Omit<AgentTurnRow, "id" | "createdAt">): Promise<AgentTurnRow> {
  const stored: AgentTurnRow = { ...row, id: crypto.randomUUID(), createdAt: Date.now() };
  await requireDb().agentTurns.put(stored);
  return stored;
}
export async function listAgentTurns(limit = 400): Promise<AgentTurnRow[]> {
  const rows = await requireDb().agentTurns
    .orderBy("createdAt")
    .reverse()
    .limit(limit)
    .toArray();
  return rows.reverse(); // oldest → newest for display
}
export async function clearAgentTurns(): Promise<void> {
  await requireDb().agentTurns.clear();
}

// ---- scheduled backups ----
// A scheduled backup is a pending export that fires at whenIso. The
// UI probes for due backups on load and surfaces each as a confirm
// card (never sends silently — same rule as every other write).

export async function addScheduledBackup(b: Omit<ScheduledBackup, "id" | "createdAt">) {
  await requireDb().scheduledBackups.put({
    ...b,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  });
}
export async function listScheduledBackups(): Promise<ScheduledBackup[]> {
  return (await requireDb().scheduledBackups.toArray())
    .sort((a, b) => a.whenIso.localeCompare(b.whenIso));
}
export async function takeDueScheduledBackups(now = Date.now()): Promise<ScheduledBackup[]> {
  const all = await listScheduledBackups();
  const due = all.filter((b) => Date.parse(b.whenIso) <= now);
  // Consumed once they surface — the confirm card is the user's chance to act.
  if (due.length) {
    await requireDb().scheduledBackups.bulkDelete(due.map((b) => b.id));
  }
  return due;
}
export async function deleteScheduledBackup(id: string) {
  await requireDb().scheduledBackups.delete(id);
}

// ---- meta (small key/value bookkeeping) ----

export async function getMeta(k: string): Promise<string | null> {
  const row = await requireDb().meta.get(k);
  return row?.v ?? null;
}
export async function setMeta(k: string, v: string): Promise<void> {
  await requireDb().meta.put({ k, v });
}

// ---- timestamp repair ----
//
// A relay running on Postgres used to serve BIGINT timestamps as
// strings (see server/src/db.ts), and those strings were written
// straight into these rows. `createdAt` is an IndexedDB key, and key
// ordering places every string after every number, so a row with a
// string timestamp falls outside the thread view's numeric range query:
// present in the store, counted by every total, and invisible on
// screen. This walks the store once per device and coerces them back.
export async function repairTimestamps(): Promise<number> {
  const db = requireDb();
  let fixed = 0;

  const num = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  for (const m of await db.messages.toArray()) {
    const patch: Partial<StoredMessage> = {};
    if (typeof m.createdAt !== "number") patch.createdAt = num(m.createdAt) ?? 0;
    if (m.deliveredAt !== null && typeof m.deliveredAt !== "number") patch.deliveredAt = num(m.deliveredAt);
    if (m.readAt !== null && typeof m.readAt !== "number") patch.readAt = num(m.readAt);
    if (m.deletedAt !== null && typeof m.deletedAt !== "number") patch.deletedAt = num(m.deletedAt);
    if (Object.keys(patch).length > 0) { await db.messages.update(m.id, patch); fixed++; }
  }
  for (const c of await db.contacts.toArray()) {
    if (typeof c.lastSeenAt !== "number") {
      await db.contacts.update(c.id, { lastSeenAt: num(c.lastSeenAt) ?? 0 });
      fixed++;
    }
  }
  for (const g of await db.groups.toArray()) {
    const patch: Partial<GroupRow> = {};
    if (typeof g.lastSeenAt !== "number") patch.lastSeenAt = num(g.lastSeenAt) ?? 0;
    if (typeof g.createdAt !== "number") patch.createdAt = num(g.createdAt) ?? 0;
    if (Object.keys(patch).length > 0) { await db.groups.update(g.id, patch); fixed++; }
  }
  return fixed;
}

// ---- re-keying ----
//
// The local-store key used to be derived from the password, which made
// a password change equivalent to shredding local history. It is now
// derived from the identity private key (stable for the life of the
// account). Devices created under the old scheme still hold rows sealed
// with the old key, so on first boot after the upgrade we unseal with
// the old key and re-seal with the new one. Messages that cannot be
// unsealed are left alone — the server drain will replace them.
export async function rekeyMessages(oldKey: Uint8Array): Promise<{ rekeyed: number; failed: number }> {
  const db = requireDb();
  const newKey = LOCAL_STORE_KEY!;
  const rows = await db.messages.toArray();
  let rekeyed = 0, failed = 0;
  const move = (ct: string | null): string | null | undefined => {
    if (!ct) return ct;
    try { return secretBoxSeal(newKey, secretBoxOpen(oldKey, ct)); }
    catch { return undefined; }   // undefined = could not convert
  };
  for (const r of rows) {
    const body = move(r.body_ct);
    const caption = move(r.caption_ct);
    const edited = move(r.editedBody_ct);
    if (body === undefined || caption === undefined || edited === undefined) { failed++; continue; }
    await db.messages.update(r.id, {
      body_ct: body, caption_ct: caption, editedBody_ct: edited,
    });
    rekeyed++;
  }
  return { rekeyed, failed };
}

// ---- envelope ledger ----

export async function ledgerStatus(id: string): Promise<EnvelopeLedgerRow | undefined> {
  return requireDb().envelopes.get(id);
}

export async function ledgerMarkOk(id: string, createdAt: number): Promise<void> {
  await requireDb().envelopes.put({
    id, createdAt, status: "ok", reason: null, attempts: 0, raw: null,
  });
}

export async function ledgerMarkPending(
  env: NonNullable<EnvelopeLedgerRow["raw"]>, reason: string,
): Promise<void> {
  const prior = await requireDb().envelopes.get(env.id);
  await requireDb().envelopes.put({
    id: env.id,
    createdAt: env.createdAt,
    status: "pending",
    reason,
    attempts: (prior?.attempts ?? 0) + 1,
    raw: env,
  });
}

export async function ledgerPending(limit = 500): Promise<EnvelopeLedgerRow[]> {
  return requireDb().envelopes.where("status").equals("pending").limit(limit).toArray();
}

export async function ledgerCounts(): Promise<{ ok: number; pending: number; total: number }> {
  const db = requireDb();
  const ok = await db.envelopes.where("status").equals("ok").count();
  const pending = await db.envelopes.where("status").equals("pending").count();
  return { ok, pending, total: ok + pending };
}

// Every envelope id this device has accounted for, successful or
// parked. Used to diff against the relay's list.
export async function ledgerAllIds(): Promise<string[]> {
  const keys = await requireDb().envelopes.toCollection().primaryKeys();
  return keys.map((k) => String(k));
}

// Used by "Re-sync all history": forget what we think we've seen so the
// next drain re-ingests every envelope from scratch. Message rows are
// keyed by msgId, so re-ingesting overwrites rather than duplicates.
export async function ledgerClear(): Promise<void> {
  await requireDb().envelopes.clear();
}

// ---- outbox ----

export async function enqueueOutbox(row: {
  id: string; peerId: string; isGroup: boolean; packed: string;
}): Promise<void> {
  await requireDb().outbox.put({
    id: row.id,
    peerId: row.peerId,
    isGroup: row.isGroup,
    packed_ct: sealText(row.packed),
    createdAt: Date.now(),
    attempts: 0,
    lastError: null,
  });
}

export async function listOutbox(): Promise<Array<{
  id: string; peerId: string; isGroup: boolean; packed: string; attempts: number;
}>> {
  const rows = await requireDb().outbox.orderBy("createdAt").toArray();
  const out: Array<{ id: string; peerId: string; isGroup: boolean; packed: string; attempts: number }> = [];
  for (const r of rows) {
    try {
      out.push({
        id: r.id, peerId: r.peerId, isGroup: r.isGroup,
        packed: new TextDecoder().decode(secretBoxOpen(LOCAL_STORE_KEY!, r.packed_ct)),
        attempts: r.attempts,
      });
    } catch { /* unreadable queue row — drop on the next flush */ }
  }
  return out;
}

export async function outboxCount(): Promise<number> {
  return requireDb().outbox.count();
}

export async function dequeueOutbox(id: string): Promise<void> {
  await requireDb().outbox.delete(id);
}

export async function bumpOutboxAttempt(id: string, err: string): Promise<void> {
  const row = await requireDb().outbox.get(id);
  if (!row) return;
  await requireDb().outbox.update(id, { attempts: row.attempts + 1, lastError: err });
}

// ---- totals (availability watchdog) ----

export async function messageCount(): Promise<number> {
  return requireDb().messages.count();
}

// Every thread id that actually has messages, whether or not we hold
// contact/group metadata for it.
export async function distinctThreadIds(): Promise<string[]> {
  const keys = await requireDb().messages.orderBy("peerId").uniqueKeys();
  return keys.map((k) => String(k));
}

// ---- helpers ----

function sealText(s: string): string {
  return secretBoxSeal(LOCAL_STORE_KEY!, new TextEncoder().encode(s));
}

function mkStored(input: {
  id: string;
  peerId: string;
  senderId: string;
  direction: "in" | "out";
  createdAt: number;
  body_ct: string | null;
  caption_ct: string | null;
  media: MediaRef | null;
  replyTo?: { id: string; preview: string; author: string } | null;
}): StoredMessage {
  return {
    id: input.id,
    peerId: input.peerId,
    senderId: input.senderId,
    direction: input.direction,
    createdAt: input.createdAt,
    body_ct: input.body_ct,
    caption_ct: input.caption_ct,
    media: input.media,
    replyTo: input.replyTo ?? null,
    editedBody_ct: null,
    deletedAt: null,
    reactions: {},
    deliveredAt: input.direction === "in" ? Date.now() : null,
    readAt: null,
    tokens: "",
    embedding: [],
  };
}

async function bumpThread(peerId: string, at: number) {
  await requireDb().contacts.where("id").equals(peerId).modify({ lastSeenAt: at });
  await requireDb().groups.where("id").equals(peerId).modify({ lastSeenAt: at });
}

function previewOf(m: OpenedMessage, opts: { includeSender?: boolean } = {}): string {
  if (m.deletedAt) return "[deleted]";
  const prefix = opts.includeSender ? `${m.direction === "out" ? "You" : shortId(m.senderId)}: ` : "";
  if (m.media) {
    const label = m.media.kind === "voice" ? "🎤 Voice note"
      : m.media.kind === "image" ? "📷 Photo"
      : m.media.kind === "video" ? "🎬 Video"
      : m.media.kind === "audio" ? "🎵 Audio"
      : `📎 ${m.media.filename ?? "File"}`;
    return prefix + (m.caption ? `${label} — ${m.caption}` : label);
  }
  return prefix + (m.editedBody ?? m.body ?? "");
}

function shortId(id: string): string {
  return id.slice(0, 4);
}

// Re-exports so callers can compose search without a second import.
export { embed, tokenize } from "./embeddings.js";
