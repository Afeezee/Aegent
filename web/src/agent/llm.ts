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

import { apiUrl } from "../lib/api.js";
import {
  add_contact_by_handle, backup_thread, calculate, contact_profile,
  create_calendar_event, create_note, delete_message_tool,
  draft_message, export_to_email, forward_message,
  get_context_around, get_last_message, get_message_metadata, get_shared_media,
  get_thread, get_unread_count, list_reminders_tool,
  mark_thread_read, reply_to_message, resolveTarget,
  save_contact_to_phone, schedule_backup, schedule_message,
  search_by_date_range, search_by_media_type, search_by_sender,
  search_exact, search_links_and_patterns, search_messages,
  set_reminder, summarize_thread, tone_adjust, transcribe_voice, read_media,
  // Diary agent surface — read-only, metadata + consented body text.
  diary_stats, get_diary_entry, list_diary_recent, search_diary,
  type PendingAction,
} from "./tools.js";
import type { AgentEvent } from "./loop.js";

// ---- tool definitions (Anthropic tool-use schema) ----

const TOOLS = [
  // Retrieval
  {
    name: "search_messages",
    description: "Hybrid semantic + keyword search across the local encrypted store. Supports filters by contact/group (peerId), sender (senderId), date recency (sinceDaysAgo), and media type (mediaKind). Returns top matches with peerName, senderName, ISO timestamp, body, and score.",
    input_schema: { type: "object", properties: {
      query: { type: "string" },
      peerId: { type: "string" }, senderId: { type: "string" },
      sinceDaysAgo: { type: "number" },
      mediaKind: { type: "string", enum: ["image", "video", "audio", "voice", "file"] },
      limit: { type: "number" },
    }, required: ["query"] },
  },
  {
    name: "search_exact",
    description: "Case-insensitive substring search. Use when the user quotes an exact phrase, order number, link, or handle they want to find verbatim.",
    input_schema: { type: "object", properties: { needle: { type: "string" }, peerId: { type: "string" }, limit: { type: "number" } }, required: ["needle"] },
  },
  {
    name: "search_by_date_range",
    description: "All messages between two ISO timestamps, optionally scoped to one thread or filtered by a query.",
    input_schema: { type: "object", properties: { fromIso: { type: "string" }, toIso: { type: "string" }, peerId: { type: "string" }, query: { type: "string" }, limit: { type: "number" } }, required: ["fromIso", "toIso"] },
  },
  {
    name: "search_by_sender",
    description: "All messages from one specific sender, optionally filtered by a query.",
    input_schema: { type: "object", properties: { senderId: { type: "string" }, query: { type: "string" }, limit: { type: "number" } }, required: ["senderId"] },
  },
  {
    name: "search_by_media_type",
    description: "All messages containing media of a given kind (image | video | audio | voice | file).",
    input_schema: { type: "object", properties: { kind: { type: "string", enum: ["image", "video", "audio", "voice", "file"] }, peerId: { type: "string" }, limit: { type: "number" } }, required: ["kind"] },
  },
  {
    name: "search_links_and_patterns",
    description: "Find messages containing a URL, phone number, or email address.",
    input_schema: { type: "object", properties: { pattern: { type: "string", enum: ["link", "phone", "email"] }, peerId: { type: "string" }, limit: { type: "number" } }, required: ["pattern"] },
  },
  {
    name: "get_thread",
    description: "Return the last N messages in a specific thread with full metadata.",
    input_schema: { type: "object", properties: { peerId: { type: "string" }, limit: { type: "number" } }, required: ["peerId"] },
  },
  {
    name: "get_context_around",
    description: "Messages surrounding a specific match — useful for follow-ups like 'what did they say right after that?'.",
    input_schema: { type: "object", properties: { messageId: { type: "string" }, before: { type: "number" }, after: { type: "number" } }, required: ["messageId"] },
  },
  {
    name: "get_message_metadata",
    description: "Full metadata for one message (timestamp, sender, edited, delivered/read state, reply target).",
    input_schema: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"] },
  },
  {
    name: "get_last_message",
    description: "Most recent message in a specific thread.",
    input_schema: { type: "object", properties: { peerId: { type: "string" } }, required: ["peerId"] },
  },
  {
    name: "get_unread_count",
    description: "Unread inbound message counts, either total or scoped to one peer.",
    input_schema: { type: "object", properties: { peerId: { type: "string" } } },
  },
  {
    name: "get_shared_media",
    description: "All media items exchanged with a peer, optionally filtered by kind.",
    input_schema: { type: "object", properties: { peerId: { type: "string" }, kind: { type: "string", enum: ["image", "video", "audio", "voice", "file"] }, limit: { type: "number" } }, required: ["peerId"] },
  },
  {
    name: "summarize_thread",
    description: "Return a compact transcript of a thread (or a date range across all threads) for you to summarise. Ends at maxMessages (default 300).",
    input_schema: { type: "object", properties: { peerId: { type: "string" }, fromIso: { type: "string" }, toIso: { type: "string" }, maxMessages: { type: "number" } } },
  },
  {
    name: "list_reminders",
    description: "List every reminder the user currently has scheduled.",
    input_schema: { type: "object", properties: {} },
  },
  // ---- Diary (read-only). Diary is a separate rail from chats:
  // one author posts an entry for a day, grants read access to some
  // viewers, entries can expire. The user asking "what did I write
  // on Monday" / "what did Ada share this week" lives here, not in
  // search_messages. ----
  {
    name: "search_diary",
    description: "Hybrid semantic + keyword search across diary entries the user can currently see (their own + any granted + unexpired). Returns id, authorName, dayKey ('YYYY-MM-DD'), kind, ISO timestamp, snippet, score. Use this instead of search_messages when the user asks about their diary, journal, daily notes, or an entry someone else shared with them.",
    input_schema: { type: "object", properties: {
      query: { type: "string" },
      authorId: { type: "string" }, sinceDaysAgo: { type: "number" }, limit: { type: "number" },
    }, required: ["query"] },
  },
  {
    name: "list_diary_recent",
    description: "List the most recent diary entries the user can see (own + granted). Returns the same shape as search_diary, chronological rather than scored. Use when the user says 'show me the latest' or 'what did Alice share lately'.",
    input_schema: { type: "object", properties: {
      limit: { type: "number" }, authorId: { type: "string" },
    } },
  },
  {
    name: "get_diary_entry",
    description: "Fetch a single diary entry by id, with its full (bounded) body + metadata (author, dayKey, media kind, viewCount, expiresAt). Call this when the user asks for the contents of a specific entry you already have an id for.",
    input_schema: { type: "object", properties: { entryId: { type: "string" } }, required: ["entryId"] },
  },
  {
    name: "diary_stats",
    description: "Aggregate counters for the diary: total entries visible, how many are the user's own, distinct authors, entries created today / this week, newest timestamp. Use for 'how many entries do I have', 'am I keeping up with my diary'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "resolve_target",
    description: "Fuzzy-resolve a name, handle, or email fragment to a contact/group id. Call before draft/forward/schedule so you have a stable id.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "contact_profile",
    description: "Look up a contact by peerId, handle, email, or phone.",
    input_schema: { type: "object", properties: { peerId: { type: "string" }, handle: { type: "string" }, email: { type: "string" }, phone: { type: "string" } } },
  },
  {
    name: "calculate",
    description: "Evaluate an arithmetic expression safely (numbers, + - * / parens, %). No variables, no functions.",
    input_schema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
  },
  {
    name: "transcribe_voice",
    description: "Run on-device Whisper against a voice-note message and return the transcript. Returns the cached transcript if one already exists. Warn the user that the first call may take up to a minute (model download).",
    input_schema: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"] },
  },
  {
    name: "read_media",
    description: "Read the *content* of any attachment message (image, PDF, or text-based file). Decrypts on-device, then hands the bytes/text to you in the right form for analysis: images use your native vision (OCR receipts, describe photos), PDFs get text-extracted, plain-text files (.txt/.md/.csv/.json/.xml/.log/etc.) are inlined. Use this whenever the user asks 'what does that receipt say', 'summarise the doc Ada sent', 'read this PDF', 'what's in the file from last week'. Requires the message id — get it from search_messages / search_by_media_type first. Refuses .docx/.xlsx/.pptx (ask for PDF or plain text) and images >4.5 MB (ask for a smaller copy).",
    input_schema: {
      type: "object",
      properties: {
        messageId: { type: "string" },
        question: { type: "string", description: "Optional. What the user actually asked about the file — helps you focus." },
      },
      required: ["messageId"],
    },
  },

  // Writes (all confirm-gated)
  {
    name: "draft_message",
    description: "Stage a new message to a contact/group. Optionally attach it as a reply to a specific earlier message id. Surfaces a confirm card; does not send.",
    input_schema: { type: "object", properties: {
      targetPeerId: { type: "string" }, isGroup: { type: "boolean" },
      body: { type: "string" },
      replyToMessageId: { type: "string" },
    }, required: ["targetPeerId", "isGroup", "body"] },
  },
  {
    name: "reply_to_message",
    description: "Shortcut for draft_message that infers peer + group from the target message.",
    input_schema: { type: "object", properties: { targetMessageId: { type: "string" }, body: { type: "string" } }, required: ["targetMessageId", "body"] },
  },
  {
    name: "forward_message",
    description: "Stage a forward of an existing message to another contact/group with an optional note. Confirm-gated.",
    input_schema: { type: "object", properties: { messageId: { type: "string" }, toPeerId: { type: "string" }, toIsGroup: { type: "boolean" }, note: { type: "string" } }, required: ["messageId", "toPeerId", "toIsGroup"] },
  },
  {
    name: "tone_adjust",
    description: "Return a rewritten version of a message body in a chosen tone (firmer | softer | warmer | shorter | more_formal | more_casual). Read-only — the caller decides whether to draft_message it.",
    input_schema: { type: "object", properties: { text: { type: "string" }, tone: { type: "string", enum: ["firmer", "softer", "warmer", "shorter", "more_formal", "more_casual"] } }, required: ["text", "tone"] },
  },
  {
    name: "set_reminder",
    description: "Stage a reminder. Optionally tie it to a specific past message so the notification references it. Confirm-gated.",
    input_schema: { type: "object", properties: { text: { type: "string" }, whenIso: { type: "string" }, tiedToMessageId: { type: "string" } }, required: ["text", "whenIso"] },
  },
  {
    name: "schedule_message",
    description: "Stage a message to be sent at a chosen time. Confirm-gated; up to 24 h ahead currently.",
    input_schema: { type: "object", properties: { targetPeerId: { type: "string" }, isGroup: { type: "boolean" }, body: { type: "string" }, whenIso: { type: "string" } }, required: ["targetPeerId", "isGroup", "body", "whenIso"] },
  },
  {
    name: "mark_thread_read",
    description: "Mark every inbound message in one thread as read. Immediate; no confirm.",
    input_schema: { type: "object", properties: { peerId: { type: "string" } }, required: ["peerId"] },
  },
  {
    name: "delete_message",
    description: "Delete-for-everyone one of the user's own messages. Confirm-gated. Server side just relays a tombstone; recipients render the message as deleted.",
    input_schema: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"] },
  },
  {
    name: "create_calendar_event",
    description: "Emit a .ics file the user's calendar can import. Confirm-gated.",
    input_schema: { type: "object", properties: { title: { type: "string" }, whenIso: { type: "string" }, durationMin: { type: "number" }, notes: { type: "string" } }, required: ["title", "whenIso"] },
  },
  {
    name: "create_note",
    description: "Save a note as a reminder-with-far-future-time so it lives in the reminders list. Confirm-gated.",
    input_schema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title", "body"] },
  },
  {
    name: "add_contact_by_handle",
    description: "Add someone to the local contacts by their @handle. Confirm-gated.",
    input_schema: { type: "object", properties: { handle: { type: "string" } }, required: ["handle"] },
  },
  {
    name: "save_contact_to_phone",
    description: "Export an existing contact as a vCard the device's Contacts app can import. Confirm-gated.",
    input_schema: { type: "object", properties: { peerId: { type: "string" } }, required: ["peerId"] },
  },
  {
    name: "export_to_email",
    description: "Compile specific messages by id into an email body. Warns the user this leaves the E2E boundary. Confirm-gated.",
    input_schema: { type: "object", properties: { messageIds: { type: "array", items: { type: "string" } }, recipientEmail: { type: "string" }, note: { type: "string" } }, required: ["messageIds", "recipientEmail"] },
  },
  {
    name: "backup_thread",
    description: "Compile an entire conversation into a plaintext email backup. Media referenced by type only. Confirm-gated; warns about email leaving E2E.",
    input_schema: { type: "object", properties: { peerId: { type: "string" }, recipientEmail: { type: "string" }, note: { type: "string" }, sinceDaysAgo: { type: "number" } }, required: ["peerId", "recipientEmail"] },
  },
  {
    name: "schedule_backup",
    description: "Persist a backup to fire at a chosen time. When the app is next open at/after that time, the confirm card appears.",
    input_schema: { type: "object", properties: { peerId: { type: "string" }, recipientEmail: { type: "string" }, whenIso: { type: "string" }, note: { type: "string" } }, required: ["peerId", "recipientEmail", "whenIso"] },
  },
] as const;

// The base prompt is stable across turns; the per-turn "current
// context" section (whose chats exist, which is active, how many
// unread) is computed at ask() time and appended below. This gives
// Claude enough situational awareness to skip the "which chat?"
// clarification when there's only one, and to default to the active
// thread when the user says "him" / "her" / "them" without naming.
const BASE_PROMPT = `You are Aegent's on-device assistant — warm, brief, and precise.

Context you can trust:
The user's messages are end-to-end encrypted. Retrieval happens locally on their device via the tools below; you only see what a tool returns.

You are a full assistant, not only a message-search bot. Answer general-knowledge and how-to questions directly from what you know — "what is AI", "what can I cook with potato and egg", "explain X", "draft a polite decline", "convert 10 miles to km", and so on. For these you don't need any tool; just answer helpfully and concisely. Only reach for the retrieval tools when the question is about the user's own messages, contacts, diary, reminders, or attachments. If you're genuinely unsure of a fact, say so plainly rather than inventing specifics — never fabricate names, numbers, dates, citations, or quotes. Your primary job (the user's own data and the actions below) always takes priority, but being a knowledgeable everyday assistant is part of the job too.

Rules that do not bend:
Every write tool (draft_message, reply_to_message, forward_message, set_reminder, schedule_message, create_calendar_event, create_note, add_contact_by_handle, save_contact_to_phone, export_to_email, backup_thread, delete_message) stages a confirm card the user must approve. When one returns {staged: true, ...}, tell the user you've prepared it and ask them to confirm the card. Never re-invoke the same staged action.

Read-then-write pattern:
Prefer resolve_target before drafting/forwarding/scheduling to get a stable id from a fuzzy name.
Prefer search_messages, search_exact, search_by_date_range, search_by_sender, or get_last_message before forward_message/export_to_email/reply_to_message so you have a specific message id.
Diary vs chats: when the user asks about their diary / journal / daily notes, or an entry someone shared with them, use search_diary / list_diary_recent / get_diary_entry / diary_stats — NOT search_messages. Diary entries are a separate rail; search_messages won't find them. When presenting a diary answer, include author, dayKey (the day the entry is for) and when it was created.
For "what did they say next" style follow-ups, use get_context_around with a message id you already have.
For anything referencing an attachment ('the receipt Ada sent', 'that PDF', 'this photo', 'the voice note', 'the doc') — resolve the message first (search_by_sender + search_by_media_type is a good shape) then call read_media(messageId) so you can actually see the contents.
When emailing or backing up: any attachment referenced by messageId (image, PDF, doc, spreadsheet, presentation, voice note, video, arbitrary file) is decrypted and rides along on the email as a real file — not a text placeholder. So if the user says "email that receipt to X" or "send Ada that voice note by email", ALWAYS include the media message's id in messageIds. Do this for every attachment kind, not just photos.

Situational awareness (READ CAREFULLY, this is why you shouldn't ask obvious questions):
The user's world may be small. If they only have one contact and refer to a chat, that IS the chat — don't ask which one. If a specific thread is 'active' below, treat unqualified pronouns and 'the chat' as referring to that thread. If they say 'send X' with no target and there is only one plausible target, use it and confirm the target in the card, don't stall.
Only ask a clarifying question when there is genuine ambiguity that can't be resolved from what's below.

Voice:
Answer like a person, not a document. Short sentences. Plain prose.
Only use bullets or headings when you have three or more genuinely separate items — never for two-item answers or single facts.
Never restate a tool's raw output; summarise what matters and move on.
If you did not find something, say so directly. Don't invent detail.
Skip preambles ("Sure!", "Of course!") and trailing offers ("let me know if…"). Just answer.
For tone-adjust: call tone_adjust, get the rewritten text, then call draft_message with it. Don't paste raw rewritten text into your reply.
For email export or backup, mention in one short clause that it leaves the E2E boundary.

Today's date is ${new Date().toISOString().slice(0, 10)}. Convert relative times ("tomorrow", "next Monday", "in an hour") into concrete ISO timestamps in the user's local timezone.`;

// Track the last active thread so the agent context can name it in
// the system prompt. Bumped by Home whenever a Chat comes into view.
let ACTIVE_THREAD: { peerId: string; label: string; isGroup: boolean } | null = null;
export function setActiveThread(t: { peerId: string; label: string; isGroup: boolean } | null) {
  ACTIVE_THREAD = t;
}

// Build the per-turn "current context" section. Compact — hundreds of
// tokens, not thousands.
async function buildContextSuffix(): Promise<string> {
  try {
    const [{ listContacts, listGroups }] = await Promise.all([
      import("../lib/store.js"),
    ]);
    const [contacts, groups] = await Promise.all([listContacts(), listGroups()]);
    const total = contacts.length + groups.length;

    const lines: string[] = [];
    lines.push(`Current context:`);
    lines.push(`- Contacts: ${contacts.length}. Groups: ${groups.length}.`);
    if (total === 0) {
      lines.push(`- There are no chats yet. If the user asks about messages, tell them there's nothing to search until they start one.`);
    } else if (total === 1) {
      // TS union of ContactRow | GroupRow — the `in` narrowing needs
      // a widened local; assert to Record<string, unknown> just for
      // the label lookup so the property discriminant works.
      const only = (contacts[0] ?? groups[0]) as unknown as Record<string, unknown>;
      const label = ("displayName" in only ? only.displayName : only.name) as string;
      const kind = "memberIds" in only ? ", group" : "";
      lines.push(`- The user has ONE chat: "${label}" (peerId: ${only.id}${kind}). Any unqualified reference to "the chat" / "them" / "him" / "her" almost certainly means this one — don't ask.`);
    } else {
      // List up to 8 most-recent so the agent can resolve nicknames.
      const merged = [
        ...contacts.map((c) => ({ id: c.id, label: c.displayName, kind: "contact", when: c.lastSeenAt })),
        ...groups.map((g) => ({ id: g.id, label: g.name, kind: "group", when: g.lastSeenAt })),
      ].sort((a, b) => b.when - a.when).slice(0, 8);
      lines.push(`- Recent chats (${merged.length} of ${total}, most-recent first):`);
      for (const m of merged) lines.push(`    · ${m.label} (${m.kind}, id: ${m.id})`);
    }
    if (ACTIVE_THREAD) {
      lines.push(`- Active thread right now: "${ACTIVE_THREAD.label}" (peerId: ${ACTIVE_THREAD.peerId}${ACTIVE_THREAD.isGroup ? ", group" : ""}). Default unqualified references to this one.`);
    }
    return "\n\n" + lines.join("\n");
  } catch {
    return ""; // context is best-effort; never block the turn
  }
}

// ---- Anthropic types ----

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

const MAX_TURNS = 8;

// Keep the conversation window bounded. 12 prior turns (~6 exchanges)
// is enough for the follow-up-context patterns users actually rely on
// ('draft that message', 'send it to alice@x') without ballooning
// tokens per turn.
const MAX_PRIOR_TURNS = 12;

// Anthropic requires alternating user/assistant messages, starting
// with user and ending with a user message before the assistant
// replies. Clean the history to that shape defensively — bad
// sequences would 400 the API call outright.
function normalizeHistory(prior: Array<{ role: "user" | "assistant"; content: string }>): Message[] {
  const trimmed = prior.slice(-MAX_PRIOR_TURNS);
  const out: Message[] = [];
  let expect: "user" | "assistant" = "user";
  for (const m of trimmed) {
    if (!m.content || !m.content.trim()) continue;
    // Drop consecutive same-role turns (rare, but happens if a
    // reply lands with no user in between).
    if (m.role !== expect) continue;
    out.push({ role: m.role, content: m.content });
    expect = expect === "user" ? "assistant" : "user";
  }
  // We're about to append the caller's current input as a user
  // message, so the history must end with an assistant turn.
  if (out.length && out[out.length - 1].role === "user") out.pop();
  return out;
}

import { resetAgentUsage } from "./usage.js";

export async function* runLlm(
  userInput: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
): AsyncGenerator<AgentEvent> {
  const messages: Message[] = [
    ...normalizeHistory(history),
    { role: "user", content: userInput },
  ];
  // Compose the per-turn system prompt with a fresh context snapshot
  // so the LLM knows how many chats exist, which one is active, and
  // stops asking obvious "which chat?" questions when the answer is
  // "the only one".
  const contextSuffix = await buildContextSuffix();
  resetAgentUsage();
  const systemForThisAsk = BASE_PROMPT + contextSuffix;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let resp: Response;
    try { resp = await callTurn(messages, systemForThisAsk); }
    catch (e) { yield { kind: "error", text: `LLM: ${(e as Error).message}` }; return; }

    messages.push({ role: "assistant", content: resp.content });

    for (const block of resp.content) {
      if (block.type === "text" && block.text.trim()) {
        yield { kind: "reply", text: block.text.trim() };
      }
    }
    if (resp.stop_reason !== "tool_use") return;

    const toolUses = resp.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    // Anthropic tool_result.content accepts either a string or an
    // array of content blocks (text + image). We use the array form
    // whenever a tool wants to hand Claude an image (describe_image),
    // and the plain string form otherwise.
    type ToolResultBlock =
      | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
      | {
          type: "tool_result"; tool_use_id: string;
          content: Array<
            | { type: "text"; text: string }
            | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
          >;
          is_error?: boolean;
        };
    const toolResults: ToolResultBlock[] = [];

    for (const use of toolUses) {
      yield { kind: "tool_call", name: use.name, args: use.input };
      const { forClaude, event } = await runTool(use.name, use.input);
      if (event) yield event;
      yield { kind: "tool_result", name: use.name, value: forClaude };

      // Content fast-path for read_media / describe_image tool results.
      // The tool tags them with `_agent_image` (vision) or
      // `_agent_text` (extracted text). Both get repackaged into the
      // right tool_result content shape so Claude actually receives
      // pixels or the document body, not a JSON stringification.
      const asObj = forClaude as {
        _agent_image?: { mime: string; base64: string };
        _agent_text?: string;
        caption?: string; senderName?: string; when?: number;
        question?: string; filename?: string; mime?: string; pdfPages?: number;
        error?: string;
      } | null;
      if (asObj && asObj._agent_image) {
        const meta = describeMeta(asObj);
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: asObj._agent_image.mime,
                data: asObj._agent_image.base64,
              },
            },
            { type: "text", text: `Image contents above.${meta ? " " + meta : ""}` },
          ],
        });
        continue;
      }
      if (asObj && typeof asObj._agent_text === "string") {
        const meta = describeMeta(asObj);
        // Fence the file body so Claude sees where the document ends
        // and any surrounding meta begins.
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: [
            { type: "text", text: `${meta}\n\n--- FILE CONTENT ---\n${asObj._agent_text}\n--- END FILE ---` },
          ],
        });
        continue;
      }

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

async function callTurn(messages: Message[], system: string): Promise<Response> {
  const r = await fetch(apiUrl("/api/agent/turn"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${localStorage.getItem("aegent.token") ?? ""}`,
    },
    body: JSON.stringify({
      system,
      messages,
      tools: TOOLS,
      max_tokens: 1024,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`${r.status} ${body.slice(0, 240)}`);
  }
  return (await r.json()) as Response;
}

// Dispatch table for tool calls. Anything not in here → error result.
async function runTool(name: string, args: Record<string, unknown>): Promise<{ forClaude: unknown; event?: AgentEvent }> {
  try {
    // ---- reads ----
    if (name === "search_messages")     return dataOnly(await search_messages(args as never));
    if (name === "search_exact")        return dataOnly(await search_exact(args as never));
    if (name === "search_by_date_range")return dataOnly(await search_by_date_range(args as never));
    if (name === "search_by_sender")    return dataOnly(await search_by_sender(args as never));
    if (name === "search_by_media_type")return dataOnly(await search_by_media_type(args as never));
    if (name === "search_links_and_patterns") return dataOnly(await search_links_and_patterns(args as never));
    if (name === "get_thread")          return dataOnly(await get_thread(args as never));
    if (name === "get_context_around")  return dataOnly(await get_context_around(args as never));
    if (name === "get_message_metadata")return dataOnly(await get_message_metadata(args as never));
    if (name === "get_last_message")    return dataOnly(await get_last_message(args as never));
    if (name === "get_unread_count")    return dataOnly(await get_unread_count(args as never));
    if (name === "get_shared_media")    return dataOnly(await get_shared_media(args as never));
    if (name === "summarize_thread")    return dataOnly(await summarize_thread(args as never));
    if (name === "list_reminders")      return dataOnly(await list_reminders_tool());
    if (name === "search_diary")        return dataOnly(await search_diary(args as never));
    if (name === "list_diary_recent")   return dataOnly(await list_diary_recent(args as never));
    if (name === "get_diary_entry")     return dataOnly(await get_diary_entry(args as never));
    if (name === "diary_stats")         return dataOnly(await diary_stats());
    if (name === "resolve_target")      return { forClaude: (await resolveTarget(String(args.name ?? ""))) ?? { error: "not_found" } };
    if (name === "contact_profile")     return dataOnly(await contact_profile(args as never));
    if (name === "calculate")           return dataOnly(await calculate(args as never));
    if (name === "transcribe_voice")    return dataOnly(await transcribe_voice(args as never));
    if (name === "read_media" || name === "describe_image") return dataOnly(await read_media(args as never));
    if (name === "tone_adjust")         return dataOnly(await tone_adjust(args as never));
    if (name === "mark_thread_read")    return dataOnly(await mark_thread_read(args as never));

    // ---- writes (stage confirm cards) ----
    if (name === "draft_message")       return stageResult(await draft_message(args as never));
    if (name === "reply_to_message")    return stageResult(await reply_to_message(args as never));
    if (name === "forward_message")     return stageResult(await forward_message(args as never));
    if (name === "set_reminder")        return stageResult(await set_reminder(args as never));
    if (name === "schedule_message")    return stageResult(await schedule_message(args as never));
    if (name === "delete_message")      return stageResult(await delete_message_tool(args as never));
    if (name === "create_calendar_event") return stageResult(await create_calendar_event(args as never));
    if (name === "create_note")         return stageResult(await create_note(args as never));
    if (name === "add_contact_by_handle") return stageResult(await add_contact_by_handle(args as never));
    if (name === "save_contact_to_phone") return stageResult(await save_contact_to_phone(args as never));
    if (name === "export_to_email")     return stageResult(await export_to_email(args as never));
    if (name === "backup_thread")       return stageResult(await backup_thread(args as never));
    if (name === "schedule_backup")     return stageResult(await schedule_backup(args as never));
    return { forClaude: { error: `unknown tool ${name}` } };
  } catch (e) {
    return { forClaude: { error: (e as Error).message } };
  }
}

function describeMeta(o: {
  senderName?: string; when?: number; caption?: string;
  question?: string; filename?: string; mime?: string; pdfPages?: number;
}): string {
  return [
    o.filename ? `File: ${o.filename}` : null,
    o.mime ? `Type: ${o.mime}` : null,
    o.pdfPages ? `Pages: ${o.pdfPages}` : null,
    o.senderName ? `From: ${o.senderName}` : null,
    o.when ? `Sent: ${new Date(o.when).toLocaleString()}` : null,
    o.caption ? `Caption: ${o.caption}` : null,
    o.question ? `User asked: ${o.question}` : null,
  ].filter(Boolean).join(" · ");
}

function dataOnly(r: Awaited<ReturnType<typeof draft_message>>): { forClaude: unknown } {
  if (!r.ok) return { forClaude: { error: r.error } };
  if (r.kind === "data") return { forClaude: r.value };
  // Shouldn't happen for a read tool, but stay honest.
  return { forClaude: { error: "unexpected_kind" } };
}
function stageResult(r: Awaited<ReturnType<typeof draft_message>>): { forClaude: unknown; event?: AgentEvent } {
  if (!r.ok) return { forClaude: { error: r.error } };
  if (r.kind === "pending") {
    return {
      forClaude: { staged: true, summary: r.explain, action_kind: (r.action as PendingAction).kind },
      event: { kind: "confirm", action: r.action, explain: r.explain },
    };
  }
  return { forClaude: r.value };
}
