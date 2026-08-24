// Encrypted media blob store. The client encrypts the file with a fresh
// random content key, uploads the ciphertext bytes, and gets an id back.
// The content key is then delivered to the recipient(s) inside a normal
// E2E-encrypted message envelope. Server stores only opaque bytes.

import { randomUUID } from "node:crypto";
import { db, type BlobRow } from "./db.js";

export const MAX_BLOB_BYTES = 20 * 1024 * 1024; // 20 MB per upload

export function storeBlob(input: {
  ownerId: string;
  mime: string;
  ciphertext: Buffer;
}): { id: string; size: number } {
  if (input.ciphertext.byteLength > MAX_BLOB_BYTES) {
    throw new Error("blob_too_large");
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO blobs (id, owner_id, mime, ciphertext, byte_size, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.ownerId, input.mime, input.ciphertext, input.ciphertext.byteLength, Date.now());
  return { id, size: input.ciphertext.byteLength };
}

export function readBlob(id: string): BlobRow | undefined {
  return db.prepare("SELECT * FROM blobs WHERE id = ?").get(id) as BlobRow | undefined;
}
