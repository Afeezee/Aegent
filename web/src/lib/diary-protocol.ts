// What sits inside a diary entry's ciphertext.
//
// Deliberately a separate codec from `protocol.ts`. The two look alike,
// and that is exactly the reason to keep them apart: a diary entry must
// never travel down the message rail. Messages are the never-lose-
// anything channel, audited by the envelope ledger; a diary entry is
// meant to stop being readable on schedule. Sharing a `Payload` union
// between them would make sending one as the other a one-line mistake.
//
// An image's content key rides *inside* this sealed body rather than
// alongside it, so revoking the entry key revokes the picture too. If
// the key travelled outside, deleting a grant would take away the words
// and leave the photo.

import type { MediaRef } from "./store.js";

export const DIARY_VERSION = 1;

// How an entry's text should read.
//
// `body` is Markdown when `format` says so — headings for a title, bold,
// italics, quotes and lists. Alignment is not a Markdown concept, so it
// rides as its own field rather than being smuggled into the text as
// HTML, which would then have to be sanitised on the way out.
//
// Both are optional and both default to what the first version did, so
// an entry written by an older client still renders correctly.
export type DiaryFormat = "plain" | "md";
export type DiaryAlign = "left" | "center" | "right" | "justify";

export type DiaryBody =
  | { v: 1; t: "text"; body: string; format?: DiaryFormat; align?: DiaryAlign }
  | { v: 1; t: "media"; caption?: string; media: MediaRef; format?: DiaryFormat; align?: DiaryAlign };

export function packDiaryBody(b: DiaryBody): string {
  return JSON.stringify(b);
}

export function unpackDiaryBody(s: string): DiaryBody {
  const b = JSON.parse(s) as DiaryBody;
  if (!b || typeof b !== "object" || b.v !== DIARY_VERSION) {
    throw new Error("unknown_diary_version");
  }
  if (b.t !== "text" && b.t !== "media") throw new Error("unknown_diary_kind");
  return b;
}

// Entry ids are generated on the author's device so a retried publish is
// idempotent: the relay recognises the id and returns the existing entry
// instead of creating a second one.
export function newEntryId(): string {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  const suffix = Array.from(rand, (b) => b.toString(36)).join("").slice(0, 8);
  return `d-${Date.now().toString(36)}-${suffix}`;
}
