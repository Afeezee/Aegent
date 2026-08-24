// Forward a specific message to another chat, with an optional note.

import { useEffect, useState } from "react";
import { Avatar, Button, Modal, toast } from "./ui.js";
import { listContacts, listGroups, type OpenedMessage } from "../lib/store.js";
import { sendText, sendMedia } from "../lib/session.js";

export function ForwardSheet({
  open, onClose, message,
}: { open: boolean; onClose: () => void; message: OpenedMessage | null }) {
  const [targets, setTargets] = useState<Array<{ id: string; label: string; isGroup: boolean }>>([]);
  const [pick, setPick] = useState<{ id: string; isGroup: boolean } | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) return;
    (async () => {
      const cs = await listContacts();
      const gs = await listGroups();
      setTargets([
        ...cs.map((c) => ({ id: c.id, label: c.displayName, isGroup: false })),
        ...gs.map((g) => ({ id: g.id, label: g.name, isGroup: true })),
      ]);
    })();
  }, [open]);

  async function submit() {
    if (!message || !pick) return;
    const bodyText = message.editedBody ?? message.body ?? message.caption ?? "";
    const prefix = note.trim() ? `${note.trim()}\n\n` : "";
    try {
      if (message.media) {
        const res = await sendMedia(pick.id, pick.isGroup, message.media, prefix + (bodyText || ""));
        if (!res.ok) throw new Error(res.error);
      } else {
        const res = await sendText(pick.id, pick.isGroup, prefix + bodyText);
        if (!res.ok) throw new Error(res.error);
      }
      toast("Forwarded", "ok");
      onClose();
    } catch (e) { toast(`Forward failed: ${(e as Error).message}`, "error"); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Forward message" width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!pick}>Forward</Button>
        </>
      }>
      <div style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
        {targets.map((t) => (
          <button key={t.id} onClick={() => setPick({ id: t.id, isGroup: t.isGroup })}
            style={{
              display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 10,
              background: pick?.id === t.id ? "rgba(138,125,255,0.15)" : "transparent",
              border: pick?.id === t.id ? "1px solid var(--glass-border-hi)" : "1px solid transparent",
              textAlign: "left", cursor: "pointer",
            }}>
            <Avatar name={t.label} group={t.isGroup} size="sm" />
            <div>{t.label}</div>
          </button>
        ))}
      </div>
      <div style={{ marginTop: 12 }}>
        <label>Add a note (optional)</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
          placeholder="Say something before the forwarded message" />
      </div>
    </Modal>
  );
}
