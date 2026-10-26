// Admin dashboard. Reachable at #/admin.
//
// Access is server-gated: every /api/admin/* request returns 403 if
// the caller's user row doesn't have is_admin = 1. The client also
// hides the link in Settings unless /api/me's isAdmin flag is set,
// but that's cosmetic — the server is the authority.
//
// Nothing in this file reads or renders message plaintext. Everything
// comes from the admin router in server/src/admin.ts, which only
// touches metadata columns.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button, FadeIn, Glass, Icon, toast } from "../components/ui.js";
import { api, apiUrl, loadToken } from "../lib/api.js";

type Overview = {
  users: { total: number; activeDay: number; activeWeek: number; activeMonth: number };
  messages: { total: number; totalExcludingAdmins: number };
  conversations: { oneToOne: number; groups: number };
  queue: { openAbuseReports: number; unresolvedErrors: number };
  agent: { totalCalls: number; calls24h: number; calls7d: number; distinctUsers7d: number; rateLimited24h: number; trackingSince: number };
  generatedAt: number;
};
type AgentLeaderboardRow = { userId: string; handle: string; displayName: string; calls: number; lastCallAt: number };
type AgentDebugRow = { id: string; userId: string; outcome: string; tokensIn: number | null; createdAt: number; handle: string | null; displayName: string | null; isAdmin: boolean };
type SeriesPoint = { at: number; count: number };
type UserRow = {
  id: string; email: string; handle: string; displayName: string;
  createdAt: number; suspendedAt: number | null; isAdmin: boolean;
  messageCount: number; lastActiveAt: number | null;
};
type AbuseRow = {
  id: string; reporter_id: string; reported_user_id: string;
  thread_id: string | null; reason: string; reporter_note: string | null;
  created_at: number; state: string; action_taken: string | null;
  reporter_name: string; reporter_handle: string;
  reported_name: string; reported_handle: string;
};
type ErrorRow = {
  id: string; user_id: string | null; kind: string;
  message: string | null; stack: string | null;
  user_agent: string | null; app_version: string | null;
  created_at: number; resolved_at: number | null;
};
type FeedbackRow = {
  id: string; user_id: string; kind: string;
  rating: number | null; note: string | null; created_at: number;
  author_name: string; author_handle: string;
};
type Tab = "overview" | "users" | "reports" | "feedback";

async function adminFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof Uint8Array) && !(init.body instanceof Blob)) {
    headers.set("content-type", "application/json");
  }
  const t = loadToken();
  if (t) headers.set("authorization", `Bearer ${t}`);
  const r = await fetch(apiUrl(path), { ...init, headers });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json() as Promise<T>;
}

export function AdminDashboard({ onExit }: { onExit: () => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [me, setMe] = useState<{ isAdmin: boolean; displayName: string } | null>(null);
  const [gateChecked, setGateChecked] = useState(false);

  useEffect(() => {
    api.me().then((u) => {
      setMe({ isAdmin: !!(u as unknown as { isAdmin?: boolean }).isAdmin, displayName: u.displayName });
      setGateChecked(true);
    }).catch(() => setGateChecked(true));
  }, []);

  if (!gateChecked) {
    return <FullBleed><div style={{ color: "var(--text-dim)" }}>Loading…</div></FullBleed>;
  }
  if (!me || !me.isAdmin) {
    return (
      <FullBleed>
        <Glass raised style={{ padding: 32, borderRadius: 20, maxWidth: 440, textAlign: "center" }}>
          <h2 style={{ marginTop: 0 }}>Not authorised</h2>
          <p style={{ color: "var(--text-dim)" }}>
            This area is admin-only. Your account doesn't have the admin flag set.
          </p>
          <Button variant="primary" onClick={onExit}>Back to Aegent</Button>
        </Glass>
      </FullBleed>
    );
  }

  return (
    <div style={{
      // Make the entire dashboard its own scroll container so tall
      // tables (users, reports) don't push the footer off-screen on
      // phone-sized viewports. The outer <body> stays overflow:hidden.
      height: "100vh", overflowY: "auto", overflowX: "hidden",
      WebkitOverflowScrolling: "touch",
      padding: "calc(16px + var(--safe-top)) 20px calc(24px + var(--safe-bottom))",
      display: "flex", flexDirection: "column", gap: 16,
      maxWidth: 1180, margin: "0 auto",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: "linear-gradient(135deg, var(--violet), var(--aqua))",
          color: "#10132a", fontWeight: 900, fontSize: 15,
          display: "grid", placeItems: "center",
        }}>Æ</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>Aegent Admin</div>
          <div className="small" style={{ color: "var(--text-dim)" }}>Signed in as {me.displayName}</div>
        </div>
        <Button variant="ghost" onClick={onExit}><Icon.x /> Close</Button>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(["overview", "users", "reports", "feedback"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            aria-label={`Switch to ${t} tab`}
            style={{
              all: "unset", cursor: "pointer",
              padding: "8px 14px", minHeight: 36, borderRadius: 10,
              fontSize: 13, fontWeight: 600,
              background: tab === t ? "linear-gradient(135deg, var(--violet), var(--aqua))" : "transparent",
              color: tab === t ? "#10132a" : "var(--text)",
              border: tab === t ? "1px solid transparent" : "1px solid var(--line)",
            }}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {tab === "overview" && <OverviewTab />}
          {tab === "users" && <UsersTab />}
          {tab === "reports" && <ReportsTab />}
          {tab === "feedback" && <FeedbackTab />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function FullBleed({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: "100vh", display: "grid", placeItems: "center",
      padding: "calc(16px + var(--safe-top)) 20px calc(24px + var(--safe-bottom))",
    }}>{children}</div>
  );
}

// ---------- Overview tab ----------

type CohortRow = {
  weekStart: number; signups: number;
  d1: { eligible: number; returned: number };
  d3: { eligible: number; returned: number };
  d7: { eligible: number; returned: number };
};

function OverviewTab() {
  const [data, setData] = useState<Overview | null>(null);
  const [signups, setSignups] = useState<SeriesPoint[]>([]);
  const [messages, setMessages] = useState<SeriesPoint[]>([]);
  const [excludeAdmins, setExcludeAdmins] = useState(true);
  const [retention, setRetention] = useState<{ cohorts: CohortRow[] } | null>(null);
  const [agentBoard, setAgentBoard] = useState<AgentLeaderboardRow[]>([]);

  useEffect(() => {
    adminFetch<Overview>("/api/admin/overview").then(setData).catch((e) => toast(`overview failed: ${e.message}`, "error"));
    adminFetch<{ series: SeriesPoint[] }>("/api/admin/signups?period=day&days=30").then((r) => setSignups(r.series)).catch(() => undefined);
    adminFetch<{ cohorts: CohortRow[] }>("/api/admin/retention").then((r) => setRetention({ cohorts: r.cohorts })).catch(() => undefined);
    adminFetch<{ rows: AgentLeaderboardRow[] }>("/api/admin/agent-leaderboard?limit=20").then((r) => setAgentBoard(r.rows)).catch(() => undefined);
  }, []);

  useEffect(() => {
    adminFetch<{ series: SeriesPoint[] }>(`/api/admin/messages-over-time?period=day&days=30&excludeAdmins=${excludeAdmins}`)
      .then((r) => setMessages(r.series)).catch(() => undefined);
  }, [excludeAdmins]);

  if (!data) return <div className="small" style={{ color: "var(--text-dim)" }}>Loading…</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <Stat label="Total users" value={data.users.total} />
        <Stat label="Active (24h)" value={data.users.activeDay} hint={`${data.users.activeWeek} this week`} />
        <Stat label="Messages (excl. admin)" value={data.messages.totalExcludingAdmins} hint={`${data.messages.total} total`} />
        <Stat label="1:1 conversations" value={data.conversations.oneToOne} hint={`${data.conversations.groups} groups`} />
        <Stat label="Agent calls (24h)" value={data.agent.calls24h}
          hint={`${data.agent.calls7d} this week · ${data.agent.distinctUsers7d} user${data.agent.distinctUsers7d === 1 ? "" : "s"}`} />
        <Stat
          label={
            data.agent.trackingSince > 0
              ? `Agent · tracked (since ${new Date(data.agent.trackingSince).toLocaleDateString(undefined, { month: "short", day: "numeric" })})`
              : "Agent · tracked"
          }
          value={data.agent.totalCalls}
          hint={
            data.agent.rateLimited24h > 0
              ? `${data.agent.rateLimited24h} rate-limited (24h)`
              : (data.agent.trackingSince === 0
                  ? "No agent calls recorded yet"
                  : "Pre-tracking calls are not stored anywhere")
          }
          tint={data.agent.rateLimited24h > 0 ? "var(--amber)" : undefined} />
        <Stat label="Open abuse reports" value={data.queue.openAbuseReports} tint={data.queue.openAbuseReports > 0 ? "var(--rose)" : undefined} />
        <Stat label="Unresolved errors" value={data.queue.unresolvedErrors} tint={data.queue.unresolvedErrors > 0 ? "var(--amber)" : undefined} />
      </div>

      <Glass style={{ padding: 16, borderRadius: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Signups (last 30 days)</div>
        <BarChart series={signups} />
      </Glass>

      <Glass style={{ padding: 16, borderRadius: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div style={{ fontWeight: 700, flex: 1 }}>Messages (last 30 days)</div>
          <label style={{ fontSize: 12, color: "var(--text-dim)", cursor: "pointer" }}>
            <input type="checkbox" checked={excludeAdmins}
              onChange={(e) => setExcludeAdmins(e.target.checked)}
              style={{ marginRight: 6 }} />
            Exclude admin accounts
          </label>
        </div>
        <BarChart series={messages} />
      </Glass>

      <AgentDebugCard />

      {agentBoard.length > 0 && (
        <Glass style={{ padding: 16, borderRadius: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Top AI agent users</div>
          <div className="small" style={{ color: "var(--text-dim)", marginBottom: 10 }}>
            Lifetime successful agent calls. The daily cap is {10} per non-admin user.
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: "var(--text-dim)" }}>
                  <th style={th}>User</th>
                  <th style={th}>Agent calls</th>
                  <th style={th}>Last call</th>
                </tr>
              </thead>
              <tbody>
                {agentBoard.map((r) => (
                  <tr key={r.userId} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{r.displayName}</div>
                      <div className="small" style={{ color: "var(--text-dim)" }}>@{r.handle}</div>
                    </td>
                    <td style={td}>{r.calls}</td>
                    <td style={td}>{relativeTime(r.lastCallAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Glass>
      )}

      {retention && (
        <Glass style={{ padding: 16, borderRadius: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Weekly cohorts</div>
          <div className="small" style={{ color: "var(--text-dim)", marginBottom: 10 }}>
            Of users who signed up each week, what % sent at least one message by day N.
            "—" means the window isn't complete yet.
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: "var(--text-dim)" }}>
                  <th style={th}>Week of</th>
                  <th style={th}>Signups</th>
                  <th style={th}>D1</th>
                  <th style={th}>D3</th>
                  <th style={th}>D7</th>
                </tr>
              </thead>
              <tbody>
                {retention.cohorts.map((c) => (
                  <tr key={c.weekStart} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={td}>{new Date(c.weekStart).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</td>
                    <td style={td}>{c.signups}</td>
                    <td style={td}>{cohortCell(c.d1)}</td>
                    <td style={td}>{cohortCell(c.d3)}</td>
                    <td style={td}>{cohortCell(c.d7)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Glass>
      )}
    </div>
  );
}

// Shows the raw agent_events feed — proves whether writes are landing
// at all. Useful when the stat tiles read zero but you know you just
// used the agent. Expand to see the last 25 rows (no prompt content).
function AgentDebugCard() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ count: number; recent: AgentDebugRow[] } | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    setLoading(true);
    adminFetch<{ count: number; recent: AgentDebugRow[] }>("/api/admin/debug/agent-events")
      .then(setData)
      .catch((e) => toast(`debug fetch failed: ${e.message}`, "error"))
      .finally(() => setLoading(false));
  }

  return (
    <Glass style={{ padding: 16, borderRadius: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontWeight: 700, flex: 1 }}>Agent diagnostics</div>
        <Button size="small" variant="ghost" onClick={() => { if (!open) load(); setOpen(!open); }}>
          {open ? "Hide" : "Show raw events"}
        </Button>
        <Button size="small" variant="ghost" onClick={load} disabled={loading}>
          {loading ? "…" : "Refresh"}
        </Button>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          {data === null ? (
            <div className="small" style={{ color: "var(--text-mute)" }}>Loading…</div>
          ) : (
            <>
              <div className="small" style={{ color: "var(--text-dim)", marginBottom: 8 }}>
                <strong style={{ color: "var(--text)" }}>{data.count}</strong> total rows in agent_events.
                If this is 0 but you've used the agent, the write is failing silently
                — check Coolify logs for a "[analytics] agent_event write FAILED" line.
              </div>
              {data.recent.length === 0 && <div className="small" style={{ color: "var(--text-mute)" }}>No rows yet.</div>}
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: "var(--text-dim)" }}>
                      <th style={th}>When</th>
                      <th style={th}>User</th>
                      <th style={th}>Outcome</th>
                      <th style={th}>~tokens in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((r) => (
                      <tr key={r.id} style={{ borderTop: "1px solid var(--line)" }}>
                        <td style={td}>{new Date(r.createdAt).toLocaleString()}</td>
                        <td style={td}>
                          {r.displayName ?? "(unknown)"}
                          {r.isAdmin && <span className="tag ok" style={{ marginLeft: 6, fontSize: 10 }}>admin</span>}
                          <div className="small" style={{ color: "var(--text-mute)" }}>@{r.handle ?? r.userId.slice(0, 8)}</div>
                        </td>
                        <td style={td}>
                          <span style={{
                            padding: "2px 6px", borderRadius: 6, fontSize: 11,
                            background: r.outcome === "ok" ? "rgba(127, 230, 161, 0.15)"
                              : r.outcome === "rate_limited" ? "rgba(255, 209, 102, 0.15)"
                              : "rgba(255, 107, 139, 0.15)",
                            color: r.outcome === "ok" ? "var(--ok)"
                              : r.outcome === "rate_limited" ? "var(--amber)"
                              : "var(--danger)",
                          }}>{r.outcome}</span>
                        </td>
                        <td style={td}>{r.tokensIn ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </Glass>
  );
}

function cohortCell(c: { eligible: number; returned: number }): string {
  if (c.eligible === 0) return "—";
  const pct = Math.round((c.returned / c.eligible) * 100);
  return `${pct}% (${c.returned}/${c.eligible})`;
}

function Stat({ label, value, hint, tint }: { label: string; value: number; hint?: string; tint?: string }) {
  return (
    <Glass style={{ padding: 14, borderRadius: 12 }}>
      <div className="small" style={{ color: "var(--text-dim)" }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color: tint ?? "var(--text)", lineHeight: 1.1, marginTop: 4 }}>
        {value.toLocaleString()}
      </div>
      {hint && <div className="small" style={{ color: "var(--text-mute)", marginTop: 2 }}>{hint}</div>}
    </Glass>
  );
}

function BarChart({ series }: { series: SeriesPoint[] }) {
  const max = useMemo(() => series.reduce((m, p) => Math.max(m, p.count), 0), [series]);
  if (series.length === 0) return <div className="small" style={{ color: "var(--text-mute)" }}>No data in this window.</div>;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 120 }}>
      {series.map((p, i) => (
        <div key={i} title={`${new Date(p.at).toLocaleDateString()}: ${p.count}`}
          style={{
            flex: 1,
            height: `${max > 0 ? (p.count / max) * 100 : 0}%`,
            minHeight: p.count > 0 ? 2 : 0,
            background: "linear-gradient(180deg, var(--violet), var(--aqua))",
            borderRadius: "3px 3px 0 0", opacity: 0.9,
          }} />
      ))}
    </div>
  );
}

// ---------- Users tab ----------

function UsersTab() {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<"created" | "lastActive" | "messages" | "email">("messages");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminFetch<{ total: number; rows: UserRow[] }>(
        `/api/admin/users?sort=${sort}&dir=${dir}&limit=100`,
      );
      setRows(r.rows); setTotal(r.total);
    } catch (e) { toast(`users failed: ${(e as Error).message}`, "error"); }
    finally { setLoading(false); }
  }, [sort, dir]);
  useEffect(() => { load(); }, [load]);

  async function act(uid: string, action: "suspend" | "unsuspend" | "promote" | "demote") {
    try {
      await adminFetch(`/api/admin/users/${encodeURIComponent(uid)}/${action}`, { method: "POST" });
      toast(`${action} ok`, "ok");
      load();
    } catch (e) { toast(`${action} failed: ${(e as Error).message}`, "error"); }
  }

  const toggleSort = (key: typeof sort) => {
    if (sort === key) setDir(dir === "asc" ? "desc" : "asc");
    else { setSort(key); setDir(key === "email" ? "asc" : "desc"); }
  };

  return (
    <Glass style={{ padding: 16, borderRadius: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{ fontWeight: 700, flex: 1 }}>Users ({total.toLocaleString()})</div>
        {loading && <span className="small" style={{ color: "var(--text-dim)" }}>Loading…</span>}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ color: "var(--text-dim)" }}>
              <th style={th} onClick={() => toggleSort("email")}>User {sortArrow(sort, "email", dir)}</th>
              <th style={th} onClick={() => toggleSort("created")}>Signed up {sortArrow(sort, "created", dir)}</th>
              <th style={th} onClick={() => toggleSort("lastActive")}>Last active {sortArrow(sort, "lastActive", dir)}</th>
              <th style={th} onClick={() => toggleSort("messages")}>Messages {sortArrow(sort, "messages", dir)}</th>
              <th style={th}>Status</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} style={{ borderTop: "1px solid var(--line)" }}>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{u.displayName}</div>
                  <div className="small" style={{ color: "var(--text-dim)" }}>@{u.handle} · {u.email}</div>
                </td>
                <td style={td}>{new Date(u.createdAt).toLocaleDateString()}</td>
                <td style={td}>{u.lastActiveAt ? relativeTime(u.lastActiveAt) : "—"}</td>
                <td style={td}>{u.messageCount}</td>
                <td style={td}>
                  {u.isAdmin && <span className="tag ok" style={{ marginRight: 4 }}>admin</span>}
                  {u.suspendedAt && <span className="tag" style={{ background: "var(--rose)", color: "#10132a" }}>suspended</span>}
                  {!u.isAdmin && !u.suspendedAt && <span className="small" style={{ color: "var(--text-mute)" }}>active</span>}
                </td>
                <td style={td}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {u.suspendedAt
                      ? <Button size="small" variant="ghost" onClick={() => act(u.id, "unsuspend")}>Unsuspend</Button>
                      : <Button size="small" variant="ghost" onClick={() => act(u.id, "suspend")}>Suspend</Button>}
                    {u.isAdmin
                      ? <Button size="small" variant="ghost" onClick={() => act(u.id, "demote")}>Demote</Button>
                      : <Button size="small" variant="ghost" onClick={() => act(u.id, "promote")}>Promote</Button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Glass>
  );
}

function sortArrow(active: string, key: string, dir: "asc" | "desc"): string {
  if (active !== key) return "";
  return dir === "asc" ? " ↑" : " ↓";
}

// ---------- Reports tab (abuse + errors) ----------

function ReportsTab() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <AbuseReports />
      <ErrorReports />
    </div>
  );
}

function AbuseReports() {
  const [rows, setRows] = useState<AbuseRow[]>([]);
  const [state, setState] = useState<"open" | "reviewing" | "resolved" | "dismissed">("open");

  const load = useCallback(() => {
    adminFetch<{ rows: AbuseRow[] }>(`/api/admin/abuse-reports?state=${state}&limit=100`)
      .then((r) => setRows(r.rows)).catch((e) => toast(`abuse failed: ${e.message}`, "error"));
  }, [state]);
  useEffect(() => { load(); }, [load]);

  async function review(id: string, nextState: "reviewing" | "resolved" | "dismissed", actionTaken?: string) {
    try {
      await adminFetch(`/api/admin/abuse-reports/${encodeURIComponent(id)}/review`, {
        method: "POST", body: JSON.stringify({ state: nextState, actionTaken: actionTaken ?? "none" }),
      });
      toast(`Marked ${nextState}`, "ok");
      load();
    } catch (e) { toast(`review failed: ${(e as Error).message}`, "error"); }
  }

  return (
    <Glass style={{ padding: 16, borderRadius: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontWeight: 700, flex: 1 }}>Abuse reports</div>
        <select value={state} onChange={(e) => setState(e.target.value as typeof state)}
          style={{ padding: "6px 10px", borderRadius: 8, background: "var(--ink-2)", color: "var(--text)", border: "1px solid var(--line)" }}>
          <option value="open">Open</option>
          <option value="reviewing">Reviewing</option>
          <option value="resolved">Resolved</option>
          <option value="dismissed">Dismissed</option>
        </select>
      </div>
      {rows.length === 0 && <div className="small" style={{ color: "var(--text-mute)" }}>No reports in this state.</div>}
      {rows.map((r) => (
        <div key={r.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
          <div className="small" style={{ color: "var(--text-dim)" }}>
            {new Date(r.created_at).toLocaleString()} · reason: <strong style={{ color: "var(--text)" }}>{r.reason}</strong>
          </div>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            <strong>{r.reporter_name}</strong> (@{r.reporter_handle}) → reported <strong>{r.reported_name}</strong> (@{r.reported_handle})
          </div>
          {r.reporter_note && (
            <div style={{
              marginTop: 6, padding: "8px 10px", background: "var(--ink-2)",
              borderRadius: 8, fontSize: 13, color: "var(--text-dim)", whiteSpace: "pre-wrap",
            }}>Note from reporter: "{r.reporter_note}"</div>
          )}
          {r.state === "open" && (
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              <Button size="small" variant="ghost" onClick={() => review(r.id, "reviewing")}>Start review</Button>
              <Button size="small" variant="ghost" onClick={() => review(r.id, "dismissed")}>Dismiss</Button>
              <Button size="small" variant="primary" onClick={() => review(r.id, "resolved", "warned")}>Resolve · warn</Button>
              <Button size="small" variant="primary" onClick={() => review(r.id, "resolved", "suspended")}>Resolve · suspend</Button>
            </div>
          )}
        </div>
      ))}
    </Glass>
  );
}

function ErrorReports() {
  const [rows, setRows] = useState<ErrorRow[]>([]);
  const [resolved, setResolved] = useState(false);

  const load = useCallback(() => {
    adminFetch<{ rows: ErrorRow[] }>(`/api/admin/error-reports?resolved=${resolved}&limit=100`)
      .then((r) => setRows(r.rows)).catch((e) => toast(`errors failed: ${e.message}`, "error"));
  }, [resolved]);
  useEffect(() => { load(); }, [load]);

  async function resolve(id: string) {
    try {
      await adminFetch(`/api/admin/error-reports/${encodeURIComponent(id)}/resolve`, { method: "POST" });
      toast("Resolved", "ok");
      load();
    } catch (e) { toast(`resolve failed: ${(e as Error).message}`, "error"); }
  }

  return (
    <Glass style={{ padding: 16, borderRadius: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontWeight: 700, flex: 1 }}>Error reports</div>
        <label className="small" style={{ color: "var(--text-dim)", cursor: "pointer" }}>
          <input type="checkbox" checked={resolved} onChange={(e) => setResolved(e.target.checked)} style={{ marginRight: 6 }} />
          Show resolved
        </label>
      </div>
      {rows.length === 0 && <div className="small" style={{ color: "var(--text-mute)" }}>No errors in this state.</div>}
      {rows.map((r) => (
        <div key={r.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
          <div className="small" style={{ color: "var(--text-dim)" }}>
            {new Date(r.created_at).toLocaleString()} · kind: <strong style={{ color: "var(--text)" }}>{r.kind}</strong>
            {r.app_version && <> · v{r.app_version}</>}
          </div>
          {r.message && <div style={{ fontSize: 13, marginTop: 4 }}>{r.message}</div>}
          {r.stack && (
            <pre style={{
              marginTop: 6, padding: "8px 10px", background: "var(--ink-2)",
              borderRadius: 8, fontSize: 11, color: "var(--text-dim)",
              maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap",
            }}>{r.stack}</pre>
          )}
          {r.user_agent && <div className="small" style={{ color: "var(--text-mute)", marginTop: 4 }}>{r.user_agent}</div>}
          {!r.resolved_at && (
            <div style={{ marginTop: 8 }}>
              <Button size="small" variant="ghost" onClick={() => resolve(r.id)}>Mark resolved</Button>
            </div>
          )}
        </div>
      ))}
    </Glass>
  );
}

// ---------- Feedback tab ----------

function FeedbackTab() {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [kind, setKind] = useState<string>("");

  useEffect(() => {
    // URLSearchParams builds a correct `?a=b&c=d` every time — the
    // previous `.replace("?&", "?")` fallback produced `&limit=200`
    // (no `?`) when no kind was selected, which 404'd.
    const qs = new URLSearchParams({ limit: "200" });
    if (kind) qs.set("kind", kind);
    adminFetch<{ rows: FeedbackRow[] }>(`/api/admin/feedback?${qs.toString()}`)
      .then((r) => setRows(r.rows)).catch((e) => toast(`feedback failed: ${e.message}`, "error"));
  }, [kind]);

  return (
    <Glass style={{ padding: 16, borderRadius: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontWeight: 700, flex: 1 }}>Feedback</div>
        <select value={kind} onChange={(e) => setKind(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 8, background: "var(--ink-2)", color: "var(--text)", border: "1px solid var(--line)" }}>
          <option value="">All kinds</option>
          <option value="nps">NPS</option>
          <option value="feature_request">Feature request</option>
          <option value="bug">Bug</option>
          <option value="general">General</option>
        </select>
      </div>
      {rows.length === 0 && <div className="small" style={{ color: "var(--text-mute)" }}>No feedback yet.</div>}
      {rows.map((r) => (
        <div key={r.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
          <div className="small" style={{ color: "var(--text-dim)" }}>
            {new Date(r.created_at).toLocaleString()} · {r.kind}
            {r.rating !== null && <> · rating: <strong style={{ color: "var(--text)" }}>{r.rating}/5</strong></>}
          </div>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            <strong>{r.author_name}</strong> (@{r.author_handle})
          </div>
          {r.note && <div style={{
            marginTop: 6, padding: "8px 10px", background: "var(--ink-2)",
            borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap",
          }}>{r.note}</div>}
        </div>
      ))}
    </Glass>
  );
}

// ---------- helpers ----------

const th: React.CSSProperties = {
  textAlign: "left", padding: "8px 10px", fontWeight: 600,
  cursor: "pointer", userSelect: "none",
};
const td: React.CSSProperties = { padding: "10px", verticalAlign: "top" };

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}
