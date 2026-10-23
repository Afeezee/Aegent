// Agent tools — the full set the on-device agent draws on.
//
// Two rules, always:
//   READ tools return data straight to the caller (agent loop or the
//   offline planner). They run silently against the local encrypted
//   store; no network beyond what the store already does.
//
//   WRITE tools NEVER execute their side effect. They return a
//   `{ ok: true, kind: "pending", action, explain }` result and the
//   UI stages a confirm card. The user's tap in that card is the
//   ONLY thing that actually sends a message, sets a reminder,
//   schedules a backup, opens an email compose, or edits/deletes.
//
// Adding a new tool: implement the async function, register it in
// llm.ts's TOOLS array with its JSON schema + description, and (if
// helpful) teach the offline planner to route to it too.

import { api } from "../lib/api.js";
import { b64, secretBoxOpenBytes } from "../lib/crypto.js";
import { cosine, embed, tokenize } from "../lib/embeddings.js";
import {
  addScheduledBackup, deleteReminder, everyMessage, getContact, getGroup,
  listContacts, listGroups, listReminders, markThreadRead, saveReminder,
  threadWith, updateMessageMedia, upsertContact, type OpenedMessage,
} from "../lib/store.js";
import {
  currentSession, sendDelete, sendMedia, sendText,
} from "../lib/session.js";
import { saveContactToPhone } from "../lib/contacts-integration.js";
import { noteAgentUse } from "./usage.js";

import {
  assertInScope, budget, filterInScope, inScope,
} from "./policy.js";

// Every retrieval in this file reads through these two, never through
// the store directly. The model chooses what to ask for; it does not get
// to choose what it is allowed to see.
async function scopedEveryMessage(): Promise<OpenedMessage[]> {
  return filterInScope(await everyMessage());
}

async function scopedThreadWith(peerId: string, limit: number): Promise<OpenedMessage[]> {
  assertInScope(peerId);
  return threadWith(peerId, limit);
}

// Everything the model is shown passes through the turn's budget. Row
// counts were already capped per tool; message bodies never were, so a
// single summarise could ship hundreds of complete messages off-device.
const decorate = (async (rows: OpenedMessage[], ...rest: unknown[]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (decorateRaw as any)(budget(rows), ...rest)) as typeof decorateRaw;

// ---- types ----

export type PendingAction =
  | { kind: "send"; targetPeerId: string; isGroup: boolean; toDisplay: string; body: string; replyTo?: { id: string; preview: string; author: string } }
  | { kind: "reminder"; text: string; whenIso: string }
  | {
      kind: "email";
      recipientEmail: string;
      subject: string;
      body: string;
      leavesE2E: true;
      // Optional pre-decrypted attachments that ride along on
      // confirm. Files are held in memory only for the duration of
      // the confirm card — on cancel or successful send, they're
      // dropped and any decrypted bytes go with them.
      attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }>;
    }
  | { kind: "delete"; targetPeerId: string; isGroup: boolean; targetMsgId: string; preview: string }
  | { kind: "schedule_send"; targetPeerId: string; isGroup: boolean; toDisplay: string; body: string; whenIso: string }
  | { kind: "calendar_event"; title: string; whenIso: string; durationMin: number; notes?: string }
  | { kind: "add_contact"; handle: string; displayName: string; explain: string }
  | { kind: "save_contact_to_phone"; displayName: string; handle: string; email: string; phone: string | null }
  | { kind: "schedule_backup"; peerId: string; peerLabel: string; recipientEmail: string; whenIso: string; note?: string };

export type ToolResult =
  | { ok: true; kind: "data"; value: unknown }
  | { ok: true; kind: "pending"; action: PendingAction; explain: string }
  | { ok: false; error: string };

// ---- retrieval helpers (shared across search tools) ----

async function scoreAllMessages(
  query: string,
  filter: (m: OpenedMessage) => boolean = () => true,
): Promise<Array<OpenedMessage & { score: number }>> {
  const qv = embed(query);
  const qToks = new Set(tokenize(query));
  const rows = await scopedEveryMessage();
  const scored: Array<OpenedMessage & { score: number }> = [];
  for (const m of rows) {
    if (m.deletedAt) continue;
    if (!filter(m)) continue;
    const text = m.editedBody ?? m.body ?? m.caption ?? "";
    if (!text && !m.media) continue;
    const semantic = m.embedding.length ? cosine(qv, m.embedding) : 0;
    const mToks = new Set((m.tokens || "").split(" "));
    let overlap = 0; qToks.forEach((t) => mToks.has(t) && overlap++);
    const keyword = qToks.size ? overlap / qToks.size : 0;
    // Rerank: hybrid score + gentle recency bonus so ties break newer.
    const recencyBonus = Math.max(0, 1 - (Date.now() - m.createdAt) / (365 * 86400_000)) * 0.05;
    const score = semantic * 0.7 + keyword * 0.25 + recencyBonus;
    if (score < 0.06) continue;
    scored.push({ ...m, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// Adds thread-context metadata (peer name, whether it's a group) to
// hits so the agent gets useful strings back rather than raw ids.
async function decorateRaw(rows: Array<OpenedMessage & { score?: number }>) {
  const cache = new Map<string, { name: string; isGroup: boolean }>();
  const out = [];
  for (const m of rows) {
    let meta = cache.get(m.peerId);
    if (!meta) {
      const c = await getContact(m.peerId);
      if (c) meta = { name: c.displayName, isGroup: false };
      else {
        const g = await getGroup(m.peerId);
        meta = g ? { name: g.name, isGroup: true } : { name: "Unknown", isGroup: false };
      }
      cache.set(m.peerId, meta);
    }
    const senderName = m.senderId === currentSession()?.user.id
      ? "You"
      : (await getContact(m.senderId))?.displayName ?? "Someone";
    out.push({
      id: m.id, peerId: m.peerId, peerName: meta.name, isGroup: meta.isGroup,
      senderId: m.senderId, senderName,
      when: m.createdAt, whenISO: new Date(m.createdAt).toISOString(),
      body: m.editedBody ?? m.body ?? m.caption ?? (m.media ? `[${m.media.kind}]` : ""),
      mediaKind: m.media?.kind ?? null,
      score: m.score,
      readAt: m.readAt, deliveredAt: m.deliveredAt,
      edited: !!m.editedBody, hasReplyTo: !!m.replyTo,
    });
  }
  // Record exactly what is about to be shown to the model this turn, so
  // the UI can tell the person afterwards.
  noteAgentUse(out.map((r) => ({
    id: r.id, peerName: r.senderName === "You" ? `${r.peerName} (you)` : r.peerName,
    when: new Date(r.when).toLocaleString(), body: r.body,
  })));
  return out;
}

// ---- retrieval tools ----

export async function search_messages(args: {
  query: string;
  peerId?: string;
  sinceDaysAgo?: number;
  senderId?: string;
  mediaKind?: "image" | "video" | "audio" | "voice" | "file";
  limit?: number;
}): Promise<ToolResult> {
  const since = args.sinceDaysAgo ? Date.now() - args.sinceDaysAgo * 86400_000 : 0;
  const rows = await scoreAllMessages(args.query, (m) => {
    if (args.peerId && m.peerId !== args.peerId) return false;
    if (args.senderId && m.senderId !== args.senderId) return false;
    if (args.mediaKind && m.media?.kind !== args.mediaKind) return false;
    if (since && m.createdAt < since) return false;
    return true;
  });
  return { ok: true, kind: "data", value: await decorate(rows.slice(0, args.limit ?? 8)) };
}

// Exact substring / phrase — bypasses semantic scoring for cases where
// the user typed the exact string they remember ("that Zoom link", "the
// order number ending 7291").
export async function search_exact(args: { needle: string; peerId?: string; limit?: number }): Promise<ToolResult> {
  const n = args.needle.trim().toLowerCase();
  if (!n) return { ok: true, kind: "data", value: [] };
  const rows = (await scopedEveryMessage()).filter((m) => {
    if (m.deletedAt) return false;
    if (args.peerId && m.peerId !== args.peerId) return false;
    const text = (m.editedBody ?? m.body ?? m.caption ?? "").toLowerCase();
    return text.includes(n);
  });
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return { ok: true, kind: "data", value: await decorate(rows.slice(0, args.limit ?? 20)) };
}

export async function search_by_date_range(args: {
  fromIso: string; toIso: string; peerId?: string; query?: string; limit?: number;
}): Promise<ToolResult> {
  const from = Date.parse(args.fromIso), to = Date.parse(args.toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return { ok: false, error: "bad_date" };
  const filter = (m: OpenedMessage) =>
    m.createdAt >= from && m.createdAt <= to
    && (!args.peerId || m.peerId === args.peerId);
  const rows = args.query
    ? (await scoreAllMessages(args.query, filter))
    : (await scopedEveryMessage()).filter(filter).sort((a, b) => b.createdAt - a.createdAt).map((m) => ({ ...m, score: 1 }));
  return { ok: true, kind: "data", value: await decorate(rows.slice(0, args.limit ?? 30)) };
}

export async function search_by_sender(args: { senderId: string; query?: string; limit?: number }): Promise<ToolResult> {
  const filter = (m: OpenedMessage) => m.senderId === args.senderId;
  const rows = args.query
    ? await scoreAllMessages(args.query, filter)
    : (await scopedEveryMessage()).filter(filter).sort((a, b) => b.createdAt - a.createdAt).map((m) => ({ ...m, score: 1 }));
  return { ok: true, kind: "data", value: await decorate(rows.slice(0, args.limit ?? 30)) };
}

export async function search_by_media_type(args: {
  kind: "image" | "video" | "audio" | "voice" | "file"; peerId?: string; limit?: number;
}): Promise<ToolResult> {
  const rows = (await scopedEveryMessage()).filter((m) =>
    !m.deletedAt && m.media?.kind === args.kind && (!args.peerId || m.peerId === args.peerId),
  ).sort((a, b) => b.createdAt - a.createdAt).map((m) => ({ ...m, score: 1 }));
  return { ok: true, kind: "data", value: await decorate(rows.slice(0, args.limit ?? 30)) };
}

// Look for messages containing a URL/phone/email pattern.
export async function search_links_and_patterns(args: { pattern: "link" | "phone" | "email"; peerId?: string; limit?: number }): Promise<ToolResult> {
  const re = args.pattern === "link" ? /https?:\/\/\S+/i
    : args.pattern === "email" ? /[\w.+-]+@[\w-]+\.[\w.-]+/i
    : /(\+?\d[\d\s()\-.]{6,}\d)/;
  const rows = (await scopedEveryMessage()).filter((m) => {
    if (m.deletedAt) return false;
    if (args.peerId && m.peerId !== args.peerId) return false;
    const text = m.editedBody ?? m.body ?? m.caption ?? "";
    return re.test(text);
  }).sort((a, b) => b.createdAt - a.createdAt).map((m) => ({ ...m, score: 1 }));
  return { ok: true, kind: "data", value: await decorate(rows.slice(0, args.limit ?? 30)) };
}

export async function get_thread(args: { peerId: string; limit?: number }): Promise<ToolResult> {
  const rows = await scopedThreadWith(args.peerId, args.limit ?? 40);
  return { ok: true, kind: "data", value: await decorate(rows.map((m) => ({ ...m }))) };
}

// N messages surrounding a specific match, useful for follow-up
// questions like "what did they say right after that?".
export async function get_context_around(args: { messageId: string; before?: number; after?: number }): Promise<ToolResult> {
  const rows = await scopedEveryMessage();
  const idx = rows.findIndex((m) => m.id === args.messageId);
  if (idx < 0) return { ok: false, error: "message_not_found" };
  const before = args.before ?? 3, after = args.after ?? 3;
  const peer = rows[idx].peerId;
  const same = rows.filter((m) => m.peerId === peer).sort((a, b) => a.createdAt - b.createdAt);
  const j = same.findIndex((m) => m.id === args.messageId);
  const slice = same.slice(Math.max(0, j - before), j + 1 + after);
  return { ok: true, kind: "data", value: await decorate(slice.map((m) => ({ ...m }))) };
}

export async function get_message_metadata(args: { messageId: string }): Promise<ToolResult> {
  const rows = await scopedEveryMessage();
  const m = rows.find((x) => x.id === args.messageId);
  if (!m) return { ok: false, error: "message_not_found" };
  const decorated = (await decorate([{ ...m }]))[0];
  return { ok: true, kind: "data", value: decorated };
}

export async function get_last_message(args: { peerId: string }): Promise<ToolResult> {
  const rows = await scopedThreadWith(args.peerId, 1000);
  const last = rows[rows.length - 1];
  if (!last) return { ok: true, kind: "data", value: null };
  return { ok: true, kind: "data", value: (await decorate([{ ...last }]))[0] };
}

export async function get_unread_count(args: { peerId?: string }): Promise<ToolResult> {
  const rows = await scopedEveryMessage();
  let count = 0;
  const perPeer: Record<string, number> = {};
  for (const m of rows) {
    if (m.direction !== "in" || m.readAt) continue;
    if (args.peerId && m.peerId !== args.peerId) continue;
    count++;
    perPeer[m.peerId] = (perPeer[m.peerId] ?? 0) + 1;
  }
  return { ok: true, kind: "data", value: { total: count, perPeer } };
}

export async function get_shared_media(args: {
  peerId: string; kind?: "image" | "video" | "audio" | "voice" | "file"; limit?: number;
}): Promise<ToolResult> {
  const rows = (await scopedThreadWith(args.peerId, 5000)).filter(
    (m) => !m.deletedAt && m.media && (!args.kind || m.media.kind === args.kind),
  ).sort((a, b) => b.createdAt - a.createdAt).slice(0, args.limit ?? 30);
  return { ok: true, kind: "data", value: rows.map((m) => ({
    id: m.id, when: m.createdAt, whenISO: new Date(m.createdAt).toISOString(),
    kind: m.media!.kind, mime: m.media!.mime, byteSize: m.media!.byteSize,
    filename: m.media!.filename, caption: m.caption,
    durationMs: m.media!.durationMs,
  })) };
}

export async function list_reminders_tool(): Promise<ToolResult> {
  return { ok: true, kind: "data", value: await listReminders() };
}

// Very lightweight summarization: fetch a thread + hand raw text back
// to the caller, who is expected to summarize. When the LLM path runs
// this, the LLM produces the summary.
export async function summarize_thread(args: {
  peerId?: string; fromIso?: string; toIso?: string; maxMessages?: number;
}): Promise<ToolResult> {
  let rows: OpenedMessage[];
  if (args.peerId) {
    rows = await scopedThreadWith(args.peerId, args.maxMessages ?? 300);
  } else {
    rows = await scopedEveryMessage();
    if (args.fromIso) rows = rows.filter((m) => m.createdAt >= Date.parse(args.fromIso!));
    if (args.toIso) rows = rows.filter((m) => m.createdAt <= Date.parse(args.toIso!));
    rows.sort((a, b) => a.createdAt - b.createdAt);
    rows = rows.slice(0, args.maxMessages ?? 300);
  }
  return { ok: true, kind: "data", value: await decorate(rows.map((m) => ({ ...m }))) };
}

// Contact-profile lookup — for questions like "who is @ada".
export async function contact_profile(args: { peerId?: string; handle?: string; email?: string; phone?: string }): Promise<ToolResult> {
  if (args.peerId) {
    const c = await getContact(args.peerId);
    if (!c) return { ok: false, error: "unknown" };
    return { ok: true, kind: "data", value: c };
  }
  if (args.handle) {
    try { return { ok: true, kind: "data", value: await api.byHandle(args.handle) }; }
    catch { return { ok: false, error: "unknown" }; }
  }
  if (args.email) {
    try { return { ok: true, kind: "data", value: await api.byEmail(args.email) }; }
    catch { return { ok: false, error: "unknown" }; }
  }
  if (args.phone) {
    try { return { ok: true, kind: "data", value: await api.byPhone(args.phone) }; }
    catch { return { ok: false, error: "unknown" }; }
  }
  return { ok: false, error: "no_identifier" };
}

// ---- write tools (pending — nothing executes until user confirms) ----

export async function draft_message(args: {
  targetPeerId: string; isGroup: boolean; body: string;
  replyToMessageId?: string;
}): Promise<ToolResult> {
  const label = args.isGroup
    ? (await getGroup(args.targetPeerId))?.name
    : (await getContact(args.targetPeerId))?.displayName;
  if (!label) return { ok: false, error: "unknown_target" };
  let replyTo: { id: string; preview: string; author: string } | undefined;
  if (args.replyToMessageId) {
    const rows = await scopedEveryMessage();
    const src = rows.find((m) => m.id === args.replyToMessageId);
    if (src) {
      replyTo = {
        id: src.id,
        preview: (src.editedBody ?? src.body ?? src.caption ?? "").slice(0, 120),
        author: (await getContact(src.senderId))?.displayName ?? "Someone",
      };
    }
  }
  return {
    ok: true, kind: "pending",
    action: { kind: "send", targetPeerId: args.targetPeerId, isGroup: args.isGroup, toDisplay: label, body: args.body, replyTo },
    explain: replyTo
      ? `I'll reply to ${label} referencing that earlier message. Confirm to send.`
      : `I'll send this to ${label}. Confirm to send.`,
  };
}

export async function reply_to_message(args: { targetMessageId: string; body: string }): Promise<ToolResult> {
  const rows = await scopedEveryMessage();
  const src = rows.find((m) => m.id === args.targetMessageId);
  if (!src) return { ok: false, error: "message_not_found" };
  const isGroup = !!(await getGroup(src.peerId));
  return draft_message({
    targetPeerId: src.peerId, isGroup, body: args.body,
    replyToMessageId: args.targetMessageId,
  });
}

export async function forward_message(args: {
  messageId: string; toPeerId: string; toIsGroup: boolean; note?: string;
}): Promise<ToolResult> {
  const rows = await scopedEveryMessage();
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

// Tone-adjust: return a rephrased draft. Purely mechanical rewriting
// isn't the agent's strong suit; when the LLM is available it does the
// rewrite before calling draft_message. Offline mode returns a naive
// prefix so the user isn't left empty-handed.
export async function tone_adjust(args: {
  text: string; tone: "firmer" | "softer" | "warmer" | "shorter" | "more_formal" | "more_casual";
}): Promise<ToolResult> {
  const prefix = {
    firmer: "To be clear: ",
    softer: "Just wanted to check: ",
    warmer: "Hey! ",
    shorter: "",
    more_formal: "Dear team, ",
    more_casual: "Hey — ",
  }[args.tone];
  const rewritten = args.tone === "shorter"
    ? args.text.split(/[.!?]/)[0].trim() + "."
    : prefix + args.text;
  return { ok: true, kind: "data", value: { rewritten } };
}

export async function set_reminder(args: {
  text: string; whenIso: string; tiedToMessageId?: string;
}): Promise<ToolResult> {
  const when = new Date(args.whenIso);
  if (Number.isNaN(when.getTime())) return { ok: false, error: "bad_time" };
  let hint = "";
  if (args.tiedToMessageId) {
    const rows = await scopedEveryMessage();
    const src = rows.find((m) => m.id === args.tiedToMessageId);
    if (src) {
      const from = (await getContact(src.senderId))?.displayName ?? "you";
      hint = ` (about “${(src.editedBody ?? src.body ?? src.caption ?? "").slice(0, 60)}” from ${from})`;
    }
  }
  return {
    ok: true, kind: "pending",
    action: { kind: "reminder", text: args.text + hint, whenIso: when.toISOString() },
    explain: `I'll remind you: "${args.text}" at ${when.toLocaleString()}.`,
  };
}

export async function schedule_message(args: {
  targetPeerId: string; isGroup: boolean; body: string; whenIso: string;
}): Promise<ToolResult> {
  const when = new Date(args.whenIso);
  if (Number.isNaN(when.getTime())) return { ok: false, error: "bad_time" };
  const label = args.isGroup
    ? (await getGroup(args.targetPeerId))?.name
    : (await getContact(args.targetPeerId))?.displayName;
  if (!label) return { ok: false, error: "unknown_target" };
  return {
    ok: true, kind: "pending",
    action: {
      kind: "schedule_send",
      targetPeerId: args.targetPeerId, isGroup: args.isGroup,
      toDisplay: label, body: args.body, whenIso: when.toISOString(),
    },
    explain: `I'll send "${args.body.slice(0, 60)}" to ${label} at ${when.toLocaleString()}.`,
  };
}

export async function mark_thread_read(args: { peerId: string }): Promise<ToolResult> {
  const ids = await markThreadRead(args.peerId);
  return { ok: true, kind: "data", value: { markedRead: ids.length } };
}

export async function delete_message_tool(args: { messageId: string }): Promise<ToolResult> {
  const rows = await scopedEveryMessage();
  const src = rows.find((m) => m.id === args.messageId);
  if (!src) return { ok: false, error: "message_not_found" };
  if (src.senderId !== currentSession()?.user.id) {
    return { ok: false, error: "not_your_message" };
  }
  const isGroup = !!(await getGroup(src.peerId));
  const preview = (src.editedBody ?? src.body ?? src.caption ?? "[media]").slice(0, 80);
  return {
    ok: true, kind: "pending",
    action: { kind: "delete", targetPeerId: src.peerId, isGroup, targetMsgId: src.id, preview },
    explain: `Delete "${preview}" for everyone?`,
  };
}

export async function create_calendar_event(args: {
  title: string; whenIso: string; durationMin?: number; notes?: string;
}): Promise<ToolResult> {
  const when = new Date(args.whenIso);
  if (Number.isNaN(when.getTime())) return { ok: false, error: "bad_time" };
  return {
    ok: true, kind: "pending",
    action: {
      kind: "calendar_event",
      title: args.title, whenIso: when.toISOString(),
      durationMin: args.durationMin ?? 30, notes: args.notes,
    },
    explain: `Add "${args.title}" to your calendar for ${when.toLocaleString()}?`,
  };
}

// "Notes" are just reminders with far-future dates + a note tag; keeps
// the storage simple. If you eventually want a proper notes table, add
// one and swap this in-place.
export async function create_note(args: { title: string; body: string }): Promise<ToolResult> {
  return {
    ok: true, kind: "pending",
    action: {
      kind: "reminder",
      // Encode as a note by placing far in the future so it doesn't fire.
      text: `📝 ${args.title}\n${args.body}`,
      whenIso: new Date(Date.now() + 100 * 365 * 86400_000).toISOString(),
    },
    explain: `Save note "${args.title}"?`,
  };
}

export async function add_contact_by_handle(args: { handle: string }): Promise<ToolResult> {
  try {
    const u = await api.byHandle(args.handle);
    return {
      ok: true, kind: "pending",
      action: { kind: "add_contact", handle: u.handle, displayName: u.displayName, explain: `Add @${u.handle} (${u.displayName}) to your contacts?` },
      explain: `Add @${u.handle} (${u.displayName}) to your contacts?`,
    };
  } catch { return { ok: false, error: "not_found" }; }
}

export async function save_contact_to_phone(args: { peerId: string }): Promise<ToolResult> {
  const c = await getContact(args.peerId);
  if (!c) return { ok: false, error: "unknown" };
  return {
    ok: true, kind: "pending",
    action: {
      kind: "save_contact_to_phone",
      displayName: c.displayName, handle: c.handle,
      email: c.email, phone: c.phone,
    },
    explain: `Export ${c.displayName}'s contact card to your phone contacts?`,
  };
}

export async function export_to_email(args: {
  messageIds: string[]; recipientEmail: string; note?: string;
}): Promise<ToolResult> {
  const rows = await scopedEveryMessage();
  const chosen = rows.filter((m) => args.messageIds.includes(m.id));
  if (chosen.length === 0) return { ok: false, error: "no_matching_messages" };
  chosen.sort((a, b) => a.createdAt - b.createdAt);

  // Decrypt referenced media inline so they can ride along as real
  // attachments. Skip anything that fails to fetch/decrypt — the
  // body still lists the message with its type/caption.
  const attachments: Array<{ name: string; mime: string; bytes: Uint8Array }> = [];
  for (const m of chosen) {
    if (!m.media) continue;
    try {
      const enc = await api.downloadBlob(m.media.blobId);
      const pt = secretBoxOpenBytes(b64.decode(m.media.contentKey), enc);
      attachments.push({
        name: uniqueName(attachments, m.media.filename ?? `${m.media.kind}-${m.id.slice(0, 6)}${extForMime(m.media.mime)}`),
        mime: m.media.mime || "application/octet-stream",
        bytes: pt,
      });
    } catch (e) {
      console.warn("[export_to_email] attach fetch failed", m.id, e);
    }
  }

  const lines = await Promise.all(chosen.map(async (m) => {
    const from = m.direction === "out"
      ? "You"
      : (await getContact(m.senderId))?.displayName ?? "someone";
    const text = m.editedBody ?? m.body ?? m.caption ?? "";
    const mediaTag = m.media
      ? ` [${m.media.kind}${m.media.filename ? `: ${m.media.filename}` : ""}]`
      : "";
    return `• ${new Date(m.createdAt).toLocaleString()} — ${from}: ${text}${mediaTag}`;
  }));
  const attachSummary = attachments.length
    ? `\nAttachments (${attachments.length}): ${attachments.map((a) => a.name).join(", ")}`
    : "";
  const body = [
    args.note ?? "Sharing the following messages from Aegent:",
    "",
    ...lines,
    attachSummary,
    "",
    "— Sent via Aegent. Note: email is not encrypted the way Aegent messages are.",
  ].join("\n");
  return {
    ok: true, kind: "pending",
    action: {
      kind: "email",
      recipientEmail: args.recipientEmail,
      subject: `From Aegent (${chosen.length} message${chosen.length === 1 ? "" : "s"})`,
      body, leavesE2E: true,
      attachments: attachments.length ? attachments : undefined,
    },
    explain: attachments.length
      ? `Prepared ${chosen.length} messages + ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}. Email leaves Aegent's E2E boundary — review before sending.`
      : `This will leave Aegent's E2E boundary — email isn't encrypted the same way. Review before sending.`,
  };
}

// Suffix-collision helper so two files with the same name don't
// overwrite each other in the outgoing share bundle.
function uniqueName(existing: Array<{ name: string }>, want: string): string {
  const taken = new Set(existing.map((x) => x.name.toLowerCase()));
  if (!taken.has(want.toLowerCase())) return want;
  const dot = want.lastIndexOf(".");
  const stem = dot > 0 ? want.slice(0, dot) : want;
  const ext = dot > 0 ? want.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const c = `${stem}-${i}${ext}`;
    if (!taken.has(c.toLowerCase())) return c;
  }
  return `${stem}-${Date.now()}${ext}`;
}

function downloadFiles(files: File[]): void {
  // Trigger a Save dialog for each file. Small stagger so browsers
  // don't collapse them into "you are downloading multiple files"
  // permission prompts on the same tick.
  files.forEach((f, i) => {
    setTimeout(() => {
      const url = URL.createObjectURL(f);
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, i * 120);
  });
}

// Build an RFC-5322 `.eml` file with attachments so desktop mail
// clients (Outlook, Apple Mail, Thunderbird, Windows Mail) open a
// pre-filled draft with the files already attached. Double-clicking
// the downloaded .eml on any desktop OS opens the default mail app
// and creates a new message from it — the true "Web Share L2 with
// files, for PC" fallback.
function buildEml(opts: {
  from?: string;
  to: string;
  subject: string;
  body: string;
  attachments: Array<{ name: string; mime: string; bytes: Uint8Array }>;
}): Blob {
  // Random boundary that will not appear inside the body or any
  // base64 payload (base64 has no `=` runs mid-line, and our marker
  // is prefixed with `=_` which base64 never emits).
  const boundary = `=_aegent_${crypto.randomUUID().replace(/-/g, "")}`;
  const CRLF = "\r\n";
  const headers = [
    opts.from ? `From: ${opts.from}` : null,
    `To: ${opts.to}`,
    `Subject: ${quotedPrintableHeader(opts.subject)}`,
    "MIME-Version: 1.0",
    "X-Unsent: 1", // Outlook honours this — opens as a draft, not "sent"
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean).join(CRLF);

  const parts: string[] = [];
  // Text body part.
  parts.push([
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    opts.body,
  ].join(CRLF));

  // Each attachment as its own base64-encoded part.
  for (const a of opts.attachments) {
    parts.push([
      `--${boundary}`,
      `Content-Type: ${a.mime || "application/octet-stream"}; name="${mimeSafeName(a.name)}"`,
      `Content-Disposition: attachment; filename="${mimeSafeName(a.name)}"`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Wrap(u8ToBase64(a.bytes)),
    ].join(CRLF));
  }
  parts.push(`--${boundary}--${CRLF}`);

  const eml = headers + CRLF + CRLF + parts.join(CRLF) + CRLF;
  return new Blob([eml], { type: "message/rfc822" });
}

function u8ToBase64(bytes: Uint8Array): string {
  // btoa can't handle Uint8Array directly; chunk to avoid stack
  // overflow on multi-MB attachments (spread operator arg cap).
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

// RFC 2045: base64 body lines must be ≤76 chars.
function base64Wrap(s: string): string {
  return s.replace(/(.{76})/g, "$1\r\n");
}

function sanitizeStem(s: string): string {
  return s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "message";
}

function mimeSafeName(n: string): string {
  // Strip anything a header can't carry unquoted; keep letters,
  // digits, common punctuation, spaces. Quoted string in Content-
  // Disposition handles the rest.
  return n.replace(/["\r\n]/g, "_");
}

// Encode non-ASCII subjects as RFC 2047 base64 word so Outlook /
// Apple Mail render Unicode correctly.
function quotedPrintableHeader(s: string): string {
  // ASCII fast path — most subjects.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  const utf8 = new TextEncoder().encode(s);
  return `=?UTF-8?B?${u8ToBase64(utf8)}?=`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function extForMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
    "video/mp4": ".mp4", "video/webm": ".webm",
    "audio/webm": ".webm", "audio/mp4": ".m4a", "audio/mpeg": ".mp3", "audio/ogg": ".ogg",
    "application/pdf": ".pdf", "text/plain": ".txt", "text/csv": ".csv",
    "application/json": ".json", "application/zip": ".zip",
  };
  return map[mime] ?? "";
}

// ---- backup: whole thread → email (existing) ----

export async function backup_thread(args: {
  peerId: string; recipientEmail: string; note?: string;
  sinceDaysAgo?: number;
}): Promise<ToolResult> {
  const label = (await getContact(args.peerId))?.displayName
    ?? (await getGroup(args.peerId))?.name;
  if (!label) return { ok: false, error: "unknown_thread" };
  const isGroup = !!(await getGroup(args.peerId));
  const since = args.sinceDaysAgo ? Date.now() - args.sinceDaysAgo * 86400_000 : 0;
  const rows = (await scopedThreadWith(args.peerId, 5000))
    .filter((m) => !m.deletedAt && m.createdAt >= since);
  if (rows.length === 0) return { ok: false, error: "empty_thread" };

  const nameOf = new Map<string, string>();
  nameOf.set(myId(), "You");
  for (const m of rows) {
    if (nameOf.has(m.senderId)) continue;
    const c = await getContact(m.senderId);
    nameOf.set(m.senderId, c?.displayName ?? "Someone");
  }
  const lines = rows.map((m) => {
    const when = new Date(m.createdAt).toLocaleString();
    const who = nameOf.get(m.senderId) ?? "Someone";
    let body: string;
    if (m.media) {
      const size = m.media.byteSize > 1e6
        ? `${(m.media.byteSize / 1e6).toFixed(1)}MB`
        : `${Math.round(m.media.byteSize / 1024)}KB`;
      const label = m.media.kind === "voice" && m.media.durationMs
        ? `voice ${Math.round(m.media.durationMs / 1000)}s`
        : `${m.media.kind} ${size}`;
      body = `[${label}${m.caption ? ` — ${m.caption}` : ""}]`;
    } else {
      body = m.editedBody ?? m.body ?? "";
    }
    return `[${when}] ${who}: ${body}`;
  });

  const header = [
    args.note ?? `Aegent backup of ${isGroup ? "group" : "conversation"} with ${label}.`,
    `Messages: ${rows.length}`,
    `Range: ${new Date(rows[0].createdAt).toLocaleString()} — ${new Date(rows[rows.length - 1].createdAt).toLocaleString()}`,
    "",
  ].join("\n");
  // Decrypt every media file in the thread and pack them as
  // attachments, so a backup email actually carries the photos /
  // voice notes / documents — not just a manifest of them.
  const attachments: Array<{ name: string; mime: string; bytes: Uint8Array }> = [];
  for (const m of rows) {
    if (!m.media) continue;
    try {
      const enc = await api.downloadBlob(m.media.blobId);
      const pt = secretBoxOpenBytes(b64.decode(m.media.contentKey), enc);
      attachments.push({
        name: uniqueName(attachments, m.media.filename ?? `${m.media.kind}-${m.id.slice(0, 6)}${extForMime(m.media.mime)}`),
        mime: m.media.mime || "application/octet-stream",
        bytes: pt,
      });
    } catch (e) {
      console.warn("[backup_thread] media fetch failed", m.id, e);
    }
  }

  const footer = [
    "",
    "— Sent via Aegent. Note: email is not end-to-end encrypted the way Aegent messages are.",
    attachments.length
      ? `  ${attachments.length} attachment${attachments.length === 1 ? "" : "s"} included.`
      : "  Media is referenced by type — the encrypted files stay on your device.",
  ].join("\n");
  const body = header + lines.join("\n") + footer;

  return {
    ok: true, kind: "pending",
    action: {
      kind: "email",
      recipientEmail: args.recipientEmail,
      subject: `Aegent backup: ${label} (${rows.length} messages)`,
      body, leavesE2E: true,
      attachments: attachments.length ? attachments : undefined,
    },
    explain: attachments.length
      ? `I've compiled ${rows.length} messages + ${attachments.length} attachment${attachments.length === 1 ? "" : "s"} from ${label}. Email isn't E2E encrypted — review before sending.`
      : `I've compiled ${rows.length} messages from ${label}. Email isn't E2E encrypted — review before sending.`,
  };
}

export async function schedule_backup(args: {
  peerId: string; recipientEmail: string; whenIso: string; note?: string;
}): Promise<ToolResult> {
  const when = new Date(args.whenIso);
  if (Number.isNaN(when.getTime())) return { ok: false, error: "bad_time" };
  const label = (await getContact(args.peerId))?.displayName
    ?? (await getGroup(args.peerId))?.name;
  if (!label) return { ok: false, error: "unknown_thread" };

  // Stage it. This used to write the schedule straight to the store and
  // report success, so the model could arrange an export of a whole
  // thread to an arbitrary email address with no confirmation — the card
  // only appeared later, when it fired. Every other write in this file
  // returns `pending`; this one escaped the gate.
  return {
    ok: true, kind: "pending",
    action: {
      kind: "schedule_backup",
      peerId: args.peerId,
      peerLabel: label,
      recipientEmail: args.recipientEmail,
      whenIso: when.toISOString(),
      note: args.note,
    },
    explain: `Schedule a backup of ${label} to ${args.recipientEmail} for ${when.toLocaleString()}. Email isn't E2E encrypted — you'll get a second confirm card when it fires.`,
  };
}

// ---- voice-note transcription (on-device Whisper) ----
//
// Fetches the encrypted voice-note blob, decrypts locally, runs the
// audio through the on-device Whisper pipeline, and stores the
// transcript back on the message. Read-only in effect — the transcript
// is a derived index over data the user already has, not a new
// outbound message — so no confirm gate needed.

export async function transcribe_voice(args: { messageId: string }): Promise<ToolResult> {
  const rows = await scopedEveryMessage();
  const msg = rows.find((m) => m.id === args.messageId);
  if (!msg) return { ok: false, error: "message_not_found" };
  if (!msg.media || msg.media.kind !== "voice") return { ok: false, error: "not_a_voice_note" };
  if (msg.media.transcript) return { ok: true, kind: "data", value: { transcript: msg.media.transcript, cached: true } };

  try {
    const { transcribeAudio } = await import("../lib/transcribe.js");
    // Fetch the encrypted bytes ourselves and decrypt with the ref's
    // content key. Avoids going through objectUrlFor which returns
    // an ObjectURL (extra copy) and then fetching that URL.
    const enc = await api.downloadBlob(msg.media.blobId);
    const pt = secretBoxOpenBytes(b64.decode(msg.media.contentKey), enc);
    const { text } = await transcribeAudio(pt);
    if (text) {
      // Persist onto the message so future queries hit cache AND the
      // search index picks it up on the next re-tokenise.
      await updateMessageMedia(args.messageId, { transcript: text });
    }
    return { ok: true, kind: "data", value: { transcript: text, cached: false } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---- read_media ----
//
// Give the LLM the *content* of an attachment message, not just its
// metadata. Routes on MIME so a single tool covers images, PDFs, and
// text-based files with the right transport in each case:
//
//   - image/*                 → vision content block (Claude 5's native OCR)
//   - application/pdf         → extract text on-device with pdfjs-dist
//                                (works for text-based PDFs; scanned/image
//                                PDFs get a note that we'd need OCR)
//   - text/* + json/xml/csv/  → decode as UTF-8, cap to ~200 KB of chars
//     tsv/etc                    (Anthropic's context window handles a
//                                 whole receipt or short doc; longer docs
//                                 get truncated with a marker so the model
//                                 knows there's more)
//   - anything else           → refuse cleanly ("we don't parse .docx yet;
//                                send as PDF or plain text")
//
// The LLM loop unpacks the `_agent_image` / `_agent_text` markers and
// builds the right Anthropic content blocks. Nothing about this path
// leaves the device except the specific bytes handed to the LLM for
// this one turn.

const MAX_INLINE_IMAGE_MB = 4.5;   // Anthropic vision cap
const MAX_INLINE_TEXT_CHARS = 200_000;

export async function read_media(args: { messageId: string; question?: string }): Promise<ToolResult> {
  const rows = await scopedEveryMessage();
  const msg = rows.find((m) => m.id === args.messageId);
  if (!msg) return { ok: false, error: "message_not_found" };
  if (!msg.media) return { ok: false, error: "message_has_no_media" };
  const media = msg.media;
  const senderName = msg.direction === "out" ? "you" : ((await getContact(msg.senderId))?.displayName ?? "someone");
  const meta = {
    senderName,
    when: msg.createdAt,
    caption: msg.caption ?? undefined,
    question: args.question,
    filename: media.filename,
    mime: media.mime,
  };

  try {
    const enc = await api.downloadBlob(media.blobId);
    const pt = secretBoxOpenBytes(b64.decode(media.contentKey), enc);

    // Images → hand pixels to Claude vision.
    if (media.kind === "image" || media.mime.startsWith("image/")) {
      if (media.byteSize > MAX_INLINE_IMAGE_MB * 1024 * 1024) {
        return { ok: false, error: `image too large for inline vision (${(media.byteSize/1024/1024).toFixed(1)} MB > ${MAX_INLINE_IMAGE_MB} MB)` };
      }
      return { ok: true, kind: "data", value: {
        _agent_image: { mime: media.mime || "image/jpeg", base64: b64.encode(pt) },
        ...meta,
      }};
    }

    // PDFs → extract text on-device.
    if (media.mime === "application/pdf") {
      const text = await extractPdfText(pt);
      if (!text || text.trim().length === 0) {
        return { ok: true, kind: "data", value: {
          _agent_text: "[PDF has no extractable text — appears to be a scanned image. On-device OCR isn't wired for PDFs yet; ask the user to send a text PDF or a photo of the page.]",
          ...meta,
        }};
      }
      const truncated = text.length > MAX_INLINE_TEXT_CHARS;
      return { ok: true, kind: "data", value: {
        _agent_text: truncated
          ? text.slice(0, MAX_INLINE_TEXT_CHARS) + `\n\n[…document truncated. Original length: ${text.length} chars.]`
          : text,
        ...meta,
        pdfPages: (await countPdfPages(pt).catch(() => undefined)),
      }};
    }

    // DOCX / XLSX / PPTX → parse to text on-device. Each parser is
    // lazy-imported so a user who never asks the agent to read an
    // Office file doesn't pay the ~1 MB bundle cost.
    const officeText = await tryExtractOffice(pt, media.mime, media.filename);
    if (officeText !== null) {
      if (!officeText.text.trim()) {
        return { ok: true, kind: "data", value: {
          _agent_text: `[${officeText.kind} appears to be empty or contains only images/embeds — no extractable text.]`,
          ...meta,
        }};
      }
      const truncated = officeText.text.length > MAX_INLINE_TEXT_CHARS;
      return { ok: true, kind: "data", value: {
        _agent_text: truncated
          ? officeText.text.slice(0, MAX_INLINE_TEXT_CHARS) + `\n\n[…${officeText.kind} truncated. Original length: ${officeText.text.length} chars.]`
          : officeText.text,
        ...meta,
      }};
    }

    // Text-based formats → decode and inline.
    if (isTextish(media.mime, media.filename)) {
      // Reject huge text files defensively (a 5 MB CSV shouldn't blow
      // out the LLM context; ask the user for a slice).
      if (media.byteSize > 5 * 1024 * 1024) {
        return { ok: false, error: `${media.filename ?? "text file"} is ${(media.byteSize/1024/1024).toFixed(1)} MB — send a smaller slice.` };
      }
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(pt);
      const truncated = decoded.length > MAX_INLINE_TEXT_CHARS;
      return { ok: true, kind: "data", value: {
        _agent_text: truncated
          ? decoded.slice(0, MAX_INLINE_TEXT_CHARS) + `\n\n[…file truncated. Original length: ${decoded.length} chars.]`
          : decoded,
        ...meta,
      }};
    }

    // Everything else — be honest about what we don't parse.
    return { ok: false, error: `Can't analyze ${media.mime}. Aegent reads images, PDFs, DOCX / XLSX / PPTX / CSV, and plain-text files. Archives (zip, rar, 7z) aren't unpacked on device.` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---- helpers ----

function isTextish(mime: string, filename?: string): boolean {
  if (mime.startsWith("text/")) return true;
  const textishMimes = new Set([
    "application/json", "application/xml", "application/x-yaml", "application/yaml",
    "application/x-log", "application/x-sh", "application/javascript",
    "application/csv", "text/csv",
  ]);
  if (textishMimes.has(mime)) return true;
  // Extension fallback for anything the picker mis-labelled.
  const ext = filename?.split(".").pop()?.toLowerCase() ?? "";
  return ["txt", "md", "log", "csv", "tsv", "json", "yaml", "yml", "xml", "srt", "ini", "toml"].includes(ext);
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  // Lazy-import — 500 KB of pdfjs never lands in the bundle for users
  // who don't ask the agent to read a PDF.
  const pdfjs = await import("pdfjs-dist");
  // pdfjs v6 needs a worker — we tell it to use the fake worker path
  // so it runs on the main thread. Voice-note-sized docs (a receipt,
  // a memo) parse in <500 ms; heavier docs will hitch briefly. For
  // large docs the truncation in read_media caps output anyway.
  (pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = "";
  const doc = await pdfjs.getDocument({ data: bytes } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = content.items
      .map((it) => (it as { str?: string }).str ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (line) parts.push(`--- Page ${i} ---\n${line}`);
  }
  await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
  return parts.join("\n\n");
}

// Route to the right Office parser based on MIME (with filename
// fallback because Android pickers sometimes hand back a generic
// application/octet-stream). Returns null if this isn't an Office
// file we know how to unpack; the caller then continues to the
// text-ish / refuse branches.
async function tryExtractOffice(
  bytes: Uint8Array,
  mime: string,
  filename?: string,
): Promise<{ text: string; kind: "docx" | "xlsx" | "pptx" } | null> {
  const ext = filename?.split(".").pop()?.toLowerCase() ?? "";
  const isDocx = mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || ext === "docx";
  const isXlsx = mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || ext === "xlsx" || ext === "xls";
  const isPptx = mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || ext === "pptx";
  if (isDocx) return { kind: "docx", text: await extractDocxText(bytes) };
  if (isXlsx) return { kind: "xlsx", text: await extractXlsxText(bytes) };
  if (isPptx) return { kind: "pptx", text: await extractPptxText(bytes) };
  return null;
}

async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  // Mammoth wants an ArrayBuffer; take a defensive copy so pdfjs (or
  // anything else running against the same bytes) isn't disrupted.
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
  return value.trim();
}

async function extractXlsxText(bytes: Uint8Array): Promise<string> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(bytes, { type: "array" });
  // For each sheet, emit CSV — compact enough for the LLM context and
  // preserves cell relationships. Headed with the sheet name.
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]).trim();
    if (csv) parts.push(`--- Sheet: ${name} ---\n${csv}`);
  }
  return parts.join("\n\n");
}

async function extractPptxText(bytes: Uint8Array): Promise<string> {
  // PPTX = zip of XML. We only pull text out of slide<N>.xml files.
  // Notes and comments could also be added if needed later.
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const slideNames = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    // slide1.xml, slide2.xml, ..., slide10.xml — numeric-ordered.
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml$/)![1]) - Number(b.match(/slide(\d+)\.xml$/)![1]));
  const parts: string[] = [];
  for (let i = 0; i < slideNames.length; i++) {
    const xml = await zip.file(slideNames[i])!.async("string");
    const text = pptxTextFromXml(xml);
    if (text.trim()) parts.push(`--- Slide ${i + 1} ---\n${text.trim()}`);
  }
  return parts.join("\n\n");
}

function pptxTextFromXml(xml: string): string {
  // OpenXML text lives in <a:t>…</a:t> runs inside <a:p> paragraphs.
  // Collect the runs paragraph-by-paragraph so line breaks survive.
  const paragraphs = xml.split(/<a:p[\s>]/i).slice(1);
  return paragraphs.map((para) => {
    const runs = [...para.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)];
    return runs.map((r) => decodeXmlEntities(r[1])).join("").trim();
  }).filter(Boolean).join("\n");
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

async function countPdfPages(bytes: Uint8Array): Promise<number | undefined> {
  try {
    const pdfjs = await import("pdfjs-dist");
    (pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = "";
    const doc = await pdfjs.getDocument({ data: bytes } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;
    const n = doc.numPages;
    await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
    return n;
  } catch { return undefined; }
}

// Backwards-compatible alias — an older LLM prompt cached the old
// tool name. Delegates to the general path.
export const describe_image = read_media;

// ---- general-assistant tools ----

export async function calculate(args: { expression: string }): Promise<ToolResult> {
  // Very deliberately narrow: numbers, operators, parens, decimal points.
  // Never evaluate arbitrary strings via Function() — expression cleared
  // first, and even then wrapped in a Function('return (...)') to keep
  // the ambient scope hidden.
  const cleaned = args.expression.replace(/[^0-9+\-*/().% \t]/g, "");
  if (!cleaned || cleaned !== args.expression.replace(/\s+/g, "").replace(/(\d)\s+(\d)/g, "$1$2") && !/[0-9]/.test(cleaned)) {
    return { ok: false, error: "expression_rejected" };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const v = new Function(`"use strict"; return (${cleaned});`)();
    if (typeof v !== "number" || !isFinite(v)) return { ok: false, error: "not_a_number" };
    return { ok: true, kind: "data", value: { result: v } };
  } catch { return { ok: false, error: "evaluation_failed" }; }
}

// ---- executing a confirmed action ----

export async function executePending(action: PendingAction) {
  if (action.kind === "send") {
    const res = await sendText(action.targetPeerId, action.isGroup, action.body, action.replyTo);
    return res;
  }
  if (action.kind === "reminder") {
    await saveReminder(action.text, action.whenIso);
    schedule(action.text, action.whenIso);
    return { ok: true } as const;
  }
  if (action.kind === "email") {
    // Four tiers, best-first — every platform gets attachments:
    //
    //  1. Web Share Level 2 with `files` — mobile Android/iOS + a
    //     handful of desktop Chromium builds. Native share sheet
    //     hands the file straight to Gmail/Outlook/etc.
    //  2. `.eml` download (PC/Mac fallback) — a proper RFC-5322
    //     multipart message with the attachments embedded. Double-
    //     clicking the download opens the default mail client
    //     (Outlook, Apple Mail, Thunderbird, Windows Mail) with the
    //     draft pre-filled AND the files attached. This is the
    //     "Web Share L2 with files, for PC" equivalent.
    //  3. Web Share without files — desktops with `.share` but no
    //     file support, and the user cancelled/refused the .eml.
    //  4. `mailto:` + individual file downloads — last resort.
    const files: File[] = (action.attachments ?? []).map((a) => new File(
      [a.bytes as BlobPart], a.name, { type: a.mime },
    ));
    const nav = navigator as unknown as {
      canShare?: (data: ShareData) => boolean;
      share?: (data: ShareData) => Promise<void>;
    };
    const canShareFiles = files.length > 0
      && !!nav.canShare && nav.canShare({ files });
    const from = currentSession()?.user.email;

    // Tier 1: native share sheet with files (mobile).
    if (canShareFiles) {
      try {
        await nav.share!({
          title: action.subject,
          text: `To: ${action.recipientEmail}\n\n${action.body}`,
          files,
        });
        return { ok: true } as const;
      } catch (e) {
        if ((e as Error).name !== "AbortError") console.warn("[email] share files failed:", e);
        // Fall through to .eml — attachments matter more than the sheet.
      }
    }

    // Tier 2: .eml with attachments (desktop, and any mobile that
    // couldn't share files above). If there are no files we skip
    // straight to Web Share / mailto so we don't force a download
    // for a plain-text email.
    if (files.length) {
      try {
        const eml = buildEml({
          from,
          to: action.recipientEmail,
          subject: action.subject,
          body: action.body,
          attachments: action.attachments!,
        });
        const emlName = `aegent-${sanitizeStem(action.subject)}.eml`;
        downloadBlob(eml, emlName);
        return { ok: true } as const;
      } catch (e) {
        console.warn("[email] .eml build failed:", e);
        // Fall through — worst case the user gets mailto + separate
        // downloads instead.
      }
    }

    // Tier 3: Web Share without files (desktop compose UI).
    if (nav.share) {
      try {
        await nav.share({
          title: action.subject,
          text: `To: ${action.recipientEmail}\n\n${action.body}`,
        });
        return { ok: true } as const;
      } catch (e) {
        if ((e as Error).name !== "AbortError") console.warn("[email] share failed:", e);
      }
    }

    // Tier 4: mailto: + drop attachments to Downloads.
    if (files.length) downloadFiles(files);
    const url = `mailto:${encodeURIComponent(action.recipientEmail)}`
      + `?subject=${encodeURIComponent(action.subject)}`
      + `&body=${encodeURIComponent(action.body + (files.length ? `\n\n(${files.length} attachment${files.length === 1 ? "" : "s"} downloaded — drag into the email.)` : ""))}`;
    window.open(url);
    return { ok: true } as const;
  }
  if (action.kind === "delete") {
    await sendDelete(action.targetPeerId, action.isGroup, action.targetMsgId);
    return { ok: true } as const;
  }
  if (action.kind === "schedule_send") {
    // Simple in-memory schedule using setTimeout + a persisted reminder as
    // the crash-safety net. For a real schedule-send you'd want the same
    // scheduledBackups-style persistence.
    const at = new Date(action.whenIso).getTime() - Date.now();
    if (at > 0 && at < 24 * 3600_000) {
      window.setTimeout(() => {
        sendText(action.targetPeerId, action.isGroup, action.body).catch(() => { /* silent */ });
      }, at);
    }
    await saveReminder(`Send to ${action.toDisplay}: "${action.body.slice(0, 40)}"`, action.whenIso);
    return { ok: true } as const;
  }
  if (action.kind === "calendar_event") {
    // Data-URL ICS so any calendar app on the platform picks it up.
    const dt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z/, "Z");
    const start = new Date(action.whenIso);
    const end = new Date(start.getTime() + action.durationMin * 60_000);
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Aegent//EN",
      "BEGIN:VEVENT",
      `UID:${crypto.randomUUID()}@aegent`,
      `DTSTAMP:${dt(new Date())}`,
      `DTSTART:${dt(start)}`,
      `DTEND:${dt(end)}`,
      `SUMMARY:${(action.title || "").replace(/[\r\n]/g, " ")}`,
      action.notes ? `DESCRIPTION:${action.notes.replace(/[\r\n]/g, "\\n")}` : "",
      "END:VEVENT", "END:VCALENDAR",
    ].filter(Boolean).join("\r\n");
    const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${(action.title || "event").replace(/[^\w]+/g, "_")}.ics`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return { ok: true } as const;
  }
  if (action.kind === "add_contact") {
    try {
      const u = await api.byHandle(action.handle);
      await upsertContact({
        id: u.id, email: u.email, phone: u.phone ?? null, handle: u.handle,
        displayName: u.displayName, publicKey: u.publicKey,
        lastSeenAt: Date.now(), online: u.presence?.online,
      });
      return { ok: true } as const;
    } catch { return { ok: false, error: "lookup_failed" } as const; }
  }
  if (action.kind === "schedule_backup") {
    await addScheduledBackup({
      peerId: action.peerId,
      peerLabel: action.peerLabel,
      recipientEmail: action.recipientEmail,
      whenIso: action.whenIso,
      note: action.note,
    });
    await saveReminder(`Backup ${action.peerLabel} to ${action.recipientEmail}`, action.whenIso);
    return { ok: true } as const;
  }

  if (action.kind === "save_contact_to_phone") {
    await saveContactToPhone({
      displayName: action.displayName, handle: action.handle,
      email: action.email, phone: action.phone,
    });
    return { ok: true } as const;
  }
  return { ok: false, error: "unknown_action" } as const;
}

async function schedule(text: string, whenIso: string) {
  const when = new Date(whenIso);
  const at = when.getTime() - Date.now();
  if (at <= 0 || at > 30 * 86400_000) return;
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    let perm = await LocalNotifications.checkPermissions();
    if (perm.display !== "granted") {
      perm = await LocalNotifications.requestPermissions();
      if (perm.display !== "granted") throw new Error("perm_denied");
    }
    await LocalNotifications.schedule({
      notifications: [{
        id: Math.floor(Date.now() / 1000) % 2147483647,
        title: "Aegent reminder", body: text,
        schedule: { at: when },
        smallIcon: "ic_stat_icon_config_sample",
      }],
    });
    return;
  } catch { /* fall through */ }
  window.setTimeout(async () => {
    try {
      if (Notification.permission !== "granted") {
        const r = await Notification.requestPermission();
        if (r !== "granted") return;
      }
      new Notification("Aegent reminder", { body: text });
    } catch { /* ignore */ }
  }, at);
}

// Ensure a contact/group exists in the local store before the agent
// tries to send to them (useful for offline planner shortcuts).
export async function ensureByHandle(handle: string) {
  try { return await api.byHandle(handle); }
  catch { return null; }
}

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

export function myId(): string { return currentSession()!.user.id; }

// keep import live for future media-forward
void sendMedia; void deleteReminder;
