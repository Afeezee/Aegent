// Session bootstrap and the high-level send/receive pipeline.
//
// Registration/login derives the identity keys and the local-store key
// without either ever leaving the device in cleartext. Once open, this
// module also exposes the send/receive helpers every UI screen uses,
// so the components never have to know about crypto or envelopes.

import {
  b64, decryptFromPeer, deriveKey, encryptForPeer, identityFromRecovery,
  initCrypto, newKdfSalt, newRecoveryPhrase, secretBoxOpen, secretBoxSeal,
} from "./crypto.js";
import { api, setToken, type MeApi, type PublicUser } from "./api.js";
import {
  applyDelete, applyEdit, applyReaction, closeStore, getContact, getGroup,
  markDelivered, markRead, openStore, saveMediaMessage, saveTextMessage,
  upsertContact, upsertGroup, type MediaRef,
} from "./store.js";
import { connectSocket, disconnectSocket, sendCipher } from "./socket.js";
import { newMsgId, packPayload, unpackPayload, type Payload } from "./protocol.js";

export type Session = {
  user: MeApi;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
};

let CURRENT: Session | null = null;
export function currentSession(): Session | null { return CURRENT; }

// ---- registration / login ----

export async function register(input: {
  email: string; displayName: string; password: string;
}): Promise<{ session: Session; recoveryPhrase: string }> {
  await initCrypto();
  const { phrase, entropy } = newRecoveryPhrase();
  const id = identityFromRecovery(entropy);
  const salt = newKdfSalt();
  const [wrapKey, storeKey] = await Promise.all([
    deriveKey(input.password, salt, "priv-wrap"),
    deriveKey(input.password, salt, "local-store"),
  ]);
  const wrappedPriv = secretBoxSeal(wrapKey, id.privateKey);

  const { user, token } = await api.register({
    email: input.email,
    displayName: input.displayName,
    password: input.password,
    publicKey: b64.encode(id.publicKey),
    wrappedPriv,
    kdfSalt: b64.encode(salt),
  });
  setToken(token);
  connectSocket(token);
  openStore(user.id, storeKey);

  const me = await api.me();
  CURRENT = { user: me, privateKey: id.privateKey, publicKey: id.publicKey };
  return { session: CURRENT, recoveryPhrase: phrase };
}

export async function login(input: { email: string; password: string }): Promise<Session> {
  await initCrypto();
  const { token, wrappedPriv, kdfSalt } = await api.login(input);
  const salt = b64.decode(kdfSalt);
  const [wrapKey, storeKey] = await Promise.all([
    deriveKey(input.password, salt, "priv-wrap"),
    deriveKey(input.password, salt, "local-store"),
  ]);
  const privateKey = secretBoxOpen(wrapKey, wrappedPriv);
  setToken(token);
  connectSocket(token);
  const me = await api.me();
  openStore(me.id, storeKey);
  CURRENT = { user: me, privateKey, publicKey: b64.decode(me.publicKey) };
  return CURRENT;
}

export function logout() {
  disconnectSocket();
  closeStore();
  setToken(null);
  CURRENT = null;
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
  const packed = packPayload(payload);
  let recipients: string[] = [];
  if (isGroup) {
    const g = await getGroup(targetPeerId);
    if (!g) return { ok: false, error: "unknown_group" };
    recipients = g.memberIds.filter((id) => id !== CURRENT!.user.id);
  } else {
    recipients = [targetPeerId];
  }
  if (recipients.length === 0) return { ok: false, error: "no_recipients" };

  let firstEnvelopeId: string | undefined;
  for (const rid of recipients) {
    const peer = await getContact(rid);
    if (!peer) continue;
    const cipher = encryptForPeer(packed, b64.decode(peer.publicKey), CURRENT.privateKey);
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
  const sender = await ensureContact(env.senderId);
  if (!sender) return null;
  const packed = decryptFromPeer(env.ciphertext, b64.decode(sender.publicKey), CURRENT.privateKey);
  const payload = unpackPayload(packed);
  const threadId = env.groupId ?? sender.id;

  if (payload.t === "text") {
    await saveTextMessage({
      id: payload.msgId,
      peerId: threadId,
      senderId: env.senderId,
      direction: "in",
      createdAt: env.createdAt,
      body: payload.body,
      replyTo: payload.replyTo ?? null,
    });
  } else if (payload.t === "media") {
    await saveMediaMessage({
      id: payload.msgId,
      peerId: threadId,
      senderId: env.senderId,
      direction: "in",
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
  // Server-side delivered ack + local delivered marker.
  await api.ack([env.id]);
  await markDelivered(env.id);
  return { threadId, msgId: (payload as { msgId?: string }).msgId ?? env.id };
}

export async function ensureContact(id: string): Promise<{ id: string; publicKey: string; displayName: string } | null> {
  const existing = await getContact(id);
  if (existing) return existing;
  try {
    const u = await api.byId(id);
    await upsertContact({
      id: u.id, email: u.email, handle: u.handle,
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
