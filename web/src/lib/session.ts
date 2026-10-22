// Session bootstrap and the high-level send/receive pipeline.
//
// Registration/login derives the identity keys and the local-store key
// without either ever leaving the device in cleartext. Once open, this
// module also exposes the send/receive helpers every UI screen uses,
// so the components never have to know about crypto or envelopes.

import {
  b64, backupKeyFromPrivate, decryptFromPeer, deriveKey, encryptForPeer,
  generateIdentity,
  initCrypto, newKdfSalt, secretBoxOpen, secretBoxSeal,
} from "./crypto.js";
import {
  api, apiUrl, loadToken, setRefreshToken, setToken,
  type MeApi, type PublicUser,
} from "./api.js";
import {
  applyDelete, applyEdit, applyReaction, closeStore, getContact, getGroup,
  markDelivered, markRead, openStore, saveMediaMessage, saveTextMessage,
  upsertContact, upsertGroup, type MediaRef,
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
// Watermark: the highest server createdAt we've successfully drained
// for this user. Namespaced by userId so switching accounts on the
// same device stays clean. Absence → drain everything from the start
// (fresh install / new device path).
function KEY_WATERMARK(userId: string) { return `aegent.inbox.watermark.${userId}`; }

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

// ---- inbox drain ----
//
// Always full-drain by createdAt watermark. `?all=true` returns every
// envelope addressed to us — delivered or not, self-echo included —
// since the watermark. On a fresh install the watermark is 0 and we
// get the entire history. On a repeat login/socket-reconnect we get
// only what's newer than our high-water mark, so it stays cheap.
//
// This is what "nothing is lost, whether logged in or out" hinges on:
// the client never trusts local Dexie as the source of truth — the
// server's message log is. Every session boot re-drains from the
// point we last successfully caught up.
let PULL_IN_FLIGHT: Promise<{ pulled: number }> | null = null;
export async function pullInbox(): Promise<{ pulled: number }> {
  if (!CURRENT) return { pulled: 0 };
  // Coalesce: if a pull is already running, join it. Prevents the
  // boot + focus + socket-reconnect trio from triggering three
  // parallel drains on the same instant.
  if (PULL_IN_FLIGHT) return PULL_IN_FLIGHT;
  const userId = CURRENT.user.id;
  const key = KEY_WATERMARK(userId);
  const watermark = Number(localStorage.getItem(key) ?? 0) || 0;
  PULL_IN_FLIGHT = (async () => {
    try {
      const envs = await api.inbox({ all: true, since: watermark });
      let highest = watermark;
      let pulled = 0;
      for (const e of envs) {
        try {
          const res = await ingestEnvelope(e);
          if (res) pulled++;
        } catch (err) {
          console.warn("[pullInbox] ingest failed", e.id, err);
        }
        // Bump watermark even if ingest failed — the envelope is on the
        // server permanently, and a broken decrypt won't be fixed by
        // re-fetching. This prevents one bad row from stalling the
        // whole drain on every boot.
        if (e.createdAt > highest) highest = e.createdAt;
      }
      // Persist as (highest + 1) so a `>= since` query on the next
      // drain doesn't re-return the last row.
      if (highest > watermark) {
        try { localStorage.setItem(key, String(highest + 1)); } catch { /* ignore */ }
      }
      return { pulled };
    } finally {
      PULL_IN_FLIGHT = null;
    }
  })();
  return PULL_IN_FLIGHT;
}

// Device-to-device backfill. For every message in this device's
// local store that THIS user sent, encrypt a self-copy and send it
// to the server. Other devices (same account, same password → same
// private key) will then see those messages on their next inbox
// drain, closing the "sent before self-echo was wired" gap.
//
// Nothing leaves the client as plaintext: the self-copy is
// encrypted to our own public key with our own private key, exactly
// the way sendToPeer does it. The server stores opaque bytes keyed
// to our user id, and only our own private key can decrypt them.
//
// Idempotent: ingestEnvelope dedupes by msgId, so running this
// twice (or running it when the server already has the self-echo
// for some messages) is harmless; those just redundant-insert on
// the server side but overlay the same Dexie row elsewhere.
export async function pushLocalHistoryToServer(opts: {
  onProgress?: (done: number, total: number) => void;
} = {}): Promise<{ pushed: number; skipped: number }> {
  if (!CURRENT) return { pushed: 0, skipped: 0 };
  const selfId = CURRENT.user.id;
  const selfPub = CURRENT.publicKey;
  // Lazy import so this feature doesn't pull store/protocol into the
  // auth bundle on cold boot.
  const [{ everyMessage }, { packPayload }] = await Promise.all([
    import("./store.js"),
    import("./protocol.js"),
  ]);
  const rows = await everyMessage();
  const mine = rows.filter((m) => m.senderId === selfId && !m.deletedAt);
  let pushed = 0, skipped = 0;
  for (let i = 0; i < mine.length; i++) {
    opts.onProgress?.(i, mine.length);
    const m = mine[i];
    try {
      // Rebuild the payload exactly as the original sendText/sendMedia
      // would have produced. The msgId stays stable so Dexie dedupes
      // against the existing row on any device that already has it.
      let payload: Record<string, unknown>;
      if (m.media) {
        payload = { v: 1, t: "media", msgId: m.id, caption: m.caption, media: m.media };
      } else if (m.body || m.editedBody) {
        payload = { v: 1, t: "text", msgId: m.id, body: m.editedBody ?? m.body };
      } else { skipped++; continue; }
      // _thread is what lets a self-echo land under the right chat on
      // the receiving device — recipient_id is self, so there's no
      // routing info otherwise.
      payload._thread = m.peerId;
      const packed = packPayload(payload as unknown as import("./protocol.js").Payload);
      const cipher = encryptForPeer(packed, selfPub, CURRENT.privateKey);
      const res = await sendCipher(selfId, cipher);
      if (res.ok) pushed++; else skipped++;
    } catch { skipped++; }
  }
  opts.onProgress?.(mine.length, mine.length);
  return { pushed, skipped };
}

// Force-drain: discards the local watermark and pulls EVERY envelope
// the server has for this user. Used by Settings → "Re-sync all
// history" so a device that joined mid-conversation (or lost its
// local Dexie) can catch up. Idempotent — ingestEnvelope dedupes by
// msgId, so running it twice is harmless.
export async function fullResyncInbox(): Promise<{ pulled: number }> {
  if (!CURRENT) return { pulled: 0 };
  const userId = CURRENT.user.id;
  const key = KEY_WATERMARK(userId);
  try { localStorage.removeItem(key); } catch { /* ignore */ }
  return pullInbox();
}

// Called from the live-socket handler after every real-time delivery
// so a subsequent pullInbox() doesn't re-fetch what we already have.
export function bumpInboxWatermark(createdAt: number): void {
  if (!CURRENT) return;
  const key = KEY_WATERMARK(CURRENT.user.id);
  try {
    const cur = Number(localStorage.getItem(key) ?? 0) || 0;
    if (createdAt + 1 > cur) localStorage.setItem(key, String(createdAt + 1));
  } catch { /* ignore */ }
}

// ---- registration / login ----

export async function register(input: {
  email: string; phone?: string; displayName: string; password: string;
}): Promise<{ session: Session }> {
  // No more recovery phrase at signup. New-device restore flows through
  // the server-held `wrappedPriv`: password derives the wrap key, which
  // unwraps the private key, which decrypts the ciphertext inbox
  // (including self-echoes) at next login. The recovery phrase was a
  // redundant backup path people were being told to safeguard.
  //
  // An optional downloadable "recovery kit" lives in Settings for users
  // who want an offline fallback; it is never forced on anyone.
  await initCrypto();
  const id = generateIdentity();
  const salt = newKdfSalt();
  const [wrapKey, storeKey] = await Promise.all([
    deriveKey(input.password, salt, "priv-wrap"),
    deriveKey(input.password, salt, "local-store"),
  ]);
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
  openStore(user.id, storeKey);

  const me = await api.me();
  CURRENT = { user: me, privateKey: id.privateKey, publicKey: id.publicKey };
  const bk = backupKeyFromPrivate(id.privateKey);
  persistKeys(id.privateKey, storeKey, bk);
  return { session: CURRENT };
}

// Called after every successful send to keep the cloud backup fresh.
// Throttled inside scheduleAutoBackup; safe to spam.
export function tickAutoBackup(): void {
  const bk = backupKey();
  const me = CURRENT?.user;
  if (!bk || !me) return;
  scheduleAutoBackup(bk, {
    id: me.id, email: me.email, handle: me.handle,
    displayName: me.displayName, publicKey: me.publicKey,
  });
}

export async function login(input: { email: string; password: string }): Promise<Session> {
  await initCrypto();
  const { token, refreshToken, wrappedPriv, kdfSalt } = await api.login({
    ...input, deviceLabel: describeDevice(),
  });
  const salt = b64.decode(kdfSalt);
  const [wrapKey, storeKey] = await Promise.all([
    deriveKey(input.password, salt, "priv-wrap"),
    deriveKey(input.password, salt, "local-store"),
  ]);
  const privateKey = secretBoxOpen(wrapKey, wrappedPriv);
  setToken(token);
  setRefreshToken(refreshToken);
  connectSocket(token);
  const me = await api.me();
  openStore(me.id, storeKey);
  CURRENT = { user: me, privateKey, publicKey: b64.decode(me.publicKey) };
  // Backup key is deterministic from the private key, so this login
  // on a brand-new device gets the same key that produced any prior
  // backups on the account — no separate recovery-code prompt needed.
  const bk = backupKeyFromPrivate(privateKey);
  persistKeys(privateKey, storeKey, bk);
  // Best-effort cloud-restore: if this account has a backup on the
  // relay and our local store is empty (or missing content), pull
  // and rehydrate. Runs in the background — login returns
  // immediately either way.
  attemptCloudRestore(bk, me.id, storeKey).catch(() => { /* silent */ });
  // Full inbox drain (all messages since watermark, delivered or not).
  // On a fresh device with no watermark this pulls the entire history
  // from the server — the app's "nothing is lost, even signed out"
  // guarantee comes from this line.
  pullInbox().catch((err) => console.warn("[login] pullInbox failed", err));
  return CURRENT;
}

// Fetch the encrypted backup with the JWT already established by
// login(), decrypt with the private-key-derived backup key, and merge
// missing messages/contacts into the local store. Idempotent — running
// twice does nothing the second time.
async function attemptCloudRestore(bk: Uint8Array, userId: string, storeKey: Uint8Array): Promise<void> {
  const t = loadToken();
  if (!t) return;
  const r = await fetch(apiUrl("/api/backup"), {
    headers: { authorization: `Bearer ${t}` },
  });
  if (!r.ok) return; // 404 = no backup yet, treat as "nothing to restore"
  const ct = new Uint8Array(await r.arrayBuffer());
  try {
    const { openBackupCiphertext, rehydrateInto } = await import("./backup.js");
    const payload = openBackupCiphertext(bk, ct);
    await rehydrateInto(payload, { id: userId, storeKey });
  } catch (e) {
    // Wrong key (old v1 backup encrypted with recovery-phrase key), or
    // corrupted bytes. Silent — user still has their live session.
    console.warn("[session] cloud restore skipped:", (e as Error).message);
  }
}

// Attempt a silent session restore at boot: if we have a JWT and both
// persisted keys, validate the JWT by fetching /me, then reopen the
// store and socket. Any failure (bad/expired token, tampered keys)
// falls back to a clean state so the user sees the auth screen.
export async function tryRestoreSession(): Promise<Session | null> {
  await initCrypto();
  const token = (typeof localStorage !== "undefined") && localStorage.getItem("aegent.token");
  const refresh = (typeof localStorage !== "undefined") && localStorage.getItem("aegent.refresh");
  const keys = loadPersistedKeys();
  // Need the crypto keys at minimum; either the access token OR a
  // refresh token can establish the session (the refresh will be
  // auto-exchanged on the first authed request if the access is dead).
  if (!keys || (!token && !refresh)) return null;
  if (token) setToken(token);
  if (refresh) setRefreshToken(refresh);
  try {
    const me = await api.me(); // implicitly validates (and auto-refreshes if needed)
    connectSocket(loadToken() ?? "");
    openStore(me.id, keys.storeKey);
    CURRENT = {
      user: me,
      privateKey: keys.privateKey,
      publicKey: b64.decode(me.publicKey),
    };
    // Restore path: pull anything the server has that this device
    // doesn't. Watermark-scoped so it's cheap on repeat launches and
    // full on a fresh reinstall.
    pullInbox().catch((err) => console.warn("[restore] pullInbox failed", err));
    return CURRENT;
  } catch {
    // Token no longer valid, or /me refused — full reset so the user
    // isn't stuck in a half-restored state.
    logout();
    return null;
  }
}

export function logout() {
  disconnectSocket();
  closeStore();
  setToken(null);
  setRefreshToken(null);
  clearPersistedKeys();
  CURRENT = null;
}

// Short human-readable device label stored with the refresh token so
// Settings > Devices can show "Android (Chrome Mobile)" instead of a
// random id. Non-identifying — just UA family + platform family.
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

// One envelope per recipient. For 1:1 that's one call; for a group we
// fan out and skip our own id (we keep a local copy anyway).
export async function sendToPeer(
  targetPeerId: string,   // user id (1:1) or group id
  isGroup: boolean,
  payload: Payload,
): Promise<{ ok: true; envelopeId: string } | { ok: false; error: string }> {
  if (!CURRENT) return { ok: false, error: "no_session" };
  const selfId = CURRENT.user.id;

  // Stamp the thread id on the payload so any self-copy that arrives
  // back through the socket knows which chat to file itself under.
  // Non-self recipients derive the thread from env.senderId/groupId
  // and ignore this field.
  const withThread: Payload = { ...payload, _thread: targetPeerId } as Payload;
  const packed = packPayload(withThread);

  // Compose the recipient list:
  //  - 1:1     → [targetPeerId, self]
  //  - group   → every member (including self)
  // The self-copy is what gives us server-side replication: every
  // message you send is now on the relay as ciphertext for you too,
  // so a new device restores by draining the inbox — no separate
  // backup dance for chat content.
  let recipients: string[] = [];
  if (isGroup) {
    const g = await getGroup(targetPeerId);
    if (!g) return { ok: false, error: "unknown_group" };
    recipients = Array.from(new Set([...g.memberIds, selfId]));
  } else {
    recipients = Array.from(new Set([targetPeerId, selfId]));
  }
  if (recipients.length === 0) return { ok: false, error: "no_recipients" };

  // Cache self's public key so we don't need a store lookup for the
  // self-copy — it's the same key already resident in CURRENT.
  const selfPubKey = CURRENT.publicKey;

  let firstEnvelopeId: string | undefined;
  for (const rid of recipients) {
    let peerPubKey: Uint8Array | null = null;
    if (rid === selfId) {
      peerPubKey = selfPubKey;
    } else {
      const peer = await getContact(rid);
      if (!peer) continue;
      peerPubKey = b64.decode(peer.publicKey);
    }
    const cipher = encryptForPeer(packed, peerPubKey, CURRENT.privateKey);
    const res = await sendCipher(rid, cipher, isGroup ? targetPeerId : undefined);
    if (!res.ok) return { ok: false, error: res.error };
    firstEnvelopeId = firstEnvelopeId ?? res.envelope.id;
  }
  return { ok: true, envelopeId: firstEnvelopeId ?? "" };
}

// High-level: compose + persist + fan-out for a text message.
export async function sendText(
  targetPeerId: string, isGroup: boolean, body: string,
  replyTo?: { id: string; preview: string; author: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const payload: Payload = {
    v: 1, t: "text", msgId: newMsgId(), body,
    replyTo: replyTo && { id: replyTo.id, preview: replyTo.preview, author: replyTo.author },
  };
  const res = await sendToPeer(targetPeerId, isGroup, payload);
  if (!res.ok) return res;
  await saveTextMessage({
    id: payload.msgId,
    peerId: targetPeerId,
    senderId: CURRENT!.user.id,
    direction: "out",
    createdAt: Date.now(),
    body,
    replyTo,
  });
  tickAutoBackup();
  return { ok: true };
}

export async function sendMedia(
  targetPeerId: string, isGroup: boolean, media: MediaRef, caption?: string,
  replyTo?: { id: string; preview: string; author: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const payload: Payload = {
    v: 1, t: "media", msgId: newMsgId(), caption, media,
    replyTo: replyTo && { id: replyTo.id, preview: replyTo.preview, author: replyTo.author },
  };
  const res = await sendToPeer(targetPeerId, isGroup, payload);
  if (!res.ok) return res;
  await saveMediaMessage({
    id: payload.msgId,
    peerId: targetPeerId,
    senderId: CURRENT!.user.id,
    direction: "out",
    createdAt: Date.now(),
    caption, media, replyTo,
  });
  tickAutoBackup();
  return { ok: true };
}

export async function sendReaction(
  targetPeerId: string, isGroup: boolean, targetMsgId: string, emoji: string,
) {
  const payload: Payload = { v: 1, t: "reaction", msgId: newMsgId(), targetId: targetMsgId, emoji };
  await sendToPeer(targetPeerId, isGroup, payload);
  await applyReaction(targetMsgId, CURRENT!.user.id, emoji);
}

export async function sendEdit(
  targetPeerId: string, isGroup: boolean, targetMsgId: string, body: string,
) {
  const payload: Payload = { v: 1, t: "edit", msgId: newMsgId(), targetId: targetMsgId, body };
  await sendToPeer(targetPeerId, isGroup, payload);
  await applyEdit(targetMsgId, body);
}

export async function sendDelete(targetPeerId: string, isGroup: boolean, targetMsgId: string) {
  const payload: Payload = { v: 1, t: "delete", msgId: newMsgId(), targetId: targetMsgId };
  await sendToPeer(targetPeerId, isGroup, payload);
  await applyDelete(targetMsgId);
}

// ---- receive path ----

// Decode one incoming envelope. Returns the resolved thread id so the
// UI can bump/highlight it. Also handles reactions/edits/deletes by
// mutating the target message in the local store.
export async function ingestEnvelope(env: {
  id: string; senderId: string; recipientId: string; groupId: string | null;
  ciphertext: string; createdAt: number;
}): Promise<{ threadId: string; msgId: string } | null> {
  if (!CURRENT) return null;
  const selfId = CURRENT.user.id;
  const isSelfEcho = env.senderId === selfId;

  // For a self-echo we decrypt with (self-pub, self-priv). For a
  // normal inbound we look up the sender's public key. `ensureContact`
  // for `self` would try to fetch our own contact record — skip.
  let peerPubKey: Uint8Array;
  if (isSelfEcho) {
    peerPubKey = CURRENT.publicKey;
  } else {
    const sender = await ensureContact(env.senderId);
    if (!sender) return null;
    peerPubKey = b64.decode(sender.publicKey);
  }

  let packed: string;
  try {
    packed = decryptFromPeer(env.ciphertext, peerPubKey, CURRENT.privateKey);
  } catch (e) {
    console.warn("[ingest] decrypt failed", env.id, (e as Error).message);
    // Ack anyway so a broken message doesn't clog the inbox forever.
    await api.ack([env.id]).catch(() => { /* ignore */ });
    return null;
  }
  const payload = unpackPayload(packed);

  // Thread id: for a self-echo the recipient_id is self, so we
  // can't infer the target from server routing. The sender stamped
  // `_thread` for exactly this case.
  const threadId = isSelfEcho
    ? (payload._thread ?? env.groupId ?? env.recipientId)
    : (env.groupId ?? env.senderId);
  const direction: "in" | "out" = isSelfEcho ? "out" : "in";

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
    await applyDelete(payload.targetId);
  }
  // Ack once the ingest actually landed (both for normal inbound
  // and self-echoes so the server-side delivered_at flips).
  await api.ack([env.id]).catch(() => { /* best-effort */ });
  await markDelivered(env.id).catch(() => { /* ignore */ });
  return { threadId, msgId: (payload as { msgId?: string }).msgId ?? env.id };
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
    // Cache each member as a contact too.
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

// Mark reads and notify server if the user has read receipts enabled.
export async function reportRead(envelopeIds: string[]) {
  if (envelopeIds.length === 0) return;
  for (const id of envelopeIds) await markRead(id);
  if (CURRENT?.user.settings.readReceipts) {
    try { await api.markRead(envelopeIds); } catch { /* best-effort */ }
  }
}
