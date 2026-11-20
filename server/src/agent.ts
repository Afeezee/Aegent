// LLM proxy for the on-device agent.
//
// The agent's tool loop runs on the client — retrieval happens against
// the local encrypted store, and only the matched messages ever leave
// the device. This module forwards the LLM call itself (and only the
// LLM call) to Groq on behalf of an authenticated user, so the
// API key never lives in the browser bundle.
//
// The client was built against Anthropic's Messages API shape
// (content blocks for text/tool_use, stop_reason, etc.). Groq exposes
// an OpenAI-compatible Chat Completions endpoint, so this module does
// the request/response translation on both sides: the client keeps
// sending the Anthropic shape it already knows, and Qwen 3 on Groq
// never sees that it's been wrapped.
//
// Rate limiting: persistent 10-successful-calls per user per UTC day,
// backed by agent_events in the db. Survives restarts and exposes an
// accurate count the client can display. Admins (is_admin=1) bypass
// the cap entirely so the founder can test / dogfood freely.

import type { Request, Response } from "express";
import { agentUsageToday, logAgentEvent } from "./analytics.js";
import { isAdmin } from "./auth.js";

const GROQ_API_BASE = process.env.GROQ_API_BASE ?? "https://api.groq.com/openai/v1";
const GROQ_ENDPOINT = `${GROQ_API_BASE.replace(/\/$/, "")}/chat/completions`;
// Qwen 3.8 on Groq (the 27B tool-use variant Afeez picked for this
// hackathon). Override with GROQ_MODEL if you want a different id from
// GET /v1/models.
const DEFAULT_MODEL = process.env.GROQ_MODEL ?? "qwen/qwen3.8-27b";
const DEFAULT_MAX_TOKENS = 1024;

// ---- types for the Anthropic shape the client sends / expects ----

type AnthTextBlock = { type: "text"; text: string };
type AnthToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type AnthImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
type AnthToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<AnthTextBlock | AnthImageBlock>;
  is_error?: boolean;
};
type AnthContentBlock = AnthTextBlock | AnthToolUseBlock | AnthImageBlock | AnthToolResultBlock;
type AnthMessage = {
  role: "user" | "assistant";
  content: string | AnthContentBlock[];
};
type AnthToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

// ---- types for the OpenAI/Groq shape ----

type OAITextPart = { type: "text"; text: string };
type OAIImagePart = { type: "image_url"; image_url: { url: string } };
type OAIContent = string | Array<OAITextPart | OAIImagePart>;
type OAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
type OAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: OAIContent }
  | { role: "assistant"; content: string | null; tool_calls?: OAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type OAIToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

// ---- translation: Anthropic → OpenAI ----

function anthToolResultToString(
  content: string | Array<AnthTextBlock | AnthImageBlock>,
): string {
  if (typeof content === "string") return content;
  // Qwen 3 on Groq is text-only; flatten image parts into a tag.
  return content
    .map((b) => (b.type === "text" ? b.text : `[image attached: ${b.source?.media_type ?? "unknown"}]`))
    .join("\n");
}

function translateMessagesToOpenAI(
  system: string | undefined,
  messages: AnthMessage[],
): OAIMessage[] {
  const out: OAIMessage[] = [];
  if (system && system.trim()) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (m.role === "user") {
      // User turn is either:
      //   - a plain string (an actual user message), or
      //   - an array of tool_result blocks (a tool-loop continuation).
      if (typeof m.content === "string") {
        out.push({ role: "user", content: m.content });
        continue;
      }
      const blocks = m.content;
      // If any tool_result blocks are present, this is a continuation:
      // emit one role:"tool" message per tool_result.
      const toolResults = blocks.filter((b): b is AnthToolResultBlock => b.type === "tool_result");
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          out.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: anthToolResultToString(tr.content),
          });
        }
        continue;
      }
      // Otherwise, pack text + image parts into one user message.
      const parts: Array<OAITextPart | OAIImagePart> = [];
      for (const b of blocks) {
        if (b.type === "text") parts.push({ type: "text", text: b.text });
        else if (b.type === "image") {
          const url = `data:${b.source.media_type};base64,${b.source.data}`;
          parts.push({ type: "image_url", image_url: { url } });
        }
      }
      if (parts.length === 0) continue;
      // If only text and only one part, flatten to a plain string —
      // some Groq model families complain about array-of-text content.
      const textOnly = parts.every((p) => p.type === "text");
      out.push({
        role: "user",
        content: textOnly
          ? (parts as OAITextPart[]).map((p) => p.text).join("\n")
          : parts,
      });
      continue;
    }

    // assistant
    if (typeof m.content === "string") {
      out.push({ role: "assistant", content: m.content });
      continue;
    }
    const texts: string[] = [];
    const toolCalls: OAIToolCall[] = [];
    for (const b of m.content) {
      if (b.type === "text") texts.push(b.text);
      else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      }
    }
    const content = texts.join("\n") || null;
    const msg: Extract<OAIMessage, { role: "assistant" }> = { role: "assistant", content };
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    out.push(msg);
  }
  return out;
}

function translateToolsToOpenAI(tools: AnthToolDef[] | undefined): OAIToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.input_schema as Record<string, unknown>) ?? { type: "object", properties: {} },
    },
  }));
}

// ---- translation: OpenAI → Anthropic ----

type OAIChatCompletion = {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OAIToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: unknown;
};

function translateResponseToAnthropic(oai: OAIChatCompletion): {
  id: string;
  role: "assistant";
  content: Array<AnthTextBlock | AnthToolUseBlock>;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage?: unknown;
} {
  const choice = oai.choices?.[0];
  const msg = choice?.message;
  const blocks: Array<AnthTextBlock | AnthToolUseBlock> = [];
  if (msg?.content && msg.content.trim()) {
    blocks.push({ type: "text", text: msg.content });
  }
  if (msg?.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { input = {}; }
      blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }
  const finish = choice?.finish_reason;
  const stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" =
    finish === "tool_calls" ? "tool_use"
    : finish === "length" ? "max_tokens"
    : finish === "content_filter" ? "end_turn"
    : "end_turn";

  return {
    id: oai.id ?? `groq_${Date.now()}`,
    role: "assistant",
    content: blocks,
    stop_reason,
    usage: oai.usage,
  };
}

// ---- the proxy handler ----

export async function agentTurn(req: Request & { userId: string }, res: Response) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "llm_disabled",
      message: "The server has no GROQ_API_KEY set; agent runs in offline mode.",
    });
  }

  const body = req.body as {
    model?: string;
    system?: string;
    messages: AnthMessage[];
    tools?: AnthToolDef[];
    max_tokens?: number;
    temperature?: number;
    // Flag the client sets on the FIRST LLM call that follows a fresh
    // user utterance (tool-use follow-up turns leave it false). Quota
    // counts user messages, not every LLM round-trip — otherwise
    // one question that happened to call three tools burned three of
    // the user's ten daily quota.
    turnStart?: boolean;
  };

  // Daily cap: admins bypass; everyone else gets 10/day. We log the
  // rate-limit outcome too so the dashboard can see cap pressure.
  // Only ENFORCE the cap on turnStart calls (one per user message) —
  // tool-use continuations always get to finish the turn once started,
  // so the agent never leaves the user mid-answer because an internal
  // loop happened to tip them over.
  const admin = await isAdmin(req.userId);
  if (!admin && body.turnStart === true) {
    const usage = await agentUsageToday(req.userId);
    if (usage.used >= usage.limit) {
      await logAgentEvent({ userId: req.userId, outcome: "rate_limited" });
      return res.status(429).json({
        error: "rate_limited",
        message: `You've used your ${usage.limit} agent messages for today. Resets at ${new Date(usage.resetsAt).toISOString()}.`,
        used: usage.used, limit: usage.limit, resetsAt: usage.resetsAt,
      });
    }
  }

  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: "bad_request", message: "messages required" });
  }

  // The client may hint a model (originally meant for Claude). Ignore
  // that hint — a claude-* id would 400 on Groq. Always route through
  // the configured Groq model.
  const model = DEFAULT_MODEL;

  const openaiBody = {
    model,
    messages: translateMessagesToOpenAI(body.system, body.messages),
    tools: translateToolsToOpenAI(body.tools),
    max_tokens: Math.min(body.max_tokens ?? DEFAULT_MAX_TOKENS, 2048),
    temperature: body.temperature ?? 0.4,
  };

  const approxCharsIn = (() => {
    try { return JSON.stringify(body.messages).length; } catch { return 0; }
  })();

  try {
    const upstream = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(openaiBody),
    });
    const text = await upstream.text();
    const isCountable = body.turnStart === true;
    await logAgentEvent({
      userId: req.userId,
      outcome: upstream.ok
        ? (isCountable ? "ok" : "ok_continuation")
        : "error",
      approxCharsIn,
    });
    if (!upstream.ok) {
      // Pass through the upstream error shape; the client already
      // surfaces it as an error banner. Add a prefix so the operator
      // can tell at a glance it came from Groq.
      res.status(upstream.status).type("application/json").send(text);
      return;
    }
    let parsed: OAIChatCompletion;
    try { parsed = JSON.parse(text); }
    catch {
      res.status(502).json({ error: "upstream_failed", message: "Groq returned non-JSON." });
      return;
    }
    const translated = translateResponseToAnthropic(parsed);
    res.status(200).json(translated);
  } catch (err) {
    await logAgentEvent({ userId: req.userId, outcome: "error", approxCharsIn });
    res.status(502).json({
      error: "upstream_failed",
      message: (err as Error).message,
    });
  }
}

// GET /api/agent/quota — returns {used, limit, resetsAt, unlimited}.
// Admins are reported as unlimited but we STILL compute `used` for
// them so the UI can show their own activity ("12 messages today ·
// no limit"). Hiding the counter entirely left admins unable to see
// their own usage.
export async function agentQuota(req: Request & { userId: string }, res: Response) {
  const admin = await isAdmin(req.userId);
  const usage = await agentUsageToday(req.userId);
  res.json({ ...usage, unlimited: admin });
}
