// Metadata-only analytics logging.
//
// NON-NEGOTIABLE RULE: every function in this file is a WRITE for
// metadata the server already legitimately has, PLUS user-consented
// free text (abuse-report notes, feedback notes). None of it is or
// may become message plaintext. If a caller tries to pass something
// that could be plaintext (e.g. a message body as `note`), that is a
// bug in the caller, not a license here — and the file is small on
// purpose so a reviewer can confirm there is no plaintext path.
//
// Every function wraps the DB write in try/catch and swallows the
// error. Analytics must NEVER block a send, a login, or a reply.
// Phase-1 brief: "if the logging call errors, it must never block or
// affect the actual message-send/sync path."

import { randomUUID } from "node:crypto";
import { db } from "./db.js";

// -----------------------------------------------------------------------------
// Session events — the DAU/retention backbone.
// -----------------------------------------------------------------------------

export type SessionEventKind = "login" | "session_start" | "token_refresh";

export async function logSessionEvent(
  userId: string,
  kind: SessionEventKind,
  deviceLabel?: string | null,
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO session_events (id, user_id, kind, device_label, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID(), userId, kind, deviceLabel ?? null, Date.now());
  } catch (e) {
    // Logging failure MUST NOT propagate — the request path keeps running.
    console.warn("[analytics] session_event write failed:", (e as Error).message);
  }
}

// In-memory throttle for `session_start` so a chatty UI doesn't insert
// a row on every HTTP request. One row per user per 15 minutes is
// plenty for DAU/WAU accuracy. Lost on restart (at worst one extra
// row per user after a reboot).
const SESSION_START_WINDOW_MS = 15 * 60 * 1000;
const lastSessionStart = new Map<string, number>();
export async function maybeLogSessionStart(userId: string): Promise<void> {
  const now = Date.now();
  const last = lastSessionStart.get(userId);
  if (last && now - last < SESSION_START_WINDOW_MS) return;
  lastSessionStart.set(userId, now);
  await logSessionEvent(userId, "session_start");
}

// -----------------------------------------------------------------------------
// Reports / feedback. User-initiated. Note fields are the user's own
// words (abuse-report note from the reporter; feedback note from the
// author) — never ciphertext from a conversation.
// -----------------------------------------------------------------------------

export type AbuseReason =
  | "harassment" | "spam" | "threats" | "impersonation" | "csam" | "other";

export async function recordErrorReport(input: {
  userId: string | null;
  kind: "crash" | "handled" | "failed_request";
  message?: string | null;
  stack?: string | null;
  userAgent?: string | null;
  appVersion?: string | null;
}): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO error_reports
         (id, user_id, kind, message, stack, user_agent, app_version, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      randomUUID(), input.userId, input.kind,
      truncate(input.message, 4000),
      truncate(input.stack, 16000),
      truncate(input.userAgent, 500),
      truncate(input.appVersion, 60),
      Date.now(),
    );
  } catch (e) {
    console.warn("[analytics] error_report write failed:", (e as Error).message);
  }
}

export async function recordAbuseReport(input: {
  reporterId: string;
  reportedUserId: string;
  threadId?: string | null;
  reason: AbuseReason;
  reporterNote?: string | null;
}): Promise<string | null> {
  try {
    const id = randomUUID();
    await db.prepare(
      `INSERT INTO abuse_reports
         (id, reporter_id, reported_user_id, thread_id, reason, reporter_note,
          created_at, state, reviewed_by, reviewed_at, action_taken)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL)`,
    ).run(
      id, input.reporterId, input.reportedUserId,
      input.threadId ?? null, input.reason,
      truncate(input.reporterNote, 4000),
      Date.now(),
    );
    return id;
  } catch (e) {
    console.warn("[analytics] abuse_report write failed:", (e as Error).message);
    return null;
  }
}

export type FeedbackKind = "nps" | "feature_request" | "bug" | "general";

export async function recordFeedback(input: {
  userId: string;
  kind: FeedbackKind;
  rating?: number | null;
  note?: string | null;
}): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO feedback (id, user_id, kind, rating, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), input.userId, input.kind,
      input.rating ?? null,
      truncate(input.note, 4000),
      Date.now(),
    );
  } catch (e) {
    console.warn("[analytics] feedback write failed:", (e as Error).message);
  }
}

function truncate(s: string | null | undefined, max: number): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s);
  return t.length > max ? t.slice(0, max) : t;
}

// -----------------------------------------------------------------------------
// Agent usage — metadata only. outcome is the only string we persist,
// along with an approximate token count. The prompt text and the
// model response NEVER touch this table. This is the one place in the
// system where the server does see plaintext in-flight (the agent
// proxy forwards it to Anthropic), so we are deliberate about it: the
// moment the fetch returns, nothing of substance is kept.
// -----------------------------------------------------------------------------

export type AgentOutcome = "ok" | "rate_limited" | "error";

export async function logAgentEvent(input: {
  userId: string;
  outcome: AgentOutcome;
  approxCharsIn?: number;
}): Promise<void> {
  try {
    const tokensIn = input.approxCharsIn !== undefined
      ? Math.max(0, Math.round(input.approxCharsIn / 4))
      : null;
    await db.prepare(
      `INSERT INTO agent_events (id, user_id, outcome, tokens_in, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID(), input.userId, input.outcome, tokensIn, Date.now());
    // Visible in Coolify logs so you can watch calls land in real time.
    console.log(`[agent] ${input.outcome} user=${input.userId.slice(0, 8)}… tokens~${tokensIn ?? "?"}`);
  } catch (e) {
    // VERY loud on failure — this is the one write that was silently
    // dropping and showing as "0 agent calls" in the dashboard.
    console.error("[analytics] agent_event write FAILED:", (e as Error).message, "— user:", input.userId.slice(0, 8));
  }
}

// Daily cap: 10 OK outcomes per user per UTC day. We count only
// outcome='ok' so a rate-limit rejection itself doesn't consume quota.
export const AGENT_DAILY_LIMIT = 10;

export async function agentUsageToday(userId: string): Promise<{ used: number; limit: number; resetsAt: number }> {
  const dayStart = utcDayStart(Date.now());
  const resetsAt = dayStart + 86_400_000;
  try {
    const row = await db.prepare(
      `SELECT COUNT(*)::int AS n FROM agent_events
         WHERE user_id = ? AND outcome = 'ok' AND created_at >= ?`,
    ).get<{ n: number | string }>(userId, dayStart);
    return { used: Number(row?.n ?? 0), limit: AGENT_DAILY_LIMIT, resetsAt };
  } catch {
    // Fail open on quota read — never block legit use because of a DB
    // hiccup. The write path is the one that actually enforces caps.
    return { used: 0, limit: AGENT_DAILY_LIMIT, resetsAt };
  }
}

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
