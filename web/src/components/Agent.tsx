// The Agent — reachable from anywhere via the floating action button
// or the ⌘J shortcut. Slides in from the right as a glass sheet.

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Avatar, Button, Icon } from "./ui.js";
import { runAgent, type AgentEvent } from "../agent/loop.js";
import { executePending, type PendingAction } from "../agent/tools.js";

type UiMsg =
  | { id: string; kind: "you"; text: string }
  | { id: string; kind: "thought"; text: string }
  | { id: string; kind: "reply"; text: string }
  | { id: string; kind: "error"; text: string }
  | { id: string; kind: "confirm"; action: PendingAction; explain: string; resolved?: "sent" | "cancelled" };

export function AgentSheet({
  open, onClose, onDidAct,
}: { open: boolean; onClose: () => void; onDidAct: () => void }) {
  const reduce = useReducedMotion();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<UiMsg[]>([initialGreeting()]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function ask(text: string) {
    if (!text.trim() || busy) return;
    setInput("");
    setMsgs((xs) => [...xs, { id: crypto.randomUUID(), kind: "you", text }]);
    setBusy(true);
    try {
      for await (const ev of runAgent(text)) {
        setMsgs((xs) => [...xs, uiFor(ev)]);
      }
    } catch (e) {
      setMsgs((xs) => [...xs, { id: crypto.randomUUID(), kind: "error", text: (e as Error).message }]);
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
              <Button variant="icon" onClick={onClose} aria-label="Close"><Icon.x /></Button>
            </header>

            <div ref={scrollRef} style={{
              flex: 1, overflowY: "auto", padding: 14,
              display: "flex", flexDirection: "column", gap: 10,
            }}>
              {msgs.map((m) => renderMsg(m, confirm, cancel))}
              <AnimatePresence>
                {busy && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="small" style={{ padding: "6px 12px", color: "var(--text-dim)" }}>thinking…</motion.div>}
              </AnimatePresence>
            </div>

            <div style={{ padding: 12, borderTop: "1px solid var(--line)", display: "flex", gap: 8 }}>
              <input value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") ask(input); }}
                placeholder="Ask the agent…"
                autoFocus
              />
              <Button variant="primary" onClick={() => ask(input)} disabled={busy || !input.trim()}
                aria-label="Ask"><Icon.send /></Button>
            </div>

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
) {
  const base: React.CSSProperties = { padding: "10px 12px", borderRadius: 12, fontSize: 14, whiteSpace: "pre-wrap", wordBreak: "break-word" };
  switch (m.kind) {
    case "you": return (
      <div key={m.id} style={{ ...base, alignSelf: "flex-end", maxWidth: "88%",
        background: "linear-gradient(135deg, var(--violet), var(--violet-2))", color: "#10132a" }}>{m.text}</div>
    );
    case "thought": return (
      <div key={m.id} style={{ ...base, color: "var(--text-dim)", fontStyle: "italic", border: "1px dashed var(--line-strong)" }}>{m.text}</div>
    );
    case "reply": return (
      <div key={m.id} style={{ ...base, background: "var(--glass-bg-hi)", border: "1px solid var(--glass-border-hi)" }}>{m.text}</div>
    );
    case "error": return (
      <div key={m.id} style={{ ...base, color: "var(--danger)", border: "1px solid var(--danger)" }}>{m.text}</div>
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
  if (a.kind === "send") return `To: ${a.toDisplay}\n\n${a.body}`;
  if (a.kind === "reminder") return `${a.text}\n\nWhen: ${new Date(a.whenIso).toLocaleString()}`;
  return `To: ${a.recipientEmail}\nSubject: ${a.subject}\n\n${a.body}`;
}

function uiFor(ev: AgentEvent): UiMsg {
  const id = crypto.randomUUID();
  switch (ev.kind) {
    case "thought": return { id, kind: "thought", text: ev.text };
    case "tool_call": return { id, kind: "thought", text: `↳ ${ev.name}` };
    case "tool_result": return { id, kind: "thought", text: `↩ ${ev.name} returned` };
    case "reply": return { id, kind: "reply", text: ev.text };
    case "confirm": return { id, kind: "confirm", action: ev.action, explain: ev.explain };
    case "error": return { id, kind: "error", text: ev.text };
  }
}

function initialGreeting(): UiMsg {
  return {
    id: "hi", kind: "reply",
    text:
      "I'm your on-device agent. I can search your messages, draft replies, forward with a note, set reminders, and compile things into an email. I always show a preview and wait for you to confirm.",
  };
}
