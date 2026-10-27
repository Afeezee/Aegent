// Diary: publishing, syncing, and letting go.
//
// The author's device is the only place that knows the audience —
// contacts live in Dexie and nowhere else — so publishing is: seal the
// entry once with a fresh key, wrap that key for each reader, and hand
// the relay a pile of opaque grants. The relay validates and stores; it
// never expands "everyone I know" on our behalf, because it cannot and
// should not learn how.
//
// Reading is the mirror: a grant arrives with the key sealed to us, we
// unwrap it with our own private key, and open the body. When a grant
// lapses the relay stops serving both, and this module drops what is
// left locally.
//
// The expiry clock is the relay's, not the device's. A phone whose clock
// has been wound back a day would otherwise resurrect entries it should
// have dropped, so every sync records the server's time and we measure
// against that.

import {
  b64, boxOpenBytes, boxSealBytes, newEntryKey, secretBoxOpen, secretBoxSeal,
} from "./crypto.js";
import { api, type DiaryEntryApi } from "./api.js";
import {
  deleteDiaryEntry, dequeueDiaryPublish, diaryEntryCount, enqueueDiaryPublish,
  gcDiaryEntries, getDiaryAudience, getMeta, listContacts, listDiaryPublishQueue,
  markDiarySeenLocal, saveDiaryEntry, setDiaryViewCount, setMeta,
  type MediaRef,
} from "./store.js";
import { currentSession, ensureContact } from "./session.js";
import { revokeObjectUrlFor } from "./media.js";
import { dayKeyFor } from "./daybreaks.js";
import {
  newEntryId, packDiaryBody, unpackDiaryBody,
  type DiaryAlign, type DiaryBody, type DiaryFormat,
} from "./diary-protocol.js";

const META_SKEW = "diary.clockSkew";
const META_CURSOR = "diary.feedCursor";
const META_ARCHIVE_CURSOR = "diary.archiveCursor";

// ---- the relay's clock ----

let SKEW_MS = 0;
let SKEW_LOADED = false;

async function loadSkew(): Promise<void> {
  if (SKEW_LOADED) return;
  SKEW_LOADED = true;
  try { SKEW_MS = Number(await getMeta(META_SKEW) ?? 0) || 0; } catch { SKEW_MS = 0; }
}

function noteServerNow(serverNow: number): void {
  SKEW_MS = serverNow - Date.now();
  setMeta(META_SKEW, String(SKEW_MS)).catch(() => { /* best effort */ });
}

// What time the relay thinks it is. Everything about expiry uses this.
export function diaryNow(): number {
  return Date.now() + SKEW_MS;
}

// ---- publishing ----

// "public" is a superset of "contacts": contacts still see the entry in
// their normal diary feed (same grants), and additionally a cleartext
// copy goes to the global Discover feed so people who aren't contacts
// can find the author through it.
export type DiaryVisibility = "contacts" | "private" | "public";

export const MAX_PUBLIC_TEXT = 500;

export type PublishInput =
  | { kind: "text"; body: string; format?: DiaryFormat; align?: DiaryAlign; visibility?: DiaryVisibility }
  | { kind: "media"; media: MediaRef; album?: MediaRef[]; caption?: string; format?: DiaryFormat; align?: DiaryAlign; visibility?: DiaryVisibility };

// Resolve today's audience on this device. The relay is handed an
// explicit list of recipients and never the word "everyone": it has no
// contact graph and giving it one to compute would hand it exactly the
// social map the local-only design avoids.
export async function resolveAudience(dayKey: string): Promise<string[]> {
  const me = currentSession()?.user.id;
  const contacts = (await listContacts()).map((c) => c.id).filter((id) => id !== me);
  const rule = await getDiaryAudience(dayKey);
  if (!rule || rule.mode === "all") return contacts;
  if (rule.mode === "only") return contacts.filter((id) => rule.ids.includes(id));
  return contacts.filter((id) => !rule.ids.includes(id));
}

export async function publishDiaryEntry(input: PublishInput): Promise<{ id: string; queued: boolean }> {
  const session = currentSession();
  if (!session) throw new Error("no_session");
  await loadSkew();

  const createdAt = diaryNow();
  const tzOffsetMin = -new Date(createdAt).getTimezoneOffset();
  const dayKey = dayKeyFor(createdAt, tzOffsetMin);
  const id = newEntryId();

  const body: DiaryBody = input.kind === "text"
    ? { v: 1, t: "text", body: input.body, format: input.format, align: input.align }
    : {
        v: 1, t: "media", media: input.media,
        album: input.album && input.album.length > 1 ? input.album : undefined,
        caption: input.caption, format: input.format, align: input.align,
      };

  // One key per entry: it is what a grant hands out, and what deleting a
  // grant takes away.
  const entryKey = newEntryKey();
  const bodyCt = secretBoxSeal(entryKey, new TextEncoder().encode(packDiaryBody(body)));

  // "private" keeps the entry off everyone's feed: no viewer grants are
  // minted, so only the author's own never-expiring grant exists and the
  // entry lives in the archive alone.
  const audience = input.visibility === "private" ? [] : await resolveAudience(dayKey);
  const grants: Array<{ viewerId: string; wrappedKey: string }> = [];
  for (const viewerId of audience) {
    const contact = await ensureContact(viewerId);
    if (!contact) continue;   // unknown key: they simply aren't in this entry's audience
    grants.push({
      viewerId,
      wrappedKey: boxSealBytes(entryKey, b64.decode(contact.publicKey), session.privateKey),
    });
  }

  const payload = {
    id,
    dayKey,
    tzOffsetMin,
    seq: await nextSeqFor(dayKey),
    kind: input.kind,
    createdAt,
    bodyCt,
    // Our own copy of the key, so a brand-new device can rebuild the
    // archive from a bare login with nothing but the password.
    authorKey: boxSealBytes(entryKey, session.publicKey, session.privateKey),
    grants,
    blobIds: input.kind === "media"
      ? (input.album && input.album.length > 1 ? input.album : [input.media]).map((m) => m.blobId)
      : [],
  };

  // Save locally first. A publish that fails must never cost the user
  // what they wrote — the same rule the message outbox follows.
  await saveDiaryEntry({
    id, authorId: session.user.id, dayKey, tzOffsetMin, seq: payload.seq,
    kind: input.kind, createdAt, expiresAt: null,
    text: input.kind === "text" ? input.body : null,
    caption: input.kind === "media" ? input.caption ?? null : null,
    media: input.kind === "media" ? input.media : null,
    album: input.kind === "media" ? input.album ?? null : null,
    format: input.format, align: input.align,
  });

  let queued = false;
  try {
    await api.diaryPublish(payload);
  } catch {
    await enqueueDiaryPublish(id, JSON.stringify(payload));
    queued = true;
  }

  // Public entries get a cleartext twin in the Discover feed. Best
  // effort and strictly additive: a failure here never costs the
  // private entry, which is already saved and published above. Only a
  // single image or a voice note carries media into Discover — an album
  // contributes just its cover.
  if (input.visibility === "public") {
    try { await publishToDiscover(id, input); } catch { /* feed is non-critical */ }
  }

  return { id, queued };
}

async function publishToDiscover(id: string, input: PublishInput): Promise<void> {
  if (input.kind === "text") {
    const body = input.body.trim();
    if (!body || body.length > MAX_PUBLIC_TEXT) return;
    await api.discoverPublish({ id, kind: "text", text: body });
    return;
  }
  const media = input.media;
  const kind = media.kind === "voice" ? "voice" : "image";
  const caption = (input.caption ?? "").trim().slice(0, MAX_PUBLIC_TEXT);
  await api.discoverPublish({
    id, kind, text: caption || undefined,
    mediaJson: JSON.stringify(media), blobId: media.blobId,
  });
}

async function nextSeqFor(dayKey: string): Promise<number> {
  const me = currentSession()?.user.id;
  if (!me) return 0;
  const { myDiaryEntries } = await import("./store.js");
  return (await myDiaryEntries(me, dayKey)).length;
}

async function flushDiaryQueue(): Promise<number> {
  let sent = 0;
  for (const row of await listDiaryPublishQueue()) {
    try {
      await api.diaryPublish(JSON.parse(row.payload));
      await dequeueDiaryPublish(row.id);
      sent++;
    } catch { /* still unreachable; try again next cycle */ }
  }
  return sent;
}

// ---- reading ----

async function ingest(entry: DiaryEntryApi, mine: boolean): Promise<boolean> {
  const session = currentSession();
  if (!session) return false;

  // The key is sealed to us by the author, so opening it needs their
  // public key — ours alone is not enough.
  let authorPub: Uint8Array;
  if (mine) {
    authorPub = session.publicKey;
  } else {
    const contact = await ensureContact(entry.authorId);
    if (!contact) return false;
    authorPub = b64.decode(contact.publicKey);
  }

  let body: DiaryBody;
  try {
    const entryKey = boxOpenBytes(entry.wrappedKey, authorPub, session.privateKey);
    const plain = new TextDecoder().decode(secretBoxOpen(entryKey, entry.bodyCt));
    body = unpackDiaryBody(plain);
  } catch {
    return false;   // not ours to read, or damaged
  }

  await saveDiaryEntry({
    id: entry.id,
    authorId: entry.authorId,
    dayKey: entry.dayKey,
    tzOffsetMin: entry.tzOffsetMin,
    seq: entry.seq,
    kind: body.t,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    text: body.t === "text" ? body.body : null,
    caption: body.t === "media" ? body.caption ?? null : null,
    media: body.t === "media" ? body.media : null,
    album: body.t === "media" ? body.album ?? null : null,
    format: body.format, align: body.align,
  });
  return true;
}

async function pull(
  which: "feed" | "mine",
  cursorKey: string,
): Promise<number> {
  const session = currentSession();
  if (!session) return 0;
  let cursor: { since: number; afterId: string } | null = null;
  try {
    const raw = await getMeta(cursorKey);
    if (raw) cursor = JSON.parse(raw);
  } catch { cursor = null; }

  let pulled = 0;
  for (let page = 0; page < 200; page++) {
    const res = which === "feed"
      ? await api.diaryFeed({ since: cursor?.since, afterId: cursor?.afterId })
      : await api.diaryMine({ since: cursor?.since, afterId: cursor?.afterId });
    noteServerNow(res.serverNow);
    for (const entry of res.entries) {
      if (await ingest(entry, which === "mine")) pulled++;
    }
    if (res.cursor) {
      cursor = res.cursor;
      await setMeta(cursorKey, JSON.stringify(cursor)).catch(() => { /* ignore */ });
    }
    if (!res.more) break;
  }
  return pulled;
}

// One cycle of the replication loop's diary step.
export async function syncDiary(): Promise<{ pulled: number; dropped: number }> {
  if (!currentSession()) return { pulled: 0, dropped: 0 };
  await loadSkew();

  await flushDiaryQueue();

  // A device with no diary rows yet is a fresh install or a new device,
  // so rebuild the archive from the beginning. Afterwards the cursor
  // keeps it incremental.
  if (await diaryEntryCount() === 0) {
    await setMeta(META_ARCHIVE_CURSOR, "").catch(() => { /* ignore */ });
  }

  let pulled = 0;
  pulled += await pull("mine", META_ARCHIVE_CURSOR);
  pulled += await pull("feed", META_CURSOR);

  const dropped = await gcDiary();
  return { pulled, dropped };
}

// Drop what has lapsed, and release the decrypted bytes with it.
export async function gcDiary(): Promise<number> {
  const { removed, blobIds } = await gcDiaryEntries(diaryNow());
  for (const blobId of blobIds) revokeObjectUrlFor(blobId);
  return removed;
}

// ---- responding ----
//
// A reaction and a reply are the same thing at different lengths: an
// ordinary end-to-end message to the author, carrying a reference to the
// entry. That is the whole social layer.
//
// Riding the message rail rather than inventing a diary-comment store
// buys a lot for free — offline queueing, delivery receipts, the
// author's existing chat thread, and permanence for the response even
// though the entry it answers will expire. It also means nothing a
// viewer writes is readable by another viewer, which is what keeps this
// feature free of a moderation surface.

export async function reactToEntry(entry: { id: string; authorId: string }, emoji: string): Promise<void> {
  const { sendText } = await import("./session.js");
  const res = await sendText(entry.authorId, false, emoji, undefined, {
    diaryRef: { entryId: entry.id, authorId: entry.authorId, kind: "reaction", emoji },
  });
  if (!res.ok) throw new Error(res.error);
}

export async function replyToEntry(entry: { id: string; authorId: string }, body: string): Promise<void> {
  const { sendText } = await import("./session.js");
  const res = await sendText(entry.authorId, false, body, undefined, {
    diaryRef: { entryId: entry.id, authorId: entry.authorId, kind: "reply" },
  });
  if (!res.ok) throw new Error(res.error);
}

export type EntryResponses = {
  reactions: Array<{ emoji: string; from: string[] }>;
  replies: number;
  mine: string | null;          // the emoji this device already sent, if any
};

// Reactions are counted from the messages already on this device. There
// is no server-side reaction store to keep in sync, and nothing extra
// for the relay to learn.
export async function responsesFor(entryId: string): Promise<EntryResponses> {
  const { messagesAboutEntry } = await import("./store.js");
  const me = currentSession()?.user.id;
  const rows = await messagesAboutEntry(entryId);

  const byEmoji = new Map<string, Set<string>>();
  let replies = 0;
  let mine: string | null = null;
  for (const m of rows) {
    if (m.diaryRef?.kind === "reply") { replies++; continue; }
    const emoji = m.diaryRef?.emoji ?? m.body ?? "";
    if (!emoji) continue;
    const who = byEmoji.get(emoji) ?? new Set<string>();
    who.add(m.senderId);
    byEmoji.set(emoji, who);
    if (m.senderId === me) mine = emoji;
  }
  return {
    reactions: [...byEmoji.entries()]
      .map(([emoji, from]) => ({ emoji, from: [...from] }))
      .sort((a, b) => b.from.length - a.from.length),
    replies,
    mine,
  };
}

// ---- views ----

export async function reportSeen(entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) return;
  await markDiarySeenLocal(entryIds, diaryNow());
  try { await api.diarySeen(entryIds); } catch { /* best effort */ }
}

export async function refreshViewCount(entryId: string): Promise<number | null> {
  try {
    const r = await api.diaryViews(entryId);
    await setDiaryViewCount(entryId, r.count);
    return r.count;
  } catch { return null; }
}

// ---- author actions ----

// Edit a text entry's body on the day it was posted.
//
// The entry key does NOT change — contacts who already hold their 24h
// grant keep seeing the live text — so re-encrypting with the same key
// and shipping fresh ciphertext is all the server needs. If the window
// has closed the server refuses, and the UI hides the control, so this
// never silently fails.
export async function editDiaryText(id: string, newBody: string, opts: { format?: DiaryFormat; align?: DiaryAlign } = {}): Promise<void> {
  const session = currentSession();
  if (!session) throw new Error("no_session");
  const { getDiaryEntry, saveDiaryEntry } = await import("./store.js");
  const row = await getDiaryEntry(id);
  if (!row) throw new Error("unknown_entry");
  if (row.authorId !== session.user.id) throw new Error("not_yours");
  if (row.media) throw new Error("only_text_entries_can_be_edited");

  // We need the entry key to re-seal. For OUR OWN entries the never-
  // expiring self-grant on the relay carries it; opening our own copy of
  // our own wrapped key gives us the same `K_e` the entry was sealed with
  // originally.
  const mine = await api.diaryMine({ since: row.createdAt, afterId: undefined, limit: 50 });
  const match = mine.entries.find((e) => e.id === id);
  if (!match) throw new Error("entry_not_on_server");
  const entryKey = boxOpenBytes(match.wrappedKey, session.publicKey, session.privateKey);

  const body: DiaryBody = { v: 1, t: "text", body: newBody, format: opts.format ?? row.format, align: opts.align ?? row.align };
  const bodyCt = secretBoxSeal(entryKey, new TextEncoder().encode(packDiaryBody(body)));
  await api.diaryEdit(id, { bodyCt, kind: "text" });

  // Mirror into the local row so the author sees the update right away.
  await saveDiaryEntry({
    id: row.id, authorId: row.authorId, dayKey: row.dayKey, tzOffsetMin: row.tzOffsetMin,
    seq: row.seq, kind: "text", createdAt: row.createdAt, expiresAt: row.expiresAt,
    text: newBody, caption: null, media: null, format: opts.format ?? row.format, align: opts.align ?? row.align,
  });
}

export async function removeDiaryEntry(id: string): Promise<void> {
  await api.diaryDelete(id).catch(() => { /* may already be gone */ });
  // If it was also public, pull its Discover twin. Harmless if there was
  // never one (the server no-ops on an unknown id).
  await api.discoverDelete(id).catch(() => { /* no public twin, or already gone */ });
  const { getDiaryEntry } = await import("./store.js");
  const row = await getDiaryEntry(id);
  if (row?.media) revokeObjectUrlFor(row.media.blobId);
  await deleteDiaryEntry(id);
}

// Change who can see an entry after the fact. Removing is immediate and
// real — the key goes with the grant. Adding someone late gives them the
// entry's ORIGINAL expiry, not a fresh day.
export async function changeAudience(entryId: string, input: {
  add?: string[]; remove?: string[];
}): Promise<void> {
  const session = currentSession();
  if (!session) throw new Error("no_session");
  const { getDiaryEntry } = await import("./store.js");
  const row = await getDiaryEntry(entryId);
  if (!row) throw new Error("unknown_entry");

  const add: Array<{ viewerId: string; wrappedKey: string }> = [];
  if (input.add?.length) {
    // Re-deriving the entry key means re-opening our own grant, which we
    // only hold for our own entries — which is correct, since only the
    // author may widen an audience.
    const mine = await api.diaryMine({ since: row.createdAt, afterId: undefined });
    const match = mine.entries.find((e) => e.id === entryId);
    if (!match) throw new Error("not_author");
    const entryKey = boxOpenBytes(match.wrappedKey, session.publicKey, session.privateKey);
    for (const viewerId of input.add) {
      const contact = await ensureContact(viewerId);
      if (!contact) continue;
      add.push({ viewerId, wrappedKey: boxSealBytes(entryKey, b64.decode(contact.publicKey), session.privateKey) });
    }
  }
  await api.diaryGrants(entryId, { add, remove: input.remove ?? [] });
}
