// First-use consent for the agent.
//
// Shown the first time someone taps the agent, not at sign-up, where it
// would be noise before it means anything. Plain language, no jargon: it
// says what happens to a message when you ask for help, and lets the
// person turn it on or wait. "Not now" leaves consent ungranted, so the
// next tap asks again.

import { useState } from "react";
import { Button } from "./ui.js";
import { currentSession } from "../lib/session.js";

const KEY = () => `aegent.agent-consent.${currentSession()?.user.id ?? "anon"}`;

export function hasAgentConsent(): boolean {
  try { return localStorage.getItem(KEY()) === "1"; } catch { return false; }
}
function grantAgentConsent(): void {
  try { localStorage.setItem(KEY(), "1"); } catch { /* ignore */ }
}

export function AgentConsent({ onAccept, onDecline }: { onAccept: () => void; onDecline: () => void }) {
  const [how, setHow] = useState(false);
  return (
    <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>Meet your agent</h2>
        <p style={{ margin: 0, color: "var(--text-dim)", lineHeight: 1.6 }}>
          Your chats stay end-to-end encrypted. When you ask the agent for
          help, it picks only the messages it needs on your phone and sends
          them to our AI to get an answer. Nothing else leaves your phone.
        </p>
      </div>

      <Flow />

      <button type="button" onClick={() => setHow((v) => !v)}
        style={{ all: "unset", cursor: "pointer", color: "var(--accent-strong)", fontSize: 13 }}>
        How it works {how ? "↑" : "→"}
      </button>
      {how && (
        <div className="small" style={{ lineHeight: 1.6, color: "var(--text-dim)" }}>
          The agent runs on this phone. It searches your messages here, and
          for a question it can't answer alone it sends just the few it
          needs to our AI, over an encrypted connection, to write a reply.
          It never sends your whole history, and you can see exactly what
          was used after each answer. You can turn it off any time in
          Settings.
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <Button variant="primary" style={{ flex: 1 }}
          onClick={() => { grantAgentConsent(); onAccept(); }}>
          Turn on agent
        </Button>
        <Button style={{ flex: 1 }} onClick={onDecline}>Not now</Button>
      </div>
    </div>
  );
}

function Flow() {
  const steps = [
    { icon: "📱", label: "Your phone" },
    { icon: "🔍", label: "Picks only what's needed" },
    { icon: "☁️", label: "AI" },
    { icon: "💬", label: "Answer back" },
  ];
  return (
    <div style={{
      display: "flex", alignItems: "stretch", gap: 4, justifyContent: "space-between",
      padding: "12px 10px", borderRadius: 14, background: "rgba(138,125,255,0.10)",
      border: "1px solid var(--line)",
    }}>
      {steps.map((s, i) => (
        <div key={i} style={{ display: "contents" }}>
          <div style={{ flex: 1, textAlign: "center" }}>
            <div style={{ fontSize: 22 }}>{s.icon}</div>
            <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.3 }}>{s.label}</div>
          </div>
          {i < steps.length - 1 && (
            <div aria-hidden style={{ alignSelf: "center", color: "var(--text-mute)", fontSize: 14 }}>→</div>
          )}
        </div>
      ))}
    </div>
  );
}
