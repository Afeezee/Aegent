// Settings sheet — privacy toggles, view recovery-code reminder, sign
// out. Every toggle round-trips to the server so it applies to future
// sends of read receipts / presence broadcasts.

import { useState } from "react";
import { Avatar, Button, Icon, Modal, toast } from "./ui.js";
import { api } from "../lib/api.js";
import { currentSession, logout, refreshMe } from "../lib/session.js";

export function Settings({
  open, onClose, onSignedOut,
}: { open: boolean; onClose: () => void; onSignedOut: () => void }) {
  const me = currentSession()?.user;
  const [readReceipts, setReadReceipts] = useState(!!me?.settings.readReceipts);
  const [presence, setPresence] = useState(!!me?.settings.presence);
  const [busy, setBusy] = useState(false);

  async function toggle(key: "readReceipts" | "presence", v: boolean) {
    setBusy(true);
    try {
      await api.updateSettings({ [key]: v });
      await refreshMe();
      if (key === "readReceipts") setReadReceipts(v); else setPresence(v);
    } catch (e) { toast(`Failed: ${(e as Error).message}`, "error"); }
    finally { setBusy(false); }
  }

  if (!me) return null;
  return (
    <Modal open={open} onClose={onClose} title="Settings" width={520}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <Avatar name={me.displayName} size="lg" />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 17 }}>{me.displayName}</div>
          <div className="small">@{me.handle} · {me.email}</div>
        </div>
      </div>

      <section style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8, letterSpacing: 0.05 }}>PRIVACY</div>
        <Toggle
          label="Send read receipts"
          hint="Off by default. When off, others see 'delivered' but never that you opened it."
          checked={readReceipts} disabled={busy}
          onChange={(v) => toggle("readReceipts", v)}
        />
        <Toggle
          label="Share online / last-seen"
          hint="Off by default. When off, no one sees when you were last active."
          checked={presence} disabled={busy}
          onChange={(v) => toggle("presence", v)}
        />
      </section>

      <section style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8, letterSpacing: 0.05 }}>SECURITY</div>
        <div className="glass" style={{ padding: 12, borderRadius: 12, fontSize: 13 }}>
          Your messages are encrypted with a key derived from your password.
          Aegent's servers store only ciphertext — write your recovery code
          somewhere safe if you haven't yet.
        </div>
      </section>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button variant="danger" onClick={() => { logout(); onSignedOut(); }}>
          <Icon.logout /> Sign out
        </Button>
      </div>
    </Modal>
  );
}

function Toggle({
  label, hint, checked, onChange, disabled,
}: {
  label: string; hint?: string; checked: boolean;
  onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <label style={{
      display: "flex", alignItems: "flex-start", gap: 12,
      padding: "10px 12px", borderRadius: 12,
      background: "rgba(255,255,255,0.03)", border: "1px solid var(--line)",
      marginBottom: 8, cursor: disabled ? "not-allowed" : "pointer",
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        {hint && <div className="small" style={{ marginTop: 2 }}>{hint}</div>}
      </div>
      <span style={{
        width: 42, height: 24, borderRadius: 999, position: "relative",
        background: checked ? "var(--accent)" : "var(--line-strong)",
        transition: "background .2s",
      }}>
        <input type="checkbox" checked={checked} disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          style={{ position: "absolute", opacity: 0, inset: 0, cursor: "inherit" }} />
        <span style={{
          position: "absolute", top: 3, left: checked ? 21 : 3,
          width: 18, height: 18, borderRadius: "50%",
          background: "white", transition: "left .2s var(--ease)",
          boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
        }} />
      </span>
    </label>
  );
}
