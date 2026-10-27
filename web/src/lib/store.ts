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
import { sentTimeFromMsgId, type DiaryRef } from "./protocol.js";
import type { DiaryAlign, DiaryFormat } from "./diary-protocol.js";
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
  // Public-directory profile bits, refreshed whenever we fetch the
  // contact. Optional so old rows migrate silently.
  avatar?: string | null;
  statusText?: string | null;
};

export type GroupRow = {
  id: string;
  name: string;
  memberIds: string[];
  createdAt: number;
  createdBy: string;
  lastSeenAt: number;
  avatar?: string | null;
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
  // "View once" media: shown to the recipient a single time, then
  // locked behind a "Viewed" placeholder. Text view-once is sent by
  // rendering the text to a PNG card first, so this flag covers it
  // uniformly. Older clients that don't recognise the flag just show
  // the content as a normal attachment — acceptable trade-off.
  viewOnce?: boolean;
  // Set when the user tapped to reveal a view-once attachment. Lives
  // on the StoredMessage below too, but duplicated here so previews
  // (ThreadList subtitle, forward preview) can decide at a glance.
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
  // Set when this message is a reaction or reply to a diary entry.
  // Indexed (dotted key path) so the author's diary view can find the
  // responses to one entry without scanning every message they own.
  diaryRef: DiaryRef | null;
  editedBody_ct: string | null;   // if set, replaces body_ct on display
  deletedAt: number | null;       // if set, render as tombstone
  reactions: Record<string, string[]>; // emoji → [userId, ...]

  // Delivery/read state (tracked locally for the sender's UI).
  deliveredAt: number | null;
  readAt: number | null;
  // Set when the recipient has tapped a view-once attachment and
  // revealed its content. Lives on the message row so the "Viewed"
  // placeholder survives reloads. Non-indexed Dexie field — added
  // without a schema version bump, so older rows read as undefined.
  viewedAt?: number | null;

  // Search index (unencrypted; the whole DB is protected by the OS
  // account, and search would be useless if we couldn't index).
  tokens: string;
  embedding: number[];
};

export type ReminderRow = { id: string; text: string; whenIso: string; createdAt: number };

// ---- diary ----
//
// One row per entry this device can read, whether we wrote it or someone
// shared it. `expiresAt` is the whole asymmetry: null means ours and
// kept forever, a number means somebody lent it to us until then.
//
// Text is sealed at rest with the local-store key like message bodies.
// `media` is not: it holds the attachment's content key, which is the
// same (knowingly imperfect) position chat media already takes.
export type DiaryEntryRow = {
  id: string;
  authorId: string;
  dayKey: string;          // 'YYYY-MM-DD' in the AUTHOR's timezone
  tzOffsetMin: number;
  seq: number;
  kind: "text" | "media";
  createdAt: number;
  expiresAt: number | null;
  text_ct: string | null;
  caption_ct: string | null;
  media: MediaRef | null;
  // When an entry is a set of images, the full list (cover first). One
  // image leaves this null and `media` is the single picture.
  album: MediaRef[] | null;
  seenAt: number | null;
  // Author-side only: how many people have opened this entry.
  viewCount: number | null;
  // Presentation. Not sealed — these describe how the text reads, not
  // what it says, and keeping them in the clear means the list can show
  // a preview without opening every entry.
  format: DiaryFormat;
  align: DiaryAlign;
};

export type OpenedDiaryEntry =
  Omit<DiaryEntryRow, "text_ct" | "caption_ct"> & { text: string | null; caption: string | null };

// Who a day's entries go to. Default is every contact; the override is
// per day because that is the unit people think in ("not today").
export type DiaryAudienceRow = {
  dayKey: string;
  mode: "all" | "only" | "except";
  ids: string[];
};

// A publish that hasn't reached the relay yet. Separate from the message
// outbox so `queuedOutbound` in the replication status keeps meaning
// messages — a diary entry waiting to go out is not a message at risk.
export type DiaryOutboxRow = {
  id: string;
  createdAt: number;
  payload_ct: string;      // the sealed publish request
  attempts: number;
};

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
  // Sealed like message bodies. Agent replies quote the conversations
  // they were asked about, so leaving this in the clear made the
  // transcript the one unencrypted copy of other people's words — and
  // with groups in scope those words are not even the reader's own.
  text_ct: string;
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
  diaryEntries!: Table<DiaryEntryRow, string>;
  diaryAudience!: Table<DiaryAudienceRow, string>;
  diaryOutbox!: Table<DiaryOutboxRow, string>;
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
    // v5: the diary. `expiresAt` is indexed and nullable on purpose —
    // IndexedDB leaves null keys out of an index, so a range query over
    // it sees exactly the borrowed entries and never our own.
    this.version(5).stores({
      diaryEntries: "id, authorId, createdAt, expiresAt, [authorId+createdAt], [authorId+dayKey]",
      diaryAudience: "dayKey",
      diaryOutbox: "id, createdAt",
    });
    // v6: index responses to a diary entry. Re-declares the messages
    // index list in full, which is how Dexie adds an index to an
    // existing store. Rows without a diaryRef simply aren't in it.
    this.version(6).stores({
      messages: "id, peerId, direction, createdAt, [peerId+createdAt], diaryRef.entryId",
    });
    // v7: persisted translation cache. Keyed by messageId so one row
    // per translated message. targetLang lets us re-translate into
    // another language later without blowing the first cached copy
    // away. Stays local-only — translations are a client-side cache,
    // never synced to the server (the server never saw the plaintext
    // to begin with).
    this.version(7).stores({
      translations: "messageId, createdAt",
    });
    // v8: per-conversation local state — pin / archive. Keyed by the
    // thread's peerId (contact id or group id). Local-only: these are
    // organisational preferences, not content, so there's nothing to
    // sync. pinnedAt/archivedAt double as the "when" for ordering.
    this.version(8).stores({
      threadMeta: "peerId, pinnedAt, archivedAt",
    });
  }
  translations!: Table<{
    messageId: string;
    sourceText: string;
    translatedText: string;
    targetLang: string;
    createdAt: number;
  }, string>;
  threadMeta!: Table<{
    peerId: string;
    pinnedAt: number | null;
    archivedAt: number | null;
  }, string>;
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

// ---- translations ----
//
// Local-only cache. Translations are opt-in and leave the E2E
// boundary (user consents inside the UI), so we don't want to send
// the same text to Google twice if the user re-opens a chat.
// Writes are idempotent — put() overwrites by messageId.

export async function getTranslation(messageId: string): Promise<{ text: string; targetLang: string } | null> {
  try {
    const row = await requireDb().translations.get(messageId);
    return row ? { text: row.translatedText, targetLang: row.targetLang } : null;
  } catch { return null; }
}

export async function saveTranslation(input: {
  messageId: string;
  sourceText: string;
  translatedText: string;
  targetLang: string;
}): Promise<void> {
  try {
    await requireDb().translations.put({
      messageId: input.messageId,
      sourceText: input.sourceText,
      translatedText: input.translatedText,
      targetLang: input.targetLang,
      createdAt: Date.now(),
    });
  } catch { /* non-fatal — translation still shows in memory */ }
}

export async function clearTranslation(messageId: string): Promise<void> {
  try { await requireDb().translations.delete(messageId); } catch { /* ignore */ }
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
  pinned?: boolean;
  archived?: boolean;
  avatar?: string | null;
};

// ---- conversation management (pin / archive / delete) ----

export const MAX_PINNED = 10;

export async function getThreadMetaMap(): Promise<Map<string, { pinnedAt: number | null; archivedAt: number | null }>> {
  const rows = await requireDb().threadMeta.toArray();
  return new Map(rows.map((r) => [r.peerId, { pinnedAt: r.pinnedAt, archivedAt: r.archivedAt }]));
}

export async function countPinned(): Promise<number> {
  return requireDb().threadMeta.filter((r) => r.pinnedAt !== null).count();
}

// Returns false (and changes nothing) if pinning would exceed MAX_PINNED.
export async function setThreadPinned(peerId: string, pinned: boolean): Promise<boolean> {
  const db = requireDb();
  if (pinned && (await countPinned()) >= MAX_PINNED) {
    const existing = await db.threadMeta.get(peerId);
    if (!existing?.pinnedAt) return false;  // already at cap and this one isn't pinned
  }
  const cur = await db.threadMeta.get(peerId);
  await db.threadMeta.put({
    peerId,
    pinnedAt: pinned ? Date.now() : null,
    archivedAt: cur?.archivedAt ?? null,
  });
  return true;
}

export async function setThreadArchived(peerId: string, archived: boolean): Promise<void> {
  const db = requireDb();
  const cur = await db.threadMeta.get(peerId);
  await db.threadMeta.put({
    peerId,
    // Archiving clears a pin — a pinned chat shouldn't hide in archive.
    pinnedAt: archived ? null : (cur?.pinnedAt ?? null),
    archivedAt: archived ? Date.now() : null,
  });
}

// Delete a conversation locally: drop every message for the peer, its
// thread-meta, and its contact/group row so the thread disappears from
// the list. The person stays reachable — messaging them again (or them
// messaging you) re-creates the contact and a fresh thread. Server-side
// history is untouched; this is a local clear, like WhatsApp's "delete
// chat".
export async function deleteConversation(peerId: string, isGroup: boolean): Promise<void> {
  const db = requireDb();
  const ids = await db.messages.where("peerId").equals(peerId).primaryKeys();
  await db.messages.bulkDelete(ids);
  await db.threadMeta.delete(peerId);
  if (isGroup) await db.groups.delete(peerId);
  else await db.contacts.delete(peerId);
}

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
  const meta = await getThreadMetaMap();
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
      avatar: c.avatar ?? null,
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
      avatar: g.avatar ?? null,
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
  // Fold in pin/archive state.
  for (const t of threads) {
    const m = meta.get(t.peerId);
    t.pinned = !!m?.pinnedAt;
    t.archived = !!m?.archivedAt;
  }
  // Sort: pinned first (newest pin on top), then everyone else by
  // recency. Archived threads are NOT filtered here — the caller
  // decides whether to show them, so an "Archived" view can reuse
  // this same list.
  return threads.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.updatedAt - a.updatedAt;
  });
}

// Upper bound of a thread query.
//
// This used to be `Date.now() + 1`, which quietly made the device's own
// clock a filter: if the relay ran even slightly ahead, the newest
// messages sorted past the bound and simply did not render. A thread
// should show everything in it, not everything the local clock believes
// has happened yet.
const END_OF_TIME = Number.MAX_SAFE_INTEGER;

async function lastMessageIn(peerId: string): Promise<OpenedMessage | undefined> {
  const rows = await requireDb().messages
    .where("[peerId+createdAt]")
    .between([peerId, 0], [peerId, END_OF_TIME])
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
  diaryRef?: DiaryRef | null;
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
// Toggle a reaction (user tapped it): flips the user's presence in the
// emoji's set and returns which way it went, so the caller can send an
// explicit op to peers. Returns null if the target is gone.
export async function toggleReaction(targetId: string, userId: string, emoji: string): Promise<"add" | "remove" | null> {
  const target = await requireDb().messages.get(targetId);
  if (!target) return null;
  const map = target.reactions || {};
  const users = new Set(map[emoji] ?? []);
  const op: "add" | "remove" = users.has(userId) ? "remove" : "add";
  if (op === "remove") users.delete(userId); else users.add(userId);
  const next: Record<string, string[]> = { ...map };
  if (users.size === 0) delete next[emoji];
  else next[emoji] = Array.from(users);
  await requireDb().messages.update(targetId, { reactions: next });
  return op;
}

// Idempotent apply of an explicit op (used when INGESTING a reaction
// from a peer or a self-echo). Setting a state that's already set is a
// no-op — this is what stops a self-echo of our own reaction from
// toggling it back off, the bug where a reaction flashed then vanished
// on the sender's side while persisting on the receiver's.
export async function setReaction(
  targetId: string, userId: string, emoji: string, op: "add" | "remove",
) {
  const target = await requireDb().messages.get(targetId);
  if (!target) return;
  const map = target.reactions || {};
  const users = new Set(map[emoji] ?? []);
  if (op === "add") users.add(userId); else users.delete(userId);
  const next: Record<string, string[]> = { ...map };
  if (users.size === 0) delete next[emoji];
  else next[emoji] = Array.from(users);
  await requireDb().messages.update(targetId, { reactions: next });
}

// Back-compat alias: the old toggle name, still used by any caller that
// genuinely wants toggle semantics. New code should prefer
// toggleReaction (returns the op) + setReaction (idempotent apply).
export async function applyReaction(targetId: string, userId: string, emoji: string) {
  await toggleReaction(targetId, userId, emoji);
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

// Mark a view-once attachment as "seen" by the recipient. Permanent —
// the next render replaces the content with the Viewed placeholder.
export async function markMessageViewed(id: string, at = Date.now()) {
  await requireDb().messages.update(id, { viewedAt: at });
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
    .between([peerId, 0], [peerId, END_OF_TIME])
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
    .between([peerId, 0], [peerId, END_OF_TIME])
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

export type OpenedAgentTurn = Omit<AgentTurnRow, "text_ct"> & { text: string };

export async function appendAgentTurn(row: { kind: AgentTurnRow["kind"]; text: string }): Promise<OpenedAgentTurn> {
  const stored: AgentTurnRow = {
    id: crypto.randomUUID(), createdAt: Date.now(),
    kind: row.kind, text_ct: sealText(row.text),
  };
  await requireDb().agentTurns.put(stored);
  return { id: stored.id, createdAt: stored.createdAt, kind: stored.kind, text: row.text };
}
export async function listAgentTurns(limit = 400): Promise<OpenedAgentTurn[]> {
  const rows = await requireDb().agentTurns
    .orderBy("createdAt")
    .reverse()
    .limit(limit)
    .toArray();
  const key = LOCAL_STORE_KEY!;
  return rows.reverse().map((r) => {
    // The row shape used to be {text}, then changed to {text_ct}. Rows
    // written before the change have no text_ct — fall back to the
    // legacy field instead of reporting corruption. The migration below
    // moves them over on next write.
    const legacy = (r as unknown as { text?: string }).text;
    let text = "";
    if (r.text_ct) {
      try { text = new TextDecoder().decode(secretBoxOpen(key, r.text_ct)); }
      catch { text = legacy ?? "<corrupt>"; }
    } else {
      text = legacy ?? "";
    }
    return { id: r.id, createdAt: r.createdAt, kind: r.kind, text };
  });
}
// One-time migration: old agentTurns rows had a cleartext `text` field
// that was replaced by `text_ct`. Promote any surviving legacy rows so
// they stop reading as blank or corrupt. Safe to run repeatedly.
export async function repairAgentTurns(): Promise<number> {
  const db = requireDb();
  const rows = await db.agentTurns.toArray();
  let moved = 0;
  for (const r of rows) {
    const legacy = (r as unknown as { text?: string }).text;
    if (!r.text_ct && typeof legacy === "string") {
      await db.agentTurns.update(r.id, { text_ct: sealText(legacy), text: undefined } as never);
      moved++;
    }
  }
  return moved;
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

// Put our own messages back where they belong in time.
//
// The background replicator uploads messages that existed only on this
// device so other devices can see them. Until now the self-copy carried
// no authored time, so the relay stamped it with the moment of upload
// and ingesting it overwrote the original — re-dating a whole history to
// whenever the backup happened. On screen that reads as every message
// you ever sent bunched together, separated from the replies they
// belong beside.
//
// The fix stops it happening again; this undoes what already happened.
// A message id's first segment is base36 of the sender's clock when it
// was composed, so the real time is recoverable from the id alone.
// Only outbound messages are touched: inbound ones carry the relay's
// receipt time, which was never wrong.
export async function repairSentTimes(): Promise<number> {
  const db = requireDb();
  let fixed = 0;
  for (const m of await db.messages.toArray()) {
    if (m.direction !== "out") continue;
    const authored = sentTimeFromMsgId(m.id);
    if (authored === null) continue;
    // A minute of slack: small differences are just clock jitter between
    // composing and sending, and rewriting those would be noise.
    if (Math.abs(authored - m.createdAt) < 60_000) continue;
    await db.messages.update(m.id, { createdAt: authored });
    fixed++;
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
// Every table holding ciphertext sealed with the local-store key.
//
// This exists as a registry rather than a hand-written walk because the
// old version re-keyed `messages` and nothing else — and `outbox` was
// already being missed, so a message queued while offline became
// permanently unreadable the moment the store key changed. A new sealed
// table is now one line here instead of a bug nobody notices until
// somebody changes their password.
//
// Add a table to this list in the same commit that starts sealing text
// into it, and only once the table actually exists in the schema —
// `db.table()` throws for a store the current version doesn't declare.
const SEALED_TABLES: Array<{ table: string; fields: string[] }> = [
  { table: "messages",     fields: ["body_ct", "caption_ct", "editedBody_ct"] },
  { table: "outbox",       fields: ["packed_ct"] },
  { table: "diaryEntries", fields: ["text_ct", "caption_ct"] },
  { table: "diaryOutbox",  fields: ["payload_ct"] },
  { table: "agentTurns",   fields: ["text_ct"] },
];

// Re-seal everything under a new local-store key.
//
// Rows that cannot be opened with the old key are left exactly as they
// are and counted as failed: they are either already under the new key
// (a half-finished previous run) or genuinely lost, and overwriting them
// with garbage would turn a recoverable state into an unrecoverable one.
export async function rekeyLocalStore(oldKey: Uint8Array): Promise<{ rekeyed: number; failed: number }> {
  const db = requireDb();
  const newKey = LOCAL_STORE_KEY!;
  let rekeyed = 0, failed = 0;

  const move = (ct: unknown): string | null | undefined => {
    if (ct === null || ct === undefined || ct === "") return null;
    if (typeof ct !== "string") return null;
    try { return secretBoxSeal(newKey, secretBoxOpen(oldKey, ct)); }
    catch { return undefined; }   // undefined = could not convert
  };

  for (const spec of SEALED_TABLES) {
    const table = db.table<Record<string, unknown>, string>(spec.table);
    for (const row of await table.toArray()) {
      const patch: Record<string, unknown> = {};
      let broken = false;
      for (const field of spec.fields) {
        const next = move(row[field]);
        if (next === undefined) { broken = true; break; }
        if (next !== (row[field] ?? null)) patch[field] = next;
      }
      if (broken) { failed++; continue; }
      if (Object.keys(patch).length === 0) continue;   // nothing sealed in this row
      await table.update(row.id as string, patch);
      rekeyed++;
    }
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

// Every reaction and reply pointed at one diary entry. Uses the dotted
// index added in v6, so this stays cheap as the archive grows.
export async function messagesAboutEntry(entryId: string): Promise<OpenedMessage[]> {
  const rows = await requireDb().messages
    .where("diaryRef.entryId").equals(entryId)
    .toArray();
  return rows
    .filter((m) => !m.deletedAt)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(openMessage);
}

// ---- diary ----

export function openDiaryEntry(r: DiaryEntryRow): OpenedDiaryEntry {
  const key = LOCAL_STORE_KEY!;
  const dec = (ct: string | null): string | null => {
    if (!ct) return null;
    try { return new TextDecoder().decode(secretBoxOpen(key, ct)); }
    catch { return "<corrupt>"; }
  };
  return { ...r, text: dec(r.text_ct), caption: dec(r.caption_ct) };
}

export async function saveDiaryEntry(input: {
  id: string; authorId: string; dayKey: string; tzOffsetMin: number; seq: number;
  kind: "text" | "media"; createdAt: number; expiresAt: number | null;
  text?: string | null; caption?: string | null; media?: MediaRef | null;
  album?: MediaRef[] | null;
  format?: DiaryFormat; align?: DiaryAlign;
}): Promise<void> {
  const existing = await requireDb().diaryEntries.get(input.id);
  await requireDb().diaryEntries.put({
    id: input.id,
    authorId: input.authorId,
    dayKey: input.dayKey,
    tzOffsetMin: input.tzOffsetMin,
    seq: input.seq,
    kind: input.kind,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    text_ct: input.text ? sealText(input.text) : null,
    caption_ct: input.caption ? sealText(input.caption) : null,
    media: input.media ?? null,
    album: input.album ?? null,
    // Re-ingesting an entry must not un-see it or forget its view count.
    seenAt: existing?.seenAt ?? null,
    viewCount: existing?.viewCount ?? null,
    format: input.format ?? "plain",
    align: input.align ?? "left",
  });
}

export async function getDiaryEntry(id: string): Promise<OpenedDiaryEntry | undefined> {
  const row = await requireDb().diaryEntries.get(id);
  return row ? openDiaryEntry(row) : undefined;
}

// Everything still readable at `now`. Expiry is checked on read as well
// as swept, so a stale sweep can never surface an entry that has lapsed.
export async function liveDiaryEntries(now: number): Promise<OpenedDiaryEntry[]> {
  const rows = await requireDb().diaryEntries.toArray();
  return rows
    .filter((r) => r.expiresAt === null || r.expiresAt > now)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(openDiaryEntry);
}

export async function myDiaryEntries(authorId: string, dayKey?: string): Promise<OpenedDiaryEntry[]> {
  const table = requireDb().diaryEntries;
  const rows = dayKey
    ? await table.where("[authorId+dayKey]").equals([authorId, dayKey]).toArray()
    : await table.where("authorId").equals(authorId).toArray();
  return rows.sort((a, b) => a.createdAt - b.createdAt).map(openDiaryEntry);
}

export async function diaryEntryCount(): Promise<number> {
  return requireDb().diaryEntries.count();
}

export async function markDiarySeenLocal(ids: string[], at = Date.now()): Promise<void> {
  for (const id of ids) {
    await requireDb().diaryEntries.update(id, { seenAt: at }).catch(() => { /* gone */ });
  }
}

export async function setDiaryViewCount(id: string, count: number): Promise<void> {
  await requireDb().diaryEntries.update(id, { viewCount: count }).catch(() => { /* gone */ });
}

// Drop what we were only lent. Returns the blob ids that went with them
// so the caller can release their decrypted object URLs — deleting the
// row while the URL still resolves would be cleanup in name only.
export async function gcDiaryEntries(now: number): Promise<{ removed: number; blobIds: string[] }> {
  const doomed = await requireDb().diaryEntries
    .where("expiresAt").below(now)
    .toArray();
  if (doomed.length === 0) return { removed: 0, blobIds: [] };
  const blobIds = doomed.map((r) => r.media?.blobId).filter((b): b is string => !!b);
  await requireDb().diaryEntries.bulkDelete(doomed.map((r) => r.id));
  return { removed: doomed.length, blobIds };
}

export async function deleteDiaryEntry(id: string): Promise<void> {
  await requireDb().diaryEntries.delete(id);
}

export async function getDiaryAudience(dayKey: string): Promise<DiaryAudienceRow | undefined> {
  return requireDb().diaryAudience.get(dayKey);
}
export async function setDiaryAudience(row: DiaryAudienceRow): Promise<void> {
  await requireDb().diaryAudience.put(row);
}

export async function enqueueDiaryPublish(id: string, payload: string): Promise<void> {
  await requireDb().diaryOutbox.put({
    id, createdAt: Date.now(), payload_ct: sealText(payload), attempts: 0,
  });
}
export async function listDiaryPublishQueue(): Promise<Array<{ id: string; payload: string }>> {
  const rows = await requireDb().diaryOutbox.orderBy("createdAt").toArray();
  const out: Array<{ id: string; payload: string }> = [];
  for (const r of rows) {
    try {
      out.push({ id: r.id, payload: new TextDecoder().decode(secretBoxOpen(LOCAL_STORE_KEY!, r.payload_ct)) });
    } catch { /* unreadable queue row — drop on next flush */ }
  }
  return out;
}
export async function dequeueDiaryPublish(id: string): Promise<void> {
  await requireDb().diaryOutbox.delete(id);
}
export async function diaryQueueCount(): Promise<number> {
  return requireDb().diaryOutbox.count();
}

// ---- helpers ----

export function sealText(s: string): string {
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
  diaryRef?: DiaryRef | null;
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
    diaryRef: input.diaryRef ?? null,
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
