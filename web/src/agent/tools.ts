// Agent tools — read tools run silently against the local encrypted
// store; write tools always return a *pending* action for user
// confirmation before anything happens.

import { api } from "../lib/api.js";
import { cosine, embed, tokenize } from "../lib/embeddings.js";
import {
  everyMessage, getContact, getGroup, listContacts, listGroups,
  listReminders, saveReminder,
} from "../lib/store.js";
import {
  currentSession, sendMedia, sendText,
} from "../lib/session.js";

// ---- types ----

export type PendingAction =
  | { kind: "send"; targetPeerId: string; isGroup: boolean; toDisplay: string; body: string }
  | { kind: "reminder"; text: string; whenIso: string }
  | { kind: "email"; recipientEmail: string; subject: string; body: string; leavesE2E: true };

export type ToolResult =
  | { ok: true; kind: "data"; value: unknown }
  | { ok: true; kind: "pending"; action: PendingAction; explain: string }
  | { ok: false; error: string };

// ---- read tools ----

export async function search_messages(args: {
  query: string; peerId?: string; sinceDaysAgo?: number;
}): Promise<ToolResult> {
  const qv = embed(args.query);
  const qToks = new Set(tokenize(args.query));
  const since = args.sinceDaysAgo ? Date.now() - args.sinceDaysAgo * 86400_000 : 0;
  const rows = await everyMessage();
  const hits: Array<{
    id: string; peerId: string; peerName: string; when: number;
    body: string; score: number;
  }> = [];
  const cache = new Map<string, string>();
  for (const m of rows) {
    if (m.createdAt < since) continue;
    if (args.peerId && m.peerId !== args.peerId) continue;
    if (m.deletedAt) continue;
    const text = m.editedBody ?? m.body ?? m.caption ?? "";
    if (!text) continue;
    const semantic = cosine(qv, m.embedding);
    const mToks = new Set((m.tokens || "").split(" "));
    let overlap = 0; qToks.forEach((t) => mToks.has(t) && overlap++);
    const keyword = qToks.size ? overlap / qToks.size : 0;
    const score = semantic * 0.75 + keyword * 0.25;
    if (score < 0.08) continue;
    let name = cache.get(m.peerId);
    if (!name) {
      const c = await getContact(m.peerId);
      name = c?.displayName ?? (await getGroup(m.peerId))?.name ?? "Unknown";
      cache.set(m.peerId, name);
    }
    hits.push({ id: m.id, peerId: m.peerId, peerName: name, when: m.createdAt, body: text, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return { ok: true, kind: "data", value: hits.slice(0, 8) };
}

export async function get_thread(args: { peerId: string; limit?: number }): Promise<ToolResult> {
  const rows = await everyMessage();
  const filtered = rows.filter((m) => m.peerId === args.peerId).slice(0, args.limit ?? 40);
  return { ok: true, kind: "data", value: filtered.map((m) => ({
    id: m.id, direction: m.direction, when: m.createdAt,
    body: m.editedBody ?? m.body ?? m.caption ?? (m.media ? `[${m.media.kind}]` : ""),
  })) };
}

export async function list_reminders_tool(): Promise<ToolResult> {
  return { ok: true, kind: "data", value: await listReminders() };
}

// ---- write tools (pending) ----

export async function draft_message(args: {
  targetPeerId: string; isGroup: boolean; body: string;
}): Promise<ToolResult> {
  const label = args.isGroup
    ? (await getGroup(args.targetPeerId))?.name
    : (await getContact(args.targetPeerId))?.displayName;
  if (!label) return { ok: false, error: "unknown_target" };
  return {
    ok: true, kind: "pending",
    action: { kind: "send", targetPeerId: args.targetPeerId, isGroup: args.isGroup, toDisplay: label, body: args.body },
    explain: `I'll send this to ${label}. Confirm to send.`,
  };
}

export async function forward_message(args: {
  messageId: string; toPeerId: string; toIsGroup: boolean; note?: string;
}): Promise<ToolResult> {
  const rows = await everyMessage();
  const src = rows.find((m) => m.id === args.messageId);
  if (!src) return { ok: false, error: "message_not_found" };
  const from = (await getContact(src.senderId))?.displayName ?? "someone";
  const bodyText = src.editedBody ?? src.body ?? src.caption ?? "[media]";
  const body = args.note
    ? `${args.note}\n\n— forwarded from ${from}:\n"${bodyText}"`
    : `— forwarded from ${from}:\n"${bodyText}"`;
  const targetLabel = args.toIsGroup
    ? (await getGroup(args.toPeerId))?.name
    : (await getContact(args.toPeerId))?.displayName;
  if (!targetLabel) return { ok: false, error: "unknown_target" };
  return {
    ok: true, kind: "pending",
    action: { kind: "send", targetPeerId: args.toPeerId, isGroup: args.toIsGroup, toDisplay: targetLabel, body },
    explain: `I'll forward that message to ${targetLabel}.`,
  };
}

export async function set_reminder(args: { text: string; whenIso: string }): Promise<ToolResult> {
  const when = new Date(args.whenIso);
  if (Number.isNaN(when.getTime())) return { ok: false, error: "bad_time" };
  return {
    ok: true, kind: "pending",
    action: { kind: "reminder", text: args.text, whenIso: when.toISOString() },
    explain: `I'll remind you: "${args.text}" at ${when.toLocaleString()}.`,
  };
}

export async function export_to_email(args: {
  messageIds: string[]; recipientEmail: string; note?: string;
}): Promise<ToolResult> {
  const rows = await everyMessage();
  const chosen = rows.filter((m) => args.messageIds.includes(m.id));
  if (chosen.length === 0) return { ok: false, error: "no_matching_messages" };
  chosen.sort((a, b) => a.createdAt - b.createdAt);
  const lines = await Promise.all(chosen.map(async (m) => {
    const from = m.direction === "out"
      ? "You"
      : (await getContact(m.senderId))?.displayName ?? "someone";
    const text = m.editedBody ?? m.body ?? m.caption ?? (m.media ? `[${m.media.kind}]` : "");
    return `• ${new Date(m.createdAt).toLocaleString()} — ${from}: ${text}`;
  }));
  const body = [
    args.note ?? "Sharing the following messages from Aegent:",
    "",
    ...lines,
    "",
    "— Sent via Aegent. Note: email is not encrypted the way Aegent messages are.",
  ].join("\n");
  return {
    ok: true, kind: "pending",
    action: {
      kind: "email",
      recipientEmail: args.recipientEmail,
      subject: `From Aegent (${chosen.length} message${chosen.length === 1 ? "" : "s"})`,
      body,
      leavesE2E: true,
    },
    explain: `This will leave Aegent's E2E boundary — email isn't encrypted the same way. Review before sending.`,
  };
}

// ---- executing a confirmed action ----

export async function executePending(action: PendingAction) {
  if (action.kind === "send") {
    const res = await sendText(action.targetPeerId, action.isGroup, action.body);
    return res;
  }
  if (action.kind === "reminder") {
    await saveReminder(action.text, action.whenIso);
    // Schedule a browser notification if permitted.
    schedule(action.text, action.whenIso);
    return { ok: true } as const;
  }
  if (action.kind === "email") {
    const url = `mailto:${encodeURIComponent(action.recipientEmail)}`
      + `?subject=${encodeURIComponent(action.subject)}`
      + `&body=${encodeURIComponent(action.body)}`;
    window.open(url);
    return { ok: true } as const;
  }
  return { ok: false, error: "unknown_action" } as const;
}

function schedule(text: string, whenIso: string) {
  const at = new Date(whenIso).getTime() - Date.now();
  if (at <= 0 || at > 24 * 3600_000) return;
  window.setTimeout(async () => {
    if (Notification.permission === "granted") new Notification("Aegent reminder", { body: text });
  }, at);
}

// Ensure a contact/group exists in the local store before the agent
// tries to send to them (useful for offline planner shortcuts).
export async function ensureByHandle(handle: string) {
  try {
    const u = await api.byHandle(handle);
    return u;
  } catch { return null; }
}

// Convenience: resolve a fuzzy name to a target peer/group id.
export async function resolveTarget(name: string): Promise<{ id: string; isGroup: boolean; label: string } | null> {
  const n = name.toLowerCase().trim().replace(/^@/, "");
  const contacts = await listContacts();
  const cHit = contacts.find((c) =>
    c.displayName.toLowerCase().startsWith(n) ||
    c.handle.toLowerCase().startsWith(n) ||
    c.email.toLowerCase().startsWith(n),
  );
  if (cHit) return { id: cHit.id, isGroup: false, label: cHit.displayName };
  const groups = await listGroups();
  const gHit = groups.find((g) => g.name.toLowerCase().startsWith(n));
  if (gHit) return { id: gHit.id, isGroup: true, label: gHit.name };
  return null;
}

// Utility for the offline planner: get the id of the currently signed-in user.
export function myId(): string {
  return currentSession()!.user.id;
}

// Guard: keep sendMedia live for future media-forward tool.
void sendMedia;
