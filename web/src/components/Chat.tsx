// The right-hand chat pane. Owns the currently open thread, the reply
// stack, the edit state, and typing indicators.

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Avatar, Button, FadeIn, Icon, toast } from "./ui.js";
import { Composer, type ReplyTarget } from "./Composer.js";
import { MessageBubble } from "./MessageBubble.js";
import type { OpenedMessage, Thread } from "../lib/store.js";
import {
  getContact, getGroup, markThreadRead, threadWith,
  type ContactRow, type GroupRow,
} from "../lib/store.js";
import { onTyping } from "../lib/socket.js";
import {
  currentSession, myId, reportRead, sendDelete, sendEdit, sendReaction,
} from "../lib/session.js";

export function Chat({
  thread, onOpenForward, onOpenGroupInfo, onBack, refreshKey,
}: {
  thread: Thread;
  onOpenForward: (msg: OpenedMessage) => void;
  onOpenGroupInfo?: () => void;
  onBack?: () => void;
  refreshKey: number;
}) {
  const [msgs, setMsgs] = useState<OpenedMessage[]>([]);
  const [peers, setPeers] = useState<Map<string, string>>(new Map());
  const [peerMeta, setPeerMeta] = useState<{ contact?: ContactRow; group?: GroupRow }>({});
  const [typing, setTyping] = useState<Set<string>>(new Set());
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const me = myId();

  // Load thread on peer change / on refresh.
  useEffect(() => {
    let alive = true;
    (async () => {
      const rows = await threadWith(thread.peerId, 800);
      if (!alive) return;
      setMsgs(rows);
      queueMicrotask(() => streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight }));
    })();
    (async () => {
      if (thread.isGroup) {
        const g = await getGroup(thread.peerId);
        setPeerMeta({ group: g });
        const map = new Map<string, string>();
        for (const uid of g?.memberIds ?? []) {
          if (uid === me) { map.set(uid, "You"); continue; }
          const c = await getContact(uid);
          map.set(uid, c?.displayName ?? "Unknown");
        }
        setPeers(map);
      } else {
        const c = await getContact(thread.peerId);
        setPeerMeta({ contact: c });
        setPeers(new Map([[thread.peerId, c?.displayName ?? "?"], [me, "You"]]));
      }
    })();
    return () => { alive = false; };
  }, [thread.peerId, refreshKey]);

  // Mark thread read + tell the server (respecting the receipts toggle).
  useEffect(() => {
    (async () => {
      const marked = await markThreadRead(thread.peerId);
      if (marked.length) reportRead(marked);
    })();
  }, [thread.peerId, refreshKey]);

  // Typing indicator (only relevant sender ids).
  useEffect(() => {
    return onTyping(({ from, groupId }) => {
      if (thread.isGroup ? groupId === thread.peerId : from === thread.peerId) {
        setTyping((s) => new Set(s).add(from));
        window.setTimeout(() => setTyping((s) => { const n = new Set(s); n.delete(from); return n; }), 2500);
      }
    });
  }, [thread.peerId, thread.isGroup]);

  const subtitle = useMemo(() => {
    if (typing.size > 0) {
      const names = Array.from(typing).map((u) => peers.get(u) ?? "someone");
      return `${names.join(", ")} typing…`;
    }
    if (thread.isGroup) {
      const count = peerMeta.group?.memberIds.length ?? 0;
      return `${count} member${count === 1 ? "" : "s"}`;
    }
    return peerMeta.contact?.handle ? `@${peerMeta.contact.handle}` : peerMeta.contact?.email ?? "";
  }, [typing, peers, peerMeta, thread.isGroup]);

  // Actions
  function startReply(m: OpenedMessage) {
    const author = peers.get(m.senderId) ?? "Someone";
    const preview = m.deletedAt ? "[deleted]" : (m.body ?? m.editedBody ?? m.caption ?? previewLabel(m));
    setReply({ id: m.id, preview: (preview ?? "").slice(0, 120), author });
  }
  async function react(m: OpenedMessage, emoji: string) {
    await sendReaction(thread.peerId, thread.isGroup, m.id, emoji);
    setMsgs(await threadWith(thread.peerId, 800));
  }
  async function copy(m: OpenedMessage) {
    const text = m.body ?? m.editedBody ?? m.caption ?? "";
    if (!text) return toast("Nothing to copy", "warn");
    try { await navigator.clipboard.writeText(text); toast("Copied", "ok"); }
    catch { toast("Copy failed", "error"); }
  }
  async function del(m: OpenedMessage) {
    if (!confirm("Delete this message for everyone?")) return;
    await sendDelete(thread.peerId, thread.isGroup, m.id);
    setMsgs(await threadWith(thread.peerId, 800));
  }
  function startEdit(m: OpenedMessage) {
    setEditing({ id: m.id, body: m.editedBody ?? m.body ?? "" });
  }
  async function commitEdit(newBody: string) {
    if (!editing) return;
    await sendEdit(thread.peerId, thread.isGroup, editing.id, newBody);
    setEditing(null);
    setMsgs(await threadWith(thread.peerId, 800));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="glass glass-flat" style={{
        display: "flex", alignItems: "center", gap: 12, padding: "12px 18px",
        borderBottom: "1px solid var(--line)",
      }}>
        {onBack && <Button variant="icon" onClick={onBack} aria-label="Back"><Icon.chevron /></Button>}
        <Avatar
          name={thread.title}
          group={thread.isGroup}
          online={peerMeta.contact?.online}
        />
        <div
          style={{ minWidth: 0, flex: 1, cursor: thread.isGroup && onOpenGroupInfo ? "pointer" : "default" }}
          onClick={() => thread.isGroup && onOpenGroupInfo?.()}
        >
          <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {thread.title}
          </div>
          <div className="small">{subtitle}</div>
        </div>
        <span className="tag ok">end-to-end</span>
      </div>

      <div ref={streamRef} style={{
        flex: 1, overflowY: "auto", padding: "20px 22px", display: "flex", flexDirection: "column", gap: 10,
      }}>
        {msgs.length === 0 ? (
          <EmptyChat title={thread.title} isGroup={thread.isGroup} />
        ) : (
          renderWithDayBreaks(msgs).map((entry, i) => {
            if (entry.kind === "day") return (
              <div key={`day-${entry.at}`} style={{ textAlign: "center", margin: "10px 0" }}>
                <span className="tag">{formatDay(entry.at)}</span>
              </div>
            );
            const m = entry.msg;
            const prev = msgs[i - 1];
            const isMine = m.senderId === me;
            const consecutive = prev && prev.senderId === m.senderId
              && Math.abs(m.createdAt - prev.createdAt) < 6 * 60_000;
            return (
              <MessageBubble
                key={m.id}
                msg={m}
                isMine={isMine}
                isGroup={thread.isGroup}
                senderName={peers.get(m.senderId) ?? "Someone"}
                peers={peers}
                showAvatar={!consecutive}
                onReact={(e) => react(m, e)}
                onReply={() => startReply(m)}
                onEdit={() => startEdit(m)}
                onDelete={() => del(m)}
                onForward={() => onOpenForward(m)}
                onCopy={() => copy(m)}
              />
            );
          })
        )}
        <AnimatePresence>
          {typing.size > 0 && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 12px", color: "var(--text-dim)", fontSize: 13 }}>
              <div style={{ display: "flex", gap: 3 }}>
                {[0, 1, 2].map((i) => (
                  <motion.span key={i}
                    animate={{ y: [0, -4, 0] }}
                    transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.12 }}
                    style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)" }} />
                ))}
              </div>
              <span>typing</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Composer
        peerId={thread.peerId}
        isGroup={thread.isGroup}
        replyTo={reply}
        onClearReply={() => setReply(null)}
        editing={editing}
        onCancelEdit={() => setEditing(null)}
        onEditCommit={commitEdit}
      />
    </div>
  );
}

function EmptyChat({ title, isGroup }: { title: string; isGroup: boolean }) {
  return (
    <FadeIn>
      <div style={{ padding: 40, textAlign: "center", color: "var(--text-dim)" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>{isGroup ? "👥" : "👋"}</div>
        <div style={{ fontSize: 16, marginBottom: 4, color: "var(--text)" }}>Start chatting with {title}</div>
        <div className="small">Everything you write here is end-to-end encrypted.</div>
      </div>
    </FadeIn>
  );
}

type Entry = { kind: "day"; at: number } | { kind: "msg"; msg: OpenedMessage };
function renderWithDayBreaks(msgs: OpenedMessage[]): Entry[] {
  const out: Entry[] = [];
  let lastDay = "";
  for (const m of msgs) {
    const d = new Date(m.createdAt).toDateString();
    if (d !== lastDay) { out.push({ kind: "day", at: m.createdAt }); lastDay = d; }
    out.push({ kind: "msg", msg: m });
  }
  return out;
}

function formatDay(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const one = new Date(now); one.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === one.toDateString()) return "Yesterday";
  const week = 7 * 86400_000;
  if (now.getTime() - t < week) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function previewLabel(m: OpenedMessage): string {
  if (m.media) return `[${m.media.kind}]`;
  return "";
}
// unused import guard
void currentSession;
