// Renders an encrypted-media reference: fetches the ciphertext blob
// on mount, decrypts locally, and hands the resulting object URL to
// the right element (img / video / audio / file card / voice player).

import { useEffect, useRef, useState } from "react";
import { objectUrlFor } from "../lib/media.js";
import type { MediaRef } from "../lib/store.js";
import { updateMessageMedia } from "../lib/store.js";
import { api } from "../lib/api.js";
import { b64, secretBoxOpenBytes } from "../lib/crypto.js";
import { Icon, toast } from "./ui.js";

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
    return (
      <img src={url} alt={caption ?? ""} style={{
        maxWidth: "100%", maxHeight: 360, borderRadius: 12, display: "block",
      }} />
    );
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
    toast("Preparing on-device transcription…", "info");
    try {
      // Pull the raw ciphertext bytes; decrypt locally with the ref's
      // content key (never leaves the app). Then hand the plaintext
      // audio to the on-device Whisper pipeline.
      const enc = await api.downloadBlob(media.blobId);
      const pt = secretBoxOpenBytes(b64.decode(media.contentKey), enc);
      const { transcribeAudio } = await import("../lib/transcribe.js");
      const { text } = await transcribeAudio(pt, {
        onProgress: (p) => {
          if (p.status === "progress" && typeof p.progress === "number") {
            // First-time download can take a while — show a coarse hint.
            if (p.progress < 1) toast(`Loading model… ${Math.round(p.progress * 100)}%`, "info");
          }
        },
      });
      if (!text) { toast("Couldn't hear anything to transcribe", "warn"); return; }
      const opened = await updateMessageMedia(messageId, { transcript: text });
      setTranscript(opened?.media?.transcript ?? text);
      toast("Transcribed on-device", "ok");
    } catch (e) {
      toast(`Transcribe failed: ${(e as Error).message}`, "error");
    } finally { setBusy(false); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <VoicePlayer url={url} durationMs={media.durationMs} isMine={isMine} />
      {transcript
        ? (
          <div style={{
            padding: "2px 8px 6px", fontSize: 12, fontStyle: "italic",
            color: isMine ? "rgba(16,19,42,0.75)" : "var(--text-dim)",
            lineHeight: 1.4,
          }} title="On-device transcript">
            “{transcript}”
          </div>
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
