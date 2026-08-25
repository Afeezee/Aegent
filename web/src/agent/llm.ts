// LLM-mode tool loop.
//
// Contract with the server: /api/agent/turn is a thin proxy for the
// Anthropic Messages API. This file owns the loop:
//
//   1. Assemble the tools' JSON-schema definitions.
//   2. POST the current turn (messages + tools) to /api/agent/turn.
//   3. If Claude replies with tool_use blocks, execute them *locally*
//      against the encrypted store, package the results as
//      tool_result blocks, and go around again.
//   4. Loop until Claude replies without tool_use (stop_reason
//      "end_turn"), or the safety cap is hit.
//
// Read tools return their data straight to Claude. Write tools stage a
// pending action in the UI (via the yielded 'confirm' event) and return
// {staged: true, ...} to Claude — the actual send/reminder/email is
// gated on the user's explicit confirmation in the card.
//
// The retrieval-locality invariant from spec §5.2 still holds: only the
// matched messages ever leave the device, and only inside the LLM turn.

import { api } from "../lib/api.js";
import {
  backup_thread, draft_message, export_to_email, forward_message,
  list_reminders_tool, resolveTarget, schedule_backup, search_messages,
  set_reminder,
  type PendingAction,
} from "./tools.js";
import type { AgentEvent } from "./loop.js";

// ---- tool definitions (Anthropic tool-use schema) ----

const TOOLS = [
  {
    name: "search_messages",
    description:
      "Semantic + keyword search across every conversation in the user's local encrypted store. Use this to find message(s) about a topic, or to answer 'when did X happen'. Returns the top matches with their IDs.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The topic or phrase to look for (natural language is fine)." },
        peerId: { type: "string", description: "Optional: restrict to one conversation (contact id or group id)." },
        sinceDaysAgo: { type: "number", description: "Optional: only consider messages from the last N days." },
      },
      required: ["query"],
    },
  },
  {
    name: "resolve_target",
    description:
      "Given a fuzzy name, @handle, or email fragment, find the matching contact or group. Call this to convert 'Ada' or '@ada' into a stable id before drafting or forwarding.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "list_reminders",
    description: "List all reminders the user currently has scheduled.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "draft_message",
    description:
      "Stage a message to send to a contact or group. This DOES NOT send it — it surfaces a confirm card the user must approve. Use resolve_target first to get the target id.",
    input_schema: {
      type: "object",
      properties: {
        targetPeerId: { type: "string" },
        isGroup: { type: "boolean" },
        body: { type: "string" },
      },
      required: ["targetPeerId", "isGroup", "body"],
    },
  },
  {
    name: "forward_message",
    description:
      "Stage a forward of an existing message to a contact or group with an optional note. Requires the source message id (from search_messages) and the target id (from resolve_target). Surfaces a confirm card, does not send.",
    input_schema: {
      type: "object",
      properties: {
        messageId: { type: "string" },
        toPeerId: { type: "string" },
        toIsGroup: { type: "boolean" },
        note: { type: "string" },
      },
      required: ["messageId", "toPeerId", "toIsGroup"],
    },
  },
  {
    name: "set_reminder",
    description:
      "Stage a reminder. Surfaces a confirm card, does not schedule until the user confirms.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        whenIso: {
          type: "string",
          description: "ISO 8601 timestamp for when the reminder should fire.",
        },
      },
      required: ["text", "whenIso"],
    },
  },
  {
    name: "export_to_email",
    description:
      "Stage an email that compiles specific messages (by id, from search_messages) into a body. Surfaces a confirm card that warns the user this leaves Aegent's E2E boundary — do not send silently.",
    input_schema: {
      type: "object",
      properties: {
        messageIds: { type: "array", items: { type: "string" } },
        recipientEmail: { type: "string" },
        note: { type: "string" },
      },
      required: ["messageIds", "recipientEmail"],
    },
  },
  {
    name: "backup_thread",
    description:
      "Compile an entire conversation (with a contact or group) into a plaintext email, oldest first. Prefer this over export_to_email when the user says 'backup', 'archive', or 'save the chat'. Media is referenced by type — the encrypted media itself doesn't leave the app. Surfaces a confirm card; does not send until the user approves.",
    input_schema: {
      type: "object",
      properties: {
        peerId: { type: "string", description: "The contact id or group id whose thread to back up." },
        recipientEmail: { type: "string" },
        note: { type: "string", description: "Optional intro line placed at the top of the backup email." },
        sinceDaysAgo: { type: "number", description: "Optional: only include messages from the last N days." },
      },
      required: ["peerId", "recipientEmail"],
    },
  },
  {
    name: "schedule_backup",
    description:
      "Schedule a backup_thread to fire at a chosen time. Persists locally; the user will see a confirm card the next time the app is open at or after that time. Use whenever the user says 'backup at X', 'every night', 'later today'.",
    input_schema: {
      type: "object",
      properties: {
        peerId: { type: "string" },
        recipientEmail: { type: "string" },
        whenIso: { type: "string", description: "ISO 8601 timestamp for when the backup should fire." },
        note: { type: "string" },
      },
      required: ["peerId", "recipientEmail", "whenIso"],
    },
  },
] as const;

const SYSTEM_PROMPT = `You are Aegent's on-device assistant — warm, brief, and precise.

Context you can trust:
The user's messages are end-to-end encrypted. Retrieval happens locally on their device via the tools below; you only see what a tool returns.

Rules that do not bend:
Write tools (draft_message, forward_message, set_reminder, export_to_email, backup_thread, schedule_backup) never send or execute on their own — they stage a confirm card the user must approve. When one returns {staged: true, ...}, tell the user in one sentence that you've prepared it and ask them to confirm the card. Never re-invoke the same staged action.
Prefer resolve_target before draft_message or forward_message.
Prefer search_messages before forward_message or export_to_email so you can hand over a specific message id.
Email export and backup cross the E2E boundary — mention that in one short clause.

Voice:
Answer like a person, not a document. Short sentences. Plain prose.
Only use bullets or headings when you have three or more genuinely separate items — never for two-item answers or single facts.
Never restate a tool's raw output; summarise what matters and move on.
If you did not find something, say so directly. Don't invent detail.
Skip preambles ("Sure!", "Of course!"). Skip trailing offers ("let me know if…"). Just answer.

Today's date is ${new Date().toISOString().slice(0, 10)}. Convert relative times ("tomorrow", "next Monday", "in an hour") into concrete ISO timestamps in the user's local timezone.`;

// ---- types coming back from Anthropic ----

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

type Response = {
  id: string;
  role: "assistant";
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage?: unknown;
};

type Message = { role: "user" | "assistant"; content: unknown };

// ---- the loop ----

const MAX_TURNS = 6;

export async function* runLlm(userInput: string): AsyncGenerator<AgentEvent> {
  const messages: Message[] = [
    { role: "user", content: userInput },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let resp: Response;
    try {
      resp = await callTurn(messages);
    } catch (e) {
      yield { kind: "error", text: `LLM: ${(e as Error).message}` };
      return;
    }

    messages.push({ role: "assistant", content: resp.content });

    // Surface any assistant text.
    for (const block of resp.content) {
      if (block.type === "text" && block.text.trim()) {
        yield { kind: "reply", text: block.text.trim() };
      }
    }

    // If Claude didn't ask for tools, we're done.
    if (resp.stop_reason !== "tool_use") return;

    // Execute every tool_use block, gather results, feed back for the next turn.
    const toolUses = resp.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }> = [];

    for (const use of toolUses) {
      yield { kind: "tool_call", name: use.name, args: use.input };
      const { forClaude, event } = await runTool(use.name, use.input);
      if (event) yield event;
      yield { kind: "tool_result", name: use.name, value: forClaude };
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: typeof forClaude === "string" ? forClaude : JSON.stringify(forClaude),
        is_error: (forClaude as { error?: string })?.error != null,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  yield { kind: "reply", text: "(Reached turn limit — try asking again in one step.)" };
}

async function callTurn(messages: Message[]): Promise<Response> {
  const r = await fetch("/api/agent/turn", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${localStorage.getItem("aegent.token") ?? ""}`,
    },
    body: JSON.stringify({
      system: SYSTEM_PROMPT,
      messages,
      tools: TOOLS,
      max_tokens: 1024,
      // `temperature` intentionally omitted — Claude 5 models reject it.
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`${r.status} ${body.slice(0, 240)}`);
  }
  return (await r.json()) as Response;
}

// Dispatch one tool call. Returns:
//   forClaude — what the LLM sees as its tool_result
//   event    — optional AgentEvent to yield to the UI (e.g. a confirm card)
async function runTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ forClaude: unknown; event?: AgentEvent }> {
  try {
    if (name === "search_messages") {
      const r = await search_messages(args as { query: string; peerId?: string; sinceDaysAgo?: number });
      return { forClaude: r.ok && r.kind === "data" ? r.value : { error: (r as { error?: string }).error ?? "no_data" } };
    }
    if (name === "resolve_target") {
      const t = await resolveTarget(String(args.name ?? ""));
      return { forClaude: t ?? { error: "not_found" } };
    }
    if (name === "list_reminders") {
      const r = await list_reminders_tool();
      return { forClaude: r.ok && r.kind === "data" ? r.value : { error: "unavailable" } };
    }
    if (name === "draft_message") {
      const r = await draft_message(args as { targetPeerId: string; isGroup: boolean; body: string });
      return stageResult(r);
    }
    if (name === "forward_message") {
      const r = await forward_message(args as { messageId: string; toPeerId: string; toIsGroup: boolean; note?: string });
      return stageResult(r);
    }
    if (name === "set_reminder") {
      const r = await set_reminder(args as { text: string; whenIso: string });
      return stageResult(r);
    }
    if (name === "export_to_email") {
      const r = await export_to_email(args as { messageIds: string[]; recipientEmail: string; note?: string });
      return stageResult(r);
    }
    if (name === "backup_thread") {
      const r = await backup_thread(args as {
        peerId: string; recipientEmail: string; note?: string; sinceDaysAgo?: number;
      });
      return stageResult(r);
    }
    if (name === "schedule_backup") {
      const r = await schedule_backup(args as {
        peerId: string; recipientEmail: string; whenIso: string; note?: string;
      });
      return { forClaude: r.ok && r.kind === "data" ? r.value : { error: (r as { error?: string }).error ?? "unavailable" } };
    }
    return { forClaude: { error: `unknown tool ${name}` } };
  } catch (e) {
    return { forClaude: { error: (e as Error).message } };
  }
}

function stageResult(r: Awaited<ReturnType<typeof draft_message>>): { forClaude: unknown; event?: AgentEvent } {
  if (!r.ok) return { forClaude: { error: r.error } };
  if (r.kind === "pending") {
    return {
      forClaude: {
        staged: true,
        summary: r.explain,
        // Give the LLM a compact description of what it staged so it can
        // reference it in its final reply without re-invoking the tool.
        action_kind: (r.action as PendingAction).kind,
      },
      event: { kind: "confirm", action: r.action, explain: r.explain },
    };
  }
  return { forClaude: r.value };
}
