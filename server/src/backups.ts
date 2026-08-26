// Ciphertext-only backup storage. One row per user; latest replaces
// prior. Server never has the key, only knows the byte count.

import { db } from "./db.js";

// 50 MB per backup is comfortable for a store with tens of thousands of
// messages plus their local embeddings. If a user grows beyond that,
// bump this cap and consider paginated chunk backups.
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

export async function saveBackup(userId: string, ciphertext: Buffer): Promise<{ size: number }> {
  if (ciphertext.byteLength > MAX_BACKUP_BYTES) throw new Error("backup_too_large");
  // UPSERT via delete-then-insert — works identically on Postgres and
  // node:sqlite without needing per-backend ON CONFLICT syntax.
  await db.tx(async () => {
    await db.prepare("DELETE FROM backups WHERE user_id = ?").run(userId);
    await db.prepare(
      "INSERT INTO backups (user_id, ciphertext, byte_size, created_at) VALUES (?, ?, ?, ?)",
    ).run(userId, ciphertext, ciphertext.byteLength, Date.now());
  });
  return { size: ciphertext.byteLength };
}

export async function readBackup(userId: string): Promise<{ bytes: Buffer; createdAt: number } | null> {
  const row = await db.prepare(
    "SELECT ciphertext, created_at FROM backups WHERE user_id = ?",
  ).get<{ ciphertext: Uint8Array; created_at: number }>(userId);
  if (!row) return null;
  return { bytes: Buffer.from(row.ciphertext), createdAt: row.created_at };
}

export async function backupMeta(userId: string): Promise<{ size: number; createdAt: number } | null> {
  const row = await db.prepare(
    "SELECT byte_size, created_at FROM backups WHERE user_id = ?",
  ).get<{ byte_size: number; created_at: number }>(userId);
  return row ? { size: row.byte_size, createdAt: row.created_at } : null;
}
