// Compose = start a new conversation: find one person and DM them, or
// pick multiple people and create a group. Also owns the "add contact
// by link / QR" flow so a first-time user can bring in their circle.

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import QRCode from "qrcode";
import { Avatar, Button, Glass, Icon, Modal, toast } from "./ui.js";
import { api, siteUrl, type PublicUser } from "../lib/api.js";
import { currentSession } from "../lib/session.js";
import { upsertContact, upsertGroup } from "../lib/store.js";
import {
  inviteBodyFor, inviteBySms, isContactPickerSupported,
  matchPickedContactsToAegent, pickPhoneContacts, shareInvite,
} from "../lib/contacts-integration.js";

type Mode = "chat" | "group" | "invite";

export function ComposeOverlay({
  open, onClose, onOpenThread,
}: {
  open: boolean;
  onClose: () => void;
  onOpenThread: (peerId: string, isGroup: boolean) => void;
}) {
  const [mode, setMode] = useState<Mode>("chat");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PublicUser[]>([]);
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [groupName, setGroupName] = useState("");
  const me = currentSession()?.user;

  useEffect(() => { if (!open) { setQ(""); setResults([]); setPicked([]); setGroupName(""); setMode("chat"); } }, [open]);

  useEffect(() => {
    let alive = true;
    if (!q.trim()) { setResults([]); return; }
    const h = window.setTimeout(async () => {
      try {
        const trimmed = q.trim();
        // Phone number? Do a direct phone lookup — cheap and exact.
        if (/^\+?\d[\d\s()\-.]{5,}$/.test(trimmed)) {
          try {
            const u = await api.byPhone(trimmed);
            if (alive) setResults([u]);
            return;
          } catch { if (alive) setResults([]); return; }
        }
        // Handle-shaped?
        const looksHandle = /^@?[a-z0-9_.]+$/i.test(trimmed);
        if (looksHandle) {
          try {
            const u = await api.byHandle(trimmed);
            if (alive) setResults([u]);
            return;
          } catch { /* fall through to search */ }
        }
        const r = await api.search(trimmed);
        if (alive) setResults(r);
      } catch { /* ignore */ }
    }, 180);
    return () => { alive = false; window.clearTimeout(h); };
  }, [q]);

  async function cacheContact(u: PublicUser) {
    await upsertContact({
      id: u.id, email: u.email, phone: u.phone ?? null, handle: u.handle,
      displayName: u.displayName, publicKey: u.publicKey,
      lastSeenAt: Date.now(), online: u.presence?.online,
      avatar: u.avatar ?? null,
      statusText: u.statusText ?? null,
    });
  }

  async function startChat(u: PublicUser) {
    await cacheContact(u);
    onOpenThread(u.id, false);
    onClose();
    toast(`Started chat with ${u.displayName}`, "ok");
  }

  // ---- import from phone contacts (Android Chrome / supported) ----
  const canPickContacts = isContactPickerSupported();
  const [phonePicks, setPhonePicks] = useState<Awaited<ReturnType<typeof matchPickedContactsToAegent>>>([]);
  const [picking, setPicking] = useState(false);

  async function importPhoneContacts() {
    setPicking(true);
    try {
      const picked = await pickPhoneContacts();
      if (picked.length === 0) {
        setPicking(false);
        toast("No contacts selected", "info");
        return;
      }
      const matched = await matchPickedContactsToAegent(picked);
      setPhonePicks(matched);
      const onAegent = matched.filter((m) => m.aegent).length;
      const total = matched.length;
      toast(
        onAegent > 0
          ? `${total} imported · ${onAegent} already on Aegent`
          : `${total} imported — invite them via SMS below`,
        "ok",
      );
    } catch (e) {
      const msg = (e as Error).message;
      if (/permission_denied/i.test(msg)) {
        toast("Contacts permission denied — enable it in system settings.", "warn");
      } else if (!/cancel/i.test(msg)) {
        toast(`Contacts: ${msg}`, "error");
      }
    } finally { setPicking(false); }
  }

  async function createGroup() {
    if (!groupName.trim() || picked.length === 0) return;
    try {
      const g = await api.createGroup(groupName.trim(), picked.map((u) => u.id));
      for (const u of picked) await cacheContact(u);
      await upsertGroup({
        id: g.id, name: g.name, memberIds: g.memberIds,
        createdBy: g.created_by, createdAt: g.created_at, lastSeenAt: g.created_at,
      });
      onOpenThread(g.id, true);
      onClose();
      toast(`Group "${g.name}" created`, "ok");
    } catch (e) { toast(`Failed: ${(e as Error).message}`, "error"); }
  }

  // Use the public site URL, not location.origin — inside the APK the
  // WebView's origin is https://localhost and would produce
  // unusable share links.
  const inviteLink = useMemo(() => me ? siteUrl(`/#/i/${me.handle}`) : "", [me]);

  return (
    <Modal open={open} onClose={onClose} title={<TabRow mode={mode} setMode={setMode} />}>
      {mode === "chat" && (
        <>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="@handle, exact email, or phone number"
            autoFocus
          />
          <div className="small" style={{ marginTop: 6, color: "var(--text-dim)" }}>
            People are found only by what they share with you — their exact
            @handle, email, or number. Nobody can be found by name.
          </div>
          {canPickContacts && (
            <div style={{ marginTop: 10 }}>
              <Button size="small" onClick={importPhoneContacts} disabled={picking}>
                <Icon.contacts /> {picking ? "Choosing…" : "Import from phone contacts"}
              </Button>
            </div>
          )}
          <div style={{ marginTop: 12, maxHeight: 340, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {phonePicks.length > 0 && <PhonePickList picks={phonePicks} onStart={startChat} onDismiss={() => setPhonePicks([])} />}
            {results.length === 0 && q && !phonePicks.length && (
              <div className="small" style={{ padding: 12 }}>
                No one on Aegent matches “{q}”. Try the Invite tab to bring them in.
              </div>
            )}
            {results.map((u) => (
              <UserRow key={u.id} u={u} onClick={() => startChat(u)} />
            ))}
          </div>
        </>
      )}

      {mode === "group" && (
        <>
          <input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="Group name (e.g. Design squad)"
            autoFocus
          />
          <div style={{ marginTop: 10 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add people" />
          </div>
          {picked.length > 0 && (
            <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6 }}>
              {picked.map((u) => (
                <span key={u.id} className="tag" style={{ padding: "4px 8px", fontSize: 12 }}>
                  {u.displayName}
                  <button onClick={() => setPicked(picked.filter((x) => x.id !== u.id))}
                    style={{ marginLeft: 6, background: "none", border: "none", cursor: "pointer", color: "inherit" }}>×</button>
                </span>
              ))}
            </div>
          )}
          <div style={{ marginTop: 12, maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {results.map((u) => (
              <UserRow key={u.id} u={u}
                onClick={() => setPicked(picked.some((p) => p.id === u.id)
                  ? picked.filter((p) => p.id !== u.id)
                  : [...picked, u])}
                selected={picked.some((p) => p.id === u.id)} />
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16, gap: 8 }}>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={createGroup} disabled={!groupName.trim() || picked.length === 0}>
              Create group
            </Button>
          </div>
        </>
      )}

      {mode === "invite" && me && (
        <InviteCard link={inviteLink} handle={me.handle} displayName={me.displayName} />
      )}
    </Modal>
  );
}

function TabRow({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  const tab = (m: Mode, label: string, icon: React.ReactNode) => (
    <button onClick={() => setMode(m)}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "6px 10px", fontSize: 13, borderRadius: 999,
        background: mode === m ? "var(--glass-bg-hi)" : "transparent",
        border: mode === m ? "1px solid var(--glass-border-hi)" : "1px solid transparent",
        cursor: "pointer", color: "inherit",
        whiteSpace: "nowrap", flex: "0 1 auto", minWidth: 0,
      }}>{icon} <span>{label}</span></button>
  );
  return (
    // Wrap when the three chips exceed the modal header width so the
    // "Invite" tab can never fall off the right edge on a phone.
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", minWidth: 0, maxWidth: "100%" }}>
      {tab("chat", "New chat", <Icon.plus />)}
      {tab("group", "New group", <Icon.users />)}
      {tab("invite", "Invite", <Icon.link />)}
    </div>
  );
}

function UserRow({ u, onClick, selected }: { u: PublicUser; onClick: () => void; selected?: boolean }) {
  return (
    <motion.button onClick={onClick} whileHover={{ x: 2 }}
      style={{
        display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 10,
        background: selected ? "rgba(138,125,255,0.15)" : "transparent",
        border: selected ? "1px solid var(--glass-border-hi)" : "1px solid transparent",
        textAlign: "left", cursor: "pointer",
      }}>
      <Avatar name={u.displayName} src={u.avatar} size="sm" online={u.presence?.online} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{u.displayName}</div>
        <div className="small">@{u.handle}</div>
      </div>
      {selected && <Icon.check />}
    </motion.button>
  );
}

function InviteCard({ link, handle, displayName }: { link: string; handle: string; displayName: string }) {
  const [png, setPng] = useState<string | null>(null);
  const [smsTarget, setSmsTarget] = useState("");
  useEffect(() => {
    QRCode.toDataURL(link, { margin: 1, width: 220, color: { dark: "#0f1226", light: "#ffffff" } })
      .then(setPng).catch(() => setPng(null));
  }, [link]);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <Glass raised style={{ padding: 12, borderRadius: 18 }}>
        {png ? <img src={png} alt="Your invite QR" style={{ display: "block" }} />
          : <div style={{ width: 220, height: 220 }} />}
      </Glass>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontWeight: 600 }}>@{handle}</div>
        <div className="small" style={{ wordBreak: "break-all", marginTop: 4 }}>{link}</div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
        <Button onClick={async () => {
          try { await navigator.clipboard.writeText(link); toast("Invite link copied", "ok"); }
          catch { toast("Copy failed", "error"); }
        }}><Icon.copy /> Copy link</Button>
        <Button variant="primary" onClick={async () => {
          const how = await shareInvite({
            url: link,
            title: `Chat with ${displayName} on Aegent`,
            text: `${displayName} invited you to chat privately on Aegent — end-to-end encrypted.`,
          });
          if (how === "copied") toast("Sharing not available — link copied", "warn");
        }}><Icon.link /> Share</Button>
      </div>

      <div style={{
        width: "100%", padding: "12px 14px", borderRadius: 12,
        background: "rgba(255,255,255,0.03)", border: "1px solid var(--line)",
        marginTop: 4,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Invite by SMS</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input type="tel" inputMode="tel"
            value={smsTarget} onChange={(e) => setSmsTarget(e.target.value)}
            placeholder="+234 800 000 0000 (optional)" />
          <Button variant="primary" onClick={() => inviteBySms(smsTarget.trim() || null, link, displayName)}>
            <Icon.phone /> Text
          </Button>
        </div>
        <div className="small" style={{ marginTop: 8 }}>
          Opens your SMS app with a prefilled invite. Leave the number blank to pick a recipient there.
        </div>
        <div style={{ marginTop: 8 }}>
          <button onClick={async () => {
            try { await navigator.clipboard.writeText(inviteBodyFor(link, displayName)); toast("Invite text copied", "ok"); }
            catch { toast("Copy failed", "error"); }
          }}
            style={{ background: "none", border: "none", padding: 0, color: "var(--accent-strong)", cursor: "pointer", fontSize: 13 }}>
            Copy invite text for another app
          </button>
        </div>
      </div>
    </div>
  );
}

function PhonePickList({
  picks, onStart, onDismiss,
}: {
  picks: Awaited<ReturnType<typeof matchPickedContactsToAegent>>;
  onStart: (u: PublicUser) => void;
  onDismiss: () => void;
}) {
  const onAegent = picks.filter((p) => p.aegent);
  const notYet = picks.filter((p) => !p.aegent);
  return (
    <div style={{ padding: "8px 4px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div className="small" style={{ letterSpacing: 0.4 }}>FROM YOUR PHONE CONTACTS</div>
        <button onClick={onDismiss}
          style={{ background: "none", border: "none", padding: 0, color: "var(--text-dim)", cursor: "pointer", fontSize: 12 }}>
          clear
        </button>
      </div>
      {onAegent.length > 0 && (
        <>
          <div className="small" style={{ padding: "4px 8px", color: "var(--ok)" }}>Already on Aegent</div>
          {onAegent.map((p, i) => (
            <UserRow key={p.aegent!.id + i} u={p.aegent!} onClick={() => onStart(p.aegent!)} />
          ))}
        </>
      )}
      {notYet.length > 0 && (
        <>
          <div className="small" style={{ padding: "4px 8px" }}>Not on Aegent yet</div>
          {notYet.map((p, i) => (
            <div key={p.phone + i} style={{ display: "flex", alignItems: "center", gap: 10, padding: 10 }}>
              <Avatar name={p.name} size="sm" />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div className="small">{p.phone}</div>
              </div>
              <Button size="small" onClick={() => {
                const me = currentSession()?.user;
                if (!me) return;
                inviteBySms(p.phone, siteUrl(`/#/i/${me.handle}`), me.displayName);
              }}>
                <Icon.phone /> Invite
              </Button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
