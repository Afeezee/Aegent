// Writing an entry.
//
// Not a reuse of Composer.tsx: that one is shaped around a conversation.
// This is the smaller thing a diary post is — formatted text, or a
// picture with a caption — plus the two choices that belong to the
// author: who may see it, and (while writing) how it reads.

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button, Icon, toast, toastDismiss, toastUpdate } from "./ui.js";
import { publishDiaryEntry, resolveAudience, type DiaryVisibility } from "../lib/diary.js";
import { RichEditor, applyRich, type RichCommand } from "./RichEditor.js";
import type { DiaryAlign } from "../lib/diary-protocol.js";
import { dayKeyFor } from "../lib/daybreaks.js";
import { pickFile, uploadMedia } from "../lib/media.js";
import type { MediaRef } from "../lib/store.js";

const MAX_ATTACH_MB = 19;   // server cap minus a safety margin
const isNarrow = () => typeof window !== "undefined" && window.innerWidth < 720;

export function DiaryComposer({
  open, onClose, onPosted,
}: { open: boolean; onClose: () => void; onPosted: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [audience, setAudience] = useState<number | null>(null);
  const [align, setAlign] = useState<DiaryAlign>("left");
  const [visibility, setVisibility] = useState<DiaryVisibility>("contacts");
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setAudience(null);
    resolveAudience(dayKeyFor(Date.now()))
      .then((a) => { if (live) setAudience(a.length); })
      .catch(() => { if (live) setAudience(0); });
    return () => { live = false; };
  }, [open]);

  // Reset when the sheet closes, so a fresh open starts blank.
  useEffect(() => { if (!open) { setText(""); setAlign("left"); setVisibility("contacts"); } }, [open]);

  async function postText() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const r = await publishDiaryEntry({ kind: "text", body, format: "md", align, visibility });
      setText("");
      toast(r.queued ? "Saved — it'll post when you're back online"
        : visibility === "private" ? "Saved to your diary (only you)" : "Added to today's page", "ok");
      onPosted();
    } catch (e) {
      toast(`Couldn't post: ${(e as Error).message}`, "error");
    } finally { setBusy(false); }
  }

  async function attach(files: File[]) {
    const chosen = files.slice(0, 8);   // server binds at most 8 blobs per entry
    if (chosen.some((f) => f.size > MAX_ATTACH_MB * 1024 * 1024)) {
      toast(`Each image must be under ${MAX_ATTACH_MB} MB`, "warn");
      return;
    }
    setBusy(true);
    const id = toast(chosen.length > 1 ? `Encrypting ${chosen.length} photos…` : "Encrypting photo…", "info", { sticky: true });
    try {
      const album: MediaRef[] = [];
      for (let k = 0; k < chosen.length; k++) {
        const picked = await pickFile(chosen[k]);
        const base = k / chosen.length;
        const media = await uploadMedia(picked, (frac) => {
          const overall = Math.round((base + frac / chosen.length) * 100);
          toastUpdate(id, { text: `Uploading · ${overall}%`, progress: base + frac / chosen.length });
        });
        album.push(media);
      }
      const r = await publishDiaryEntry({
        kind: "media", media: album[0], album, caption: text.trim() || undefined, format: "md", align, visibility,
      });
      setText("");
      toastUpdate(id, {
        text: r.queued ? "Saved — it'll post when you're back online"
          : chosen.length > 1 ? `${chosen.length} photos added to today's page` : "Photo added to today's page",
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

  const narrow = isNarrow();
  const aligns: DiaryAlign[] = narrow ? ["left", "center"] : ["left", "center", "justify"];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={onClose}
          style={{
            position: "fixed", inset: 0, zIndex: 950,
            background: "rgba(6,8,20,0.6)",
            display: "flex", alignItems: "flex-end", justifyContent: "center",
          }}
        >
          <motion.div
            initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(640px, 100%)", borderRadius: "20px 20px 0 0",
              background: "var(--sheet-bg)", border: "1px solid var(--line-strong)",
              padding: 18, paddingBottom: "calc(18px + var(--safe-bottom))",
              maxHeight: "calc(var(--app-h) - 24px)", display: "flex", flexDirection: "column",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 650 }}>Today's page</div>
                <div className="small">
                  {visibility === "private" ? "Only you will see this"
                    : audience === null ? "…"
                    : audience === 0 ? "No contacts yet — only you will see this"
                    : `${audience} ${audience === 1 ? "contact" : "contacts"} can read it for 24 hours`}
                </div>
              </div>
              <Button variant="icon" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close composer">
                <Icon.x />
              </Button>
            </div>

            {/* Who can see it. */}
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              {([["contacts", "Share with contacts"], ["private", "Only me"]] as const).map(([v, label]) => (
                <button key={v} type="button" onClick={() => setVisibility(v)}
                  aria-pressed={visibility === v}
                  style={{
                    all: "unset", cursor: "pointer", flex: 1, textAlign: "center",
                    minHeight: 40, lineHeight: "40px", borderRadius: 12, fontSize: 13,
                    border: `1px solid ${visibility === v ? "var(--accent)" : "var(--line)"}`,
                    background: visibility === v ? "rgba(138,125,255,0.18)" : "transparent",
                    color: visibility === v ? "var(--text)" : "var(--text-dim)",
                  }}>
                  {label}
                </button>
              ))}
            </div>

            {/* Formatting toolbar — labelled, 44px targets. */}
            <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", paddingBottom: 8 }}>
              <Fmt cmd="h2" label="Heading"><span style={{ fontWeight: 700 }}>H</span></Fmt>
              <Fmt cmd="bold" label="Bold"><span style={{ fontWeight: 800 }}>B</span></Fmt>
              <Fmt cmd="italic" label="Italic"><span style={{ fontStyle: "italic", fontFamily: "Georgia, serif" }}>I</span></Fmt>
              <Fmt cmd="quote" label="Quote"><span style={{ fontSize: 16 }}>&rdquo;</span></Fmt>
              <Fmt cmd="bullet" label="Bulleted list"><span style={{ fontSize: 15 }}>&bull;</span></Fmt>
              <span style={{ width: 1, height: 20, background: "var(--line)", margin: "0 4px" }} />
              {aligns.map((a) => (
                <button key={a} type="button" aria-label={`Align ${a}`} aria-pressed={align === a}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => setAlign(a)}
                  style={{
                    all: "unset", cursor: "pointer", minWidth: 40, minHeight: 40,
                    display: "grid", placeItems: "center", borderRadius: 10,
                    color: align === a ? "var(--text)" : "var(--text-mute)",
                    background: align === a ? "rgba(138,125,255,0.18)" : "transparent",
                    border: `1px solid ${align === a ? "var(--accent)" : "var(--line)"}`,
                  }}>
                  <AlignGlyph which={a} />
                </button>
              ))}
            </div>

            <RichEditor
              value={text} onChange={setText} autoFocus
              placeholder="What happened today?"
              style={{ textAlign: align, flex: "0 1 auto", maxHeight: "40vh" }}
            />

            <div className="small" style={{ marginTop: 8, lineHeight: 1.5, color: "var(--text-dim)" }}>
              {visibility === "private"
                ? "Kept in your diary forever. Nobody else can see it."
                : "You keep this forever. After 24 hours your contacts can't open it again — though anyone who already read it may have kept a copy."}
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
              <input ref={fileRef} type="file" accept="image/*" multiple hidden
                onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; if (fs.length) void attach(fs); }} />
              <Button onClick={() => fileRef.current?.click()} disabled={busy} aria-label="Add photos">
                <Icon.photo /> Photos
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

function Fmt({ cmd, label, children }: { cmd: RichCommand; label: string; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label}
      // preventDefault keeps the editor selection alive across the click
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => applyRich(cmd)}
      style={{
        all: "unset", cursor: "pointer", minWidth: 40, minHeight: 40,
        display: "grid", placeItems: "center", borderRadius: 10,
        color: "var(--text-dim)", border: "1px solid var(--line)",
        background: "rgba(255,255,255,0.03)",
      }}>
      {children}
    </button>
  );
}

function AlignGlyph({ which }: { which: DiaryAlign }) {
  const w = which === "center" ? ["60%", "90%", "70%"]
    : which === "justify" ? ["100%", "100%", "100%"]
    : ["90%", "60%", "80%"];
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 2, width: 14 }}>
      {w.map((width, i) => (
        <span key={i} style={{
          height: 1.5, width, background: "currentColor", borderRadius: 1,
          alignSelf: which === "center" ? "center" : "flex-start",
        }} />
      ))}
    </span>
  );
}
