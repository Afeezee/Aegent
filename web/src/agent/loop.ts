// Agent reasoning loop. Offline rule-based planner by default; if the
// user has configured a zero-retention LLM endpoint, the same tool
// interface can be pointed at it (scaffold in runWithClaude).

import {
  draft_message, export_to_email, forward_message,
  list_reminders_tool, resolveTarget, search_messages, set_reminder,
  type PendingAction,
} from "./tools.js";

export type AgentEvent =
  | { kind: "thought"; text: string }
  | { kind: "tool_call"; name: string; args: unknown }
  | { kind: "tool_result"; name: string; value: unknown }
  | { kind: "reply"; text: string }
  | { kind: "confirm"; action: PendingAction; explain: string }
  | { kind: "error"; text: string };

export async function* runAgent(input: string): AsyncGenerator<AgentEvent> {
  const key = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (key) { yield* runWithClaude(input, key); }
  else { yield* runOffline(input); }
}

async function* runOffline(input: string): AsyncGenerator<AgentEvent> {
  const lower = input.toLowerCase();

  // --- reminder
  const remMatch = /remind (?:me )?(?:to )?(.+?)(?:\s+(?:on|at|by|in|tomorrow|next).+)?$/i.exec(input);
  if (/remind|reminder/.test(lower) && remMatch) {
    const text = remMatch[1].trim().replace(/\s+at\s+.+$/i, "").replace(/\s+in\s+.+$/i, "").replace(/\s+tomorrow.*$/i, "");
    const when = parseWhen(input) ?? new Date(Date.now() + 24 * 3600_000);
    yield { kind: "thought", text: `Setting a reminder for ${when.toLocaleString()}.` };
    const res = await set_reminder({ text, whenIso: when.toISOString() });
    if (res.ok && res.kind === "pending") yield { kind: "confirm", action: res.action, explain: res.explain };
    else if (!res.ok) yield { kind: "error", text: res.error };
    return;
  }

  // --- email export
  const emailMatch = /(?:email|send.*(?:to|via)\s*email|save.*to.*email).*?([\w.+-]+@[\w-]+\.[\w.-]+)/i.exec(input);
  if (emailMatch) {
    const addr = emailMatch[1];
    const query = input.replace(emailMatch[0], "").replace(/(?:email|send).*/i, "").trim() || "recent";
    yield { kind: "thought", text: `Finding messages about "${query}" to send to ${addr}.` };
    yield { kind: "tool_call", name: "search_messages", args: { query } };
    const s = await search_messages({ query });
    if (!s.ok || s.kind !== "data") { yield { kind: "error", text: "no matches" }; return; }
    const ids = (s.value as Array<{ id: string }>).slice(0, 5).map((h) => h.id);
    if (ids.length === 0) { yield { kind: "reply", text: `I couldn't find anything about "${query}" to send.` }; return; }
    const res = await export_to_email({ messageIds: ids, recipientEmail: addr });
    if (res.ok && res.kind === "pending") yield { kind: "confirm", action: res.action, explain: res.explain };
    else if (!res.ok) yield { kind: "error", text: res.error };
    return;
  }

  // --- forward — "forward that/the last to X saying Y"
  const forwardMatch = /forward.+?(?:to|→)\s+(\w[\w.-]*)/i.exec(input);
  if (forwardMatch) {
    const who = forwardMatch[1];
    const target = await resolveTarget(who);
    if (!target) { yield { kind: "reply", text: `I don't have a contact called "${who}".` }; return; }
    const noteMatch = /saying\s+"([^"]+)"|:\s*(.+)$/i.exec(input);
    const note = noteMatch?.[1] ?? noteMatch?.[2];
    const query = input.replace(forwardMatch[0], "").replace(/^forward\s*/i, "").replace(/(?:saying|:)\s*"?[^"]*"?$/i, "").trim() || "last";
    yield { kind: "thought", text: `Finding the message about "${query}" to forward.` };
    const s = await search_messages({ query });
    if (!s.ok || s.kind !== "data") { yield { kind: "error", text: "no match" }; return; }
    const hit = (s.value as Array<{ id: string }>)[0];
    if (!hit) { yield { kind: "reply", text: "I couldn't find a matching message." }; return; }
    const res = await forward_message({ messageId: hit.id, toPeerId: target.id, toIsGroup: target.isGroup, note });
    if (res.ok && res.kind === "pending") yield { kind: "confirm", action: res.action, explain: res.explain };
    else if (!res.ok) yield { kind: "error", text: res.error };
    return;
  }

  // --- send / tell
  const sendMatch = /(?:send|tell|message|write to)\s+([@\w.-]+)\s+(?:that|to say|saying|:)?\s*(.+)/i.exec(input);
  if (sendMatch) {
    const [, who, body] = sendMatch;
    const target = await resolveTarget(who);
    if (!target) { yield { kind: "reply", text: `I don't have a contact called "${who}".` }; return; }
    const res = await draft_message({ targetPeerId: target.id, isGroup: target.isGroup, body: body.trim() });
    if (res.ok && res.kind === "pending") yield { kind: "confirm", action: res.action, explain: res.explain };
    else if (!res.ok) yield { kind: "error", text: res.error };
    return;
  }

  // --- list reminders
  if (/reminders?\??$|what.*remind/i.test(lower)) {
    const res = await list_reminders_tool();
    if (res.ok && res.kind === "data") {
      const rs = res.value as Array<{ text: string; whenIso: string }>;
      yield { kind: "reply", text: rs.length
        ? rs.map((r) => `• ${new Date(r.whenIso).toLocaleString()} — ${r.text}`).join("\n")
        : "No reminders." };
    }
    return;
  }

  // --- default: search
  yield { kind: "thought", text: `Searching your messages for "${input}".` };
  yield { kind: "tool_call", name: "search_messages", args: { query: input } };
  const res = await search_messages({ query: input });
  yield { kind: "tool_result", name: "search_messages", value: res };
  if (res.ok && res.kind === "data") {
    const rows = res.value as Array<{ peerName: string; when: number; body: string }>;
    yield { kind: "reply", text: rows.length === 0
      ? "I didn't find anything matching that in your chats."
      : `Here's what I found:\n${rows.slice(0, 5).map((r) =>
        `• ${r.peerName} · ${new Date(r.when).toLocaleDateString()} — ${trim(r.body)}`,
      ).join("\n")}` };
  }
}

function trim(s: string, n = 140) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function parseWhen(input: string): Date | null {
  const now = new Date();
  // "in N unit" wins if present.
  const inMatch = /in\s+(\d+)\s*(min|minute|minutes|hour|hours|day|days)/i.exec(input);
  if (inMatch) {
    const n = parseInt(inMatch[1], 10);
    const unit = inMatch[2].toLowerCase();
    const ms = unit.startsWith("min") ? n * 60_000 : unit.startsWith("hour") ? n * 3600_000 : n * 86400_000;
    return new Date(Date.now() + ms);
  }
  // Time-of-day (may combine with 'tomorrow').
  let h = 9, m = 0;
  const atMatch = /at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(input);
  if (atMatch) {
    h = parseInt(atMatch[1], 10);
    m = atMatch[2] ? parseInt(atMatch[2], 10) : 0;
    const ap = atMatch[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  }
  const d = new Date(now);
  if (/tomorrow/i.test(input)) {
    d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
    return d;
  }
  if (atMatch) {
    d.setHours(h, m, 0, 0);
    if (d < now) d.setDate(d.getDate() + 1);
    return d;
  }
  return null;
}

async function* runWithClaude(input: string, apiKey: string): AsyncGenerator<AgentEvent> {
  // Scaffold only — swap in a call to a zero-retention Anthropic endpoint
  // per spec §5.2 / §8 to enable this. Falls through to the offline
  // planner meanwhile so the app never appears broken.
  void apiKey;
  yield* runOffline(input);
}
