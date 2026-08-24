// Compose = start a new conversation: find one person and DM them, or
// pick multiple people and create a group. Also owns the "add contact
// by link / QR" flow so a first-time user can bring in their circle.

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import QRCode from "qrcode";
import { Avatar, Button, Glass, Icon, Modal, toast } from "./ui.js";
import { api, type PublicUser } from "../lib/api.js";
import { currentSession } from "../lib/session.js";
import { upsertContact, upsertGroup } from "../lib/store.js";

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
        // Try handle first if it looks like one, then generic search.
        const looksHandle = /^@?[a-z0-9_.]+$/i.test(q.trim());
        if (looksHandle) {
          try {
            const u = await api.byHandle(q.trim());
            if (alive) setResults([u]);
            return;
          } catch { /* fall through to search */ }
        }
        const r = await api.search(q.trim());
        if (alive) setResults(r);
      } catch { /* ignore */ }
    }, 180);
    return () => { alive = false; window.clearTimeout(h); };
  }, [q]);

  async function cacheContact(u: PublicUser) {
    await upsertContact({
      id: u.id, email: u.email, handle: u.handle,
      displayName: u.displayName, publicKey: u.publicKey,
      lastSeenAt: Date.now(), online: u.presence?.online,
    });
  }

  async function startChat(u: PublicUser) {
    await cacheContact(u);
    onOpenThread(u.id, false);
    onClose();
    toast(`Started chat with ${u.displayName}`, "ok");
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

  const inviteLink = useMemo(() => me ? `${location.origin}/#/i/${me.handle}` : "", [me]);

  return (
    <Modal open={open} onClose={onClose} title={<TabRow mode={mode} setMode={setMode} />}>
      {mode === "chat" && (
        <>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, @handle, or email"
            autoFocus
          />
          <div style={{ marginTop: 12, maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {results.length === 0 && q && <div className="small" style={{ padding: 12 }}>No one matches “{q}”.</div>}
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
        <InviteCard link={inviteLink} handle={me.handle} />
      )}
    </Modal>
  );
}

function TabRow({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  const tab = (m: Mode, label: string, icon: React.ReactNode) => (
    <button onClick={() => setMode(m)}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "6px 12px", fontSize: 13, borderRadius: 999,
        background: mode === m ? "var(--glass-bg-hi)" : "transparent",
        border: mode === m ? "1px solid var(--glass-border-hi)" : "1px solid transparent",
        cursor: "pointer", color: "inherit",
      }}>{icon} {label}</button>
  );
  return (
    <div style={{ display: "flex", gap: 4 }}>
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
      <Avatar name={u.displayName} size="sm" online={u.presence?.online} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{u.displayName}</div>
        <div className="small">@{u.handle}</div>
      </div>
      {selected && <Icon.check />}
    </motion.button>
  );
}

function InviteCard({ link, handle }: { link: string; handle: string }) {
  const [png, setPng] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(link, { margin: 1, width: 240, color: { dark: "#0f1226", light: "#ffffff" } })
      .then(setPng).catch(() => setPng(null));
  }, [link]);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <Glass raised style={{ padding: 14, borderRadius: 18 }}>
        {png ? <img src={png} alt="Your invite QR" style={{ display: "block" }} />
          : <div style={{ width: 240, height: 240 }} />}
      </Glass>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontWeight: 600 }}>@{handle}</div>
        <div className="small" style={{ wordBreak: "break-all", marginTop: 4 }}>{link}</div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button onClick={async () => {
          try { await navigator.clipboard.writeText(link); toast("Invite link copied", "ok"); }
          catch { toast("Copy failed", "error"); }
        }}><Icon.copy /> Copy link</Button>
        <Button onClick={async () => {
          if (navigator.share) { try { await navigator.share({ title: "Chat with me on Aegent", url: link }); } catch { /* ignore */ } }
          else { try { await navigator.clipboard.writeText(link); toast("Copied", "ok"); } catch { /* ignore */ } }
        }} variant="primary"><Icon.link /> Share</Button>
      </div>
    </div>
  );
}
