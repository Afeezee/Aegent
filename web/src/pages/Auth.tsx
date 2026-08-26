// Register / sign-in. Same glass card, two states, plus a one-time
// recovery-code reveal after registration.

import { motion } from "framer-motion";
import { useState } from "react";
import { Button, FadeIn, Glass, Icon, toast } from "../components/ui.js";
import { Brand } from "./Onboarding.js";
import { beginRestoreFromRecovery, finishRestore, login, register, type PendingRestore } from "../lib/session.js";

const switchBtn: React.CSSProperties = {
  background: "none", border: "none", padding: 0,
  color: "var(--accent-strong)", cursor: "pointer", fontSize: 13,
};

export function AuthScreen({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register" | "restore">("login");
  const [restorePhrase, setRestorePhrase] = useState("");
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      if (mode === "register") {
        const { recoveryPhrase } = await register({
          email, displayName, password,
          phone: phone.trim() || undefined,
        });
        setRecovery(recoveryPhrase);
      } else if (mode === "login") {
        await login({ email, password });
        onDone();
      } else if (mode === "restore") {
        if (!pendingRestore) {
          // Step 1: derive from phrase + fetch backup.
          const p = await beginRestoreFromRecovery(restorePhrase);
          setPendingRestore(p);
          setEmail(p.email);   // pre-fill for the password step
        } else {
          // Step 2: log in with the recovered email + user's password,
          // then rehydrate the store from the decrypted backup.
          await login({ email: pendingRestore.email, password });
          await finishRestore(pendingRestore);
          toast(`Restored ${pendingRestore.backup.messages.length} messages`, "ok");
          onDone();
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  }

  async function copyRecovery() {
    if (!recovery) return;
    try {
      await navigator.clipboard.writeText(recovery);
      toast("Recovery code copied", "ok");
    } catch { toast("Copy failed — write it down instead", "warn"); }
  }

  return (
    <div style={{
      // Scroll container: centre when it fits, top-align when it overflows
      // (so the tall registration form stays fully reachable on short viewports).
      height: "100vh", overflowY: "auto", overflowX: "hidden", padding: 24,
      display: "flex", justifyContent: "center", alignItems: "safe center",
      WebkitOverflowScrolling: "touch",
    }}>
      <FadeIn>
        <Glass raised style={{ width: "min(460px, 100%)", padding: 32, borderRadius: 22 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22 }}>
            <Brand />
            <span className="tag">encrypted</span>
          </div>

          {recovery ? (
              <motion.div key="recovery"
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              >
                <h1 style={{ marginBottom: 6 }}>Save your recovery code</h1>
                <p style={{ color: "var(--text-dim)", marginBottom: 16 }}>
                  This is the only way to restore your account on a new device. Aegent's servers
                  don't have it — if you lose your password and this code, your messages are
                  permanently unreadable.
                </p>
                <div className="glass" style={{
                  padding: 16, borderRadius: 14, textAlign: "center",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 17, letterSpacing: 2, lineHeight: 1.6,
                  background: "rgba(138,125,255,0.08)",
                }}>{recovery}</div>
                <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
                  <Button onClick={copyRecovery}><Icon.copy /> Copy</Button>
                  <Button variant="primary" onClick={onDone}>I've saved it</Button>
                </div>
              </motion.div>
            ) : (
              <motion.form key={mode} onSubmit={submit}
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
              >
                <h1 style={{ marginBottom: 6 }}>
                  {mode === "login" ? "Welcome back"
                    : mode === "register" ? "Create your account"
                    : pendingRestore ? "Finish restoring" : "Restore from recovery code"}
                </h1>
                <p style={{ color: "var(--text-dim)", marginBottom: 20 }}>
                  {mode === "login" ? "Sign in to unlock your messages."
                    : mode === "register" ? "One account, encrypted from the first message."
                    : pendingRestore
                      ? `Signed as ${pendingRestore.displayName} (${pendingRestore.email}). Enter your password to finish restoring ${pendingRestore.backup.messages.length} messages.`
                      : "Enter the recovery code you saved when you first created your account. Aegent will pull the encrypted backup, and once you sign in with your password, your messages come back."}
                </p>

                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {mode === "restore" && !pendingRestore ? (
                    <div>
                      <label>Recovery code</label>
                      <input required value={restorePhrase}
                        onChange={(e) => setRestorePhrase(e.target.value)}
                        autoComplete="off" autoCapitalize="characters"
                        placeholder="ABCDE-FGHIJ-KLMNP-QRSTU-VWXYZ-2345"
                        style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", letterSpacing: 1 }} />
                      <div className="small" style={{ marginTop: 6 }}>
                        Case-insensitive. Hyphens optional. This runs entirely on this device — the code never leaves.
                      </div>
                    </div>
                  ) : (
                  <div>
                    <label>Email</label>
                    <input type="email" required value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email" placeholder="you@somewhere.com"
                      disabled={mode === "restore" && !!pendingRestore} />
                  </div>
                  )}
                  {mode === "register" && (
                    <>
                      <div>
                        <label>Display name</label>
                        <input required value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="What should we call you?" />
                      </div>
                      <div>
                        <label>Phone number <span style={{ color: "var(--text-mute)" }}>(optional)</span></label>
                        <input type="tel" inputMode="tel" autoComplete="tel"
                          value={phone} onChange={(e) => setPhone(e.target.value)}
                          placeholder="+234 800 000 0000" />
                        <div className="small" style={{ marginTop: 6 }}>
                          Lets friends find you by number. You can add or change it later.
                        </div>
                      </div>
                    </>
                  )}
                  {(mode !== "restore" || pendingRestore) && (
                    <div>
                      <label>Password</label>
                      <input type="password" required minLength={8}
                        value={password} onChange={(e) => setPassword(e.target.value)}
                        autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="8 characters minimum" />
                      {mode === "register" && (
                        <div className="small" style={{ marginTop: 6 }}>
                          Also derives your local encryption keys — don't lose it.
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {error && (
                  <div style={{ marginTop: 12, color: "var(--danger)", fontSize: 13 }}>{error}</div>
                )}

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 20, gap: 12, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                    <button type="button" style={switchBtn}
                      onClick={() => { setError(null); setPendingRestore(null); setMode(mode === "login" ? "register" : "login"); }}>
                      {mode === "login" ? "Need an account? Register" : "Have one? Sign in"}
                    </button>
                    {mode !== "restore" && (
                      <button type="button" style={switchBtn}
                        onClick={() => { setError(null); setPendingRestore(null); setMode("restore"); }}>
                        Restore from recovery code
                      </button>
                    )}
                  </div>
                  <Button type="submit" variant="primary" disabled={busy}>
                    {busy ? "…"
                      : mode === "login" ? "Sign in"
                      : mode === "register" ? "Create account"
                      : pendingRestore ? "Finish restore" : "Next"}
                  </Button>
                </div>
              </motion.form>
            )}
        </Glass>
      </FadeIn>
    </div>
  );
}
