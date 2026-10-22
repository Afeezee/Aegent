// Register / sign-in / recover. Three states on one glass card.
//
// Signup goes straight into the app: your password IS your key, and
// signing in with it on any device unwraps the same encryption key and
// restores the entire history. No words to write down, no second
// factor to configure, nothing to lose at the moment someone is least
// invested in the product.
//
// "Forgot your password?" below redeems an optional recovery key, which
// users opt into from Settings → Account keys. Without one, a forgotten
// password cannot be reset without losing the history — that is the
// honest cost of the server never holding a key, and it is stated
// plainly in the welcome tour and in Settings rather than enforced with
// a modal.

import { motion } from "framer-motion";
import { useState } from "react";
import { Button, FadeIn, Glass, toast } from "../components/ui.js";
import { Brand } from "./Onboarding.js";
import { login, register, resetPasswordWithRecoveryKey } from "../lib/session.js";
import { markTourPending } from "../components/WelcomeTour.js";

const switchBtn: React.CSSProperties = {
  background: "none", border: "none", padding: 0,
  color: "var(--accent-strong)", cursor: "pointer", fontSize: 13,
};

export function AuthScreen({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register" | "reset">("login");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryInput, setRecoveryInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      if (mode === "reset") {
        await resetPasswordWithRecoveryKey({
          email, recoveryPhrase: recoveryInput, newPassword: password,
        });
        toast("Password reset — your messages are being restored", "ok");
        onDone();
        return;
      }
      if (mode === "register") {
        await register({
          email, displayName, password,
          phone: phone.trim() || undefined,
        });
        // Fresh account → queue the welcome tour. Home.tsx picks it up
        // on first mount after signup. Login path skips this.
        markTourPending();
        onDone();
        return;
      }
      // Login handles cloud-restore automatically: if this account has a
      // backup on the relay, the client re-derives the backup key from
      // the freshly-unwrapped private key and rehydrates in the
      // background. It also force-drains the inbox, so a device that has
      // never seen this account rebuilds the entire history.
      await login({ email, password });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
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

          <motion.form key={mode} onSubmit={submit}
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
              >
                <h1 style={{ marginBottom: 6 }}>
                  {mode === "login" ? "Welcome back"
                    : mode === "register" ? "Create your account"
                    : "Reset with your recovery key"}
                </h1>
                <p style={{ color: "var(--text-dim)", marginBottom: 20 }}>
                  {mode === "login"
                    ? "Sign in. If you had Aegent on another device, your messages come back automatically."
                    : mode === "register" ? "One account, encrypted from the first message."
                    : "Your recovery key unlocks the same account — every message stays where it is."}
                </p>

                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div>
                    <label>Email</label>
                    <input type="email" required value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email" placeholder="you@somewhere.com" />
                  </div>
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
                  {mode === "reset" && (
                    <div>
                      <label>Recovery key</label>
                      <input required value={recoveryInput}
                        onChange={(e) => setRecoveryInput(e.target.value)}
                        autoCapitalize="characters" spellCheck={false}
                        placeholder="ABCDE-FGHJK-LMNPQ-…" />
                      <div className="small" style={{ marginTop: 6 }}>
                        The code from your recovery kit. Dashes and case don't matter.
                      </div>
                    </div>
                  )}
                  <div>
                    <label>{mode === "reset" ? "New password" : "Password"}</label>
                    <input type="password" required minLength={8}
                      value={password} onChange={(e) => setPassword(e.target.value)}
                      autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="8 characters minimum" />
                    {mode === "register" && (
                      <div className="small" style={{ marginTop: 6 }}>
                        This password is your encryption key. Sign in with it on any
                        device and every message comes back. Save it in your password
                        manager — it's the one thing we can't reset for you.
                      </div>
                    )}
                  </div>
                </div>

                {error && (
                  <div style={{ marginTop: 12, color: "var(--danger)", fontSize: 13 }}>{error}</div>
                )}

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 20, gap: 12, flexWrap: "wrap" }}>
                  <button type="button" style={switchBtn}
                    onClick={() => { setError(null); setMode(mode === "login" ? "register" : "login"); }}>
                    {mode === "login" ? "Need an account? Register" : "Have one? Sign in"}
                  </button>
                  <Button type="submit" variant="primary" disabled={busy}>
                    {busy ? "…" : mode === "login" ? "Sign in"
                      : mode === "register" ? "Create account" : "Reset password"}
                  </Button>
                </div>
                {mode !== "register" && (
                  <div style={{ marginTop: 14 }}>
                    <button type="button" style={switchBtn}
                      onClick={() => { setError(null); setMode(mode === "reset" ? "login" : "reset"); }}>
                      {mode === "reset" ? "Back to sign in" : "Forgot your password? Use your recovery key"}
                    </button>
                  </div>
                )}
              </motion.form>
        </Glass>
      </FadeIn>
    </div>
  );
}
