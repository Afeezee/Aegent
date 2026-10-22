// Group routing. Groups exist server-side only for fan-out — the server
// needs to know who's in a group to route envelopes. Message *content*
// stays end-to-end encrypted per member; the client sends one ciphertext
// envelope per recipient.

import { randomUUID } from "node:crypto";
import { db, type GroupRow } from "./db.js";
import { AuthError } from "./auth.js";

// A group send is one ciphertext envelope per member, so membership size
// is a direct multiplier on every message's cost. The cap is a real
// protocol constraint, not a product preference.
export const MAX_GROUP_MEMBERS = 256;

export async function createGroup(input: {
  name: string;
  createdBy: string;
  memberIds: string[]; // must include createdBy
}): Promise<GroupRow> {
  const id = randomUUID();
  const now = Date.now();

  // Validate before inserting. The foreign key alone is not enough:
  // addMember swallows constraint errors, and the two backends differ on
  // whether they enforce FKs at all, so an unknown id could become a
  // silently-missing member instead of an error.
  const members = Array.from(new Set([input.createdBy, ...input.memberIds]));
  if (members.length > MAX_GROUP_MEMBERS) {
    throw new AuthError("too_many_members", `A group can hold at most ${MAX_GROUP_MEMBERS} members.`);
  }
  for (const uid of members) {
    const row = await db.prepare("SELECT 1 AS one FROM users WHERE id = ?").get(uid);
    if (!row) throw new AuthError("unknown_member", "One of those members no longer exists.");
  }

  await db.tx(async () => {
    await db.prepare(
      "INSERT INTO groups (id, name, created_by, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, input.name, input.createdBy, now);
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
