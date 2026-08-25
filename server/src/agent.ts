// LLM proxy for the on-device agent.
//
// The agent's tool loop runs on the client — retrieval happens against
// the local encrypted store, and only the matched messages ever leave
// the device. This module forwards the LLM call itself (and only the
// LLM call) to Anthropic on behalf of an authenticated user, so the
// API key never lives in the browser bundle.
//
// Zero-data-retention is a *contractual* control on the Anthropic side
// (see spec §5.2 / §8) — enable it on the account whose key you paste
// into ANTHROPIC_API_KEY. This code doesn't need any change for ZDR.
//
// Per-user rate limit: coarse in-memory sliding window. Enough for a
// pilot; swap for a real limiter (Redis token bucket) if you open to
// the public.

import type { Request, Response } from "express";

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 1024;

// Sliding window: up to N calls per user per hour.
const CALLS_PER_HOUR = 60;
const WINDOW_MS = 60 * 60 * 1000;
const callWindow = new Map<string, number[]>();

function withinRateLimit(userId: string): boolean {
  const now = Date.now();
  const entries = (callWindow.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (entries.length >= CALLS_PER_HOUR) {
    callWindow.set(userId, entries);
    return false;
  }
  entries.push(now);
  callWindow.set(userId, entries);
  return true;
}

export async function agentTurn(req: Request & { userId: string }, res: Response) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "llm_disabled",
      message: "The server has no ANTHROPIC_API_KEY set; agent runs in offline mode.",
    });
  }
  if (!withinRateLimit(req.userId)) {
    return res.status(429).json({ error: "rate_limited", message: "Slow down." });
  }

  const body = req.body as {
    model?: string;
    system?: string;
    messages: Array<{ role: "user" | "assistant"; content: unknown }>;
    tools?: Array<{ name: string; description: string; input_schema: unknown }>;
    max_tokens?: number;
    temperature?: number;
  };

  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: "bad_request", message: "messages required" });
  }

  // Note: Claude 5 models reject `temperature`. Only include it when the
  // caller explicitly asks and the model looks like a pre-5 build.
  const model = body.model ?? DEFAULT_MODEL;
  const includeTemp = body.temperature != null && !/(claude-(?:sonnet|opus|fable)-5)|(claude-haiku-4)/.test(model);
  const upstreamBody = {
    model,
    max_tokens: Math.min(body.max_tokens ?? DEFAULT_MAX_TOKENS, 2048),
    ...(includeTemp ? { temperature: body.temperature } : {}),
    system: body.system,
    messages: body.messages,
    tools: body.tools,
  };

  try {
    const upstream = await fetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(upstreamBody),
    });
    const text = await upstream.text();
    // Pass through the API's response verbatim (status + body). Errors from
    // Anthropic come back with their own shape; the client understands it.
    res.status(upstream.status).type("application/json").send(text);
  } catch (err) {
    res.status(502).json({
      error: "upstream_failed",
      message: (err as Error).message,
    });
  }
}
