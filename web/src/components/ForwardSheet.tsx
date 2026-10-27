// Forward a specific message to one OR MANY chats, with an optional note.

import { useEffect, useMemo, useState } from "react";
import { Avatar, Button, Icon, Modal, toast } from "./ui.js";
import { listContacts, listGroups, type OpenedMessage } from "../lib/store.js";
import { sendText, sendMedia } from "../lib/session.js";

type Target = { id: string; label: string; isGroup: boolean };

export function ForwardSheet({
  open, onClose, message,
}: { open: boolean; onClose: () => void; message: OpenedMessage | null }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) { setPicked(new Set()); setNote(""); setQuery(""); return; }
    (async () => {
      const cs = await listContacts();
      const gs = await listGroups();
      setTargets([
        ...cs.map((c) => ({ id: c.id, label: c.displayName, isGroup: false })),
        ...gs.map((g) => ({ id: g.id, label: g.name, isGroup: true })),
      ]);
    })();
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter((t) => t.label.toLowerCase().includes(q));
  }, [targets, query]);

  function toggle(id: string) {
    setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function submit() {
    if (!message || picked.size === 0) return;
    const bodyText = message.editedBody ?? message.body ?? message.caption ?? "";
    const prefix = note.trim() ? `${note.trim()}\n\n` : "";
    setBusy(true);
    let okCount = 0, failCount = 0;
    for (const id of picked) {
      const t = targets.find((x) => x.id === id);
      if (!t) continue;
      try {
        const res = message.media
          ? await sendMedia(t.id, t.isGroup, message.media, prefix + (bodyText || ""))
          : await sendText(t.id, t.isGroup, prefix + bodyText);
        if (!res.ok) throw new Error(res.error);
        okCount++;
      } catch { failCount++; }
    }
    setBusy(false);
    if (okCount > 0) toast(`Forwarded to ${okCount} chat${okCount === 1 ? "" : "s"}${failCount ? ` · ${failCount} failed` : ""}`, failCount ? "warn" : "ok");
    else toast("Forward failed", "error");
    if (okCount > 0) onClose();
  }

  return (
    <Modal open={open} onClose={onClose}
      title={picked.size > 0 ? `Forward to ${picked.size} selected` : "Forward message"} width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={picked.size === 0 || busy}>
            {busy ? "Forwarding…" : picked.size > 1 ? `Forward to ${picked.size}` : "Forward"}
          </Button>
        </>
      }>
      <input
        value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Search people and groups"
        style={{ width: "100%", marginBottom: 10 }}
      />
      <div style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
        {filtered.length === 0 && (
          <div className="small" style={{ color: "var(--text-mute)", padding: 10 }}>No matches.</div>
        )}
        {filtered.map((t) => {
          const on = picked.has(t.id);
          return (
            <button key={t.id} onClick={() => toggle(t.id)}
              aria-pressed={on}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 10,
                background: on ? "rgba(138,125,255,0.15)" : "transparent",
                border: on ? "1px solid var(--glass-border-hi)" : "1px solid transparent",
                textAlign: "left", cursor: "pointer",
              }}>
              <span style={{
                width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
                border: on ? "none" : "2px solid var(--line-strong)",
                background: on ? "var(--accent)" : "transparent",
                color: "#0f1226", display: "grid", placeItems: "center",
              }}>{on && <Icon.check />}</span>
              <Avatar name={t.label} group={t.isGroup} size="sm" />
              <div style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.label}</div>
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 12 }}>
        <label>Add a note (optional)</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
          placeholder="Say something before the forwarded message" />
      </div>
    </Modal>
  );
}
