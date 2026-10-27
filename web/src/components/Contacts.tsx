// Dedicated contacts view: search + sort across every person Aegent
// knows about (both local cached contacts and server directory
// results). Openable from the sidebar; the same list drives forward-
// picker, group creator, and DM starter.

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Avatar, Button, Icon, Modal, toast } from "./ui.js";
import { api, type PublicUser } from "../lib/api.js";
import { listContacts, upsertContact, type ContactRow } from "../lib/store.js";
import { saveContactToPhone } from "../lib/contacts-integration.js";

export type ContactSort = "name" | "recent" | "added";

export function ContactsSheet({
  open, onClose, onOpenThread,
}: {
  open: boolean;
  onClose: () => void;
  onOpenThread: (peerId: string) => void;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<ContactSort>("recent");
  const [local, setLocal] = useState<ContactRow[]>([]);
  const [remote, setRemote] = useState<PublicUser[]>([]);

  useEffect(() => { if (open) (async () => setLocal(await listContacts()))(); }, [open]);

  // Debounced server search — kicks in when the query looks like a
  // handle/phone/email or has 2+ chars and no local matches.
  useEffect(() => {
    let alive = true;
    if (!q.trim()) { setRemote([]); return; }
    const h = window.setTimeout(async () => {
      try { const r = await api.search(q.trim()); if (alive) setRemote(r); }
      catch { if (alive) setRemote([]); }
    }, 220);
    return () => { alive = false; window.clearTimeout(h); };
  }, [q]);

  const shown = useMemo(() => {
    const filtered = local.filter(matches(q));
    return sortRows(filtered, sort);
  }, [local, q, sort]);

  const remoteNotLocal = remote.filter((u) => !local.some((c) => c.id === u.id));

  async function addAndOpen(u: PublicUser) {
    await upsertContact({
      id: u.id, email: u.email, phone: u.phone ?? null, handle: u.handle,
      displayName: u.displayName, publicKey: u.publicKey,
      lastSeenAt: Date.now(), online: u.presence?.online,
    });
    onOpenThread(u.id);
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Contacts" width={520}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="@handle, exact email, or phone"
        autoFocus
      />

      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
        {(["name", "recent", "added"] as ContactSort[]).map((s) => (
          <button key={s} onClick={() => setSort(s)}
            style={{
              padding: "6px 12px", fontSize: 12, borderRadius: 999,
              background: sort === s ? "var(--glass-bg-hi)" : "transparent",
              border: sort === s ? "1px solid var(--glass-border-hi)" : "1px solid var(--line)",
              cursor: "pointer", color: "inherit",
            }}>
            {s === "name" ? "A → Z" : s === "recent" ? "Recently active" : "Recently added"}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 14, maxHeight: 380, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
        {shown.length === 0 && !remoteNotLocal.length && (
          <div className="small" style={{ padding: 12 }}>
            {q.trim() ? `No one matches “${q}”.` : "No contacts yet — try searching by @handle above."}
          </div>
        )}

        {shown.map((c) => (
          <ContactRow
            key={c.id}
            name={c.displayName}
            handle={c.handle}
            subline={c.phone || c.email}
            online={c.online}
            avatar={c.avatar ?? null}
            onOpen={() => { onOpenThread(c.id); onClose(); }}
            onSave={() => saveContactToPhone({
              displayName: c.displayName, handle: c.handle, email: c.email, phone: c.phone,
            }).catch(() => toast("Save failed", "error"))}
          />
        ))}

        {remoteNotLocal.length > 0 && (
          <>
            <div className="small" style={{ padding: "10px 8px 4px", letterSpacing: 0.4 }}>ON AEGENT</div>
            {remoteNotLocal.map((u) => (
              <ContactRow key={u.id}
                name={u.displayName} handle={u.handle}
                subline={u.phone || u.email}
                online={u.presence?.online}
                avatar={u.avatar ?? null}
                onOpen={() => addAndOpen(u)}
                onSave={() => saveContactToPhone({
                  displayName: u.displayName, handle: u.handle, email: u.email, phone: u.phone,
                }).catch(() => toast("Save failed", "error"))}
              />
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}

function matches(q: string) {
  const s = q.trim().toLowerCase().replace(/^@/, "");
  if (!s) return () => true;
  return (c: ContactRow) =>
    c.displayName.toLowerCase().includes(s) ||
    c.handle.toLowerCase().includes(s) ||
    (c.email ?? "").toLowerCase().includes(s) ||
    (c.phone ?? "").replace(/[^\d]/g, "").includes(s.replace(/[^\d]/g, ""));
}

function sortRows(rows: ContactRow[], sort: ContactSort): ContactRow[] {
  const copy = [...rows];
  if (sort === "name") return copy.sort((a, b) => a.displayName.localeCompare(b.displayName));
  if (sort === "added") return copy.sort((a, b) => b.lastSeenAt - a.lastSeenAt); // proxy for created-at
  // recent: recently active first — last message timestamp lives on lastSeenAt too
  return copy.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

function ContactRow({
  name, handle, subline, online, avatar, onOpen, onSave,
}: {
  name: string; handle: string; subline?: string | null; online?: boolean;
  avatar?: string | null;
  onOpen: () => void; onSave: () => void;
}) {
  return (
    <motion.div whileHover={{ x: 2 }}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 10 }}>
      <Avatar name={name} src={avatar} size="sm" online={online} />
      <button onClick={onOpen}
        style={{
          flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none",
          padding: 0, cursor: "pointer", color: "inherit",
        }}>
        <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
        </div>
        <div className="small">@{handle}{subline ? ` · ${subline}` : ""}</div>
      </button>
      <Button size="small" variant="ghost" onClick={onSave} title="Save to phone contacts">
        <Icon.contacts />
      </Button>
    </motion.div>
  );
}
