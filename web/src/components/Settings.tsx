// Settings sheet — privacy toggles, view recovery-code reminder, sign
// out. Every toggle round-trips to the server so it applies to future
// sends of read receipts / presence broadcasts.

import { useEffect, useState } from "react";
import { Avatar, Button, Icon, Modal, toast } from "./ui.js";
import { api } from "../lib/api.js";
import { currentSession, logout, refreshMe } from "../lib/session.js";
import { saveContactToPhone } from "../lib/contacts-integration.js";

export function Settings({
  open, onClose, onSignedOut,
}: { open: boolean; onClose: () => void; onSignedOut: () => void }) {
  const me = currentSession()?.user;
  const [readReceipts, setReadReceipts] = useState(!!me?.settings.readReceipts);
  const [presence, setPresence] = useState(!!me?.settings.presence);
  const [phone, setPhoneInput] = useState(me?.phone ?? "");
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [backupInfo, setBackupInfo] = useState<{ size: number; createdAt: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    // Just for the "last backup" line under the note — no button anymore.
    api.backupMeta().then(setBackupInfo).catch(() => setBackupInfo(null));
  }, [open]);

  async function toggle(key: "readReceipts" | "presence", v: boolean) {
    setBusy(true);
    try {
      await api.updateSettings({ [key]: v });
      await refreshMe();
      if (key === "readReceipts") setReadReceipts(v); else setPresence(v);
    } catch (e) { toast(`Failed: ${(e as Error).message}`, "error"); }
    finally { setBusy(false); }
  }

  async function savePhone() {
    setPhoneBusy(true);
    try {
      await api.setPhone(phone.trim() || null);
      await refreshMe();
      toast(phone.trim() ? "Phone number saved" : "Phone number removed", "ok");
    } catch (e) { toast(`Failed: ${(e as Error).message}`, "error"); }
    finally { setPhoneBusy(false); }
  }

  async function saveMyCard() {
    if (!me) return;
    try {
      const how = await saveContactToPhone({
        displayName: me.displayName,
        handle: me.handle,
        email: me.email,
        phone: me.phone,
        note: `Aegent · @${me.handle}`,
      });
      toast(how === "shared" ? "Opened share sheet" : "vCard downloaded — open it to add", "ok");
    } catch (e) { toast(`Couldn't save: ${(e as Error).message}`, "error"); }
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
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8, letterSpacing: 0.05 }}>PHONE NUMBER</div>
        <div className="glass" style={{ padding: 12, borderRadius: 12 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="tel" inputMode="tel" autoComplete="tel"
              value={phone} onChange={(e) => setPhoneInput(e.target.value)}
              placeholder="+234 800 000 0000"
            />
            <Button variant="primary" onClick={savePhone}
              disabled={phoneBusy || phone === (me.phone ?? "")}>
              Save
            </Button>
          </div>
          <div className="small" style={{ marginTop: 8 }}>
            Lets friends who have your number find you on Aegent. Leave blank to keep hidden.
          </div>
          <div style={{ marginTop: 10 }}>
            <Button size="small" onClick={saveMyCard}><Icon.contacts /> Save my contact card to phone</Button>
          </div>
        </div>
      </section>

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

      <section style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8, letterSpacing: 0.05 }}>VOICE NOTES</div>
        <VoiceTranscribeToggle />
      </section>

      <section style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8, letterSpacing: 0.05 }}>SECURITY</div>
        <div className="glass" style={{ padding: 12, borderRadius: 12, fontSize: 13 }}>
          Your messages are encrypted with a key derived from your password.
          Aegent's servers store only ciphertext — write your recovery code
          somewhere safe if you haven't yet.
        </div>
      </section>

      <section style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8, letterSpacing: 0.05 }}>ENCRYPTED BACKUP</div>
        <div className="glass" style={{ padding: 12, borderRadius: 12 }}>
          <div style={{ fontSize: 13, marginBottom: backupInfo ? 8 : 0 }}>
            Your messages are automatically backed up in the background,
            encrypted with a key only your account can derive. Sign in on
            any other device with the same email and password — your
            chats come back on their own. Aegent's servers only ever hold
            opaque bytes.
          </div>
          {backupInfo && (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              Last backup: {new Date(backupInfo.createdAt).toLocaleString()} · {(backupInfo.size / 1024).toFixed(0)} KB
            </div>
          )}
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

function VoiceTranscribeToggle() {
  const [on, setOn] = useState<boolean>(() => localStorage.getItem("aegent.transcribeVoice") === "1");
  function set(v: boolean) {
    setOn(v);
    try {
      if (v) localStorage.setItem("aegent.transcribeVoice", "1");
      else localStorage.removeItem("aegent.transcribeVoice");
    } catch { /* ignore */ }
    if (v) toast("Voice notes will transcribe on this device", "ok");
  }
  return (
    <>
      <Toggle
        label="Transcribe voice notes on this device"
        hint="Runs Whisper locally in this WebView — your audio never leaves the phone. First use downloads a ~40 MB model to your browser cache."
        checked={on}
        onChange={set}
      />
    </>
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
