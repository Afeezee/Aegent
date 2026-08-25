// Group routing. Groups exist server-side only for fan-out — the server
// needs to know who's in a group to route envelopes. Message *content*
// stays end-to-end encrypted per member; the client sends one ciphertext
// envelope per recipient.

import { randomUUID } from "node:crypto";
import { db, type GroupRow } from "./db.js";

export async function createGroup(input: {
  name: string;
  createdBy: string;
  memberIds: string[]; // must include createdBy
}): Promise<GroupRow> {
  const id = randomUUID();
  const now = Date.now();
  await db.tx(async () => {
    await db.prepare(
      "INSERT INTO groups (id, name, created_by, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, input.name, input.createdBy, now);
    const members = new Set([input.createdBy, ...input.memberIds]);
    const stmt = db.prepare(
      "INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)",
    );
    for (const uid of members) await stmt.run(id, uid, now);
  });
  return { id, name: input.name, created_by: input.createdBy, created_at: now };
}

export async function addMember(groupId: string, userId: string): Promise<boolean> {
  try {
    await db.prepare(
      "INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)",
    ).run(groupId, userId, Date.now());
    return true;
  } catch { return false; }
}

export async function removeMember(groupId: string, userId: string) {
  await db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(groupId, userId);
}

export async function groupById(id: string): Promise<GroupRow | undefined> {
  return db.prepare("SELECT * FROM groups WHERE id = ?").get<GroupRow>(id);
}

export async function membersOf(groupId: string): Promise<string[]> {
  const rows = await db.prepare(
    "SELECT user_id FROM group_members WHERE group_id = ?",
  ).all<{ user_id: string }>(groupId);
  return rows.map((r) => r.user_id);
}

export async function groupsForUser(userId: string): Promise<GroupRow[]> {
  return db.prepare(
    `SELECT g.* FROM groups g
       JOIN group_members m ON m.group_id = g.id
      WHERE m.user_id = ?
      ORDER BY g.created_at DESC`,
  ).all<GroupRow>(userId);
}

export async function isMember(groupId: string, userId: string): Promise<boolean> {
  const r = await db.prepare(
    "SELECT 1 AS one FROM group_members WHERE group_id = ? AND user_id = ?",
  ).get(groupId, userId);
  return !!r;
}
