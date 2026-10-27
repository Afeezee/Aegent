// Renders an encrypted-media reference: fetches the ciphertext blob
// on mount, decrypts locally, and hands the resulting object URL to
// the right element (img / video / audio / file card / voice player).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { objectUrlFor } from "../lib/media.js";
import type { MediaRef } from "../lib/store.js";
import { updateMessageMedia } from "../lib/store.js";
import { api } from "../lib/api.js";
import { b64, secretBoxOpenBytes } from "../lib/crypto.js";
import { Icon, toast, toastDismiss, toastUpdate } from "./ui.js";
import { grantTranslationConsent, translateText, translationConsentGranted } from "../lib/translate.js";
import { clearTranslation, getTranslation, saveTranslation } from "../lib/store.js";
import { sendTranscriptEdit } from "../lib/session.js";

// NOTE: prop is deliberately named `media`, NOT `ref` — React
// intercepts a prop literally named `ref` as a forwarded-ref and
// never delivers it to the component, so any read from it would
// throw "Cannot read properties of undefined (reading 'blobId')".
export function MediaView({
  media, caption, isMine, messageId,
}: { media: MediaRef; caption?: string; isMine?: boolean; messageId?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    objectUrlFor(media).then((u) => { if (alive) setUrl(u); }).catch((e) => setErr(String(e)));
    return () => { alive = false; };
  }, [media.blobId]);

  if (err) return <div style={{ padding: 8, color: "var(--danger)", fontSize: 12 }}>media failed: {err}</div>;
  if (!url) return <MediaSkeleton kind={media.kind} />;

  if (media.kind === "image") {
    return <ImageWithLightbox url={url} alt={caption ?? ""} />;
  }
  if (media.kind === "video") {
    return <video src={url} controls style={{ maxWidth: "100%", borderRadius: 12 }} />;
  }
  if (media.kind === "voice") return (
    <VoiceCell url={url} media={media} isMine={isMine} messageId={messageId} />
  );
  if (media.kind === "audio") return <audio src={url} controls style={{ width: "100%" }} />;
  return <FileCard url={url} filename={media.filename ?? "file"} size={media.byteSize} />;
}

// Tap/click to open the fullscreen lightbox. Lightbox supports:
//   - pinch-zoom + two-finger pan on mobile (native browser gestures
//     via touch-action: none on the overlay)
//   - double-tap / double-click to toggle 1x ↔ 2.5x
//   - mouse wheel to zoom on desktop
//   - Escape or outside-tap to close
// All state is local — no portals, no modal library.
function ImageWithLightbox({ url, alt }: { url: string; alt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button" onClick={() => setOpen(true)}
        aria-label="Open image"
        style={{
          all: "unset", cursor: "zoom-in", display: "block", borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <img src={url} alt={alt} style={{
          maxWidth: "100%", maxHeight: 360, display: "block",
        }} />
      </button>
      {open && <Lightbox url={url} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}

export function Lightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const pinch = useRef<{ dist: number; scale: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function toggle() {
    if (scale === 1) { setScale(2.5); }
    else { setScale(1); setTx(0); setTy(0); }
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const next = Math.min(5, Math.max(1, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    setScale(next);
    if (next === 1) { setTx(0); setTy(0); }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (scale <= 1) return;
    drag.current = { x: e.clientX, y: e.clientY, tx, ty };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    setTx(drag.current.tx + (e.clientX - drag.current.x));
    setTy(drag.current.ty + (e.clientY - drag.current.y));
  }
  function onPointerUp() { drag.current = null; }

  function onTouchStart(e: React.TouchEvent) {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      pinch.current = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), scale };
    }
  }
  function onTouchMove(e: React.TouchEvent) {
    if (e.touches.length === 2 && pinch.current) {
      e.preventDefault();
      const [a, b] = [e.touches[0], e.touches[1]];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const next = Math.min(5, Math.max(1, pinch.current.scale * (d / pinch.current.dist)));
      setScale(next);
      if (next === 1) { setTx(0); setTy(0); }
    }
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (e.touches.length < 2) pinch.current = null;
  }

  // Portal to body: the message bubble is wrapped in framer-motion
  // divs that apply transforms, and any ancestor with a transform
  // turns position:fixed into position:fixed-relative-to-that-ancestor
  // (containing-block rule). Without the portal the lightbox stays
  // inside its tiny bubble and the user sees nothing happen.
  return createPortal((
    <div
      role="dialog" aria-modal="true" aria-label={alt || "Image"}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1200,
        background: "rgba(0,0,0,0.92)",
        display: "grid", placeItems: "center",
        padding: "calc(16px + var(--safe-top)) 16px calc(16px + var(--safe-bottom))",
        touchAction: "none", userSelect: "none",
      }}
    >
      <button
        type="button" onClick={onClose} aria-label="Close image"
        style={{
          position: "fixed", top: "calc(14px + var(--safe-top))", right: 14, zIndex: 2,
          width: 44, height: 44, minWidth: 44, minHeight: 44, borderRadius: 999,
          background: "rgba(255,255,255,0.14)", color: "#fff",
          border: "1px solid rgba(255,255,255,0.22)",
          display: "grid", placeItems: "center", cursor: "pointer",
        }}
      >
        <Icon.x />
      </button>
      <img
        src={url} alt={alt}
        onDoubleClick={toggle}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          maxWidth: "100%", maxHeight: "100%",
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transformOrigin: "center center",
          transition: drag.current || pinch.current ? "none" : "transform 0.2s ease-out",
          cursor: scale > 1 ? "grab" : "zoom-in",
          willChange: "transform",
        }}
      />
    </div>
  ), document.body);
}

function MediaSkeleton({ kind }: { kind: MediaRef["kind"] }) {
  const h = kind === "image" || kind === "video" ? 180 : 44;
  return (
    <div style={{
      width: "100%", height: h, borderRadius: 12,
      background: "linear-gradient(90deg, rgba(255,255,255,0.05), rgba(255,255,255,0.14), rgba(255,255,255,0.05))",
      backgroundSize: "200% 100%",
      animation: "shine 1.2s linear infinite",
    }}>
      <style>{`@keyframes shine { 0% { background-position: 0% 0; } 100% { background-position: -200% 0; } }`}</style>
    </div>
  );
}

function FileCard({ url, filename, size }: { url: string; filename: string; size: number }) {
  return (
    <a href={url} download={filename}
      style={{
        display: "flex", gap: 10, alignItems: "center",
        padding: "10px 12px", borderRadius: 12,
        background: "rgba(255,255,255,0.05)", border: "1px solid var(--line)",
        textDecoration: "none", color: "inherit",
      }}>
      <div style={{
        width: 36, height: 36, borderRadius: 10, display: "grid", placeItems: "center",
        background: "var(--glass-bg-hi)",
      }}><Icon.paperclip /></div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{filename}</div>
        <div className="small">{formatSize(size)}</div>
      </div>
    </a>
  );
}

// Voice-note cell: waveform player + on-demand Transcribe button +
// persisted transcript text. Transcription is opt-in per-tap so
// nothing downloads the ~40 MB Whisper model unless the user actually
// asks for it.
function VoiceCell({
  url, media, isMine, messageId,
}: { url: string; media: MediaRef; isMine?: boolean; messageId?: string }) {
  const [transcript, setTranscript] = useState<string | undefined>(media.transcript);
  const [busy, setBusy] = useState(false);

  async function runTranscribe() {
    if (!messageId) return;
    setBusy(true);
    // Sticky toast updated in place — avoids spawning a new line on
    // every progress tick as the model downloads its sub-files.
    const tId = toast("Preparing on-device transcription…", "info", { sticky: true });
    try {
      // Pull the raw ciphertext bytes; decrypt locally with the ref's
      // content key (never leaves the app). Then hand the plaintext
      // audio to the on-device Whisper pipeline.
      const enc = await api.downloadBlob(media.blobId);
      const pt = secretBoxOpenBytes(b64.decode(media.contentKey), enc);
      let transcribeAudio: typeof import("../lib/transcribe.js").transcribeAudio;
      try {
        ({ transcribeAudio } = await import("../lib/transcribe.js"));
      } catch (impErr) {
        const m = (impErr as Error)?.message ?? String(impErr);
        if (/Failed to fetch dynamically imported module|ChunkLoadError/i.test(m)) {
          if (confirm("Aegent was updated on the server. Reload now to pick up the new version?")) {
            location.reload();
          }
          throw new Error("Transcription unavailable — app needs reload");
        }
        throw impErr;
      }
      // Monotonic progress: the model downloads several files, each
      // reporting its own 0→100%, so the raw number bounces around.
      // We clamp to the max seen so the bar only ever moves forward,
      // and switch the label to "Transcribing audio…" once the model
      // is ready (download done) so the final inference step doesn't
      // look stalled at 100%.
      let maxPct = 0;
      let modelReady = false;
      const { text } = await transcribeAudio(pt, {
        onProgress: (p) => {
          if (p.status === "ready" || p.status === "done") {
            modelReady = true;
            toastUpdate(tId, { text: "Transcribing audio…", progress: 1 });
            return;
          }
          if (p.status === "progress" && typeof p.progress === "number" && p.progress > 0) {
            const pct = Math.min(100, Math.round(p.progress));
            if (pct <= maxPct) return;  // never go backwards
            maxPct = pct;
            toastUpdate(tId, {
              text: modelReady ? "Transcribing audio…" : `Loading model · ${pct}%`,
              progress: pct / 100,
            });
          }
        },
      });
      if (!text) {
        toastUpdate(tId, { text: "Couldn't hear anything to transcribe", kind: "warn", sticky: false, progress: undefined });
        return;
      }
      const opened = await updateMessageMedia(messageId, { transcript: text });
      setTranscript(opened?.media?.transcript ?? text);
      toastUpdate(tId, { text: "Transcribed on-device", kind: "ok", sticky: false, progress: undefined });
      setTimeout(() => toastDismiss(tId), 2000);
    } catch (e) {
      toastUpdate(tId, { text: `Transcribe failed: ${(e as Error).message}`, kind: "error", sticky: false, progress: undefined });
    } finally { setBusy(false); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <VoicePlayer url={url} durationMs={media.durationMs} isMine={isMine} />
      {transcript
        ? (
          <TranscriptWithTranslate text={transcript} isMine={isMine} messageId={messageId} />
        ) : messageId ? (
          <button onClick={runTranscribe} disabled={busy}
            style={{
              alignSelf: "flex-start",
              margin: "2px 6px 4px",
              padding: "3px 10px", fontSize: 11, borderRadius: 999,
              background: isMine ? "rgba(16,19,42,0.16)" : "rgba(255,255,255,0.06)",
              color: isMine ? "rgba(16,19,42,0.9)" : "var(--text-dim)",
              border: "1px solid " + (isMine ? "rgba(16,19,42,0.2)" : "var(--line-strong)"),
              cursor: busy ? "wait" : "pointer",
              display: "inline-flex", alignItems: "center", gap: 5,
            }}
            title="Transcribe on device — audio never leaves your phone"
          >
            <Icon.transcribe /> {busy ? "Transcribing…" : "Transcribe"}
          </button>
        ) : null}
    </div>
  );
}

function VoicePlayer({ url, durationMs, isMine }: { url: string; durationMs?: number; isMine?: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setProgress(a.currentTime / (a.duration || 1));
    const onEnd = () => { setPlaying(false); setProgress(0); };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("ended", onEnd);
    return () => { a.removeEventListener("timeupdate", onTime); a.removeEventListener("ended", onEnd); };
  }, []);

  const toggle = () => {
    const a = audioRef.current; if (!a) return;
    if (a.paused) { a.play(); setPlaying(true); } else { a.pause(); setPlaying(false); }
  };

  const bars = 22;
  const arr = new Array(bars).fill(0).map((_, i) => 0.35 + 0.65 * Math.abs(Math.sin(i * 1.7 + i)));

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 6, minWidth: 200 }}>
      <audio ref={audioRef} src={url} preload="metadata" />
      <button onClick={toggle} style={{
        width: 34, height: 34, borderRadius: "50%",
        background: isMine ? "rgba(255,255,255,0.35)" : "var(--accent)",
        color: isMine ? "#10132a" : "#0f1226",
        border: "none", cursor: "pointer", display: "grid", placeItems: "center",
      }} aria-label={playing ? "Pause" : "Play"}>
        {playing ? <Icon.pause /> : <Icon.play />}
      </button>
      <div style={{ display: "flex", gap: 2, alignItems: "center", flex: 1, height: 24 }}>
        {arr.map((h, i) => (
          <span key={i} style={{
            display: "inline-block", width: 3, borderRadius: 999,
            height: `${h * 100}%`,
            background: i / bars < progress ? (isMine ? "rgba(16,19,42,0.9)" : "var(--accent)") : (isMine ? "rgba(16,19,42,0.35)" : "var(--line-strong)"),
          }} />
        ))}
      </div>
      <span style={{ fontSize: 11, opacity: 0.7 }}>
        {formatDuration(durationMs)}
      </span>
    </div>
  );
}

function formatDuration(ms?: number): string {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// A swipeable, zoomable viewer for a set of images. Reuses the single
// Lightbox for the heavy lifting (pinch, pan, double-tap zoom) and adds
// index navigation on top — arrows on desktop, a horizontal swipe on
// touch. Keyed by index so each image opens at 1x.
export function AlbumLightbox({
  images, index, onClose,
}: { images: MediaRef[]; index: number; onClose: () => void }) {
  const [i, setI] = useState(index);
  const [url, setUrl] = useState<string | null>(null);
  const touch = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    setUrl(null);
    objectUrlFor(images[i]).then((u) => { if (live) setUrl(u); }).catch(() => { /* blank */ });
    return () => { live = false; };
  }, [i, images]);

  const go = (d: number) => setI((n) => Math.max(0, Math.min(images.length - 1, n + d)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [images.length]);

  if (!url) return null;
  return (
    <div
      onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        if (touch.current === null) return;
        const dx = e.changedTouches[0].clientX - touch.current;
        if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
        touch.current = null;
      }}
    >
      <Lightbox key={i} url={url} alt={`Image ${i + 1} of ${images.length}`} onClose={onClose} />
      {images.length > 1 && (
        <div style={{
          position: "fixed", bottom: "calc(24px + var(--safe-bottom))", left: 0, right: 0,
          zIndex: 1100, display: "flex", gap: 14, justifyContent: "center", alignItems: "center",
          pointerEvents: "none",
        }}>
          <NavBtn dir="prev" disabled={i === 0} onClick={() => go(-1)} />
          <span style={{
            fontSize: 13, color: "#fff", background: "rgba(0,0,0,0.5)",
            padding: "4px 10px", borderRadius: 999, pointerEvents: "none",
          }}>{i + 1} / {images.length}</span>
          <NavBtn dir="next" disabled={i === images.length - 1} onClick={() => go(1)} />
        </div>
      )}
    </div>
  );
}

function NavBtn({ dir, disabled, onClick }: { dir: "prev" | "next"; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      aria-label={dir === "prev" ? "Previous image" : "Next image"}
      style={{
        all: "unset", cursor: disabled ? "default" : "pointer", pointerEvents: "auto",
        width: 44, height: 44, borderRadius: 999, display: "grid", placeItems: "center",
        background: "rgba(0,0,0,0.5)", color: "#fff", opacity: disabled ? 0.35 : 1,
        fontSize: 22,
      }}>
      {dir === "prev" ? "‹" : "›"}
    </button>
  );
}


function TranscriptWithTranslate({ text, isMine, messageId }: { text: string; isMine?: boolean; messageId?: string }) {
  // The transcript shown here. The author may correct it (Whisper often
  // mishears unclear audio); the fix propagates to the recipient so they
  // read what was actually said. Local state so the display updates
  // instantly, and re-syncs if `text` changes (e.g. a remote correction).
  const [transcript, setTranscript] = useState(text);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [savingT, setSavingT] = useState(false);
  useEffect(() => { setTranscript(text); setDraft(text); }, [text]);

  const [translated, setTranslated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The viewer can fix a garbled machine translation for their own
  // reading; it's stored locally (translation never leaves this device
  // except the one trip to the service), so editing it is purely local.
  const [editingTr, setEditingTr] = useState(false);
  const [trDraft, setTrDraft] = useState("");

  // Rehydrate cached translation on mount — same persistence rail as
  // MessageBubble's text translation.
  useEffect(() => {
    if (!messageId) return;
    let alive = true;
    getTranslation(messageId).then((row) => {
      if (alive && row) setTranslated(row.text);
    });
    return () => { alive = false; };
  }, [messageId]);

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", resize: "vertical",
    fontSize: 12.5, lineHeight: 1.4, padding: "6px 8px", borderRadius: 8,
    background: "rgba(255,255,255,0.08)", color: "var(--text)",
    border: "1px solid var(--line-strong)",
  };
  const linkBtn = (onClick: () => void, label: string, extra?: React.CSSProperties) => (
    <button type="button" onClick={onClick}
      style={{ all: "unset", cursor: "pointer", fontSize: 11, color: "var(--accent-strong)", ...extra }}>
      {label}
    </button>
  );

  async function saveTranscript() {
    const next = draft.trim();
    if (!next || next === transcript) { setEditing(false); return; }
    setSavingT(true);
    try {
      if (messageId) await sendTranscriptEdit(messageId, next);
      setTranscript(next);
      setEditing(false);
      // A correction invalidates any cached translation of the old text.
      if (translated && messageId) { setTranslated(null); await clearTranslation(messageId); }
    } catch (e) {
      toast(`Couldn't save the correction: ${(e as Error).message}`, "error");
    } finally { setSavingT(false); }
  }

  async function doIt() {
    if (!translationConsentGranted()) {
      const ok = window.confirm(
        "Translation uses Google Translate. The transcript will be sent to Google — your end-to-end encryption does not cover that trip. Continue?",
      );
      if (!ok) return;
      grantTranslationConsent();
    }
    setBusy(true);
    try {
      const out = await translateText(transcript);
      setTranslated(out);
      if (messageId) {
        await saveTranslation({
          messageId, sourceText: transcript, translatedText: out,
          targetLang: navigator.language?.split("-")[0] ?? "en",
        });
      }
    }
    catch (e) { setTranslated(`(couldn't translate: ${(e as Error).message})`); }
    finally { setBusy(false); }
  }
  async function hide() {
    setTranslated(null);
    if (messageId) await clearTranslation(messageId);
  }
  async function saveTr() {
    const next = trDraft.trim();
    setEditingTr(false);
    if (!next) return;
    setTranslated(next);
    if (messageId) {
      await saveTranslation({
        messageId, sourceText: transcript, translatedText: next,
        targetLang: navigator.language?.split("-")[0] ?? "en",
      });
    }
  }

  return (
    <div style={{ padding: "2px 8px 6px" }}>
      {editing ? (
        <div style={{ marginBottom: 4 }}>
          <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} style={inputStyle} />
          <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
            {linkBtn(() => void saveTranscript(), savingT ? "Saving…" : "Save correction")}
            {linkBtn(() => { setEditing(false); setDraft(transcript); }, "Cancel", { color: "var(--text-dim)" })}
          </div>
        </div>
      ) : (
        <div title="On-device transcript" style={{
          fontSize: 12, fontStyle: "italic", lineHeight: 1.4,
          color: isMine ? "rgba(16,19,42,0.75)" : "var(--text-dim)",
        }}>
          “{transcript}”
        </div>
      )}

      {!editing && (
        <div style={{ display: "flex", gap: 12, marginTop: 4, flexWrap: "wrap" }}>
          {linkBtn(translated ? () => void hide() : doIt, busy ? "Translating…" : translated ? "Hide translation" : "Translate")}
          {/* Only the author can correct the transcript everyone reads. */}
          {isMine && messageId && linkBtn(() => { setDraft(transcript); setEditing(true); }, "Edit transcript")}
        </div>
      )}

      {translated && !editingTr && (
        <div style={{
          marginTop: 4, padding: "6px 8px", borderRadius: 8,
          background: "rgba(255,255,255,0.08)", borderLeft: "2px solid var(--aqua)",
          fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.4,
        }}>
          {translated}
          <div style={{ marginTop: 4 }}>
            {linkBtn(() => { setTrDraft(translated); setEditingTr(true); }, "Fix translation", { fontSize: 10.5, opacity: 0.85 })}
          </div>
        </div>
      )}
      {editingTr && (
        <div style={{ marginTop: 4 }}>
          <textarea autoFocus value={trDraft} onChange={(e) => setTrDraft(e.target.value)} rows={2} style={inputStyle} />
          <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
            {linkBtn(() => void saveTr(), "Save")}
            {linkBtn(() => setEditingTr(false), "Cancel", { color: "var(--text-dim)" })}
          </div>
        </div>
      )}
    </div>
  );
}
