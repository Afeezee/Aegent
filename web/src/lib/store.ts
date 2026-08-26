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

export type ScheduledBackup = {
  id: string;
  peerId: string;         // thread to back up (contact id or group id)
  peerLabel: string;      // cached at scheduling time for the reminder text
  recipientEmail: string;
  whenIso: string;
  createdAt: number;
  note?: string;
};

class AegentDB extends Dexie {
  contacts!: Table<ContactRow, string>;
  groups!: Table<GroupRow, string>;
  messages!: Table<StoredMessage, string>;
  reminders!: Table<ReminderRow, string>;
  scheduledBackups!: Table<ScheduledBackup, string>;
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

export async function listThreads(): Promise<Thread[]> {
  const contacts = await listContacts();
  const groups = await listGroups();
  const threads: Thread[] = [];

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

export async function applyDelete(targetId: string) {
  const target = await requireDb().messages.get(targetId);
  if (!target) return;
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
  const rows = await requireDb().messages
    .where("[peerId+createdAt]")
    .between([peerId, 0], [peerId, Date.now() + 1])
    .limit(limit)
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
