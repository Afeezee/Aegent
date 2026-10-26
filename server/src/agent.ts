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
// Rate limiting: persistent 10-successful-calls per user per UTC day,
// backed by agent_events in the db. Survives restarts and exposes an
// accurate count the client can display. Admins (is_admin=1) bypass
// the cap entirely so the founder can test / dogfood freely.

import type { Request, Response } from "express";
import { agentUsageToday, AGENT_DAILY_LIMIT, logAgentEvent } from "./analytics.js";
import { isAdmin } from "./auth.js";

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 1024;

export async function agentTurn(req: Request & { userId: string }, res: Response) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "llm_disabled",
      message: "The server has no ANTHROPIC_API_KEY set; agent runs in offline mode.",
    });
  }

  // Daily cap: admins bypass; everyone else gets 10/day. We log the
  // rate-limit outcome too so the dashboard can see cap pressure.
  const admin = await isAdmin(req.userId);
  if (!admin) {
    const usage = await agentUsageToday(req.userId);
    if (usage.used >= usage.limit) {
      await logAgentEvent({ userId: req.userId, outcome: "rate_limited" });
      return res.status(429).json({
        error: "rate_limited",
        message: `You've hit today's agent limit (${usage.limit}). Resets at ${new Date(usage.resetsAt).toISOString()}.`,
        used: usage.used, limit: usage.limit, resetsAt: usage.resetsAt,
      });
    }
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

  // Approximate char count of the serialized messages array, logged
  // as a crude token proxy. The content itself is NOT stored.
  const approxCharsIn = (() => {
    try { return JSON.stringify(body.messages).length; } catch { return 0; }
  })();

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
    // Log the outcome (metadata only, no response body). Anthropic
    // returns 400/429/5xx with its own shapes we pass through — treat
    // any non-2xx as an error for quota-accounting purposes.
    await logAgentEvent({
      userId: req.userId,
      outcome: upstream.ok ? "ok" : "error",
      approxCharsIn,
    });
    // Pass through the API's response verbatim (status + body). Errors from
    // Anthropic come back with their own shape; the client understands it.
    res.status(upstream.status).type("application/json").send(text);
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
