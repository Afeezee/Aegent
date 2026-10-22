// Encrypted media blob store. The client encrypts the file with a fresh
// random content key, uploads the ciphertext bytes, and gets an id back.
// The content key is delivered separately, inside an already-E2E-
// encrypted message envelope. Server stores only opaque bytes.

import { randomUUID } from "node:crypto";
import { db, type BlobRow } from "./db.js";

export const MAX_BLOB_BYTES = 20 * 1024 * 1024; // 20 MB per upload

export async function storeBlob(input: {
  ownerId: string;
  mime: string;
  ciphertext: Buffer;
}): Promise<{ id: string; size: number }> {
  if (input.ciphertext.byteLength > MAX_BLOB_BYTES) {
    throw new Error("blob_too_large");
  }
  const id = randomUUID();
  await db.prepare(
    `INSERT INTO blobs (id, owner_id, mime, ciphertext, byte_size, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.ownerId, input.mime, input.ciphertext, input.ciphertext.byteLength, Date.now());
  return { id, size: input.ciphertext.byteLength };
}

export async function readBlob(id: string): Promise<BlobRow | undefined> {
  return db.prepare("SELECT * FROM blobs WHERE id = ?").get<BlobRow>(id);
}

// Read a blob on behalf of a specific caller.
//
// Three rules, in order:
//
//   1. the owner may always read their own upload;
//   2. a blob with no diary binding is served as before — chat
//      attachments keep the capability model they have always had,
//      because their reference travels inside ciphertext and the relay
//      structurally cannot know who is entitled to it;
//   3. a diary-bound blob requires a live grant on its entry.
//
// Rule 3 is what makes a diary image actually expire. A viewer legitimately
// learns both the blob id and its content key while the entry is live, so
// without this they could keep fetching the ciphertext forever and the
// 24-hour window would be decoration.
//
// Rule 2 leaves the pre-existing "any authenticated user can fetch any
// chat blob id" gap open. That is deliberate and known: closing it needs
// a blob-to-message binding that does not exist and cannot be derived
// server-side without breaking the encryption model.
export async function readBlobFor(id: string, requesterId: string): Promise<BlobRow | undefined> {
  const row = await db.prepare("SELECT * FROM blobs WHERE id = ?").get<BlobRow>(id);
  if (!row) return undefined;
  if (row.owner_id === requesterId) return row;

  const bound = await db.prepare("SELECT entry_id FROM diary_blobs WHERE blob_id = ?")
    .get<{ entry_id: string }>(id);
  if (!bound) return row;

  const live = await db.prepare(
    `SELECT 1 AS one
       FROM diary_grants g
       JOIN diary_entries e ON e.id = g.entry_id
      WHERE g.entry_id = ? AND g.viewer_id = ?
        AND e.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > ?)`,
  ).get(bound.entry_id, requesterId, Date.now());
  return live ? row : undefined;
}
