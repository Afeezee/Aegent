// CheckoutPinPrompt — the local PIN gate between the agent's "order"
// confirm card and the actual PayPal call.
//
// Shapes two flows into one component:
//
//   First purchase ever (no PIN exists yet):
//     Show "Set a checkout PIN" with two numeric 4-6 digit fields
//     (enter + confirm). On submit, setCheckoutPin() seals a local
//     canary under the derived key — no network. Then proceed.
//
//   Any later purchase (PIN exists):
//     Show a single PIN field. verifyCheckoutPin() does a local
//     derive-and-attempt-unwrap; wrong PIN surfaces an inline error
//     and fires ZERO network requests. Right PIN proceeds.
//
// Nothing in this component ever reaches the server. The PIN itself
// is never read by any other code — not placed in state outside this
// file, not passed to the parent via onConfirm (which fires with no
// args), not persisted. The derived key, likewise, only ever exists
// long enough to open the canary once.

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Button, Icon } from "./ui.js";
import {
  hasCheckoutPin, setCheckoutPin, verifyCheckoutPin,
} from "../lib/checkoutPin.js";

const MIN_PIN = 4;
const MAX_PIN = 6;

export function CheckoutPinPrompt({
  title, subtitle, onConfirm, onCancel,
}: {
  title: string;
  subtitle: string;
  // Called ONLY after a successful local verify (or a successful
  // first-time set). Zero arguments — the PIN never leaves this
  // component, and the caller doesn't need it.
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"loading" | "set" | "verify">("loading");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let live = true;
    void hasCheckoutPin().then((has) => {
      if (!live) return;
      setMode(has ? "verify" : "set");
      // Give the input a tick to mount before focusing.
      setTimeout(() => inputRef.current?.focus(), 50);
    });
    return () => { live = false; };
  }, []);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setErr(null);
    const trimmed = pin.trim();
    if (trimmed.length < MIN_PIN || trimmed.length > MAX_PIN) {
      setErr(`PIN must be ${MIN_PIN}–${MAX_PIN} digits.`);
      return;
    }
    if (!/^\d+$/.test(trimmed)) {
      setErr("PIN must be digits only.");
      return;
    }
    if (mode === "set") {
      if (confirm !== trimmed) { setErr("The two PINs don't match."); return; }
      setBusy(true);
      try {
        await setCheckoutPin(trimmed);
        // Clear local copies before handing off.
        setPin(""); setConfirm("");
        await onConfirm();
      } catch (ex) {
        setErr(`Couldn't set PIN: ${(ex as Error).message}`);
      } finally { setBusy(false); }
      return;
    }
    // verify
    setBusy(true);
    try {
      const ok = await verifyCheckoutPin(trimmed);
      if (!ok) {
        setErr("Wrong PIN. Try again.");
        setPin("");
        inputRef.current?.focus();
        setBusy(false);
        return;
      }
      setPin("");
      await onConfirm();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally { setBusy(false); }
  }

  if (mode === "loading") {
    return <div className="small" style={{ padding: 12, color: "var(--text-mute)" }}>Checking…</div>;
  }

  return (
    <motion.form
      onSubmit={submit}
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
      className="glass"
      style={{
        padding: 14, borderRadius: 14, display: "flex", flexDirection: "column", gap: 10,
        border: "1px solid var(--glass-border-hi)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 20 }}>🔒</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 650 }}>{title}</div>
          <div className="small" style={{ color: "var(--text-dim)" }}>{subtitle}</div>
        </div>
      </div>

      {mode === "set" && (
        <div className="small" style={{
          padding: "8px 10px", borderRadius: 10,
          background: "rgba(23,195,230,0.10)", border: "1px solid var(--glass-border-hi)",
          color: "var(--text-dim)", lineHeight: 1.4,
        }}>
          First checkout — set a {MIN_PIN}–{MAX_PIN} digit PIN. It stays on this
          device, never on our server or PayPal. Lose it and you'll have to set
          a new one; no funds are at risk.
        </div>
      )}

      <input
        ref={inputRef}
        type="password" inputMode="numeric" autoComplete="one-time-code"
        pattern="\d*" minLength={MIN_PIN} maxLength={MAX_PIN}
        value={pin}
        onChange={(e) => { setPin(e.target.value.replace(/\D/g, "").slice(0, MAX_PIN)); setErr(null); }}
        placeholder={mode === "set" ? "Choose a PIN" : "Enter your PIN"}
        disabled={busy}
        aria-label={mode === "set" ? "Choose a PIN" : "Enter your PIN"}
        style={{ width: "100%", fontSize: 18, letterSpacing: 6, textAlign: "center" }}
      />
      {mode === "set" && (
        <input
          type="password" inputMode="numeric" autoComplete="one-time-code"
          pattern="\d*" minLength={MIN_PIN} maxLength={MAX_PIN}
          value={confirm}
          onChange={(e) => { setConfirm(e.target.value.replace(/\D/g, "").slice(0, MAX_PIN)); setErr(null); }}
          placeholder="Confirm PIN"
          disabled={busy}
          aria-label="Confirm PIN"
          style={{ width: "100%", fontSize: 18, letterSpacing: 6, textAlign: "center" }}
        />
      )}
      {err && (
        <div style={{
          fontSize: 12, color: "var(--danger)",
          padding: "6px 8px", borderRadius: 8,
          background: "rgba(255,107,139,0.10)", border: "1px solid rgba(255,107,139,0.3)",
        }}>{err}</div>
      )}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={busy || !pin.trim()}>
          <Icon.check /> {busy ? "Checking…" : mode === "set" ? "Set PIN & pay" : "Pay"}
        </Button>
      </div>
    </motion.form>
  );
}
