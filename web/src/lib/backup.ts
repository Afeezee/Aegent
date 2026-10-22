// Encrypted per-user backup of the local store.
//
// Contents of a backup payload (JSON, gzip-omitted for portability):
//   { v: 1, at, contacts[], groups[], messages[], reminders[] }
//
// Everything gets encrypted client-side with `backupKeyFromRecovery`.
// The relay only ever sees `nonce || ciphertext`. On a new device, the
// user enters their recovery phrase → we derive the identity keypair
// (public key looks the user up on the server) AND the backup key
// (decrypts the blob we pulled). The server never has either.
//
// Format wraps a schema version so future changes can migrate on read
// without touching the on-server bytes.

import { apiUrl, loadToken } from "./api.js";
import { secretBoxOpenBytes, secretBoxSealBytes } from "./crypto.js";
import { retryFetch } from "./retry.js";
import {
  everyMessage, listContacts, listGroups, listReminders, myDiaryEntries,
  openStore, upsertContact, upsertGroup,
  saveDiaryEntry, saveTextMessage, saveMediaMessage, saveReminder,
  type StoredMessage, type ContactRow, type GroupRow,
} from "./store.js";
import { currentSession } from "./session.js";

// v2 adds the author's diary archive. The version is bumped even though
// the field is optional: a v1-only reader silently dropping someone's
// diary is a worse failure than refusing to read a newer backup.
const SCHEMA_VERSION = 2;

// Message shape used on-the-wire. Bodies are the *plaintext* the user
// wrote — we're re-encrypting the whole payload with the backup key,
// so keeping them decrypted here means restore doesn't need the
// original local-store key.
type WireMessage = {
  id: string;
  peerId: string;
  senderId: string;
  direction: "in" | "out";
  createdAt: number;
  body: string | null;
  caption: string | null;
  editedBody: string | null;
  media: StoredMessage["media"];
  replyTo: StoredMessage["replyTo"];
  deletedAt: number | null;
  reactions: StoredMessage["reactions"];
  deliveredAt: number | null;
  readAt: number | null;
};

export type BackupPayload = {
  v: number;
  at: number;
  // Enough self-metadata to prompt "sign in as <email> to finish restoring".
  self: { id: string; email: string; handle: string; displayName: string; publicKey: string };
  contacts: ContactRow[];
  groups: GroupRow[];
  messages: WireMessage[];
  reminders: Array<{ id: string; text: string; whenIso: string; createdAt: number }>;
  // Only the author's own entries: the ones with no expiry. Entries
  // other people lent us are not ours to put in a backup that outlives
  // their 24 hours.
  diary?: WireDiaryEntry[];
};

type WireDiaryEntry = {
  id: string; dayKey: string; tzOffsetMin: number; seq: number;
  kind: "text" | "media"; createdAt: number;
  text: string | null; caption: string | null;
  media: StoredMessage["media"];
};

// ---- upload ----

// Snapshot the local store, encrypt with the phrase-derived backup key,
// and PUT to the relay. Idempotent — later writes replace prior.
export async function pushBackup(
  backupKey: Uint8Array,
  self: BackupPayload["self"],
): Promise<{ size: number }> {
  const contacts = await listContacts();
  const groups = await listGroups();
  const messages = await everyMessage();
  const reminders = await listReminders();
  const diary = await ownDiaryForBackup();

  const wire: BackupPayload = {
    v: SCHEMA_VERSION,
    at: Date.now(),
    self,
    contacts,
    groups,
    messages: messages.map(toWire),
    reminders,
    diary,
  };
  const json = new TextEncoder().encode(JSON.stringify(wire));
  const ct = secretBoxSealBytes(backupKey, json);

  const t = loadToken();
  const r = await retryFetch(apiUrl("/api/backup"), {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      ...(t ? { authorization: `Bearer ${t}` } : {}),
    },
    body: new Blob([ct as BlobPart], { type: "application/octet-stream" }),
  });
  if (!r.ok) throw new Error(`backup_upload_${r.status}`);
  return await r.json() as { size: number };
}

function toWire(m: ReturnType<typeof toWireInput>): WireMessage {
  return m;
}
type OpenedMessage = Awaited<ReturnType<typeof everyMessage>>[number];
function toWireInput(m: OpenedMessage): WireMessage {
  return {
    id: m.id, peerId: m.peerId, senderId: m.senderId,
    direction: m.direction, createdAt: m.createdAt,
    body: m.body, caption: m.caption, editedBody: m.editedBody,
    media: m.media, replyTo: m.replyTo, deletedAt: m.deletedAt,
    reactions: m.reactions,
    deliveredAt: m.deliveredAt, readAt: m.readAt,
  };
}
// Alias the two forms so `toWire` above compiles cleanly.
export const _toWire = toWireInput;

// ---- restore ----

// Decrypt a raw backup ciphertext with the caller-supplied key.
// Session.attemptCloudRestore() fetches the bytes via the authed
// endpoint and hands them here.
export function openBackupCiphertext(key: Uint8Array, ciphertext: Uint8Array): BackupPayload {
  const pt = secretBoxOpenBytes(key, ciphertext);
  const payload = JSON.parse(new TextDecoder().decode(pt)) as BackupPayload;
  if (payload.v > SCHEMA_VERSION) throw new Error(`backup_from_newer_version_${payload.v}`);
  return payload;
}

// Rehydrate the local store from a decrypted backup. Assumes
// openStore() has already been called with the current session's
// local-store key. Merges — existing messages/contacts are kept and
// only ones from the backup that aren't already present are added.
export async function rehydrateInto(payload: BackupPayload, me: { id: string; storeKey: Uint8Array }) {
  // Re-open the store with the caller-provided key just to be safe if
  // this is being invoked before the normal session boot sequence.
  openStore(me.id, me.storeKey);
  for (const c of payload.contacts) await upsertContact(c);
  for (const g of payload.groups) await upsertGroup(g);
  for (const m of payload.messages) {
    if (m.media) {
      await saveMediaMessage({
        id: m.id, peerId: m.peerId, senderId: m.senderId,
        direction: m.direction, createdAt: m.createdAt,
        caption: m.caption ?? undefined, media: m.media,
        replyTo: m.replyTo ?? undefined,
      });
    } else if (m.body || m.editedBody) {
      await saveTextMessage({
        id: m.id, peerId: m.peerId, senderId: m.senderId,
        direction: m.direction, createdAt: m.createdAt,
        body: (m.editedBody ?? m.body ?? "") as string,
        replyTo: m.replyTo ?? undefined,
      });
    }
  }
  for (const r of payload.reminders) await saveReminder(r.text, r.whenIso);
  // Older backups have no diary field; that is not an error.
  for (const d of payload.diary ?? []) {
    await saveDiaryEntry({
      id: d.id, authorId: me.id, dayKey: d.dayKey, tzOffsetMin: d.tzOffsetMin,
      seq: d.seq, kind: d.kind, createdAt: d.createdAt,
      expiresAt: null,                       // ours, and therefore permanent
      text: d.text, caption: d.caption, media: d.media,
    });
  }
}

// Only entries we wrote. An entry someone shared with us expires on
// their terms, and copying it into a backup would quietly outlive that.
async function ownDiaryForBackup(): Promise<WireDiaryEntry[]> {
  const me = currentSession()?.user.id;
  if (!me) return [];
  const rows = await myDiaryEntries(me);
  return rows.map((d) => ({
    id: d.id, dayKey: d.dayKey, tzOffsetMin: d.tzOffsetMin, seq: d.seq,
    kind: d.kind, createdAt: d.createdAt,
    text: d.text, caption: d.caption, media: d.media,
  }));
}

// ---- auto-backup ----
//
// Fires on send (via a callback the sender wires in), throttled so a
// burst of messages produces at most one upload per hour. Failures are
// silent — a missed backup isn't user-visible; we'll try again next tick.

let LAST_BACKUP_AT = 0;
const AUTO_BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000;

export function scheduleAutoBackup(backupKey: Uint8Array, self: BackupPayload["self"]): void {
  if (Date.now() - LAST_BACKUP_AT < AUTO_BACKUP_MIN_INTERVAL_MS) return;
  LAST_BACKUP_AT = Date.now();
  // Fire-and-forget — never block the send path on backup upload.
  pushBackup(backupKey, self).catch(() => { /* silent — next tick */ });
}
export function forceNextAutoBackup(): void { LAST_BACKUP_AT = 0; }
