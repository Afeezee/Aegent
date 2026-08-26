// The message composer. Text (with autosize), reply-to preview,
// attach-file, and voice-note record-and-send. Every send path goes
// through the same session helper so persistence and fan-out stay in
// one place.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Button, Icon, toast } from "./ui.js";
import { pickFile, uploadMedia } from "../lib/media.js";
import { sendMedia, sendText } from "../lib/session.js";
import { emitTyping } from "../lib/socket.js";

export type ReplyTarget = { id: string; preview: string; author: string };

export function Composer({
  peerId, isGroup, replyTo, onClearReply, editing, onCancelEdit, onEditCommit, onSent,
}: {
  peerId: string;
  isGroup: boolean;
  replyTo: ReplyTarget | null;
  onClearReply: () => void;
  editing: { id: string; body: string } | null;
  onCancelEdit: () => void;
  onEditCommit: (newBody: string) => Promise<void>;
  // Fires whenever a message / media / voice note has landed in the
  // local store, so the surrounding Chat can re-read and render it.
  // Without this, outbound sends only appeared after the next
  // inbound socket event bumped the shell's refreshKey.
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState<{ start: number; stop: () => Promise<Blob> } | null>(null);
  const [recordElapsed, setRecordElapsed] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) setText(editing.body);
    textRef.current?.focus();
  }, [editing?.id]);

  // Autosize
  useEffect(() => {
    const el = textRef.current; if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [text]);

  // Recording tick
  useEffect(() => {
    if (!recording) return;
    const t = window.setInterval(() => setRecordElapsed(Date.now() - recording.start), 100);
    return () => window.clearInterval(t);
  }, [recording]);

  async function submitText() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      if (editing) {
        await onEditCommit(body);
        onSent();
      } else {
        const res = await sendText(peerId, isGroup, body, replyTo ?? undefined);
        if (!res.ok) { toast(`Send failed: ${res.error}`, "error"); return; }
        onClearReply();
        onSent();
      }
      setText("");
    } catch (e) {
      toast(`Send failed: ${(e as Error).message}`, "error");
    } finally { setSending(false); }
  }

  // Server cap - 1 MB safety margin (server rejects > 20 MB with 413).
  const MAX_ATTACH_MB = 19;

  async function attach(file: File) {
    // Guard for the two crash modes: file too big for the server (413),
    // and file too big for the browser to hold in one Uint8Array without
    // OOMing the WebView.
    if (file.size > MAX_ATTACH_MB * 1024 * 1024) {
      toast(
        `${file.name} is ${formatMB(file.size)} — max ${MAX_ATTACH_MB} MB. Try a smaller file or a link.`,
        "warn",
      );
      return;
    }
    setSending(true);
    const label = file.name.length > 30 ? file.name.slice(0, 27) + "…" : file.name;
    toast(`Encrypting ${label}…`, "info");
    try {
      const picked = await pickFile(file);
      toast(`Uploading ${label}…`, "info");
      const ref = await uploadMedia(picked);
      const res = await sendMedia(peerId, isGroup, ref, text.trim() || undefined, replyTo ?? undefined);
      if (!res.ok) toast(`Send failed: ${res.error}`, "error");
      else { setText(""); onClearReply(); toast(`${label} sent`, "ok"); onSent(); }
    } catch (e) {
      // Common causes: OOM on very large files, network dropout mid-upload,
      // WebView blob API quirks on Android. Surface the actual reason.
      toast(`Attach failed: ${(e as Error).message || "unknown error"}`, "error");
    }
    finally { setSending(false); }
  }

  function formatMB(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function startVoice() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: pickAudioMime() });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const stopped: Promise<Blob> = new Promise((resolve) => {
        rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          resolve(new Blob(chunks, { type: rec.mimeType }));
        };
      });
      rec.start(100);
      setRecording({ start: Date.now(), stop: async () => { rec.stop(); return await stopped; } });
    } catch (e) { toast(`Mic blocked: ${(e as Error).message}`, "error"); }
  }

  async function stopAndSendVoice(cancel = false) {
    if (!recording) return;
    const blob = await recording.stop();
    const durationMs = Date.now() - recording.start;
    setRecording(null); setRecordElapsed(0);
    if (cancel) return;
    setSending(true);
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());

      // Best-effort on-device transcription — only runs if the user has
      // opted in via Settings (avoids the ~40 MB Whisper download on
      // first send for people who didn't ask for it). Never blocks the
      // send: on error we still upload the audio, just without the
      // transcript sidecar.
      let transcript: string | undefined;
      const wantsTranscript = localStorage.getItem("aegent.transcribeVoice") === "1";
      if (wantsTranscript) {
        toast("Transcribing…", "info");
        try {
          const { transcribeAudio } = await import("../lib/transcribe.js");
          const { text } = await transcribeAudio(bytes, {
            onProgress: (p) => {
              if (p.status === "progress" && typeof p.progress === "number") {
                if (Math.round(p.progress) % 25 === 0 && p.progress > 0) {
                  toast(`Loading transcription model… ${Math.round(p.progress)}%`, "info");
                }
              }
            },
          });
          if (text) transcript = text;
        } catch (e) {
          toast(`Transcription skipped: ${(e as Error).message}`, "warn");
        }
      }

      const ref = await uploadMedia({
        bytes, mime: blob.type, kind: "voice", durationMs, filename: "voice.webm",
      });
      if (transcript) (ref as { transcript?: string }).transcript = transcript;
      const res = await sendMedia(peerId, isGroup, ref, undefined, replyTo ?? undefined);
      if (!res.ok) toast(`Voice send failed: ${res.error}`, "error");
      else { onClearReply(); onSent(); }
    } catch (e) { toast(`Voice send failed: ${(e as Error).message}`, "error"); }
    finally { setSending(false); }
  }

  return (
    <div style={{ padding: "10px 14px 14px", borderTop: "1px solid var(--line)" }}>
      <AnimatePresence>
        {editing && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            className="glass" style={{
              padding: "6px 10px", marginBottom: 8, borderRadius: 10,
              display: "flex", alignItems: "center", gap: 10, borderLeft: "3px solid var(--amber)",
            }}>
            <Icon.edit />
            <div style={{ flex: 1, fontSize: 13, color: "var(--text-dim)" }}>Editing message</div>
            <Button size="small" variant="ghost" onClick={() => { onCancelEdit(); setText(""); }}>Cancel</Button>
          </motion.div>
        )}
        {replyTo && !editing && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            className="glass" style={{
              padding: "6px 10px", marginBottom: 8, borderRadius: 10,
              display: "flex", alignItems: "center", gap: 10, borderLeft: "3px solid var(--accent)",
            }}>
            <Icon.reply />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Replying to {replyTo.author}</div>
              <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{replyTo.preview}</div>
            </div>
            <Button size="small" variant="ghost" onClick={onClearReply} aria-label="Cancel reply"><Icon.x /></Button>
          </motion.div>
        )}
      </AnimatePresence>

      {recording ? (
        <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          className="glass glass-hi" style={{
            padding: 12, borderRadius: 14, display: "flex", alignItems: "center", gap: 10,
          }}>
          <motion.div animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.2, repeat: Infinity }}
            style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--danger)" }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>Recording</div>
            <div className="small">{fmt(recordElapsed)}</div>
          </div>
          <Button variant="ghost" onClick={() => stopAndSendVoice(true)}><Icon.x /> Cancel</Button>
          <Button variant="primary" onClick={() => stopAndSendVoice(false)}><Icon.send /> Send</Button>
        </motion.div>
      ) : (
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
          <input ref={fileRef} type="file" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { attach(f); e.target.value = ""; } }} />
          <Button variant="icon" onClick={() => fileRef.current?.click()} title="Attach"><Icon.paperclip /></Button>
          <textarea
            ref={textRef}
            rows={1}
            value={text}
            onChange={(e) => { setText(e.target.value); emitTyping(isGroup ? { groupId: peerId } : { recipientId: peerId }); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitText(); } }}
            placeholder={editing ? "Edit your message" : "Write a message"}
            style={{ flex: 1 }}
          />
          {text.trim() || editing
            ? <Button variant="primary" onClick={submitText} disabled={sending} aria-label="Send"><Icon.send /></Button>
            : <Button variant="icon" onClick={startVoice} title="Voice note"><Icon.mic /></Button>}
        </div>
      )}
    </div>
  );
}

function pickAudioMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return "audio/webm";
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
