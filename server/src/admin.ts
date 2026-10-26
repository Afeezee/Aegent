// Admin dashboard HTTP surface. Read-only metrics + a thin layer of
// moderation mutations (promote, demote, suspend, resolve a report).
//
// Every function here operates against metadata the server already
// legitimately owns (users table + session_events + messages row counts
// via sender_id/created_at + user-submitted reports). None of them
// reads a ciphertext column or decrypts anything. The dashboard that
// consumes them is UI-side glue; this file is the source of truth for
// WHAT the dashboard can ever see.
//
// Routes mount under /api/admin/* and every route must be gated by the
// requireAdmin middleware in index.ts. This file does not re-check
// admin-ness in each handler — the middleware is the authority.

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db } from "./db.js";
import { invalidateAdminCache } from "./auth.js";

export const adminRouter: Router = Router();

// ---- OVERVIEW: the four big numbers on the dashboard header ----

adminRouter.get("/overview", async (_req, res, next) => {
  try {
    const now = Date.now();
    const dayAgo = now - 86_400_000;
    const weekAgo = now - 7 * 86_400_000;
    const monthAgo = now - 30 * 86_400_000;

    const [totalUsers, activeDay, activeWeek, activeMonth, totalMessages, totalMessagesNonFounder, totalGroups, totalThreads] = await Promise.all([
      scalar("SELECT COUNT(*)::int AS n FROM users"),
      scalar("SELECT COUNT(DISTINCT user_id)::int AS n FROM session_events WHERE created_at >= ?", dayAgo),
      scalar("SELECT COUNT(DISTINCT user_id)::int AS n FROM session_events WHERE created_at >= ?", weekAgo),
      scalar("SELECT COUNT(DISTINCT user_id)::int AS n FROM session_events WHERE created_at >= ?", monthAgo),
      // 1:1 messages, deduped: ignore the self-echo row by filtering
      // sender_id != recipient_id. Group messages are counted once per
      // send via group_archive which has one row per send.
      scalar("SELECT COUNT(*)::int AS n FROM messages WHERE sender_id != recipient_id"),
      scalar(`
        SELECT COUNT(*)::int AS n FROM messages m
         WHERE m.sender_id != m.recipient_id
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.sender_id AND u.is_admin = 1)
      `),
      scalar("SELECT COUNT(*)::int AS n FROM groups"),
      scalar(`
        SELECT COUNT(DISTINCT CASE
          WHEN sender_id < recipient_id THEN sender_id || ':' || recipient_id
          ELSE recipient_id || ':' || sender_id
        END)::int AS n FROM messages
        WHERE sender_id != recipient_id AND group_id IS NULL
      `),
    ]);

    const openAbuse = await scalar("SELECT COUNT(*)::int AS n FROM abuse_reports WHERE state = 'open'");
    const openErrors = await scalar("SELECT COUNT(*)::int AS n FROM error_reports WHERE resolved_at IS NULL");

    // Agent engagement metrics (metadata only — no prompts or
    // responses are persisted; see analytics.logAgentEvent).
    // trackingSince is the timestamp of the earliest logged event,
    // which is also when the agent_events table was created on the
    // first boot after commit 76bec0b. Pre-feature agent calls were
    // never persisted anywhere and cannot be reconstructed.
    const [agentCallsTotal, agentCalls24h, agentCalls7d, agentDistinctUsers7d, agentRateLimited24h, agentFirstSeen] = await Promise.all([
      scalar("SELECT COUNT(*)::int AS n FROM agent_events WHERE outcome = 'ok'"),
      scalar("SELECT COUNT(*)::int AS n FROM agent_events WHERE outcome = 'ok' AND created_at >= ?", dayAgo),
      scalar("SELECT COUNT(*)::int AS n FROM agent_events WHERE outcome = 'ok' AND created_at >= ?", weekAgo),
      scalar("SELECT COUNT(DISTINCT user_id)::int AS n FROM agent_events WHERE outcome = 'ok' AND created_at >= ?", weekAgo),
      scalar("SELECT COUNT(*)::int AS n FROM agent_events WHERE outcome = 'rate_limited' AND created_at >= ?", dayAgo),
      // Fallback 0 when there are no rows yet — the client treats 0 as "tracking not started yet".
      scalar("SELECT COALESCE(MIN(created_at), 0)::bigint AS n FROM agent_events"),
    ]);

    res.json({
      users: { total: totalUsers, activeDay, activeWeek, activeMonth },
      messages: { total: totalMessages, totalExcludingAdmins: totalMessagesNonFounder },
      conversations: { oneToOne: totalThreads, groups: totalGroups },
      queue: { openAbuseReports: openAbuse, unresolvedErrors: openErrors },
      agent: {
        totalCalls: agentCallsTotal,
        calls24h: agentCalls24h,
        calls7d: agentCalls7d,
        distinctUsers7d: agentDistinctUsers7d,
        rateLimited24h: agentRateLimited24h,
        // ms epoch of the first logged agent event, or 0 if none yet.
        // Pre-feature calls aren't recoverable (no column existed to
        // hold them). This is the earliest timestamp the dashboard
        // numbers can honestly cover.
        trackingSince: Number(agentFirstSeen) || 0,
      },
      generatedAt: Date.now(),
    });
  } catch (e) { next(e); }
});

// Raw agent-event rows for diagnostics. Shows the admin the last 25
// writes so they can verify logging is actually landing. No prompt or
// response text is in the table to begin with, so there's nothing
// sensitive to leak here.
adminRouter.get("/debug/agent-events", async (_req, res, next) => {
  try {
    const [count, recent] = await Promise.all([
      scalar("SELECT COUNT(*)::int AS n FROM agent_events"),
      db.prepare(
        `SELECT a.id, a.user_id, a.outcome, a.tokens_in, a.created_at,
                u.handle, u.display_name, u.is_admin
           FROM agent_events a
           LEFT JOIN users u ON u.id = a.user_id
           ORDER BY a.created_at DESC
           LIMIT 25`,
      ).all<{ id: string; user_id: string; outcome: string; tokens_in: number | string | null;
              created_at: number | string; handle: string | null; display_name: string | null;
              is_admin: number | null }>(),
    ]);
    res.json({
      count,
      recent: recent.map((r) => ({
        id: r.id, userId: r.user_id, outcome: r.outcome,
        tokensIn: r.tokens_in === null ? null : Number(r.tokens_in),
        createdAt: Number(r.created_at),
        handle: r.handle, displayName: r.display_name,
        isAdmin: !!r.is_admin,
      })),
    });
  } catch (e) { next(e); }
});

// Per-user agent usage, highest first — "who's actually using the AI?"
adminRouter.get("/agent-leaderboard", async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const rows = await db.prepare(
      `SELECT a.user_id, u.handle, u.display_name,
              COUNT(*) AS calls,
              MAX(a.created_at) AS last_call_at
         FROM agent_events a
         JOIN users u ON u.id = a.user_id
         WHERE a.outcome = 'ok'
         GROUP BY a.user_id, u.handle, u.display_name
         ORDER BY calls DESC
         LIMIT ?`,
    ).all<{ user_id: string; handle: string; display_name: string;
            calls: number | string; last_call_at: number | string }>(limit);
    res.json({
      rows: rows.map((r) => ({
        userId: r.user_id, handle: r.handle, displayName: r.display_name,
        calls: Number(r.calls), lastCallAt: Number(r.last_call_at),
      })),
    });
  } catch (e) { next(e); }
});

// ---- TIME SERIES: signups + messages per day/week ----

adminRouter.get("/signups", async (req, res, next) => {
  try {
    const period = (String(req.query.period ?? "day") === "week") ? "week" : "day";
    const bucketMs = period === "week" ? 7 * 86_400_000 : 86_400_000;
    const days = Number(req.query.days ?? (period === "week" ? 90 : 60));
    const since = Date.now() - days * 86_400_000;
    const rows = await db.prepare(
      "SELECT created_at FROM users WHERE created_at >= ? ORDER BY created_at",
    ).all<{ created_at: number | string }>(since);
    res.json({ period, series: bucketize(rows.map((r) => Number(r.created_at)), bucketMs) });
  } catch (e) { next(e); }
});

adminRouter.get("/messages-over-time", async (req, res, next) => {
  try {
    const period = (String(req.query.period ?? "day") === "week") ? "week" : "day";
    const bucketMs = period === "week" ? 7 * 86_400_000 : 86_400_000;
    const days = Number(req.query.days ?? (period === "week" ? 90 : 60));
    const excludeAdmins = String(req.query.excludeAdmins ?? "true") === "true";
    const since = Date.now() - days * 86_400_000;
    const where = excludeAdmins
      ? `WHERE m.created_at >= ? AND m.sender_id != m.recipient_id
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.sender_id AND u.is_admin = 1)`
      : "WHERE m.created_at >= ? AND m.sender_id != m.recipient_id";
    const rows = await db.prepare(
      `SELECT m.created_at FROM messages m ${where}`,
    ).all<{ created_at: number | string }>(since);
    res.json({ period, excludeAdmins, series: bucketize(rows.map((r) => Number(r.created_at)), bucketMs) });
  } catch (e) { next(e); }
});

// ---- USERS: sortable list ----

adminRouter.get("/users", async (req, res, next) => {
  try {
    const sort = String(req.query.sort ?? "created");
    const dir = String(req.query.dir ?? "desc") === "asc" ? "ASC" : "DESC";
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));

    const orderExpr = ({
      created: "u.created_at",
      lastActive: "last_active",
      messages: "msg_count",
      email: "u.email",
    } as const)[sort as "created" | "lastActive" | "messages" | "email"] ?? "u.created_at";

    const rows = await db.prepare(
      `SELECT
         u.id, u.email, u.handle, u.display_name, u.created_at, u.suspended_at, u.is_admin,
         (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id AND m.sender_id != m.recipient_id) AS msg_count,
         (SELECT MAX(created_at) FROM session_events s WHERE s.user_id = u.id) AS last_active
         FROM users u
         ORDER BY ${orderExpr} ${dir} NULLS LAST
         LIMIT ? OFFSET ?`,
    ).all<{
      id: string; email: string; handle: string; display_name: string;
      created_at: number | string; suspended_at: number | string | null;
      is_admin: number; msg_count: number | string; last_active: number | string | null;
    }>(limit, offset);

    res.json({
      total: await scalar("SELECT COUNT(*)::int AS n FROM users"),
      rows: rows.map((r) => ({
        id: r.id, email: r.email, handle: r.handle, displayName: r.display_name,
        createdAt: Number(r.created_at),
        suspendedAt: r.suspended_at === null ? null : Number(r.suspended_at),
        isAdmin: !!r.is_admin,
        messageCount: Number(r.msg_count ?? 0),
        lastActiveAt: r.last_active === null ? null : Number(r.last_active),
      })),
    });
  } catch (e) { next(e); }
});

// ---- RETENTION: weekly cohorts, D1 / D3 / D7 return rates ----
//
// Signed up this week → sent at least one message within N days of
// their signup. The denominator is users who had the FULL window
// available (signed up at least N days ago), so a user who signed up
// yesterday isn't scored on D7 yet.
adminRouter.get("/retention", async (_req, res, next) => {
  try {
    const now = Date.now();
    const WEEK = 7 * 86_400_000;
    const cohorts: Array<{
      weekStart: number; signups: number;
      d1: { eligible: number; returned: number };
      d3: { eligible: number; returned: number };
      d7: { eligible: number; returned: number };
    }> = [];
    for (let w = 0; w < 12; w++) {
      const windowStart = now - (w + 1) * WEEK;
      const windowEnd = now - w * WEEK;
      const users = await db.prepare(
        "SELECT id, created_at FROM users WHERE created_at >= ? AND created_at < ?",
      ).all<{ id: string; created_at: number | string }>(windowStart, windowEnd);

      const d1Eligible = users.filter((u) => now - Number(u.created_at) >= 1 * 86_400_000);
      const d3Eligible = users.filter((u) => now - Number(u.created_at) >= 3 * 86_400_000);
      const d7Eligible = users.filter((u) => now - Number(u.created_at) >= 7 * 86_400_000);

      cohorts.push({
        weekStart: windowStart,
        signups: users.length,
        d1: { eligible: d1Eligible.length, returned: await returnedWithin(d1Eligible, 1 * 86_400_000) },
        d3: { eligible: d3Eligible.length, returned: await returnedWithin(d3Eligible, 3 * 86_400_000) },
        d7: { eligible: d7Eligible.length, returned: await returnedWithin(d7Eligible, 7 * 86_400_000) },
      });
    }
    res.json({ cohorts: cohorts.reverse() });
  } catch (e) { next(e); }
});

// ---- REPORTS / FEEDBACK: admin consumption side ----

adminRouter.get("/abuse-reports", async (req, res, next) => {
  try {
    const state = String(req.query.state ?? "open");
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const rows = await db.prepare(
      `SELECT a.id, a.reporter_id, a.reported_user_id, a.thread_id, a.reason,
              a.reporter_note, a.created_at, a.state, a.reviewed_by, a.reviewed_at,
              a.action_taken,
              reporter.display_name AS reporter_name, reporter.handle AS reporter_handle,
              reported.display_name AS reported_name, reported.handle AS reported_handle
         FROM abuse_reports a
         JOIN users reporter ON reporter.id = a.reporter_id
         JOIN users reported ON reported.id = a.reported_user_id
         WHERE a.state = ?
         ORDER BY a.created_at DESC
         LIMIT ?`,
    ).all(state, limit);
    res.json({ rows });
  } catch (e) { next(e); }
});

adminRouter.post("/abuse-reports/:id/review", async (req, res, next) => {
  try {
    const body = z.object({
      state: z.enum(["reviewing", "resolved", "dismissed"]),
      actionTaken: z.enum(["none", "warned", "suspended", "banned"]).optional(),
    }).parse(req.body);
    await db.prepare(
      `UPDATE abuse_reports
         SET state = ?, reviewed_by = ?, reviewed_at = ?, action_taken = ?
         WHERE id = ?`,
    ).run(body.state, (req as unknown as { userId: string }).userId, Date.now(), body.actionTaken ?? null, req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.get("/error-reports", async (req, res, next) => {
  try {
    const resolved = String(req.query.resolved ?? "false") === "true";
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const rows = await db.prepare(
      `SELECT id, user_id, kind, message, stack, user_agent, app_version,
              created_at, resolved_at
         FROM error_reports
         WHERE ${resolved ? "resolved_at IS NOT NULL" : "resolved_at IS NULL"}
         ORDER BY created_at DESC
         LIMIT ?`,
    ).all(limit);
    res.json({ rows });
  } catch (e) { next(e); }
});

adminRouter.post("/error-reports/:id/resolve", async (req, res, next) => {
  try {
    await db.prepare(
      "UPDATE error_reports SET resolved_at = ? WHERE id = ?",
    ).run(Date.now(), req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.get("/feedback", async (req, res, next) => {
  try {
    const kind = req.query.kind ? String(req.query.kind) : null;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
    const sql = kind
      ? "SELECT f.*, u.display_name AS author_name, u.handle AS author_handle FROM feedback f JOIN users u ON u.id = f.user_id WHERE f.kind = ? ORDER BY f.created_at DESC LIMIT ?"
      : "SELECT f.*, u.display_name AS author_name, u.handle AS author_handle FROM feedback f JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT ?";
    const rows = kind
      ? await db.prepare(sql).all(kind, limit)
      : await db.prepare(sql).all(limit);
    res.json({ rows });
  } catch (e) { next(e); }
});

// ---- USER MANAGEMENT (minimal, Phase 3 scope) ----

adminRouter.post("/users/:id/suspend", async (req, res, next) => {
  try {
    const uid = req.params.id;
    await db.prepare("UPDATE users SET suspended_at = ? WHERE id = ?").run(Date.now(), uid);
    invalidateAdminCache(uid);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.post("/users/:id/unsuspend", async (req, res, next) => {
  try {
    const uid = req.params.id;
    await db.prepare("UPDATE users SET suspended_at = NULL WHERE id = ?").run(uid);
    invalidateAdminCache(uid);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.post("/users/:id/promote", async (req, res, next) => {
  try {
    const uid = req.params.id;
    await db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(uid);
    invalidateAdminCache(uid);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.post("/users/:id/demote", async (req, res, next) => {
  try {
    const uid = req.params.id;
    const acting = (req as unknown as { userId: string }).userId;
    if (uid === acting) {
      return res.status(400).json({ error: "cannot_demote_self" });
    }
    await db.prepare("UPDATE users SET is_admin = 0 WHERE id = ?").run(uid);
    invalidateAdminCache(uid);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- helpers ----

async function scalar(sql: string, ...args: unknown[]): Promise<number> {
  // Postgres returns integers as strings via some casts; coerce to number.
  // The ::int cast in the queries above keeps that at bay for Postgres,
  // and SQLite returns a number directly.
  const row = await db.prepare(sql).get<{ n: number | string }>(...args);
  return Number(row?.n ?? 0);
}

type UserRef = { id: string; created_at: number | string };
async function returnedWithin(users: UserRef[], windowMs: number): Promise<number> {
  if (users.length === 0) return 0;
  let returned = 0;
  // Query one by one; cohorts are small (users per week), so this is
  // fine. If a cohort grows past a few thousand we can batch into a
  // single IN (...) query.
  for (const u of users) {
    const windowEnd = Number(u.created_at) + windowMs;
    const row = await db.prepare(
      `SELECT 1 AS hit FROM messages
         WHERE sender_id = ? AND sender_id != recipient_id
           AND created_at >= ? AND created_at <= ?
         LIMIT 1`,
    ).get<{ hit: number }>(u.id, Number(u.created_at), windowEnd);
    if (row) returned++;
  }
  return returned;
}

// Groups N timestamps into fixed-width buckets ending at "now". Returns
// a dense series (missing buckets are zero), oldest first, so the UI
// can render it directly without joining.
function bucketize(timestamps: number[], bucketMs: number): Array<{ at: number; count: number }> {
  const now = Date.now();
  // Round the end bucket DOWN to a multiple of bucketMs so the x-axis
  // aligns on day/week boundaries. The chart then reads as "last N
  // complete days" rather than "N arbitrary 24h windows".
  const end = Math.ceil(now / bucketMs) * bucketMs;
  const minTs = timestamps.length ? Math.min(...timestamps) : end - bucketMs;
  const start = Math.floor(minTs / bucketMs) * bucketMs;
  const buckets = new Map<number, number>();
  for (let t = start; t < end; t += bucketMs) buckets.set(t, 0);
  for (const t of timestamps) {
    const b = Math.floor(t / bucketMs) * bucketMs;
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, count]) => ({ at, count }));
}

// Suppress randomUUID import warning if any imports change in future
void randomUUID;
