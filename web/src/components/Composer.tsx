// The message composer. Text (with autosize), reply-to preview,
// attach-file, and voice-note record-and-send. Every send path goes
// through the same session helper so persistence and fan-out stay in
// one place.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Button, Icon, toast, toastDismiss, toastUpdate } from "./ui.js";
import { EmojiPicker } from "./EmojiPicker.js";
import { pickFile, uploadMedia } from "../lib/media.js";
import { sendMedia, sendText } from "../lib/session.js";
import { emitTyping } from "../lib/socket.js";

export type ReplyTarget = { id: string; preview: string; author: string };

export function Composer({
  peerId, isGroup, replyTo, onClearReply, editing, onCancelEdit, onEditCommit, onSent,
  onInvokeAgent,
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
  // Invoked when the user types `/agent <query>` and hits send. The
  // host (Chat → Home) opens the agent sheet with the query already
  // populated and the active chat in context. Keeps users in the
  // chat flow instead of making them hunt for the Æ icon.
  onInvokeAgent?: (query: string) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState<{ start: number; stop: () => Promise<Blob> } | null>(null);
  const [recordElapsed, setRecordElapsed] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);

  // Insert an emoji at the caret (or append) and keep focus so typing
  // continues naturally after picking.
  function insertEmoji(emoji: string) {
    const el = textRef.current;
    if (!el) { setText((t) => t + emoji); return; }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    setText((t) => t.slice(0, start) + emoji + t.slice(end));
    queueMicrotask(() => {
      el.focus();
      const pos = start + emoji.length;
      try { el.setSelectionRange(pos, pos); } catch { /* ignore */ }
    });
  }

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
    // /agent <query> — intercept and route to the agent sheet with
    // the active chat in context. Nothing is sent to the peer.
    // Variants accepted: `/agent …`, `/ai …`, `/ask …`.
    const agentMatch = /^\/(?:agent|ai|ask)\s+(.+)$/i.exec(body);
    if (agentMatch && onInvokeAgent) {
      onInvokeAgent(agentMatch[1].trim());
      setText("");
      return;
    }
    if (editing) {
      setSending(true);
      try { await onEditCommit(body); onSent(); setText(""); }
      catch (e) { toast(`Edit failed: ${(e as Error).message}`, "error"); }
      finally { setSending(false); }
      return;
    }

    // Optimistic send: clear the input and reply NOW so the composer
    // feels instant even on a weak connection. sendText saves the
    // message to the local store first (so it renders immediately) and
    // the network fan-out happens in the background — on a slow link
    // the user can keep typing instead of watching a spinner.
    const reply = replyTo ?? undefined;
    setText("");
    onClearReply();
    sendText(peerId, isGroup, body, reply)
      .then((res) => {
        if (!res.ok) toast(`Send failed: ${res.error}`, "error");
        else if (res.queued) toast("Offline — queued, will send when you reconnect", "info");
        onSent();
      })
      .catch((e) => toast(`Send failed: ${(e as Error).message}`, "error"));
    // Reflect the new message right away.
    onSent();
  }

  // Server cap - 1 MB safety margin (server rejects > 20 MB with 413).
  const MAX_ATTACH_MB = 19;

  async function attach(file: File) {
    if (file.size > MAX_ATTACH_MB * 1024 * 1024) {
      toast(
        `${file.name} is ${formatMB(file.size)} — max ${MAX_ATTACH_MB} MB. Try a smaller file or a link.`,
        "warn",
      );
      return;
    }
    setSending(true);
    // Show one sticky toast that updates in place through the three
    // phases: encrypt → upload (with real progress %) → done. No
    // more three separate toasts spamming the corner.
    const label = displayName(file);
    const toastId = toast(`Encrypting ${label}…`, "info", { sticky: true });
    try {
      const picked = await pickFile(file);
      toastUpdate(toastId, { text: `Uploading ${label} · 0%`, progress: 0 });
      const ref = await uploadMedia(picked, (frac) => {
        const pct = Math.round(frac * 100);
        toastUpdate(toastId, { text: `Uploading ${label} · ${pct}%`, progress: frac });
      });
      toastUpdate(toastId, { text: `Sending ${label}…`, progress: 1 });
      const res = await sendMedia(peerId, isGroup, ref, text.trim() || undefined, replyTo ?? undefined);
      if (!res.ok) {
        toastUpdate(toastId, { text: `Send failed: ${res.error}`, kind: "error", sticky: false, progress: undefined });
      } else {
        setText(""); onClearReply(); onSent();
        toastUpdate(toastId, { text: `${label} sent`, kind: "ok", sticky: false, progress: undefined });
      }
    } catch (e) {
      toastUpdate(toastId, {
        text: `Attach failed: ${(e as Error).message || "unknown error"}`,
        kind: "error", sticky: false, progress: undefined,
      });
    }
    finally { setSending(false); }
    // Belt-and-braces: if we somehow left the sticky toast up, drop it.
    setTimeout(() => toastDismiss(toastId), 6000);
  }

  function displayName(file: File): string {
    const raw = file.name || "file";
    const short = raw.length > 30 ? raw.slice(0, 27) + "…" : raw;
    return short;
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
      // Voice notes now send INSTANTLY — no transcription on the send
      // path at all. Testers found the automatic on-send transcription
      // added a long, surprising wait. Transcription is on-demand only:
      // either side taps "Transcribe" on the voice note bubble when
      // they actually want it (MediaView handles that, with the model
      // cached after the first use).
      const ref = await uploadMedia({
        bytes, mime: blob.type, kind: "voice", durationMs, filename: "voice.webm",
      });
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
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8, position: "relative" }}>
          {/* Three dedicated inputs so the OS picker opens filtered. */}
          <input ref={imageRef} type="file" accept="image/*" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { attach(f); e.target.value = ""; } }} />
          <input ref={audioRef} type="file" accept="audio/*" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { attach(f); e.target.value = ""; } }} />
          <input ref={fileRef} type="file" accept="*/*" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { attach(f); e.target.value = ""; } }} />

          <AnimatePresence>
            {attachOpen && (
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={{ duration: 0.16 }}
                className="glass"
                style={{
                  position: "absolute", bottom: "100%", left: 0, marginBottom: 10,
                  padding: 6, borderRadius: 14, display: "flex", gap: 4, zIndex: 20,
                }}
                onMouseLeave={() => setAttachOpen(false)}
              >
                <AttachOption label="Photo" title="Send a photo or image"
                  onClick={() => { setAttachOpen(false); imageRef.current?.click(); }}>
                  <Icon.photo />
                </AttachOption>
                <AttachOption label="Audio" title="Send an audio file"
                  onClick={() => { setAttachOpen(false); audioRef.current?.click(); }}>
                  <Icon.play />
                </AttachOption>
                <AttachOption label="File" title="Send any file"
                  onClick={() => { setAttachOpen(false); fileRef.current?.click(); }}>
                  <Icon.paperclip />
                </AttachOption>
              </motion.div>
            )}
          </AnimatePresence>
          <Button variant="icon" onClick={() => setAttachOpen((v) => !v)}
            title="Attach image, audio, or file" aria-label="Attach"><Icon.plus /></Button>

          <AnimatePresence>
            {emojiOpen && (
              <div style={{ position: "absolute", bottom: "100%", left: 40, marginBottom: 10, zIndex: 30 }}
                onMouseLeave={() => setEmojiOpen(false)}>
                <EmojiPicker
                  onPick={insertEmoji}
                  onClose={() => setEmojiOpen(false)}
                />
              </div>
            )}
          </AnimatePresence>
          <Button variant="icon" onClick={() => setEmojiOpen((v) => !v)}
            title="Emoji" aria-label="Emoji"><Icon.smile /></Button>

          <textarea
            ref={textRef}
            rows={1}
            value={text}
            onChange={(e) => { setText(e.target.value); emitTyping(isGroup ? { groupId: peerId } : { recipientId: peerId }); }}
            onKeyDown={(e) => {
              // Desktop: Enter sends, Shift+Enter is a newline.
              // Touch devices have no Shift key, so Enter must insert a
              // newline there — sending is done with the Send button.
              // This is what lets people type paragraphs on mobile.
              if (e.key === "Enter" && !e.shiftKey && !isTouchDevice()) {
                e.preventDefault();
                submitText();
              }
            }}
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


function AttachOption({
  children, label, title, onClick,
}: { children: React.ReactNode; label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button" onClick={onClick} title={title} aria-label={label}
      style={{
        all: "unset", cursor: "pointer",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
        padding: "8px 10px", minWidth: 56, minHeight: 56, borderRadius: 10,
        color: "var(--text)",
      }}
    >
      {children}
      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{label}</span>
    </button>
  );
}

// Touch heuristic for the Enter-key behaviour. Coarse pointer (no
// hover) is a reliable "this is a phone/tablet" signal; we also treat
// the presence of touch points as touch. Desktop with a touchscreen
// still reports a fine pointer, so Enter-to-send stays there.
function isTouchDevice(): boolean {
  try {
    if (window.matchMedia?.("(pointer: coarse)").matches) return true;
    return navigator.maxTouchPoints > 0 && !window.matchMedia?.("(pointer: fine)").matches;
  } catch { return false; }
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
