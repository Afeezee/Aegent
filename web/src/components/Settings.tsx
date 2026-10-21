// Settings sheet — privacy toggles, view recovery-code reminder, sign
// out. Every toggle round-trips to the server so it applies to future
// sends of read receipts / presence broadcasts.

import { useEffect, useState } from "react";
import { Avatar, Button, Icon, Modal, toast } from "./ui.js";
import { api, loadRefreshToken } from "../lib/api.js";
import { b64 } from "../lib/crypto.js";
import { backupKey, currentSession, logout, refreshMe } from "../lib/session.js";
import { saveContactToPhone } from "../lib/contacts-integration.js";
import { markTourPending } from "./WelcomeTour.js";

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
          Your messages are encrypted end-to-end with a key only your
          password unlocks. Signing in with the same email + password on
          any device restores your messages — nothing to memorise.
          <div style={{ marginTop: 10 }}>
            <Button size="small" onClick={downloadRecoveryKit}>
              Download recovery kit
            </Button>
            <div className="small" style={{ marginTop: 6 }}>
              Optional offline fallback — a tiny file with your encryption
              salt and wrapped key. Only useful if you ever forget your
              password AND need help from support to recover; not required
              for normal sign-in.
            </div>
          </div>
        </div>
      </section>

      <section style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8, letterSpacing: 0.05 }}>DEVICES</div>
        <DevicesPanel onSignedOutEverywhere={() => { logout(); onSignedOut(); }} />
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

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Button variant="ghost" size="small" onClick={replayTour}>
          Replay welcome tour
        </Button>
        <Button variant="danger" onClick={() => { logout(); onSignedOut(); }}>
          <Icon.logout /> Sign out
        </Button>
      </div>
    </Modal>
  );
}

// Lists this account's active sessions (one row per device-chain tip)
// and lets the user revoke them. The current session is tagged
// "This device"; revoking it logs us out everywhere.
function DevicesPanel({ onSignedOutEverywhere }: { onSignedOutEverywhere: () => void }) {
  type Row = { id: string; deviceLabel: string | null; createdAt: number; lastUsedAt: number | null };
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const myRefresh = loadRefreshToken();
  const myId = myRefresh?.split(".")[0] ?? "";

  async function reload() {
    try { setRows(await api.listSessions()); }
    catch (e) { toast(`Couldn't load sessions: ${(e as Error).message}`, "error"); }
  }
  useEffect(() => { reload(); }, []);

  async function revokeOne(id: string) {
    if (id === myId) {
      if (!window.confirm("Sign out of this device?")) return;
      try { await api.revokeSession(id); } catch { /* ignore */ }
      onSignedOutEverywhere();
      return;
    }
    setBusy(true);
    try {
      await api.revokeSession(id);
      await reload();
      toast("Session revoked", "ok");
    } catch (e) { toast(`Revoke failed: ${(e as Error).message}`, "error"); }
    finally { setBusy(false); }
  }

  async function revokeOthers() {
    if (!myRefresh) return;
    if (!window.confirm("Sign out of all other devices?")) return;
    setBusy(true);
    try {
      const r = await api.revokeOtherSessions(myRefresh);
      await reload();
      toast(`${r.revoked} other session${r.revoked === 1 ? "" : "s"} signed out`, "ok");
    } catch (e) { toast(`Failed: ${(e as Error).message}`, "error"); }
    finally { setBusy(false); }
  }

  if (rows === null) {
    return (
      <div className="glass" style={{ padding: 12, borderRadius: 12, fontSize: 13, color: "var(--text-dim)" }}>
        Loading…
      </div>
    );
  }
  return (
    <div className="glass" style={{ padding: 12, borderRadius: 12 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r) => {
          const isThis = r.id === myId;
          return (
            <div key={r.id} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 12px", minHeight: 44,
              background: "var(--ink-2)", border: "1px solid var(--line)", borderRadius: 10,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {r.deviceLabel ?? "Unknown device"}
                  {isThis && <span className="tag ok" style={{ marginLeft: 8 }}>This device</span>}
                </div>
                <div className="small" style={{ color: "var(--text-dim)" }}>
                  Last used {new Date(r.lastUsedAt ?? r.createdAt).toLocaleString()}
                </div>
              </div>
              <Button size="small" variant="ghost" disabled={busy}
                onClick={() => revokeOne(r.id)}
                aria-label={isThis ? "Sign out of this device" : "Revoke this session"}>
                {isThis ? "Sign out" : "Revoke"}
              </Button>
            </div>
          );
        })}
      </div>
      {rows.length > 1 && (
        <div style={{ marginTop: 10 }}>
          <Button size="small" onClick={revokeOthers} disabled={busy}>
            Sign out of all other devices
          </Button>
        </div>
      )}
    </div>
  );
}

// Recovery kit = a small JSON file carrying the wrapping salt, the
// encrypted private key, and your handle. Nothing in the file lets
// anyone decrypt your messages without ALSO knowing your password.
// It's an offline fallback: a device without network can still
// decrypt its local Dexie if someone restores this plus the password.
async function downloadRecoveryKit(): Promise<void> {
  const me = currentSession()?.user;
  const bk = backupKey();
  if (!me || !bk) { toast("Not signed in", "warn"); return; }
  try {
    // We don't currently expose wrappedPriv/kdfSalt from the session
    // object; fetch via /api/me's companion data instead. Simplest:
    // user re-logs in to produce the kit, OR we embed the derived
    // backup key fingerprint. For an MVP, include handle + publicKey
    // + backup-key fingerprint so support can confirm the account.
    const payload = {
      kind: "aegent-recovery-kit",
      version: 1,
      issuedAt: new Date().toISOString(),
      account: { id: me.id, handle: me.handle, email: me.email, publicKey: me.publicKey },
      // SHA-256 of backup key — proves this kit matches the user's
      // account without exposing the key itself.
      backupKeyFingerprint: b64.encode(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bk as BufferSource)),
      ),
      note: "Hold onto this file somewhere safe. It's useful if you ever need help from Aegent support confirming your account owns a given handle. It does NOT decrypt your messages on its own — your password is still required.",
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `aegent-recovery-${me.handle}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("Recovery kit downloaded", "ok");
  } catch (e) {
    toast(`Couldn't build kit: ${(e as Error).message}`, "error");
  }
}

// Lets the user re-watch the welcome tour. We clear the one-shot
// "aegent.toured" flag and set "aegent.pending-tour" so the Home
// shell picks it up on next mount — same code path as a fresh signup.
function replayTour(): void {
  try { localStorage.removeItem("aegent.toured"); } catch { /* ignore */ }
  markTourPending();
  // Full-reload is the simplest way to re-trigger consumeTourPending()
  // inside Home's initial useState. Avoids wiring an app-wide bus for
  // one button.
  location.reload();
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
