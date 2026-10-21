// Register / sign-in. Same glass card, two states. Signup goes
// straight into the app — no "save these words" screen. New devices
// restore history on next sign-in via the server-held wrappedPriv.

import { motion } from "framer-motion";
import { useState } from "react";
import { Button, FadeIn, Glass } from "../components/ui.js";
import { Brand } from "./Onboarding.js";
import { login, register } from "../lib/session.js";
import { markTourPending } from "../components/WelcomeTour.js";

const switchBtn: React.CSSProperties = {
  background: "none", border: "none", padding: 0,
  color: "var(--accent-strong)", cursor: "pointer", fontSize: 13,
};

export function AuthScreen({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      if (mode === "register") {
        await register({
          email, displayName, password,
          phone: phone.trim() || undefined,
        });
        // Fresh account → queue the welcome tour. Home.tsx picks it
        // up on first mount after signup. Login path skips this.
        markTourPending();
      } else {
        // Login handles cloud-restore automatically: if this account
        // has a backup on the relay, the client re-derives the
        // backup key from the freshly-unwrapped private key and
        // rehydrates in the background.
        await login({ email, password });
      }
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
                  {mode === "login" ? "Welcome back" : "Create your account"}
                </h1>
                <p style={{ color: "var(--text-dim)", marginBottom: 20 }}>
                  {mode === "login"
                    ? "Sign in. If you had Aegent on another device, your messages come back automatically."
                    : "One account, encrypted from the first message."}
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
                  <div>
                    <label>Password</label>
                    <input type="password" required minLength={8}
                      value={password} onChange={(e) => setPassword(e.target.value)}
                      autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="8 characters minimum" />
                    {mode === "register" && (
                      <div className="small" style={{ marginTop: 6 }}>
                        Your password protects your account on new devices. Pick one you'll remember.
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
                    {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
                  </Button>
                </div>
              </motion.form>
        </Glass>
      </FadeIn>
    </div>
  );
}
