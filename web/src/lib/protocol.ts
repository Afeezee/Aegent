// The *plaintext* protocol that lives inside every ciphertext envelope.
// The server never sees any of this. A payload can be:
//
//   - text     : ordinary message body, optionally with a reply pointer
//   - media    : reference to an uploaded encrypted blob + the content
//                key needed to decrypt it locally
//   - reaction : react to a target message with an emoji
//   - edit     : replace the body of a previously-sent text message
//   - delete   : tombstone a previously-sent message
//   - typing   : (reserved) — currently we use socket 'typing', but the
//                envelope shape leaves room to do it e2e too
//
// Every payload carries `v` (protocol version) and `msgId` (a client-
// side stable id, so all N per-recipient envelopes for one group send
// share an id and dedupe cleanly on receive).

import { b64 } from "./crypto.js";

export const PROTOCOL_VERSION = 1;

export type MediaKind = "image" | "video" | "audio" | "voice" | "file";

// `_at` (optional): when the sender actually wrote this message.
//
// The envelope's `created_at` is when the RELAY received it, which is
// normally the same thing — except for a self-copy uploaded later. The
// background replicator cloud-copies messages that only existed locally,
// and those arrive at the relay now, not when they were written. Without
// `_at`, ingesting that copy overwrites the original time and the
// message jumps to the moment it was backed up.
//
// `_thread` (optional): the sender-side thread id for self-replicated
// copies. Every send now encrypts a self-copy alongside the recipient
// copies so the server stores the sender's own message history too.
// When ingesting a self-copy, the recipient_id is self, so we can't
// tell "which chat" this belonged to from server-side routing alone —
// _thread carries that (peer id for 1:1, group id for groups). Only
// meaningful on self-copies; ignored by third-party recipients.

// `diaryRef` (optional, on text): this message is a response to a diary
// entry — a reaction or a private reply.
//
// Added as a FIELD on the existing text variant rather than a new `t`,
// which is the safest extension available: an older client renders the
// text and ignores what it doesn't recognise, where an unknown type
// would be dropped entirely.
//
// It deliberately carries NO preview of the entry. The reply is a
// permanent message; the entry expires in 24 hours. Embedding a snippet
// would quietly make a copy of the thing we promised would stop being
// readable. Both sides render the quotation from their own local diary
// row while it exists, and degrade to "a diary entry" afterwards.

export type DiaryRef = {
  entryId: string;
  authorId: string;
  kind: "reaction" | "reply";
  emoji?: string;
};

export type Payload =
  | {
      v: 1;
      t: "text";
      msgId: string;
      body: string;
      replyTo?: { id: string; preview: string; author: string };
      diaryRef?: DiaryRef;
      _thread?: string;
      _at?: number;
      // Who sealed this. Only meaningful in the group archive, where a
      // shared symmetric key means the relay's sender_id column is the
      // only other attribution — and a relay could rewrite that column.
      // Stamping the sender INSIDE the sealed payload binds it to the
      // ciphertext the relay cannot alter. Still forgeable by another
      // member (they hold the key), never by the relay.
      _from?: string;
    }
  | {
      v: 1;
      t: "media";
      msgId: string;
      caption?: string;
      media: {
        kind: MediaKind;
        blobId: string;
        mime: string;
        byteSize: number;
        durationMs?: number;   // voice notes and video
        width?: number;        // images / video
        height?: number;
        filename?: string;
        // base64 content key — the server never sees it since the whole
        // payload is inside a nacl.box envelope. Recipient decrypts the
        // outer envelope, gets this key, fetches the ciphertext blob,
        // and decrypts locally.
        contentKey: string;
      };
      replyTo?: { id: string; preview: string; author: string };
      _thread?: string;
      _at?: number;
      _from?: string;
    }
  | { v: 1; t: "reaction"; msgId: string; targetId: string; emoji: string; op?: "add" | "remove"; _thread?: string; _at?: number; _from?: string }
  | { v: 1; t: "edit";     msgId: string; targetId: string; body: string; _thread?: string; _at?: number; _from?: string }
  | { v: 1; t: "delete";   msgId: string; targetId: string; _thread?: string; _at?: number; _from?: string };

// Does the sender the relay recorded agree with the one sealed inside?
//
// A disagreement means the relay (or whoever handed us the row) is
// claiming a different author than the one bound to the ciphertext, so
// the message is dropped rather than shown under the wrong name. A
// payload with no `_from` predates this and is accepted on the relay's
// word alone, which is the old behaviour — no worse than before.
export function attributionOk(payload: { _from?: string }, recordedSenderId: string): boolean {
  return !payload._from || payload._from === recordedSenderId;
}

export function packPayload(p: Payload): string {
  return JSON.stringify(p);
}

export function unpackPayload(s: string): Payload {
  const p = JSON.parse(s);
  if (!p || typeof p !== "object" || p.v !== PROTOCOL_VERSION) {
    throw new Error("unknown_payload_version");
  }
  return p as Payload;
}

// Helpers so callers never build payloads by hand.
let counter = 0;
export function newMsgId(): string {
  // Timestamp + counter + random suffix — collision-resistant and monotonically ordered.
  counter = (counter + 1) & 0xffff;
  const rand = b64.encode(cryptoRandomBytes(6)).replace(/[+/=]/g, "").slice(0, 6);
  return `${Date.now().toString(36)}-${counter.toString(36)}-${rand}`;
}

// The first segment of a msgId is base36 of the sender's clock at the
// moment it was composed. That makes the authored time recoverable from
// the id alone, which is how a message whose timestamp was overwritten
// can be put back where it belongs.
export function sentTimeFromMsgId(id: string): number | null {
  const head = id.split("-")[0];
  if (!head) return null;
  const t = parseInt(head, 36);
  if (!Number.isFinite(t)) return null;
  // Anything outside a plausible window is not a timestamp — ids from
  // other schemes must not be mistaken for one.
  const FLOOR = Date.UTC(2020, 0, 1);
  const CEILING = Date.now() + 86400_000;
  return t > FLOOR && t < CEILING ? t : null;
}

function cryptoRandomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}
