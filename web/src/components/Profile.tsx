// Profile editor — avatar, display name, and a status line with an
// optional expiry ("Busy till 4pm"). Avatar is client-resized to a
// small square and stored as a base64 data URI in the public
// directory row (it's public info, like the display name).

import { useRef, useState } from "react";
import { Avatar, Button, Icon, Modal, toast } from "./ui.js";
import { api } from "../lib/api.js";
import { currentSession, refreshMe } from "../lib/session.js";

// Quick status presets. Picking one fills the text; the user can still
// edit it and choose an expiry.
const PRESETS = ["🟢 Available", "🔴 Busy", "🌙 Away", "🎯 Focusing", "🏖️ On holiday", "📵 Do not disturb"];

export function Profile({
  open, onClose, onSaved,
}: { open: boolean; onClose: () => void; onSaved?: () => void }) {
  const me = currentSession()?.user;
  const [displayName, setDisplayName] = useState(me?.displayName ?? "");
  const [avatar, setAvatar] = useState<string | null>((me as { avatar?: string | null })?.avatar ?? null);
  const [statusText, setStatusText] = useState((me as { statusText?: string | null })?.statusText ?? "");
  const [until, setUntil] = useState<string>(""); // "" | "1h" | "4h" | "today" | "custom hh:mm"
  // Track whether the user TOUCHED the expiry control this session.
  // If they didn't, we omit statusUntil from the PATCH entirely so the
  // server keeps the previously-saved value — fixes QA F17 where a
  // name-only edit was quietly clearing a one-hour expiry.
  const [untilTouched, setUntilTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!me) return null;

  async function onPickAvatar(file: File) {
    try {
      const resized = await resizeToDataUri(file, 256, 0.82);
      setAvatar(resized);
    } catch (e) { toast(`Couldn't load image: ${(e as Error).message}`, "error"); }
  }

  function untilTimestamp(): number | null {
    if (!until) return null;
    const now = Date.now();
    if (until === "1h") return now + 3600_000;
    if (until === "4h") return now + 4 * 3600_000;
    if (until === "today") { const d = new Date(); d.setHours(23, 59, 0, 0); return d.getTime(); }
    return null;
  }

  async function save() {
    setBusy(true);
    try {
      // Build the patch so we only SEND fields the user actually
      // touched this session. The server's updateProfile keeps the
      // current value for any field that's undefined in the patch,
      // so omitting = "leave alone". Clearing the status explicitly
      // (empty text) DOES clear the saved expiry too — a status
      // without text has no expiry to attach.
      const patch: {
        displayName?: string; avatar?: string | null;
        statusText?: string | null; statusUntil?: number | null;
      } = {
        displayName: displayName.trim() || me!.displayName,
        avatar,
        statusText: statusText.trim() || null,
      };
      if (!statusText.trim()) patch.statusUntil = null;
      else if (untilTouched) patch.statusUntil = untilTimestamp();
      // else: leave statusUntil out of the patch entirely so a prior
      // expiry survives a name-only edit (QA F17).
      await api.updateProfile(patch);
      await refreshMe();
      toast("Profile updated", "ok");
      onSaved?.();
      onClose();
    } catch (e) { toast(`Save failed: ${(e as Error).message}`, "error"); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Your profile" width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        </>
      }>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Avatar */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ position: "relative" }}>
            <Avatar name={displayName || me.displayName} src={avatar} size="xl" />
            <button
              onClick={() => fileRef.current?.click()}
              aria-label="Change photo"
              style={{
                all: "unset", cursor: "pointer", position: "absolute", right: -4, bottom: -4,
                width: 32, height: 32, borderRadius: 999, display: "grid", placeItems: "center",
                background: "linear-gradient(135deg, var(--violet), var(--aqua))", color: "#10132a",
                boxShadow: "0 4px 12px rgba(138,125,255,0.4)",
              }}
            ><Icon.photo /></button>
          </div>
          <div style={{ flex: 1 }}>
            <div className="small" style={{ color: "var(--text-dim)" }}>@{me.handle}</div>
            {avatar && (
              <Button size="small" variant="ghost" onClick={() => setAvatar(null)}>Remove photo</Button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickAvatar(f); e.target.value = ""; }} />
        </div>

        {/* Display name. Explicit htmlFor/id so screen readers pair the
            label with the input and a label click focuses the field
            (QA F18). */}
        <div>
          <label htmlFor="profile-display-name">Display name</label>
          <input id="profile-display-name"
            value={displayName} onChange={(e) => setDisplayName(e.target.value)}
            maxLength={80} placeholder="Your name" />
        </div>

        {/* Status */}
        <div>
          <label htmlFor="profile-status-text">Status</label>
          <input id="profile-status-text"
            value={statusText} onChange={(e) => setStatusText(e.target.value)}
            maxLength={120} placeholder="e.g. Busy till 4pm" />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            {PRESETS.map((p) => (
              <button key={p} onClick={() => setStatusText(p)}
                style={{
                  all: "unset", cursor: "pointer", padding: "5px 10px", borderRadius: 999,
                  fontSize: 12, background: "var(--ink-2)", border: "1px solid var(--line)",
                }}>{p}</button>
            ))}
          </div>
          {statusText.trim() && (
            <div style={{ marginTop: 10 }}>
              <label className="small" style={{ color: "var(--text-dim)" }}>Clear after</label>
              <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                {[
                  { k: "", label: "Don't clear" },
                  { k: "1h", label: "1 hour" },
                  { k: "4h", label: "4 hours" },
                  { k: "today", label: "End of day" },
                ].map((o) => (
                  <button key={o.k} onClick={() => { setUntil(o.k); setUntilTouched(true); }}
                    style={{
                      all: "unset", cursor: "pointer", flex: 1, textAlign: "center",
                      padding: "8px 6px", borderRadius: 10, fontSize: 12, fontWeight: 600,
                      background: until === o.k ? "linear-gradient(135deg, var(--violet), var(--aqua))" : "transparent",
                      color: until === o.k ? "#10132a" : "var(--text)",
                      border: until === o.k ? "1px solid transparent" : "1px solid var(--line)",
                    }}>{o.label}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Resize an image file to a square JPEG data URI. Centre-crops to a
// square, scales to `size`px, and returns a base64 data URI small
// enough to live in a directory row (~10-25 KB typically).
async function resizeToDataUri(file: File, size: number, quality: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas context");
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", quality);
}
