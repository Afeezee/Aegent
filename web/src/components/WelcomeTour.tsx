// Post-signup walkthrough. Fires once per account on this device,
// right after a successful register(). The one card that cannot be
// skipped without acknowledgement is the password-recovery warning —
// Aegent's model makes the password the single thing the server
// cannot help with, and users need to know that in a calm tone, up
// front, before they've accumulated chats they'd miss.
//
// Trigger: Auth.tsx sets localStorage.aegent.pending-tour on register.
// Home.tsx reads that flag on mount and opens the tour.
// Completion: localStorage.aegent.toured gets set so it never re-fires
// on this device.

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState, type ReactNode } from "react";
import { Button, Icon } from "./ui.js";

// Tracked flags.
const KEY_PENDING = "aegent.pending-tour";
const KEY_DONE = "aegent.toured";

export function markTourPending(): void {
  try { localStorage.setItem(KEY_PENDING, "1"); } catch { /* ignore */ }
}
export function consumeTourPending(): boolean {
  try {
    if (localStorage.getItem(KEY_DONE) === "1") return false;
    const pending = localStorage.getItem(KEY_PENDING) === "1";
    if (pending) localStorage.removeItem(KEY_PENDING);
    return pending;
  } catch { return false; }
}
function markTourDone(): void {
  try { localStorage.setItem(KEY_DONE, "1"); } catch { /* ignore */ }
}

type Step = {
  art: ReactNode;
  title: string;
  body: ReactNode;
  // Critical steps require explicit acknowledgement — their primary
  // button changes to "I understand" and the Skip button is hidden.
  critical?: boolean;
};

const STEPS: Step[] = [
  {
    art: <Spark />,
    title: "You're in",
    body: (
      <>
        Aegent is encrypted end-to-end. Your messages, voice notes and
        files leave this device as ciphertext — Aegent's servers only
        ever hold opaque bytes.
        <br /><br />
        Three quick things to know before you dive in. You can skip
        the rest, but please read the next card.
      </>
    ),
  },
  {
    art: <Lock />,
    title: "Your password is your key",
    critical: true,
    body: (
      <>
        <strong>Signing in on another device restores everything</strong> — you don't need
        a recovery phrase, a backup file, or anything you have to save
        and remember separately. Just email and password.
        <br /><br />
        The flipside: if you forget your password, there's no reset
        link that recovers messages. The server has your messages, but
        only your password can unlock them.
        <br /><br />
        <strong>Save it in your password manager now</strong> — Chrome,
        Apple Passwords, 1Password, Bitwarden all work. That one habit
        protects everything else.
      </>
    ),
  },
  {
    art: <Æ />,
    title: "Your on-device agent",
    body: (
      <>
        Tap the <strong>Æ</strong> icon anywhere to open the agent. Ask it in
        plain words:
        <br /><br />
        <em>• "find the message about the invoice"</em>
        <br />
        <em>• "remind me to call Ada tomorrow"</em>
        <br />
        <em>• "email that photo to me@work.com"</em>
        <br /><br />
        Every action it would take shows a preview first — nothing
        sends, deletes or shares until you confirm.
      </>
    ),
  },
  {
    art: <Search />,
    title: "Finding things fast",
    body: (
      <>
        Agent search results are tappable — one tap lands you on that
        exact message in its chat.
        <br /><br />
        In a chat: long-press any message for reply, forward, react,
        delete. Swipe a chat in the list for quick actions. "Jump to
        latest" appears when you've scrolled far back.
      </>
    ),
  },
  {
    art: <Cog />,
    title: "Settings → Devices",
    body: (
      <>
        <strong>Settings → Devices</strong> lists every device your
        account is signed in on. Revoke old ones from here, or sign
        out of everything in one tap.
        <br /><br />
        Also in Settings: privacy toggles (read receipts and
        online-status are off by default), voice-note transcription,
        and an optional "recovery kit" download for support purposes.
      </>
    ),
  },
];

export function WelcomeTour({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const reduce = useReducedMotion();
  const s = STEPS[step];
  const isLast = step === STEPS.length - 1;

  function next() {
    if (isLast) { markTourDone(); onDone(); return; }
    setStep((i) => i + 1);
  }
  function skip() { markTourDone(); onDone(); }

  // Priority-rules sweep: ≥44px targets, aria-labels, semantic colors
  // only, SVG icons (no emoji), transform/opacity-only motion,
  // reduced-motion respected via useReducedMotion.
  return (
    <AnimatePresence>
      <motion.div
        key="tour"
        initial={reduce ? { opacity: 0 } : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        role="dialog"
        aria-modal="true"
        aria-label={`Welcome tour step ${step + 1} of ${STEPS.length}`}
        style={{
          position: "fixed", inset: 0, zIndex: 500,
          background: "rgba(5, 7, 20, 0.72)",
          backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
          display: "flex", alignItems: "safe center", justifyContent: "center",
          padding: "calc(24px + var(--safe-top)) 20px calc(24px + var(--safe-bottom))",
          overflowY: "auto",
        }}
      >
        <motion.div
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="glass"
          style={{
            width: "min(500px, 100%)", padding: 28, borderRadius: 22,
            display: "flex", flexDirection: "column", gap: 20,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: 36 }}>
            <div style={{ display: "flex", gap: 6 }} aria-hidden>
              {STEPS.map((_, i) => (
                <span key={i} style={{
                  width: i === step ? 22 : 8, height: 8, borderRadius: 999,
                  background: i === step ? "var(--accent)" : "var(--line-strong)",
                  transition: "width .3s var(--ease), background .3s var(--ease)",
                }} />
              ))}
            </div>
            {!s.critical && (
              <button
                type="button"
                onClick={skip}
                aria-label="Skip the welcome tour"
                style={{
                  all: "unset", cursor: "pointer", padding: "8px 12px", minHeight: 36,
                  color: "var(--text-dim)", fontSize: 13, borderRadius: 10,
                }}
              >
                Skip
              </button>
            )}
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={reduce ? { opacity: 0 } : { opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: -20 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              style={{ display: "flex", flexDirection: "column", gap: 14 }}
            >
              <div style={{
                width: 72, height: 72, borderRadius: 20,
                background: "linear-gradient(135deg, rgba(138,125,255,0.28), rgba(110,231,255,0.24))",
                border: "1px solid var(--glass-border-hi)",
                display: "grid", placeItems: "center",
                color: "var(--text)",
              }}>
                {s.art}
              </div>
              <h2 style={{ margin: 0, fontSize: 22, lineHeight: 1.25 }}>{s.title}</h2>
              <div style={{
                color: "var(--text-dim)", fontSize: 15, lineHeight: 1.6,
                background: s.critical ? "rgba(255, 196, 110, 0.08)" : "transparent",
                border: s.critical ? "1px solid rgba(255, 196, 110, 0.3)" : "none",
                borderRadius: s.critical ? 12 : 0,
                padding: s.critical ? "12px 14px" : 0,
              }}>
                {s.body}
              </div>
            </motion.div>
          </AnimatePresence>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            {step > 0 && (
              <Button variant="ghost" onClick={() => setStep((i) => i - 1)}
                aria-label="Previous step">
                <span style={{ display: "inline-block", transform: "rotate(180deg)" }}>
                  <Icon.chevron />
                </span>
                Back
              </Button>
            )}
            <Button variant="primary" onClick={next}
              aria-label={isLast ? "Finish and open Aegent" : (s.critical ? "Confirm I understand and continue" : "Next step")}>
              {isLast ? "Open Aegent" : s.critical ? "I understand" : "Next"}
              {!isLast && <Icon.chevron />}
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// --- SVG art, inline. No emoji per the priority rules. ---

function Spark() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v4M12 17v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M3 12h4M17 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
    </svg>
  );
}
function Lock() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      <circle cx="12" cy="15.5" r="1" fill="currentColor" />
    </svg>
  );
}
function Æ() {
  return (
    <div style={{
      fontFamily: "serif", fontWeight: 800, fontSize: 32, lineHeight: 1,
      background: "linear-gradient(135deg, var(--violet), var(--aqua))",
      WebkitBackgroundClip: "text", backgroundClip: "text",
      color: "transparent",
    }}>Æ</div>
  );
}
function Search() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4-4" />
    </svg>
  );
}
function Cog() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </svg>
  );
}
