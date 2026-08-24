// Group routing. Groups are a server concept only in the routing sense
// — the server needs to know who's in a group to fan out envelopes to
// every member. Message content stays end-to-end encrypted per-member;
// the client sends one ciphertext envelope per recipient.

import { randomUUID } from "node:crypto";
import { db, type GroupRow } from "./db.js";

export function createGroup(input: {
  name: string;
  createdBy: string;
  memberIds: string[]; // must include createdBy
}): GroupRow {
  const id = randomUUID();
  const now = Date.now();
  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO groups (id, name, created_by, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, input.name, input.createdBy, now);
    const members = new Set([input.createdBy, ...input.memberIds]);
    const stmt = db.prepare(
      "INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)",
    );
    for (const uid of members) stmt.run(id, uid, now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { id, name: input.name, created_by: input.createdBy, created_at: now };
}

export function addMember(groupId: string, userId: string): boolean {
  try {
    db.prepare(
      "INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)",
    ).run(groupId, userId, Date.now());
    return true;
  } catch { return false; }
}

export function removeMember(groupId: string, userId: string) {
  db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(groupId, userId);
}

export function groupById(id: string): GroupRow | undefined {
  return db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;
}

export function membersOf(groupId: string): string[] {
  const rows = db.prepare(
    "SELECT user_id FROM group_members WHERE group_id = ?",
  ).all(groupId) as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

export function groupsForUser(userId: string): GroupRow[] {
  return db.prepare(
    `SELECT g.* FROM groups g
       JOIN group_members m ON m.group_id = g.id
      WHERE m.user_id = ?
      ORDER BY g.created_at DESC`,
  ).all(userId) as GroupRow[];
}

export function isMember(groupId: string, userId: string): boolean {
  const r = db.prepare(
    "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?",
  ).get(groupId, userId);
  return !!r;
}
