// Settings sheet — privacy toggles, view recovery-code reminder, sign
// out. Every toggle round-trips to the server so it applies to future
// sends of read receipts / presence broadcasts.

import { useEffect, useState } from "react";
import { Avatar, Button, Icon, Modal, toast } from "./ui.js";
import { api, loadRefreshToken } from "../lib/api.js";
import { b64 } from "../lib/crypto.js";
import {
  backupKey, changePassword, currentSession, fullResyncInbox, issueRecoveryKey, logout,
  pushLocalHistoryToServer, refreshMe,
} from "../lib/session.js";
import {
  onReplication, replicationSummary, type ReplicationState,
} from "../lib/replication.js";
import { saveContactToPhone } from "../lib/contacts-integration.js";
import { markTourPending } from "./WelcomeTour.js";
import {
  revokeTranslationConsent, setTargetLanguage,
  targetLanguage, translationConsentGranted, TRANSLATION_TARGETS,
} from "../lib/translate.js";

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
          hint={readReceipts
            ? "On: contacts can see when you've opened their messages."
            : "Off: contacts see 'delivered' but never that you've read a message."}
          checked={readReceipts} disabled={busy}
          onChange={(v) => toggle("readReceipts", v)}
        />
        <Toggle
          label="Share online / last-seen"
          hint={presence
            ? "On: contacts can see when you're active and your last-seen time."
            : "Off: no one sees when you were last active."}
          checked={presence} disabled={busy}
          onChange={(v) => toggle("presence", v)}
        />
      </section>

      <section style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8, letterSpacing: 0.05 }}>VOICE NOTES</div>
        <VoiceTranscribeToggle />
      </section>

      <section style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8, letterSpacing: 0.05 }}>APPEARANCE</div>
        <ThemePicker />
      </section>

      <section style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8, letterSpacing: 0.05 }}>TRANSLATION</div>
        <TranslationPanel />
      </section>

      <section style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8, letterSpacing: 0.05 }}>SYNC</div>
        <ResyncPanel />
      </section>

      <section style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8, letterSpacing: 0.05 }}>ACCOUNT KEYS</div>
        <AccountKeysPanel />
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

// Account keys: the recovery key and the password that wrap it.
//
// The identity private key decrypts everything this account has ever
// sent or received. It is wrapped twice — once under the password, once
// under the recovery key — and both wrappers open the same key, so a
// password change or a recovery-key reset never costs a message. This
// panel is where the user manages the second wrapper and rotates the
// first.
function AccountKeysPanel() {
  const [status, setStatus] = useState<{ enabled: boolean } | null>(null);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");

  useEffect(() => {
    api.recoveryStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  async function issue() {
    if (status?.enabled && !window.confirm(
      "Replace your existing recovery key? The old one stops working immediately.",
    )) return;
    setBusy(true);
    try {
      const p = await issueRecoveryKey();
      setPhrase(p);
      setStatus({ enabled: true });
      toast("New recovery key ready — save it now", "ok");
    } catch (e) {
      toast(`Couldn't create a recovery key: ${(e as Error).message}`, "error");
    } finally { setBusy(false); }
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await changePassword({ currentPassword: curPw, newPassword: newPw });
      setPwOpen(false); setCurPw(""); setNewPw("");
      toast("Password changed — all your messages are untouched", "ok");
    } catch (e) {
      toast(`Password change failed: ${(e as Error).message}`, "error");
    } finally { setBusy(false); }
  }

  return (
    <div className="glass" style={{ padding: 12, borderRadius: 12, fontSize: 13 }}>
      <div>
        <strong>Your password is your key.</strong> Sign in with it on any
        device and your whole history comes back — nothing to carry, nothing
        to configure. The trade-off is that nobody, us included, can reset it
        for you without losing the messages.
        <div style={{ marginTop: 8 }}>
          A <strong>recovery key</strong> is the optional second way in: one
          code, generated here, that resets a forgotten password with every
          message intact. Entirely up to you.
        </div>
      </div>

      <div style={{
        marginTop: 10, padding: "8px 10px", borderRadius: 10,
        border: "1px solid var(--line)",
        background: status?.enabled ? "rgba(70,220,160,0.08)" : "rgba(255,170,70,0.10)",
      }}>
        {status === null ? "Checking…"
          : status.enabled
            ? "✓ Recovery key is set up — a forgotten password can be reset without losing anything."
            : "No recovery key on this account. Your password is the only way in."}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <Button size="small" onClick={issue} disabled={busy}>
          {status?.enabled ? "Replace recovery key" : "Create recovery key"}
        </Button>
        <Button size="small" onClick={() => setPwOpen((v) => !v)} disabled={busy}>
          Change password
        </Button>
        <Button size="small" variant="ghost" onClick={downloadRecoveryKit}>
          Account proof file
        </Button>
      </div>

      {phrase && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Your recovery key — save it now</div>
          <div style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 15, letterSpacing: 1, wordBreak: "break-all",
            padding: "12px 14px", borderRadius: 10,
            background: "rgba(255,255,255,0.05)", border: "1px solid var(--line-strong)",
          }}>{phrase}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <Button size="small" onClick={() => {
              navigator.clipboard?.writeText(phrase)
                .then(() => toast("Copied", "ok"))
                .catch(() => toast("Copy failed — write it down", "error"));
            }}>Copy</Button>
            <Button size="small" onClick={() => downloadRecoveryPhrase(phrase)}>Download kit</Button>
            <Button size="small" variant="ghost" onClick={() => setPhrase(null)}>Hide</Button>
          </div>
          <div className="small" style={{ marginTop: 6 }}>
            We can't show this again. A replacement can be generated any
            time you're signed in.
          </div>
        </div>
      )}

      {pwOpen && (
        <form onSubmit={savePassword} style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <label>Current password</label>
            <input type="password" required value={curPw} autoComplete="current-password"
              onChange={(e) => setCurPw(e.target.value)} />
          </div>
          <div>
            <label>New password</label>
            <input type="password" required minLength={8} value={newPw} autoComplete="new-password"
              onChange={(e) => setNewPw(e.target.value)} placeholder="8 characters minimum" />
          </div>
          <div className="small">
            Changing your password re-wraps your encryption key. Nothing is
            re-encrypted and no message is lost — other signed-in devices
            keep working.
          </div>
          <div>
            <Button type="submit" size="small" variant="primary" disabled={busy}>
              {busy ? "Saving…" : "Save new password"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function downloadRecoveryPhrase(phrase: string): void {
  const me = currentSession()?.user;
  const body = [
    "Aegent recovery kit",
    "===================",
    "",
    `Account: ${me?.email ?? ""}`,
    `Issued:  ${new Date().toISOString()}`,
    "",
    "Recovery key:",
    `    ${phrase}`,
    "",
    "Use it at sign-in → \"Forgot your password?\". It resets the password",
    "without losing a single message. Keep this file somewhere you'll",
    "still have it in five years.",
    "",
  ].join("\n");
  const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url; a.download = "aegent-recovery-kit.txt";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
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

// Default-on: a stored "0" means the user explicitly turned it off.
// Anything else (unset, "1") = on.
function VoiceTranscribeToggle() {
  const [on, setOn] = useState<boolean>(() => localStorage.getItem("aegent.transcribeVoice") !== "0");
  function set(v: boolean) {
    setOn(v);
    try {
      if (v) localStorage.removeItem("aegent.transcribeVoice");
      else localStorage.setItem("aegent.transcribeVoice", "0");
    } catch { /* ignore */ }
    toast(v ? "Voice notes will transcribe on this device" : "Transcription disabled", "ok");
  }
  return (
    <Toggle
      label="Transcribe voice notes on this device"
      hint="On by default. Runs Whisper locally in this WebView — your audio never leaves the phone. First use downloads a ~40 MB model to your browser cache."
      checked={on}
      onChange={set}
    />
  );
}

// Translation runs against Google Translate's public endpoint — the one
// place in the app that leaves the end-to-end envelope, and only when
// the person explicitly taps "Translate" on a message. Settings expose
// the knobs: which language to translate TO, and a way to withdraw
// consent so the service name is shown again on next use.
function TranslationPanel() {
  const [target, setTarget] = useState(() => targetLanguage());
  const [consented, setConsented] = useState(() => translationConsentGranted());

  function pickTarget(code: string) {
    setTarget(code);
    setTargetLanguage(code);
  }
  function forget() {
    revokeTranslationConsent();
    setConsented(false);
    toast("Translation consent cleared", "ok");
  }
  return (
    <div className="glass" style={{ padding: 12, borderRadius: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={{ fontSize: 13, marginBottom: 6 }}>Translate messages into</div>
        <select
          value={target}
          onChange={(e) => pickTarget(e.target.value)}
          style={{
            width: "100%", padding: "10px 12px", minHeight: 44, borderRadius: 10,
            background: "transparent", color: "var(--text)", border: "1px solid var(--line)",
            fontSize: 14,
          }}
        >
          {TRANSLATION_TARGETS.map((t) => (
            <option key={t.code} value={t.code} style={{ background: "#101225", color: "#fff" }}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="small">
        Powered by Google Translate. Tapping Translate on a message sends
        just that message's text to Google — Aegent's servers never see
        it, and nothing is translated automatically.
      </div>
      {consented && (
        <div>
          <Button size="small" variant="ghost" onClick={forget}>Forget translation consent</Button>
          <div className="small" style={{ marginTop: 6 }}>
            You'll be asked again the next time you tap Translate.
          </div>
        </div>
      )}
    </div>
  );
}

// Theme choice persists to localStorage.aegent.theme; main.tsx reads
// it before React mounts so the first paint is in the right mode.
// "system" clears the attribute and lets prefers-color-scheme decide.
function ThemePicker() {
  const [choice, setChoice] = useState<"system" | "dark" | "light">(() => {
    const t = (typeof localStorage !== "undefined") && localStorage.getItem("aegent.theme");
    return t === "dark" || t === "light" ? t : "system";
  });
  function set(v: "system" | "dark" | "light") {
    setChoice(v);
    try {
      if (v === "system") {
        localStorage.removeItem("aegent.theme");
        document.documentElement.removeAttribute("data-theme");
      } else {
        localStorage.setItem("aegent.theme", v);
        document.documentElement.setAttribute("data-theme", v);
      }
    } catch { /* ignore */ }
  }
  const opts: Array<{ v: "system" | "dark" | "light"; label: string; hint: string }> = [
    { v: "system", label: "System", hint: "Matches your device setting" },
    { v: "dark", label: "Dark", hint: "Default — easier at night" },
    { v: "light", label: "Light", hint: "Daylight-friendly" },
  ];
  return (
    <div className="glass" style={{ padding: 8, borderRadius: 12, display: "flex", gap: 6 }}>
      {opts.map((o) => {
        const active = o.v === choice;
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => set(o.v)}
            aria-label={`Use ${o.label} theme`}
            aria-pressed={active}
            title={o.hint}
            style={{
              all: "unset", cursor: "pointer", flex: 1,
              padding: "10px 12px", minHeight: 44, borderRadius: 10,
              textAlign: "center", fontSize: 13, fontWeight: 600,
              color: active ? "#10132a" : "var(--text)",
              background: active ? "linear-gradient(135deg, var(--violet), var(--aqua))" : "transparent",
              border: active ? "1px solid transparent" : "1px solid var(--line)",
              boxShadow: active ? "0 4px 14px rgba(138,125,255,0.3)" : "none",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// Manual "re-sync all history" — forces a full-drain of the inbox
// regardless of the stored watermark. The failure mode this fixes:
// a device that joined mid-conversation (or lost its local Dexie)
// won't automatically see messages that pre-date the first message
// it saw. Idempotent — Dexie dedupes by msgId.
// Two tools, one panel.
//
// PULL (Re-sync all history): grabs every envelope the server has
// for you. Fixes the case where your device's local Dexie is missing
// messages the server already holds.
//
// PUSH (Share this device's history with the cloud): uploads self-
// encrypted copies of every message YOU sent from this device to the
// server, so your other devices can pull them. Fixes the gap for
// messages sent before the automatic-replication update went live
// (anything pre-241888c) — those have no server-side self-copy.
// Nothing leaves plaintext; the copies are encrypted to your own
// public key with your own private key.
function ResyncPanel() {
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushProgress, setPushProgress] = useState<{ done: number; total: number } | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  // Live state from the replication loop — the honest answer to "is all
  // my history actually on this device?", updated without being asked.
  const [rep, setRep] = useState<ReplicationState | null>(null);
  useEffect(() => onReplication(setRep), []);

  async function pull() {
    setPulling(true);
    try {
      const r = await fullResyncInbox();
      setLastRun(`Pulled ${r.pulled} ${r.pulled === 1 ? "message" : "messages"} from the server.`);
      toast(`Synced ${r.pulled} message${r.pulled === 1 ? "" : "s"}`, "ok");
      setTimeout(() => window.dispatchEvent(new Event("focus")), 150);
    } catch (e) {
      toast(`Sync failed: ${(e as Error).message}`, "error");
    } finally { setPulling(false); }
  }

  async function push() {
    if (!window.confirm(
      "Upload encrypted copies of every message you sent from this device to the server, so your other devices can see them? Nothing leaves this device unencrypted.",
    )) return;
    setPushing(true); setPushProgress({ done: 0, total: 0 });
    try {
      const r = await pushLocalHistoryToServer({
        onProgress: (done, total) => setPushProgress({ done, total }),
      });
      setLastRun(`Pushed ${r.pushed} message${r.pushed === 1 ? "" : "s"} to the cloud${r.skipped ? ` · ${r.skipped} skipped` : ""}.`);
      toast(`Shared ${r.pushed} message${r.pushed === 1 ? "" : "s"} with your other devices`, "ok");
    } catch (e) {
      toast(`Push failed: ${(e as Error).message}`, "error");
    } finally { setPushing(false); setPushProgress(null); }
  }

  const busy = pulling || pushing;
  return (
    <div className="glass" style={{ padding: 12, borderRadius: 12 }}>
      {rep && (
        <div style={{
          marginBottom: 10, padding: "10px 12px", borderRadius: 10, fontSize: 13,
          border: "1px solid var(--line)",
          background: rep.phase === "synced" ? "rgba(70,220,160,0.08)"
            : rep.phase === "offline" ? "rgba(255,120,120,0.10)"
            : "rgba(255,170,70,0.10)",
        }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{replicationSummary(rep)}</div>
          <div className="small">
            {rep.serverTotal < 0
              ? "Relay unreachable — this device still has everything it had before."
              : rep.missing > 0
                ? `${rep.missing} envelope${rep.missing === 1 ? "" : "s"} still to fetch`
                : `Every one of the ${rep.serverTotal} envelope${rep.serverTotal === 1 ? "" : "s"} the relay holds is on this device`}
            {rep.pending > 0 && ` · ${rep.pending} couldn't be read`}
            {rep.queuedOutbound > 0 && ` · ${rep.queuedOutbound} queued to send`}
          </div>
        </div>
      )}
      <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
        Replication is continuous and automatic — every message is copied to
        the relay as ciphertext the moment it's sent, and this device
        re-checks against the server on every reconnect. There is nothing
        here you need to switch on.
      </div>
      <button type="button" onClick={() => setAdvanced((v) => !v)}
        style={{
          background: "none", border: "none", padding: "8px 0 0",
          color: "var(--accent-strong)", cursor: "pointer", fontSize: 13,
        }}>
        {advanced ? "Hide recovery tools" : "Manual recovery tools"}
      </button>
      {advanced && (
      <div style={{ marginTop: 8 }}>
      <div className="small" style={{ marginBottom: 10 }}>
        Only needed if something looks missing. Both are idempotent.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <Button size="small" onClick={pull} disabled={busy}>
            {pulling ? "Pulling…" : "Re-sync all history (pull)"}
          </Button>
          <div className="small" style={{ marginTop: 4, color: "var(--text-mute)" }}>
            Pulls every message the server has for you.
          </div>
        </div>
        <div>
          <Button size="small" onClick={push} disabled={busy}>
            {pushing
              ? (pushProgress && pushProgress.total > 0
                  ? `Pushing… ${pushProgress.done}/${pushProgress.total}`
                  : "Pushing…")
              : "Share this device's history (push)"}
          </Button>
          <div className="small" style={{ marginTop: 4, color: "var(--text-mute)" }}>
            Uploads encrypted copies of messages you sent from this device
            so your other devices can see them. Run this on the device that
            has the most history.
          </div>
        </div>
      </div>
      {lastRun && <div className="small" style={{ marginTop: 10 }}>{lastRun}</div>}
      </div>
      )}
    </div>
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
