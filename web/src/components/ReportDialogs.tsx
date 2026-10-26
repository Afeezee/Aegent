// User-facing report / feedback dialogs.
//
// Three entry points on the client:
//   - Settings → "Give feedback"     →  <FeedbackDialog />
//   - Settings → "Report a problem"  →  <ErrorReportDialog />
//   - MessageBubble menu → "Report"  →  <AbuseReportDialog />
//
// All three write to POST endpoints added in Phase 2 (metadata-only).
// Nothing in this file reads or sends message plaintext.

import { useState } from "react";
import { apiUrl, loadToken } from "../lib/api.js";
import { Button, Modal, toast } from "./ui.js";

// Small wrapper so dialog bodies don't each need their own fetch
// scaffolding. Returns the HTTP status so callers can decide whether
// to toast "sent" or raise an error.
async function post(path: string, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const t = loadToken();
  if (t) headers.authorization = `Bearer ${t}`;
  return fetch(apiUrl(path), { method: "POST", headers, body: JSON.stringify(body) });
}

// ---- Feedback (NPS / feature / bug / general) ----

export function FeedbackDialog({
  open, onClose,
}: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<"nps" | "feature_request" | "bug" | "general">("general");
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!note.trim() && rating === null) {
      toast("Add a note or a rating first.", "warn");
      return;
    }
    setBusy(true);
    try {
      const r = await post("/api/feedback", {
        kind,
        rating: rating ?? undefined,
        note: note.trim() || undefined,
      });
      if (!r.ok) throw new Error(`${r.status}`);
      toast("Thank you — we read every one.", "ok");
      onClose();
      setNote(""); setRating(null); setKind("general");
    } catch (e) {
      toast(`Couldn't send: ${(e as Error).message}`, "error");
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Give feedback" width={480}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label className="small" style={{ color: "var(--text-dim)" }}>Type</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: 10, background: "var(--ink-2)", color: "var(--text)", border: "1px solid var(--line)" }}>
            <option value="general">General</option>
            <option value="feature_request">Feature request</option>
            <option value="bug">Bug</option>
            <option value="nps">Rate Aegent (1–5)</option>
          </select>
        </div>
        {kind === "nps" && (
          <div>
            <label className="small" style={{ color: "var(--text-dim)" }}>How are we doing?</label>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button"
                  onClick={() => setRating(n)}
                  aria-label={`Rate ${n} of 5`}
                  style={{
                    all: "unset", cursor: "pointer",
                    flex: 1, padding: "10px 0", minHeight: 44, borderRadius: 10,
                    textAlign: "center", fontSize: 16, fontWeight: 700,
                    background: rating === n ? "linear-gradient(135deg, var(--violet), var(--aqua))" : "transparent",
                    color: rating === n ? "#10132a" : "var(--text)",
                    border: rating === n ? "1px solid transparent" : "1px solid var(--line)",
                  }}>
                  {n}
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <label className="small" style={{ color: "var(--text-dim)" }}>What's on your mind?</label>
          <textarea rows={5} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Tell us what's working, what's not, what you wish Aegent did…"
            style={{ width: "100%", resize: "vertical" }} />
          <div className="small" style={{ color: "var(--text-mute)", marginTop: 4 }}>
            Only what you type here is sent. Message content isn't attached.
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---- Error report (user-driven "Report a problem") ----

export function ErrorReportDialog({
  open, onClose,
}: { open: boolean; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!note.trim()) { toast("Describe what went wrong first.", "warn"); return; }
    setBusy(true);
    try {
      const r = await post("/api/reports/error", {
        kind: "handled",
        message: note.trim(),
        appVersion: import.meta.env.VITE_APP_VERSION ?? "dev",
      });
      if (!r.ok) throw new Error(`${r.status}`);
      toast("Report filed. Thank you.", "ok");
      onClose(); setNote("");
    } catch (e) {
      toast(`Couldn't send: ${(e as Error).message}`, "error");
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Report a problem" width={480}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="small" style={{ color: "var(--text-dim)" }}>
          Tell us what you were doing and what went wrong. The browser
          version and your account id come along for debugging. No
          message content is attached.
        </div>
        <textarea rows={6} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. tried to send a voice note, got stuck on 'Encrypting…'"
          style={{ width: "100%", resize: "vertical" }} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---- Abuse report (long-press a message → Report user) ----

export function AbuseReportDialog({
  open, onClose, reportedUserId, reportedName, threadId,
}: {
  open: boolean;
  onClose: () => void;
  reportedUserId: string;
  reportedName: string;
  threadId?: string | null;
}) {
  const [reason, setReason] = useState<"harassment" | "spam" | "threats" | "impersonation" | "csam" | "other">("harassment");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const r = await post("/api/reports/abuse", {
        reportedUserId, threadId, reason,
        reporterNote: note.trim() || undefined,
      });
      if (!r.ok) throw new Error(`${r.status}`);
      toast("Report submitted. Our admins will review it.", "ok");
      onClose(); setNote(""); setReason("harassment");
    } catch (e) {
      toast(`Couldn't send: ${(e as Error).message}`, "error");
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Report ${reportedName}`} width={480}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label className="small" style={{ color: "var(--text-dim)" }}>Reason</label>
          <select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: 10, background: "var(--ink-2)", color: "var(--text)", border: "1px solid var(--line)" }}>
            <option value="harassment">Harassment</option>
            <option value="spam">Spam</option>
            <option value="threats">Threats</option>
            <option value="impersonation">Impersonation</option>
            <option value="csam">Child-safety concern</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <label className="small" style={{ color: "var(--text-dim)" }}>Note to admins (optional)</label>
          <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Anything specific our admins should know?"
            style={{ width: "100%", resize: "vertical" }} />
          <div className="small" style={{ color: "var(--text-mute)", marginTop: 4 }}>
            Only the words you type here are shared. Aegent's admins
            cannot read your messages — they are encrypted end-to-end.
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? "Sending…" : "Submit report"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
