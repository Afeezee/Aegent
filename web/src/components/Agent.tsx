// The Agent — reachable from anywhere via the floating action button
// or the ⌘J shortcut. Slides in from the right as a glass sheet.

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Avatar, Button, Icon, toast } from "./ui.js";
import { runAgent, type AgentEvent, type ConvTurn } from "../agent/loop.js";
import { executePending, type PendingAction } from "../agent/tools.js";
import { isSpeechSupported, startSpeech, type SpeechSession } from "../lib/speech.js";
import { appendAgentTurn, clearAgentTurns, listAgentTurns } from "../lib/store.js";

// A single match surfaced by a retrieval tool (search_messages,
// search_exact, get_last_message, etc.). Carries the identifiers
// needed to open the chat and scroll to the exact message.
export type ResultItem = {
  id: string;        // message id
  peerId: string;    // chat id (contact id for 1:1, group id for group)
  peerName: string;
  isGroup: boolean;
  senderName: string;
  when: number;      // ms epoch
  body: string;      // preview text / caption / [media]
  mediaKind?: string | null;
};

type UiMsg =
  | { id: string; kind: "you"; text: string }
  | { id: string; kind: "thought"; text: string }
  | { id: string; kind: "reply"; text: string }
  | { id: string; kind: "error"; text: string }
  | { id: string; kind: "results"; items: ResultItem[] }
  | { id: string; kind: "confirm"; action: PendingAction; explain: string; resolved?: "sent" | "cancelled" };

// External-event bus. Anything in the app can push a UI message into the
// Agent panel — currently used by the scheduled-backup runner to surface
// due backups as confirm cards without the user having to re-ask.
type PushKind = { kind: "reply"; text: string } | { kind: "confirm"; action: PendingAction; explain: string };
const pushListeners = new Set<(u: PushKind) => void>();
export function pushAgentEvent(u: PushKind) {
  pushListeners.forEach((cb) => cb(u));
}

export function AgentSheet({
  open, onClose, onDidAct, onOpenMessage,
  initialQuery, onConsumeInitialQuery,
}: {
  open: boolean;
  onClose: () => void;
  onDidAct: () => void;
  onOpenMessage?: (peerId: string, isGroup: boolean, msgId: string) => void;
  // When set and the sheet is open, auto-ask this query on mount
  // (used by the "/agent …" slash in the chat composer). Cleared
  // via onConsumeInitialQuery once we've handed it to ask().
  initialQuery?: string | null;
  onConsumeInitialQuery?: () => void;
}) {
  const reduce = useReducedMotion();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Start empty; the persisted-history effect below fills this in on
  // first open, appending the greeting only if the transcript is
  // genuinely empty.
  const [msgs, setMsgs] = useState<UiMsg[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const speechSupported = isSpeechSupported();
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const speechRef = useRef<SpeechSession | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  // Load persisted transcript once, on first open. Rows come back
  // oldest-first from listAgentTurns. Confirm cards aren't persisted
  // (replaying them would be misleading) — the placeholder-row kind
  // renders as a subtle "[confirmation card shown]" line so the
  // history reads correctly.
  useEffect(() => {
    if (!open || historyLoaded) return;
    (async () => {
      try {
        const rows = await listAgentTurns();
        const rehydrated: UiMsg[] = rows.map((r) => {
          if (r.kind === "confirm_placeholder") {
            return { id: r.id, kind: "thought", text: r.text };
          }
          return { id: r.id, kind: r.kind as "you" | "thought" | "reply" | "error", text: r.text };
        });
        setMsgs(rehydrated.length ? rehydrated : [initialGreeting()]);
      } catch {
        setMsgs([initialGreeting()]);
      } finally {
        setHistoryLoaded(true);
      }
    })();
  }, [open, historyLoaded]);

  // Persist any non-transient message that lands in the transcript.
  // Confirm cards go in as a placeholder line so history reads right.
  async function persistTurn(m: UiMsg): Promise<void> {
    try {
      if (m.kind === "confirm") {
        await appendAgentTurn({
          kind: "confirm_placeholder",
          text: `[confirmation shown: ${m.explain}]`,
        });
      } else if (m.kind === "results") {
        // Don't rehydrate stale result cards on next open — the ids
        // may point to messages that have since been deleted, and
        // the "wasted a search" value of the history is low.
        await appendAgentTurn({
          kind: "confirm_placeholder",
          text: `[${m.items.length} result${m.items.length === 1 ? "" : "s"} shown]`,
        });
      } else {
        await appendAgentTurn({ kind: m.kind, text: m.text });
      }
    } catch { /* transient DB error — never fail the UI */ }
  }

  async function clearHistory() {
    // `confirm` is shadowed by the local `confirm(id, action)` handler
    // below — use the window global explicitly.
    if (!window.confirm("Clear the entire agent chat history? This can't be undone.")) return;
    await clearAgentTurns().catch(() => { /* ignore */ });
    setMsgs([initialGreeting()]);
    toast("Agent history cleared", "ok");
  }

  // Subscribe to external pushes (e.g. scheduled backups coming due).
  useEffect(() => {
    const cb = (u: { kind: "reply"; text: string } | { kind: "confirm"; action: PendingAction; explain: string }) => {
      const m = { ...u, id: crypto.randomUUID() } as UiMsg;
      setMsgs((xs) => [...xs, m]);
      persistTurn(m);
    };
    pushListeners.add(cb);
    return () => { pushListeners.delete(cb); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Auto-fire a query handed over by the host (chat composer's
  // `/agent …` path). Runs once per non-empty initialQuery, after
  // history has been rehydrated so the LLM gets a full transcript.
  useEffect(() => {
    if (!open || !initialQuery || !historyLoaded || busy) return;
    const q = initialQuery;
    onConsumeInitialQuery?.();
    void ask(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialQuery, historyLoaded]);

  async function ask(text: string) {
    if (!text.trim() || busy) return;
    setInput("");
    // Snapshot the transcript BEFORE we append this turn — that
    // snapshot is what Claude gets as prior conversation. Filter to
    // clean user↔assistant exchanges; internal thoughts / errors /
    // confirm-card placeholders don't help the LLM.
    const history: ConvTurn[] = msgs
      .filter((m): m is Extract<UiMsg, { kind: "you" | "reply" }> =>
        (m.kind === "you" || m.kind === "reply") && !!m.text?.trim())
      .map((m) => ({ role: m.kind === "you" ? "user" : "assistant", content: m.text }));

    const youMsg: UiMsg = { id: crypto.randomUUID(), kind: "you", text };
    setMsgs((xs) => [...xs, youMsg]);
    persistTurn(youMsg);
    setBusy(true);
    try {
      for await (const ev of runAgent(text, { history })) {
        const m = uiFor(ev);
        setMsgs((xs) => [...xs, m]);
        persistTurn(m);
      }
    } catch (e) {
      const err: UiMsg = { id: crypto.randomUUID(), kind: "error", text: (e as Error).message };
      setMsgs((xs) => [...xs, err]);
      persistTurn(err);
    } finally { setBusy(false); }
  }

  async function confirm(id: string, action: PendingAction) {
    const res = await executePending(action);
    setMsgs((xs) => xs.map((m) =>
      m.id === id && m.kind === "confirm" ? { ...m, resolved: res.ok ? "sent" : "cancelled" } : m,
    ));
    if (res.ok) onDidAct();
  }
  function cancel(id: string) {
    setMsgs((xs) => xs.map((m) => (m.id === id && m.kind === "confirm" ? { ...m, resolved: "cancelled" } : m)));
  }

  function toggleMic() {
    if (listening) {
      speechRef.current?.stop();
      return;
    }
    if (!speechSupported) { toast("Voice input isn't supported in this browser", "warn"); return; }
    setInterim(""); setListening(true);
    speechRef.current = startSpeech({
      onInterim: (t) => { setInterim(t); setInput(t); },
      onFinal: (t) => {
        setListening(false); setInterim("");
        speechRef.current = null;
        if (t.trim()) { setInput(t); ask(t); }
      },
      onError: (msg) => {
        setListening(false); setInterim("");
        speechRef.current = null;
        if (!/no-speech|aborted/i.test(msg)) toast(`Voice: ${msg}`, "error");
      },
    });
  }
  // Cleanup on close/unmount.
  useEffect(() => {
    if (!open && speechRef.current) { speechRef.current.abort(); speechRef.current = null; setListening(false); setInterim(""); }
  }, [open]);
  useEffect(() => () => { speechRef.current?.abort(); }, []);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.16 }}
          style={{
            position: "fixed", inset: 0, zIndex: 950,
            background: "rgba(4,6,16,0.4)", backdropFilter: "blur(6px)",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.aside
            initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
            className="glass glass-hi"
            style={{
              position: "absolute", right: 16, top: 16, bottom: 16,
              width: "min(420px, calc(100vw - 32px))",
              display: "flex", flexDirection: "column", borderRadius: 20, overflow: "hidden",
            }}
          >
            <header style={{
              display: "flex", alignItems: "center", gap: 10, padding: "14px 16px",
              borderBottom: "1px solid var(--line)",
            }}>
              <Avatar name="Ag" style={{ background: "linear-gradient(135deg, var(--violet), var(--aqua))" }} size="sm" />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>Agent</div>
                <div className="small">on-device · confirms before acting</div>
              </div>
              <Button variant="icon" onClick={clearHistory} title="Clear conversation history" aria-label="Clear history">
                <Icon.trash />
              </Button>
              <Button variant="icon" onClick={onClose} aria-label="Close"><Icon.x /></Button>
            </header>

            <div ref={scrollRef} style={{
              flex: 1, overflowY: "auto", padding: 14,
              display: "flex", flexDirection: "column", gap: 10,
            }}>
              {groupMsgs(msgs).map((entry, i) => {
                if (entry.kind === "thoughts") {
                  return <ThoughtStrip key={`t-${i}`} steps={entry.steps} />;
                }
                return renderMsg(entry.msg, confirm, cancel, (peerId, isGroup, msgId) => {
                  onClose();
                  onOpenMessage?.(peerId, isGroup, msgId);
                });
              })}
              <AnimatePresence>
                {busy && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="small" style={{ padding: "6px 12px", color: "var(--text-dim)" }}>thinking…</motion.div>}
              </AnimatePresence>
            </div>

            <div style={{ padding: 12, borderTop: "1px solid var(--line)", display: "flex", gap: 8, alignItems: "center" }}>
              {speechSupported && (
                <Button variant="icon"
                  onClick={toggleMic}
                  title={listening ? "Stop listening" : "Speak"}
                  aria-label={listening ? "Stop listening" : "Speak"}
                  style={listening
                    ? { background: "var(--danger)", color: "#0f1226", borderColor: "transparent" }
                    : undefined}
                >
                  <Icon.mic />
                </Button>
              )}
              <input value={listening && interim ? interim : input}
                onChange={(e) => { if (!listening) setInput(e.target.value); }}
                onKeyDown={(e) => { if (e.key === "Enter" && !listening) ask(input); }}
                placeholder={listening ? "Listening…" : "Ask the agent…"}
                disabled={listening}
                autoFocus
              />
              <Button variant="primary" onClick={() => ask(input)} disabled={busy || listening || !input.trim()}
                aria-label="Ask"><Icon.send /></Button>
            </div>
            {listening && (
              <div style={{ padding: "0 14px 8px", display: "flex", gap: 6, alignItems: "center", color: "var(--text-dim)", fontSize: 12 }}>
                <motion.span animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.1, repeat: Infinity }}
                  style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--danger)" }} />
                <span>Listening — tap the mic again to send.</span>
              </div>
            )}

            {msgs.length <= 1 && (
              <div style={{ padding: "0 14px 14px", display: "flex", flexWrap: "wrap", gap: 6 }}>
                {[
                  "Find the chat about the payment project",
                  "Remind me to call Alice tomorrow at 10am",
                  "Send Alice that I'm on my way",
                ].map((s) => (
                  <button key={s} onClick={() => ask(s)}
                    style={{
                      padding: "6px 10px", fontSize: 12, borderRadius: 999,
                      background: "rgba(138,125,255,0.12)",
                      border: "1px solid var(--glass-border-hi)",
                      color: "var(--text)", cursor: "pointer",
                    }}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function renderMsg(
  m: UiMsg,
  confirm: (id: string, a: PendingAction) => void,
  cancel: (id: string) => void,
  onOpenMessage?: (peerId: string, isGroup: boolean, msgId: string) => void,
) {
  const base: React.CSSProperties = { padding: "10px 12px", borderRadius: 12, fontSize: 14, wordBreak: "break-word" };
  switch (m.kind) {
    case "you": return (
      <div key={m.id} style={{ ...base, alignSelf: "flex-end", maxWidth: "88%", whiteSpace: "pre-wrap",
        background: "linear-gradient(135deg, var(--violet), var(--violet-2))", color: "#10132a" }}>{m.text}</div>
    );
    case "thought":
      // Standalone thoughts render subtly; consecutive ones get grouped
      // upstream by groupMsgs → ThoughtStrip.
      return (
        <div key={m.id} className="small" style={{ padding: "2px 8px", color: "var(--text-mute)", fontStyle: "italic" }}>{m.text}</div>
      );
    case "reply": return (
      <div key={m.id} style={{ ...base, background: "var(--glass-bg-hi)", border: "1px solid var(--glass-border-hi)" }}>
        <div className="agent-md">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // Open outbound links in a new tab, and never leak referrer.
              a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
            }}
          >{m.text}</ReactMarkdown>
        </div>
      </div>
    );
    case "error": return (
      <div key={m.id} style={{ ...base, color: "var(--danger)", border: "1px solid var(--danger)", whiteSpace: "pre-wrap" }}>{m.text}</div>
    );
    case "results": return (
      <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {m.items.slice(0, 8).map((r) => (
          <ResultCard key={r.id} r={r} onOpen={onOpenMessage} />
        ))}
        {m.items.length > 8 && (
          <div className="small" style={{ color: "var(--text-mute)", paddingLeft: 2 }}>
            +{m.items.length - 8} more — ask for a narrower search
          </div>
        )}
      </div>
    );
    case "confirm": return (
      <div key={m.id} className="glass" style={{ padding: 12, borderRadius: 12, borderColor: "var(--accent)" }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 6 }}>{m.explain}</div>
        <div style={{
          background: "var(--ink-2)", border: "1px solid var(--line)", borderRadius: 10,
          padding: 10, fontSize: 13, whiteSpace: "pre-wrap", marginBottom: 8,
        }}>{previewOf(m.action)}</div>
        {m.action.kind === "email" && (
          <div style={{ fontSize: 12, color: "var(--danger)", marginBottom: 8 }}>
            Email is not end-to-end encrypted the way Aegent messages are.
          </div>
        )}
        {m.resolved === "sent" ? <div className="small" style={{ color: "var(--ok)" }}>✓ done</div>
          : m.resolved === "cancelled" ? <div className="small">cancelled</div>
          : (
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button size="small" variant="ghost" onClick={() => cancel(m.id)}>Cancel</Button>
              <Button size="small" variant="primary" onClick={() => confirm(m.id, m.action)}>Confirm</Button>
            </div>
          )}
      </div>
    );
  }
}

function previewOf(a: PendingAction): string {
  switch (a.kind) {
    case "send":
      return `To: ${a.toDisplay}\n\n${a.body}`;
    case "reminder":
      return `${a.text}\n\nWhen: ${new Date(a.whenIso).toLocaleString()}`;
    case "email":
      return `To: ${a.recipientEmail}\nSubject: ${a.subject}\n\n${a.body}`;
    case "delete":
      return `Delete this message for everyone:\n\n${a.preview}`;
    case "schedule_send":
      return `To: ${a.toDisplay}\nAt: ${new Date(a.whenIso).toLocaleString()}\n\n${a.body}`;
    case "calendar_event":
      return `${a.title}\n${new Date(a.whenIso).toLocaleString()} · ${a.durationMin} min${a.notes ? `\n\n${a.notes}` : ""}`;
    case "add_contact":
      return `Add @${a.handle} to your contacts`;
    case "save_contact_to_phone":
      return `Save ${a.displayName} to your phone Contacts\n@${a.handle}${a.phone ? `\n${a.phone}` : ""}${a.email ? `\n${a.email}` : ""}`;
    default: return "";
  }
}

// Tools whose return value is an array of decorated-message hits we
// want to render as tappable result cards.
const RESULT_TOOLS = new Set([
  "search_messages", "search_exact", "search_by_date_range",
  "search_by_sender", "search_by_media_type", "search_links_and_patterns",
  "get_thread", "get_context_around", "summarize_thread",
]);

function uiFor(ev: AgentEvent): UiMsg {
  const id = crypto.randomUUID();
  switch (ev.kind) {
    case "thought": return { id, kind: "thought", text: ev.text };
    case "tool_call": return { id, kind: "thought", text: `↳ ${ev.name}` };
    case "tool_result": {
      // If this is a retrieval tool whose value is a decorated list,
      // render as tappable cards instead of a dim "returned" line.
      if (RESULT_TOOLS.has(ev.name)) {
        const items = extractResults(ev.value);
        if (items.length) return { id, kind: "results", items };
      }
      return { id, kind: "thought", text: `↩ ${ev.name} returned` };
    }
    case "reply": return { id, kind: "reply", text: ev.text };
    case "confirm": return { id, kind: "confirm", action: ev.action, explain: ev.explain };
    case "error": return { id, kind: "error", text: ev.text };
  }
}

// Decoder for `{ ok: true, kind: "data", value: Array<decorated> }`.
// Safe against unknown shapes — returns [] when the tool returned
// anything other than an array of items with the fields we need.
function extractResults(raw: unknown): ResultItem[] {
  const w = raw as { ok?: boolean; kind?: string; value?: unknown } | null;
  if (!w?.ok || w.kind !== "data" || !Array.isArray(w.value)) return [];
  const out: ResultItem[] = [];
  for (const r of w.value as Array<Record<string, unknown>>) {
    if (!r || typeof r.id !== "string" || typeof r.peerId !== "string") continue;
    out.push({
      id: r.id,
      peerId: r.peerId,
      peerName: String(r.peerName ?? "Unknown"),
      isGroup: !!r.isGroup,
      senderName: String(r.senderName ?? "Someone"),
      when: Number(r.when ?? 0),
      body: String(r.body ?? ""),
      mediaKind: (r.mediaKind as string | null | undefined) ?? null,
    });
  }
  return out;
}

// Consecutive `thought` UiMsgs get folded into one compact strip so the
// intermediate reasoning doesn't dominate the visual stream. Everything
// else passes through unchanged.
type GroupedEntry =
  | { kind: "msg"; msg: UiMsg }
  | { kind: "thoughts"; steps: string[] };
function groupMsgs(msgs: UiMsg[]): GroupedEntry[] {
  const out: GroupedEntry[] = [];
  let bucket: string[] | null = null;
  for (const m of msgs) {
    if (m.kind === "thought") {
      if (!bucket) { bucket = []; out.push({ kind: "thoughts", steps: bucket }); }
      bucket.push(m.text);
    } else {
      bucket = null;
      out.push({ kind: "msg", msg: m });
    }
  }
  return out;
}

function ThoughtStrip({ steps }: { steps: string[] }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  return (
    <div style={{ paddingLeft: 4 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          background: "transparent", border: "none", padding: "2px 6px",
          color: "var(--text-mute)", fontSize: 11, cursor: "pointer",
          display: "inline-flex", alignItems: "center", gap: 6, letterSpacing: 0.4,
        }}
        aria-label={open ? "Hide reasoning" : "Show reasoning"}
      >
        <span style={{
          display: "inline-block",
          transform: open ? "rotate(90deg)" : "rotate(0deg)",
          transition: "transform .15s ease",
        }}>▸</span>
        {steps.length} step{steps.length === 1 ? "" : "s"}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "hidden" }}
          >
            <div style={{
              padding: "6px 10px 4px 22px",
              display: "flex", flexDirection: "column", gap: 4,
              color: "var(--text-mute)", fontSize: 11, fontStyle: "italic",
              borderLeft: "2px solid var(--line)", marginLeft: 8,
            }}>
              {steps.map((s, i) => <div key={i}>{s}</div>)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Tappable result card: sender · chat name · exact timestamp · snippet.
// Follows the touch-target priority rules (≥44px tall, visible focus).
function ResultCard({
  r, onOpen,
}: {
  r: ResultItem;
  onOpen?: (peerId: string, isGroup: boolean, msgId: string) => void;
}) {
  const when = new Date(r.when);
  const whenStr = when.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const mediaBadge = r.mediaKind ? `[${r.mediaKind}] ` : "";
  const body = (mediaBadge + (r.body || "")).trim() || "(no text)";
  const disabled = !onOpen;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onOpen?.(r.peerId, r.isGroup, r.id)}
      aria-label={`Open ${r.senderName}'s message in ${r.peerName}, ${whenStr}`}
      style={{
        all: "unset",
        display: "flex", flexDirection: "column", gap: 2,
        padding: "10px 12px", minHeight: 44, borderRadius: 12,
        background: "var(--ink-2)",
        border: "1px solid var(--line)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.75 : 1,
        boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--text-dim)" }}>
        <strong style={{ color: "var(--text)" }}>{r.senderName}</strong>
        <span>·</span>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {r.isGroup ? "📣 " : ""}{r.peerName}
        </span>
        <span style={{ marginLeft: "auto" }}>{whenStr}</span>
      </div>
      <div style={{
        fontSize: 13, color: "var(--text)",
        display: "-webkit-box", WebkitBoxOrient: "vertical",
        WebkitLineClamp: 2, overflow: "hidden", wordBreak: "break-word",
      }}>
        {body}
      </div>
    </button>
  );
}

function initialGreeting(): UiMsg {
  return {
    id: "hi", kind: "reply",
    text:
      "I'm your on-device agent. I can search your messages, draft replies, forward with a note, set reminders, and compile things into an email. I always show a preview and wait for you to confirm.",
  };
}
