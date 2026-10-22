// Writing an entry.
//
// Not a reuse of Composer.tsx: that one is shaped around a conversation
// (peer id, group flag, reply target, edit mode) and bending it to a
// diary means threading a fake peer through it. This is the smaller
// thing it actually is — a long text box, or a picture with a caption.

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button, Icon, toast, toastDismiss, toastUpdate } from "./ui.js";
import { publishDiaryEntry, resolveAudience } from "../lib/diary.js";
import { dayKeyFor } from "../lib/daybreaks.js";
import { pickFile, uploadMedia } from "../lib/media.js";

const MAX_ATTACH_MB = 19;   // server cap minus a safety margin

export function DiaryComposer({
  open, onClose, onPosted,
}: { open: boolean; onClose: () => void; onPosted: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [audience, setAudience] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Show how many people this reaches before it is written, not after.
  //
  // Re-resolved every time the sheet opens, because the contact list
  // moves underneath it: someone who messages you between two entries
  // joins the audience, and a count cached from the last open would
  // quietly tell you the wrong thing about who is about to read this.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setAudience(null);
    resolveAudience(dayKeyFor(Date.now()))
      .then((a) => { if (live) setAudience(a.length); })
      .catch(() => { if (live) setAudience(0); });
    return () => { live = false; };
  }, [open]);

  async function postText() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const r = await publishDiaryEntry({ kind: "text", body });
      setText("");
      toast(r.queued ? "Saved — it'll post when you're back online" : "Added to today's page", "ok");
      onPosted();
    } catch (e) {
      toast(`Couldn't post: ${(e as Error).message}`, "error");
    } finally { setBusy(false); }
  }

  async function attach(file: File) {
    if (file.size > MAX_ATTACH_MB * 1024 * 1024) {
      toast(`That image is over ${MAX_ATTACH_MB} MB`, "warn");
      return;
    }
    setBusy(true);
    const id = toast("Encrypting photo…", "info", { sticky: true });
    try {
      const picked = await pickFile(file);
      toastUpdate(id, { text: "Uploading · 0%", progress: 0 });
      const media = await uploadMedia(picked, (frac) => {
        toastUpdate(id, { text: `Uploading · ${Math.round(frac * 100)}%`, progress: frac });
      });
      const r = await publishDiaryEntry({ kind: "media", media, caption: text.trim() || undefined });
      setText("");
      toastUpdate(id, {
        text: r.queued ? "Saved — it'll post when you're back online" : "Photo added to today's page",
        kind: "ok", sticky: false, progress: undefined,
      });
      onPosted();
    } catch (e) {
      toastUpdate(id, { text: `Couldn't post: ${(e as Error).message}`, kind: "error", sticky: false, progress: undefined });
    } finally {
      setBusy(false);
      setTimeout(() => toastDismiss(id), 5000);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={onClose}
          style={{
            position: "fixed", inset: 0, zIndex: 950,
            background: "rgba(6,8,20,0.6)", backdropFilter: "blur(8px)",
            display: "flex", alignItems: "flex-end", justifyContent: "center",
          }}
        >
          <motion.div
            initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="glass glass-hi"
            style={{
              width: "min(640px, 100%)", borderRadius: "20px 20px 0 0",
              padding: 18,
              paddingBottom: "calc(18px + var(--safe-bottom))",
              maxHeight: "86vh", display: "flex", flexDirection: "column",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <div>
                <div style={{ fontWeight: 650 }}>Today's page</div>
                <div className="small">
                  {audience === null ? "…"
                    : audience === 0 ? "No contacts yet — only you will see this"
                    : `${audience} ${audience === 1 ? "contact" : "contacts"} can read it for 24 hours`}
                </div>
              </div>
              <Button variant="icon" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close">
                <Icon.x />
              </Button>
            </div>

            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What happened today?"
              rows={8}
              style={{
                width: "100%", boxSizing: "border-box", resize: "vertical",
                minHeight: 140, fontSize: 15, lineHeight: 1.6,
              }}
            />

            <div className="small" style={{ marginTop: 8, lineHeight: 1.5 }}>
              You keep this forever. After 24 hours your contacts can't open it
              again — though anyone who already read it may have kept a copy.
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
              <input
                ref={fileRef} type="file" accept="image/*" hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void attach(f);
                }}
              />
              <Button onClick={() => fileRef.current?.click()} disabled={busy}>
                <Icon.photo /> Photo
              </Button>
              <Button variant="primary" style={{ marginLeft: "auto" }}
                onClick={postText} disabled={busy || !text.trim()}>
                {busy ? "Posting…" : "Add entry"}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
