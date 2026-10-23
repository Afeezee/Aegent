// The very first thing a new install sees. A short, warm intro plus
// two follow-up cards. Skippable, and remembered locally so returning
// users don't sit through it again.

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { Button, FadeIn, Glass, Icon } from "../components/ui.js";

const KEY = "aegent.onboarded";
export function hasOnboarded(): boolean { return localStorage.getItem(KEY) === "1"; }
export function markOnboarded() { localStorage.setItem(KEY, "1"); }

const STEPS: Array<{ title: string; body: string; art: string }> = [
  {
    title: "Private by construction",
    body:
      "Every message is end-to-end encrypted before it leaves your device — in transit and at rest, with a key only you hold. Aegent's servers relay ciphertext they cannot read.",
    art: "🛡️",
  },
  {
    title: "Always there, every device",
    body:
      "Your whole history follows you. Sign in on a new phone and everything comes back — nothing to export, nothing lost. Forget your password and a recovery key brings it all back without losing a message.",
    art: "♾️",
  },
  {
    title: "Diary",
    body:
      "Write about your day — long text, formatted, or a set of photos. Your contacts can read each entry for 24 hours; you keep it forever. Or mark an entry just for you.",
    art: "📔",
  },
  {
    title: "Groups you can run",
    body:
      "Invite by link, set who can post, mute or remove anyone, and choose how much history a new member can see. Admins are real admins.",
    art: "👥",
  },
  {
    title: "Meet your agent",
    body:
      "Ask in plain words: find that chat about the invoice, remind me to call the studio tomorrow. It picks only the messages it needs, shows you exactly what it used, and confirms before it ever acts.",
    art: "✨",
  },
];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;

  function next() {
    if (isLast) { markOnboarded(); onDone(); }
    else setStep(step + 1);
  }
  function skip() { markOnboarded(); onDone(); }

  return (
    <div style={{
      height: "var(--app-h)", overflowY: "auto", overflowX: "hidden", padding: 24,
      display: "flex", justifyContent: "center", alignItems: "safe center",
      WebkitOverflowScrolling: "touch",
    }}>
      <FadeIn>
        <Glass raised style={{ width: "min(520px, 100%)", padding: 32, borderRadius: 22 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
            <Brand />
            <Button variant="ghost" size="small" onClick={skip}>Skip</Button>
          </div>

          <div style={{ position: "relative", minHeight: 260 }}>
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={{ x: 30, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: -30, opacity: 0 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              >
                <div style={{
                  fontSize: 48, marginBottom: 18,
                  width: 84, height: 84, borderRadius: 22,
                  display: "grid", placeItems: "center",
                  background: "linear-gradient(135deg, rgba(138,125,255,0.28), rgba(110,231,255,0.24))",
                  border: "1px solid var(--glass-border-hi)",
                }}>{STEPS[step].art}</div>
                <h1 style={{ marginBottom: 10 }}>{STEPS[step].title}</h1>
                <p style={{ color: "var(--text-dim)", fontSize: 15, lineHeight: 1.6 }}>{STEPS[step].body}</p>
              </motion.div>
            </AnimatePresence>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 26 }}>
            <div style={{ display: "flex", gap: 6 }}>
              {STEPS.map((_, i) => (
                <span key={i} style={{
                  width: i === step ? 22 : 8, height: 8, borderRadius: 999,
                  background: i === step ? "var(--accent)" : "var(--line-strong)",
                  transition: "width .3s var(--ease), background .3s var(--ease)",
                }} />
              ))}
            </div>
            <Button variant="primary" onClick={next}>
              {isLast ? "Get started" : "Next"} <Icon.chevron />
            </Button>
          </div>
        </Glass>
      </FadeIn>
    </div>
  );
}

export function Brand({ size = 22 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{
        width: 30, height: 30, borderRadius: 9,
        background: "linear-gradient(135deg, var(--violet), var(--aqua))",
        boxShadow: "0 6px 18px rgba(138,125,255,0.4)",
        display: "grid", placeItems: "center", color: "#10132a", fontWeight: 900, fontSize: 15,
      }}>Æ</div>
      <div style={{ fontWeight: 700, fontSize: size, letterSpacing: -0.2 }}>Aegent</div>
    </div>
  );
}
