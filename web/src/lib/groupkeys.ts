// Group history, and the keys that make it readable.
//
// The live rail stays exactly as it is: one nacl.box envelope per
// member, which is what carries the availability guarantee. Alongside
// it, each group send writes ONE archive row sealed with a symmetric
// epoch key, and that key is wrapped separately for each member.
//
// This is what makes "show new members the history" possible at all. On
// the per-recipient rail a joiner has no envelopes addressed to them and
// the relay cannot make any, because it has no key. With epochs, letting
// someone read the past is handing them a few old keys rather than
// re-encrypting thousands of messages — and removing someone rotates the
// epoch, so what is said next is sealed with a key they do not hold.
//
// Honest limits, both worth knowing:
//
//   * Attribution in the archive is server-attested, not cryptographic.
//     A shared symmetric key cannot bind a sender the way a box does, so
//     the relay stamps sender_id and clients compare it with what is
//     inside. On the live rail attribution is still cryptographic. Making
//     the archive equal needs signing keys, which this build has not got.
//   * Rotation protects what comes next, not what came before. Someone
//     removed today keeps whatever they already downloaded.

import { b64, boxOpenBytes, boxSealBytes, newEntryKey, secretBoxOpen, secretBoxSeal } from "./crypto.js";
import { api } from "./api.js";
import { getGroup, getMeta, setMeta } from "./store.js";
import { currentSession, ensureContact } from "./session.js";
import { attributionOk, packPayload, unpackPayload, type Payload } from "./protocol.js";

// Epoch keys live in `meta`, which is small, already per-user, and
// already opened with the local-store key — the same place the sync
// cursors live. A separate table would buy nothing.
function keyMeta(groupId: string, epoch: number) { return `gkey.${groupId}.${epoch}`; }

async function rememberKey(groupId: string, epoch: number, key: Uint8Array): Promise<void> {
  await setMeta(keyMeta(groupId, epoch), b64.encode(key));
}

async function recallKey(groupId: string, epoch: number): Promise<Uint8Array | null> {
  const raw = await getMeta(keyMeta(groupId, epoch));
  return raw ? b64.decode(raw) : null;
}

// Unwrap an epoch key the relay is holding for us. Needs the granter's
// public key, because it was sealed to us by a person, not by a server.
async function fetchKey(groupId: string, epoch: number): Promise<Uint8Array | null> {
  const local = await recallKey(groupId, epoch);
  if (local) return local;
  const session = currentSession();
  if (!session) return null;
  try {
    const { keys } = await api.groupEpochKeys(groupId);
    for (const k of keys) {
      if (k.epoch !== epoch) continue;
      const granter = k.grantedBy === session.user.id
        ? session.publicKey
        : b64.decode((await ensureContact(k.grantedBy))?.publicKey ?? "");
      if (granter.length === 0) continue;
      const key = boxOpenBytes(k.wrappedKey, granter, session.privateKey);
      await rememberKey(groupId, epoch, key);
      return key;
    }
  } catch { /* offline, or not granted */ }
  return null;
}

// The key this group's next message is sealed with. Minted on demand:
// the first person to send after a group is created (or after a
// rotation) establishes the epoch and hands it to everyone present.
export async function keyForSending(groupId: string): Promise<{ epoch: number; key: Uint8Array } | null> {
  const session = currentSession();
  if (!session) return null;
  let epoch = 0;
  try { epoch = (await api.groupEpochs(groupId)).current; } catch { return null; }

  const existing = await fetchKey(groupId, epoch);
  if (existing) return { epoch, key: existing };

  // No key for the current epoch yet. Mint one and grant it to everyone
  // who is in the group now. Any member may do this — otherwise a group
  // whose admins are all offline could not talk.
  const key = newEntryKey();
  const grants = await wrapForMembers(groupId, key);
  if (grants.length === 0) return null;
  try {
    if (epoch === 0) {
      // Epoch 0 exists implicitly; establish it by rotating to 1 so that
      // "no key yet" and "key lost" are not the same state.
      const r = await api.groupRotateEpoch(groupId, grants);
      await rememberKey(groupId, r.epoch, key);
      return { epoch: r.epoch, key };
    }
    await api.groupGrantEpochKeys(groupId, grants.map((g) => ({ ...g, epoch })));
    await rememberKey(groupId, epoch, key);
    return { epoch, key };
  } catch { return null; }
}

async function wrapForMembers(groupId: string, key: Uint8Array, only?: string[]): Promise<Array<{
  memberId: string; wrappedKey: string;
}>> {
  const session = currentSession();
  if (!session) return [];
  const group = await getGroup(groupId);
  const ids = only ?? group?.memberIds ?? [];
  const out: Array<{ memberId: string; wrappedKey: string }> = [];
  for (const id of ids) {
    if (id === session.user.id) {
      out.push({ memberId: id, wrappedKey: boxSealBytes(key, session.publicKey, session.privateKey) });
      continue;
    }
    const contact = await ensureContact(id);
    if (!contact) continue;
    out.push({
      memberId: id,
      wrappedKey: boxSealBytes(key, b64.decode(contact.publicKey), session.privateKey),
    });
  }
  return out;
}

// Write the archive copy of a message. Best-effort by design: if it
// fails, the message still reached everyone through the live rail and
// only a future member's view of history is poorer.
export async function archiveGroupMessage(
  groupId: string, payload: Payload, createdAt: number,
): Promise<void> {
  const msgId = (payload as { msgId?: string }).msgId;
  if (!msgId) return;
  const k = await keyForSending(groupId);
  if (!k) return;
  // Bind the sender to the ciphertext, so the archive's attribution does
  // not rest on a database column the relay could rewrite.
  const stamped = { ...payload, _from: currentSession()?.user.id } as Payload;
  const sealed = secretBoxSeal(k.key, new TextEncoder().encode(packPayload(stamped)));
  await api.groupArchivePut(groupId, {
    epoch: k.epoch, msgId, ciphertext: sealed, createdAt,
  }).catch(() => { /* history is a nicety; delivery already happened */ });
}

// Hand a new member the history the group's policy allows.
//
// Called by whoever added them, because only a member device holds the
// keys. If nobody runs it the group still works — the joiner simply sees
// nothing older than their arrival, which is the conservative outcome.
export async function grantHistoryTo(groupId: string, memberId: string): Promise<number> {
  const session = currentSession();
  if (!session) return 0;
  let epochs: number[] = [];
  let current = 0;
  try {
    const r = await api.groupEpochs(groupId);
    epochs = r.mine;
    current = r.current;
  } catch { return 0; }

  let policy: "none" | "all" = "none";
  try { policy = (await api.getGroup(groupId)).settings?.historyPolicy ?? "none"; } catch { /* default */ }

  // 'none' still hands over the CURRENT epoch — otherwise the new member
  // cannot read the archive copy of anything said from now on.
  const wanted = policy === "all" ? epochs : epochs.filter((e) => e === current);
  const grants: Array<{ memberId: string; epoch: number; wrappedKey: string }> = [];
  const contact = await ensureContact(memberId);
  if (!contact) return 0;
  const theirPub = b64.decode(contact.publicKey);

  for (const epoch of wanted) {
    const key = await fetchKey(groupId, epoch);
    if (!key) continue;
    grants.push({ memberId, epoch, wrappedKey: boxSealBytes(key, theirPub, session.privateKey) });
  }
  if (grants.length === 0) return 0;
  await api.groupGrantEpochKeys(groupId, grants).catch(() => { /* they'll ask again */ });
  return grants.length;
}

// Start a fresh epoch so a departing member cannot read what is said
// next. Their old keys still open what they already had — rotation is
// forward-looking, and claiming otherwise would be false.
export async function rotateAfterDeparture(groupId: string): Promise<void> {
  const key = newEntryKey();
  const grants = await wrapForMembers(groupId, key);
  if (grants.length === 0) return;
  try {
    const r = await api.groupRotateEpoch(groupId, grants);
    await rememberKey(groupId, r.epoch, key);
  } catch { /* someone else will rotate on their next send */ }
}

// Replay whatever history we have keys for into the local store.
export async function syncGroupHistory(groupId: string): Promise<number> {
  const session = currentSession();
  if (!session) return 0;
  const cursorKey = `garchive.${groupId}`;
  let cursor: { since: number; afterId: string } | null = null;
  try {
    const raw = await getMeta(cursorKey);
    if (raw) cursor = JSON.parse(raw);
  } catch { cursor = null; }

  const { saveMediaMessage, saveTextMessage } = await import("./store.js");
  let restored = 0;

  for (let page = 0; page < 100; page++) {
    let res;
    try {
      res = await api.groupArchive(groupId, { since: cursor?.since, afterId: cursor?.afterId });
    } catch { break; }
    for (const row of res.messages) {
      const key = await fetchKey(groupId, row.epoch);
      if (!key) continue;                       // not ours to read
      let payload: Payload;
      try {
        payload = unpackPayload(new TextDecoder().decode(secretBoxOpen(key, row.ciphertext)));
      } catch { continue; }

      // Attribution: the sender sealed inside the payload must agree with
      // the sender the relay recorded, or we don't know who said this.
      if (!attributionOk(payload, row.senderId)) continue;

      const at = Number(row.createdAt);
      const direction = row.senderId === session.user.id ? "out" : "in";
      if (payload.t === "text") {
        await saveTextMessage({
          id: payload.msgId, peerId: groupId, senderId: row.senderId,
          direction, createdAt: at, body: payload.body, replyTo: payload.replyTo ?? null,
        });
        restored++;
      } else if (payload.t === "media") {
        await saveMediaMessage({
          id: payload.msgId, peerId: groupId, senderId: row.senderId,
          direction, createdAt: at, caption: payload.caption,
          media: payload.media, replyTo: payload.replyTo ?? null,
        });
        restored++;
      }
    }
    if (res.cursor) {
      cursor = res.cursor;
      await setMeta(cursorKey, JSON.stringify(cursor)).catch(() => { /* ignore */ });
    }
    if (!res.more) break;
  }
  return restored;
}
