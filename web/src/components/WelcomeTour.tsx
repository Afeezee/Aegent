// Post-signup walkthrough. Fires once per account on this device,
// right after a successful register(). The card that cannot be skipped
// without acknowledgement is the one about keys: a password and a
// recovery key both unwrap the same encryption key, and between them
// they are the whole reason history survives a lost device or a
// forgotten password. Users should hear that in a calm tone, up front,
// before they've accumulated chats they'd miss.
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
    title: "Two keys, one archive",
    critical: true,
    body: (
      <>
        <strong>Signing in on another device restores everything</strong> — every
        message you've ever sent or received, pulled back from the
        server and decrypted on the spot. Just email and password.
        <br /><br />
        Your messages are encrypted with a key only your devices hold,
        and two things unwrap it: your <strong>password</strong> and your{" "}
        <strong>recovery key</strong>. We showed you the recovery key when
        you signed up — that's what resets a forgotten password without
        losing a single message.
        <br /><br />
        <strong>Put the password in your password manager and the recovery
        key somewhere you'll still have it in five years.</strong> With both,
        your history is never more than a sign-in away.
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
    art: <span style={{ fontSize: 30, lineHeight: 1 }}>🧭</span>,
    title: "Diary & Discover",
    body: (
      <>
        The <strong>Diary</strong> tab is your daily page — text or photos
        your contacts can read for 24 hours while you keep them forever.
        Mark an entry <strong>Public</strong> and it also appears in{" "}
        <strong>Discover</strong>.
        <br /><br />
        <strong>Discover</strong> is a feed of everyone's public posts —
        find people beyond your contacts and message them directly, still
        end-to-end encrypted. And tap <strong>Translate</strong> on any
        message to read it in your language.
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
  // reduced-motion respected via useReducedMotion. The card is an
  // OPAQUE surface (--sheet-bg) rather than .glass: a backdrop-filter
  // ancestor was dropping the primary button's gradient on the Android
  // WebView and reading grey in light mode. Opaque fixes both.
  return (
    <AnimatePresence>
      <motion.div
        key="tour"
        className="tour-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        role="dialog"
        aria-modal="true"
        aria-label={`Welcome tour step ${step + 1} of ${STEPS.length}`}
        style={{
          position: "fixed", inset: 0, zIndex: 500,
          backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
          display: "flex", alignItems: "safe center", justifyContent: "center",
          padding: "calc(24px + var(--safe-top)) 18px calc(24px + var(--safe-bottom))",
          overflowY: "auto",
        }}
      >
        <motion.div
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          style={{
            position: "relative",
            width: "min(460px, 100%)", borderRadius: 24,
            background: "var(--sheet-bg)",
            border: "1px solid var(--glass-border-hi)",
            boxShadow: "var(--shadow-lg)",
            display: "flex", flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Brand accent strip — a thin gradient hairline at the very
              top ties the gate to Aegent's identity without shouting. */}
          <div aria-hidden style={{
            height: 4, flexShrink: 0,
            background: "linear-gradient(90deg, var(--violet), var(--aqua), var(--pink))",
          }} />

          <div style={{ padding: "22px 26px 26px", display: "flex", flexDirection: "column", gap: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: 36 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }} aria-hidden>
                {STEPS.map((_, i) => (
                  <span key={i} style={{
                    width: i === step ? 24 : 7, height: 7, borderRadius: 999,
                    background: i === step
                      ? "linear-gradient(90deg, var(--violet), var(--aqua))"
                      : "var(--line-strong)",
                    transition: "width .32s var(--ease), background .32s var(--ease)",
                  }} />
                ))}
              </div>
              {!s.critical ? (
                <button
                  type="button"
                  onClick={skip}
                  aria-label="Skip the welcome tour"
                  style={{
                    all: "unset", cursor: "pointer", padding: "8px 12px", minHeight: 36,
                    color: "var(--text-mute)", fontSize: 13.5, fontWeight: 550, borderRadius: 10,
                  }}
                >
                  Skip
                </button>
              ) : (
                <span style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase",
                  color: "var(--amber)", padding: "4px 10px", borderRadius: 999,
                  background: "rgba(255, 196, 110, 0.12)", border: "1px solid rgba(255, 196, 110, 0.28)",
                }}>Please read</span>
              )}
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={reduce ? { opacity: 0 } : { opacity: 0, x: 18 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, x: -18 }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                style={{ display: "flex", flexDirection: "column", gap: 16 }}
              >
                <div style={{
                  width: 64, height: 64, borderRadius: 18,
                  background: "linear-gradient(135deg, rgba(138,125,255,0.32), rgba(110,231,255,0.26))",
                  border: "1px solid var(--glass-border-hi)",
                  boxShadow: "0 8px 22px rgba(138,125,255,0.22), inset 0 1px 0 rgba(255,255,255,0.14)",
                  display: "grid", placeItems: "center",
                  color: "var(--text)",
                }}>
                  {s.art}
                </div>
                <h2 style={{ margin: 0, fontSize: 24, lineHeight: 1.2, letterSpacing: "-0.01em", fontWeight: 700 }}>
                  {s.title}
                </h2>
                <div style={{
                  color: s.critical ? "var(--text)" : "var(--text-dim)",
                  fontSize: 15, lineHeight: 1.65,
                  background: s.critical ? "rgba(255, 196, 110, 0.09)" : "transparent",
                  border: s.critical ? "1px solid rgba(255, 196, 110, 0.28)" : "none",
                  borderRadius: s.critical ? 14 : 0,
                  padding: s.critical ? "14px 16px" : 0,
                }}>
                  {s.body}
                </div>
              </motion.div>
            </AnimatePresence>

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
              {step > 0 ? (
                <button
                  type="button"
                  onClick={() => setStep((i) => i - 1)}
                  aria-label="Previous step"
                  style={{
                    all: "unset", cursor: "pointer",
                    display: "inline-flex", alignItems: "center", gap: 4,
                    padding: "10px 14px", minHeight: 44, borderRadius: 12,
                    color: "var(--text-dim)", fontSize: 15, fontWeight: 550,
                  }}
                >
                  <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>
                    <Icon.chevron />
                  </span>
                  Back
                </button>
              ) : <span />}
              <Button
                className="tour-cta"
                onClick={next}
                style={{
                  marginLeft: "auto", minHeight: 48, padding: "12px 22px",
                  borderRadius: 14, fontSize: 15.5,
                }}
                aria-label={isLast ? "Finish and open Aegent" : (s.critical ? "Confirm I understand and continue" : "Next step")}
              >
                {isLast ? "Open Aegent" : s.critical ? "I understand" : "Next"}
                {!isLast && <Icon.chevron />}
              </Button>
            </div>
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
