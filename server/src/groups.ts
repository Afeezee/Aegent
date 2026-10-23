// Group membership, roles and moderation.
//
// Groups exist server-side for routing: the relay needs to know who is
// in one to deliver envelopes, and message content stays end-to-end
// encrypted per member. What it did NOT do until now is decide who may
// do what, which is why every permission question had to be re-answered
// ad hoc at each call site — and why several of them simply weren't.
//
// Every authorisation decision in the group surface goes through
// `requireRole` / `canPost` here. One place to read, one place to fix.
//
// Group events (added, removed, renamed…) are composed by the server and
// carry no message content. They cannot be end-to-end encrypted, because
// the server is their author — so they are kept in their own table,
// deliberately NOT written into `messages` with a synthetic sender,
// which would pollute search, previews, unread counts and every tool
// that reads a user's message history.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db, type GroupRow } from "./db.js";
import { AuthError, ForbiddenError } from "./auth.js";

// A group send is one ciphertext envelope per member, so membership size
// is a direct multiplier on every message's cost. The cap is a real
// protocol constraint, not a product preference.
export const MAX_GROUP_MEMBERS = 256;

export type Role = "owner" | "admin" | "member";
const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export type MemberRow = {
  group_id: string;
  user_id: string;
  joined_at: number;
  role: Role;
  added_by: string | null;
  muted_until: number | null;
  left_at: number | null;
};

export type GroupSettings = {
  description: string | null;
  joinMode: "closed" | "invite" | "request";
  postPolicy: "all" | "admins";
  historyPolicy: "none" | "all";
  agentPolicy: "off" | "members";
};

// ---- creation ----

export async function createGroup(input: {
  name: string;
  createdBy: string;
  memberIds: string[];
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
      "INSERT INTO groups (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, input.name, input.createdBy, now, now);
    const stmt = db.prepare(
      `INSERT INTO group_members (group_id, user_id, joined_at, role, added_by)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const uid of members) {
      await stmt.run(id, uid, now, uid === input.createdBy ? "owner" : "member", input.createdBy);
    }
  });
  await recordEvent({ groupId: id, kind: "created", actorId: input.createdBy });
  return { id, name: input.name, created_by: input.createdBy, created_at: now };
}

// ---- reads ----

export async function groupById(id: string): Promise<GroupRow | undefined> {
  return db.prepare("SELECT * FROM groups WHERE id = ?").get<GroupRow>(id);
}

export async function membersOf(groupId: string): Promise<string[]> {
  const rows = await db.prepare(
    "SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL",
  ).all<{ user_id: string }>(groupId);
  return rows.map((r) => r.user_id);
}

export async function membersWithRoles(groupId: string): Promise<Array<{
  id: string; role: Role; joinedAt: number; mutedUntil: number | null;
}>> {
  const rows = await db.prepare(
    `SELECT user_id, role, joined_at, muted_until FROM group_members
      WHERE group_id = ? AND left_at IS NULL`,
  ).all<{ user_id: string; role: Role; joined_at: number; muted_until: number | null }>(groupId);
  return rows.map((r) => ({
    id: r.user_id,
    role: r.role,
    joinedAt: Number(r.joined_at),
    mutedUntil: r.muted_until === null ? null : Number(r.muted_until),
  }));
}

export async function groupsForUser(userId: string): Promise<GroupRow[]> {
  return db.prepare(
    `SELECT g.* FROM groups g
       JOIN group_members m ON m.group_id = g.id
      WHERE m.user_id = ? AND m.left_at IS NULL
      ORDER BY g.created_at DESC`,
  ).all<GroupRow>(userId);
}

export async function isMember(groupId: string, userId: string): Promise<boolean> {
  const r = await db.prepare(
    "SELECT 1 AS one FROM group_members WHERE group_id = ? AND user_id = ? AND left_at IS NULL",
  ).get(groupId, userId);
  return !!r;
}

export async function roleOf(groupId: string, userId: string): Promise<Role | null> {
  const r = await db.prepare(
    "SELECT role FROM group_members WHERE group_id = ? AND user_id = ? AND left_at IS NULL",
  ).get<{ role: Role }>(groupId, userId);
  return r?.role ?? null;
}

export async function settingsOf(groupId: string): Promise<GroupSettings> {
  const g = await db.prepare(
    `SELECT description, join_mode, post_policy, history_policy, agent_policy
       FROM groups WHERE id = ?`,
  ).get<{
    description: string | null; join_mode: string; post_policy: string;
    history_policy: string; agent_policy: string;
  }>(groupId);
  return {
    description: g?.description ?? null,
    joinMode: (g?.join_mode as GroupSettings["joinMode"]) ?? "closed",
    postPolicy: (g?.post_policy as GroupSettings["postPolicy"]) ?? "all",
    historyPolicy: (g?.history_policy as GroupSettings["historyPolicy"]) ?? "none",
    agentPolicy: (g?.agent_policy as GroupSettings["agentPolicy"]) ?? "off",
  };
}

// ---- authorisation ----

export async function requireRole(groupId: string, userId: string, min: Role): Promise<Role> {
  const role = await roleOf(groupId, userId);
  if (!role) throw new ForbiddenError("not_a_member", "You're not in that group.");
  if (RANK[role] < RANK[min]) throw new ForbiddenError("insufficient_role", "Only admins can do that.");
  return role;
}

export async function isBanned(groupId: string, userId: string): Promise<boolean> {
  const r = await db.prepare(
    "SELECT 1 AS one FROM group_bans WHERE group_id = ? AND user_id = ?",
  ).get(groupId, userId);
  return !!r;
}

// Everything that decides whether a message may be sent, in one place:
// membership, the group's posting policy, and whether this member is
// muted. The socket path consults exactly this.
export async function canPost(groupId: string, userId: string, now = Date.now()): Promise<boolean> {
  const row = await db.prepare(
    `SELECT role, muted_until FROM group_members
      WHERE group_id = ? AND user_id = ? AND left_at IS NULL`,
  ).get<{ role: Role; muted_until: number | null }>(groupId, userId);
  if (!row) return false;
  if (row.muted_until !== null && Number(row.muted_until) > now) return false;
  const { postPolicy } = await settingsOf(groupId);
  if (postPolicy === "admins" && RANK[row.role] < RANK.admin) return false;
  return true;
}

// ---- membership changes ----

export async function addMember(
  groupId: string, userId: string, by: string, role: Role = "member",
): Promise<void> {
  if (await isBanned(groupId, userId)) {
    throw new ForbiddenError("banned", "That person was removed from this group.");
  }
  const count = (await membersOf(groupId)).length;
  if (count >= MAX_GROUP_MEMBERS) {
    throw new AuthError("too_many_members", `A group can hold at most ${MAX_GROUP_MEMBERS} members.`);
  }
  const existing = await db.prepare(
    "SELECT left_at FROM group_members WHERE group_id = ? AND user_id = ?",
  ).get<{ left_at: number | null }>(groupId, userId);

  if (existing) {
    if (existing.left_at === null) return;            // already in
    await db.prepare(
      "UPDATE group_members SET left_at = NULL, joined_at = ?, added_by = ?, role = ? WHERE group_id = ? AND user_id = ?",
    ).run(Date.now(), by, role, groupId, userId);
  } else {
    await db.prepare(
      "INSERT INTO group_members (group_id, user_id, joined_at, role, added_by) VALUES (?, ?, ?, ?, ?)",
    ).run(groupId, userId, Date.now(), role, by);
  }
  await recordEvent({ groupId, kind: "added", actorId: by, subjectId: userId });
}

// Leaving and being removed are the same row change with different
// authority, so they share one path and differ only in the event.
export async function removeMember(groupId: string, userId: string, by: string): Promise<void> {
  const role = await roleOf(groupId, userId);
  if (!role) return;
  if (role === "owner" && by !== userId) {
    throw new ForbiddenError("cannot_remove_owner", "The owner can't be removed.");
  }
  await db.prepare(
    "UPDATE group_members SET left_at = ? WHERE group_id = ? AND user_id = ?",
  ).run(Date.now(), groupId, userId);
  await db.prepare(
    "DELETE FROM group_join_requests WHERE group_id = ? AND user_id = ?",
  ).run(groupId, userId);
  await recordEvent({
    groupId, kind: by === userId ? "left" : "removed", actorId: by, subjectId: userId,
  });
}

export async function setRole(groupId: string, userId: string, role: Role, by: string): Promise<void> {
  const current = await roleOf(groupId, userId);
  if (!current) throw new AuthError("not_a_member", "They're not in that group.");
  if (current === "owner") throw new ForbiddenError("cannot_change_owner", "The owner's role can't be changed.");
  if (role === "owner") throw new ForbiddenError("cannot_grant_owner", "Ownership can't be handed out this way.");
  await db.prepare(
    "UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?",
  ).run(role, groupId, userId);
  await recordEvent({ groupId, kind: "role", actorId: by, subjectId: userId, data: { role } });
}

export async function setMuted(
  groupId: string, userId: string, until: number | null, by: string,
): Promise<void> {
  const role = await roleOf(groupId, userId);
  if (!role) throw new AuthError("not_a_member", "They're not in that group.");
  if (role === "owner") throw new ForbiddenError("cannot_mute_owner", "The owner can't be muted.");
  await db.prepare(
    "UPDATE group_members SET muted_until = ? WHERE group_id = ? AND user_id = ?",
  ).run(until, groupId, userId);
  await recordEvent({
    groupId, kind: until ? "muted" : "unmuted", actorId: by, subjectId: userId,
  });
}

export async function banMember(groupId: string, userId: string, by: string): Promise<void> {
  if ((await roleOf(groupId, userId)) === "owner") {
    throw new ForbiddenError("cannot_ban_owner", "The owner can't be banned.");
  }
  await removeMember(groupId, userId, by).catch(() => { /* may not be a member */ });
  await db.prepare(
    "INSERT INTO group_bans (group_id, user_id, banned_by, banned_at) VALUES (?, ?, ?, ?)",
  ).run(groupId, userId, by, Date.now()).catch(() => { /* already banned */ });
  await recordEvent({ groupId, kind: "banned", actorId: by, subjectId: userId });
}

export async function unbanMember(groupId: string, userId: string): Promise<void> {
  await db.prepare("DELETE FROM group_bans WHERE group_id = ? AND user_id = ?").run(groupId, userId);
}

// ---- group info ----

export async function updateGroup(groupId: string, patch: {
  name?: string; description?: string | null;
  joinMode?: GroupSettings["joinMode"];
  postPolicy?: GroupSettings["postPolicy"];
  historyPolicy?: GroupSettings["historyPolicy"];
  agentPolicy?: GroupSettings["agentPolicy"];
}, by: string): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  const push = (col: string, val: unknown) => { sets.push(`${col} = ?`); args.push(val); };
  if (patch.name !== undefined) push("name", patch.name);
  if (patch.description !== undefined) push("description", patch.description);
  if (patch.joinMode !== undefined) push("join_mode", patch.joinMode);
  if (patch.postPolicy !== undefined) push("post_policy", patch.postPolicy);
  if (patch.historyPolicy !== undefined) push("history_policy", patch.historyPolicy);
  if (patch.agentPolicy !== undefined) push("agent_policy", patch.agentPolicy);
  if (sets.length === 0) return;
  push("updated_at", Date.now());
  args.push(groupId);
  await db.prepare(`UPDATE groups SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  await recordEvent({ groupId, kind: "updated", actorId: by, data: patch });
}

// ---- invites ----
//
// The token is the capability, so only its hash is stored — the same
// shape refresh tokens use. A database leak must not hand out
// memberships.

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function mintInvite(groupId: string, by: string, opts: {
  expiresInMs?: number; maxUses?: number;
} = {}): Promise<{ token: string; id: string }> {
  const id = randomUUID();
  const raw = randomBytes(24).toString("base64url");
  await db.prepare(
    `INSERT INTO group_invites (id, group_id, token_hash, created_by, created_at, expires_at, max_uses, uses)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    id, groupId, hashToken(raw), by, Date.now(),
    opts.expiresInMs ? Date.now() + opts.expiresInMs : null,
    opts.maxUses ?? null,
  );
  return { token: `${id}.${raw}`, id };
}

export async function revokeInvite(groupId: string, inviteId: string): Promise<void> {
  await db.prepare(
    "UPDATE group_invites SET revoked_at = ? WHERE id = ? AND group_id = ?",
  ).run(Date.now(), inviteId, groupId);
}

export async function listInvites(groupId: string): Promise<Array<{
  id: string; createdAt: number; expiresAt: number | null; maxUses: number | null; uses: number;
}>> {
  const rows = await db.prepare(
    `SELECT id, created_at, expires_at, max_uses, uses FROM group_invites
      WHERE group_id = ? AND revoked_at IS NULL`,
  ).all<{ id: string; created_at: number; expires_at: number | null; max_uses: number | null; uses: number }>(groupId);
  return rows.map((r) => ({
    id: r.id,
    createdAt: Number(r.created_at),
    expiresAt: r.expires_at === null ? null : Number(r.expires_at),
    maxUses: r.max_uses === null ? null : Number(r.max_uses),
    uses: Number(r.uses),
  }));
}

// Redeeming either joins the group or files a request, depending on how
// the group is set up. A token that is expired, used up or revoked is
// refused the same way as one that never existed.
export async function redeemInvite(token: string, userId: string): Promise<{
  group: GroupRow; state: "joined" | "requested";
}> {
  const dot = token.indexOf(".");
  if (dot < 0) throw new AuthError("bad_invite", "That invite link isn't valid.");
  const id = token.slice(0, dot);
  const raw = token.slice(dot + 1);
  const row = await db.prepare("SELECT * FROM group_invites WHERE id = ?").get<{
    id: string; group_id: string; token_hash: string; expires_at: number | null;
    max_uses: number | null; uses: number; revoked_at: number | null;
  }>(id);
  const invalid = !row
    || row.token_hash !== hashToken(raw)
    || row.revoked_at !== null
    || (row.expires_at !== null && Number(row.expires_at) < Date.now())
    || (row.max_uses !== null && Number(row.uses) >= Number(row.max_uses));
  if (invalid) throw new AuthError("bad_invite", "That invite link isn't valid any more.");

  const group = await groupById(row.group_id);
  if (!group) throw new AuthError("bad_invite", "That group no longer exists.");
  if (await isBanned(group.id, userId)) {
    throw new ForbiddenError("banned", "You can't rejoin that group.");
  }
  if (await isMember(group.id, userId)) return { group, state: "joined" };

  const { joinMode } = await settingsOf(group.id);
  if (joinMode === "closed") throw new ForbiddenError("closed", "That group isn't accepting new members.");

  await db.prepare("UPDATE group_invites SET uses = uses + 1 WHERE id = ?").run(id);

  if (joinMode === "request") {
    await db.prepare(
      `INSERT INTO group_join_requests (group_id, user_id, requested_at, state)
       VALUES (?, ?, ?, 'pending')`,
    ).run(group.id, userId, Date.now()).catch(() => { /* already pending */ });
    return { group, state: "requested" };
  }

  await addMember(group.id, userId, userId);
  await recordEvent({ groupId: group.id, kind: "joined", actorId: userId });
  return { group, state: "joined" };
}

// ---- join requests ----

export async function listRequests(groupId: string): Promise<Array<{ userId: string; requestedAt: number }>> {
  const rows = await db.prepare(
    "SELECT user_id, requested_at FROM group_join_requests WHERE group_id = ? AND state = 'pending'",
  ).all<{ user_id: string; requested_at: number }>(groupId);
  return rows.map((r) => ({ userId: r.user_id, requestedAt: Number(r.requested_at) }));
}

export async function resolveRequest(
  groupId: string, userId: string, approve: boolean, by: string,
): Promise<void> {
  const row = await db.prepare(
    "SELECT 1 AS one FROM group_join_requests WHERE group_id = ? AND user_id = ? AND state = 'pending'",
  ).get(groupId, userId);
  if (!row) throw new AuthError("no_request", "There's no pending request from them.");
  await db.prepare(
    "UPDATE group_join_requests SET state = ? WHERE group_id = ? AND user_id = ?",
  ).run(approve ? "approved" : "denied", groupId, userId);
  if (approve) await addMember(groupId, userId, by);
}

// ---- epochs and archive ----
//
// The relay is a filing cabinet here: it stores wrapped keys it cannot
// open and ciphertext it cannot read, and decides only WHO may fetch
// which rows. Two gates, deliberately:
//
//   * cryptographic — a member without an epoch key cannot read that
//     epoch even if they obtain the bytes;
//   * server-side — rows from epochs you hold no key for are not served
//     at all, so the first gate never has to be the only one.

export async function currentEpoch(groupId: string): Promise<number> {
  const r = await db.prepare("SELECT epoch FROM groups WHERE id = ?").get<{ epoch: number }>(groupId);
  return Number(r?.epoch ?? 0);
}

// Which epochs this member may read. The history policy is expressed
// entirely as key distribution, so there is no separate switch to keep
// in sync with what people can actually decrypt.
export async function epochsFor(groupId: string, memberId: string): Promise<number[]> {
  const rows = await db.prepare(
    "SELECT epoch FROM group_epoch_keys WHERE group_id = ? AND member_id = ?",
  ).all<{ epoch: number }>(groupId, memberId);
  return rows.map((r) => Number(r.epoch)).sort((a, b) => a - b);
}

export async function grantEpochKeys(groupId: string, by: string, grants: Array<{
  memberId: string; epoch: number; wrappedKey: string;
}>): Promise<void> {
  const stmt = db.prepare(
    `INSERT INTO group_epoch_keys (group_id, epoch, member_id, wrapped_key, granted_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const g of grants) {
    await stmt.run(groupId, g.epoch, g.memberId, g.wrappedKey, by, Date.now()).catch(() => {
      /* already granted — re-granting the same epoch is a no-op */
    });
  }
}

// Start a new epoch. Called when somebody leaves or is removed, so that
// whatever is said next is sealed with a key they do not have.
export async function rotateEpoch(groupId: string, by: string, grants: Array<{
  memberId: string; wrappedKey: string;
}>): Promise<number> {
  const next = (await currentEpoch(groupId)) + 1;
  await db.tx(async () => {
    await db.prepare("UPDATE groups SET epoch = ? WHERE id = ?").run(next, groupId);
    const stmt = db.prepare(
      `INSERT INTO group_epoch_keys (group_id, epoch, member_id, wrapped_key, granted_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const g of grants) {
      await stmt.run(groupId, next, g.memberId, g.wrappedKey, by, Date.now()).catch(() => { /* dupe */ });
    }
  });
  await recordEvent({ groupId, kind: "epoch", actorId: by, data: { epoch: next } });
  return next;
}

export async function archiveMessage(input: {
  groupId: string; epoch: number; senderId: string; msgId: string;
  ciphertext: string; createdAt: number;
}): Promise<void> {
  await db.prepare(
    `INSERT INTO group_archive (id, group_id, epoch, sender_id, msg_id, ciphertext, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(), input.groupId, input.epoch, input.senderId,
    input.msgId, input.ciphertext, input.createdAt,
  ).catch(() => { /* already archived: msg_id is unique per group */ });
}

export type ArchiveRow = {
  id: string; epoch: number; sender_id: string; msg_id: string;
  ciphertext: string; created_at: number;
};

// Serve only what this member holds a key for, and only from the point
// their history begins. `history_from` is set when they join: null means
// everything they have keys for, a timestamp means from then on.
export async function groupArchiveFor(groupId: string, memberId: string, page: {
  since?: number; afterId?: string; limit?: number;
}): Promise<ArchiveRow[]> {
  const limit = Math.min(Math.max(page.limit ?? 200, 1), 500);
  const tail: unknown[] = [];
  let keyset = "";
  if (page.afterId) {
    keyset = " AND (a.created_at > ? OR (a.created_at = ? AND a.id > ?))";
    tail.push(page.since ?? 0, page.since ?? 0, page.afterId);
  } else if (page.since) {
    keyset = " AND a.created_at >= ?";
    tail.push(page.since);
  }
  return db.prepare(
    `SELECT a.id, a.epoch, a.sender_id, a.msg_id, a.ciphertext, a.created_at
       FROM group_archive a
       JOIN group_epoch_keys k
         ON k.group_id = a.group_id AND k.epoch = a.epoch AND k.member_id = ?
       JOIN group_members m
         ON m.group_id = a.group_id AND m.user_id = ? AND m.left_at IS NULL
      WHERE a.group_id = ?
        AND a.created_at >= COALESCE(m.history_from, 0)${keyset}
      ORDER BY a.created_at ASC, a.id ASC
      LIMIT ${limit}`,
  ).all<ArchiveRow>(memberId, memberId, groupId, ...tail);
}

// Where this member's readable history starts. Set at join time from the
// group's policy: 'all' means from the beginning, anything else means
// from now.
export async function setHistoryFrom(groupId: string, userId: string, from: number | null): Promise<void> {
  await db.prepare(
    "UPDATE group_members SET history_from = ? WHERE group_id = ? AND user_id = ?",
  ).run(from, groupId, userId);
}

// ---- events ----

export async function recordEvent(e: {
  groupId: string; kind: string; actorId: string; subjectId?: string; data?: unknown;
}): Promise<void> {
  await db.tx(async () => {
    const max = await db.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM group_events WHERE group_id = ?",
    ).get<{ seq: number }>(e.groupId);
    await db.prepare(
      `INSERT INTO group_events (id, group_id, seq, kind, actor_id, subject_id, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), e.groupId, Number(max?.seq ?? 0) + 1, e.kind, e.actorId,
      e.subjectId ?? null, e.data === undefined ? null : JSON.stringify(e.data), Date.now(),
    );
  });
}

export async function eventsSince(groupId: string, sinceSeq: number): Promise<Array<{
  seq: number; kind: string; actorId: string; subjectId: string | null; data: unknown; createdAt: number;
}>> {
  const rows = await db.prepare(
    `SELECT seq, kind, actor_id, subject_id, data, created_at FROM group_events
      WHERE group_id = ? AND seq > ? ORDER BY seq ASC LIMIT 500`,
  ).all<{
    seq: number; kind: string; actor_id: string; subject_id: string | null;
    data: string | null; created_at: number;
  }>(groupId, sinceSeq);
  return rows.map((r) => ({
    seq: Number(r.seq),
    kind: r.kind,
    actorId: r.actor_id,
    subjectId: r.subject_id,
    data: r.data ? JSON.parse(r.data) : null,
    createdAt: Number(r.created_at),
  }));
}
