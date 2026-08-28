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

// `_thread` (optional): the sender-side thread id for self-replicated
// copies. Every send now encrypts a self-copy alongside the recipient
// copies so the server stores the sender's own message history too.
// When ingesting a self-copy, the recipient_id is self, so we can't
// tell "which chat" this belonged to from server-side routing alone —
// _thread carries that (peer id for 1:1, group id for groups). Only
// meaningful on self-copies; ignored by third-party recipients.

export type Payload =
  | {
      v: 1;
      t: "text";
      msgId: string;
      body: string;
      replyTo?: { id: string; preview: string; author: string };
      _thread?: string;
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
    }
  | { v: 1; t: "reaction"; msgId: string; targetId: string; emoji: string; _thread?: string }
  | { v: 1; t: "edit";     msgId: string; targetId: string; body: string; _thread?: string }
  | { v: 1; t: "delete";   msgId: string; targetId: string; _thread?: string };

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

function cryptoRandomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}
