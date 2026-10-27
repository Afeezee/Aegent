// The right-hand chat pane. Owns the currently open thread, the reply
// stack, the edit state, and typing indicators.

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Avatar, Button, FadeIn, Icon, toast } from "./ui.js";
import { Composer, type ReplyTarget } from "./Composer.js";
import { MessageBubble } from "./MessageBubble.js";
import type { OpenedMessage, Thread } from "../lib/store.js";
import {
  getContact, getGroup, markThreadRead, threadBefore, threadMessageCount, threadWith,
  type ContactRow, type GroupRow,
} from "../lib/store.js";
import { onTyping } from "../lib/socket.js";
import { formatDay, withDayBreaks } from "../lib/daybreaks.js";
import {
  currentSession, myId, reportRead, sendDelete, sendEdit, sendReaction,
} from "../lib/session.js";

export function Chat({
  thread, onOpenForward, onOpenGroupInfo, onBack, refreshKey, onSent,
  highlightMsgId, fromAgent, onBackToAgent, onInvokeAgent,
}: {
  thread: Thread;
  onOpenForward: (msg: OpenedMessage) => void;
  onOpenGroupInfo?: () => void;
  onBack?: () => void;
  refreshKey: number;
  onSent: () => void;
  highlightMsgId?: string | null;
  fromAgent?: boolean;
  onBackToAgent?: () => void;
  // Pass-through for the /agent slash command in Composer — opens
  // the agent sheet in Home with the query pre-populated.
  onInvokeAgent?: (query: string) => void;
}) {
  const [msgs, setMsgs] = useState<OpenedMessage[]>([]);
  const [peers, setPeers] = useState<Map<string, string>>(new Map());
  const [peerMeta, setPeerMeta] = useState<{ contact?: ContactRow; group?: GroupRow }>({});
  const [agentOn, setAgentOn] = useState(false);
  const [typing, setTyping] = useState<Set<string>>(new Set());
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const [unseenNew, setUnseenNew] = useState(0);
  const prevLen = useRef(0);
  const streamRef = useRef<HTMLDivElement>(null);
  const me = myId();

  // Page size for the window of messages currently in the DOM.
  // Lazy-load more when the user scrolls near the top. 300 keeps
  // the render tree cheap even on a modest Android device while
  // still being enough that most sessions never hit the loader.
  const INITIAL_WINDOW = 300;
  const PAGE_SIZE = 200;

  // Load thread on peer change / on refresh. Every step is swaddled
  // in try/catch so a single bad DB row or missing contact can't
  // leave the pane in a half-mounted / blank state.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [rows, total] = await Promise.all([
          threadWith(thread.peerId, INITIAL_WINDOW),
          threadMessageCount(thread.peerId),
        ]);
        if (!alive) return;
        setMsgs(rows);
        setHasMoreOlder(total > rows.length);
        // Default: snap to bottom. If a highlight is pending, defer
        // the scroll to the highlight effect below so we don't
        // bottom-scroll and then re-scroll in a visible jump.
        if (!highlightMsgId) {
          queueMicrotask(() => streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight }));
        }
      } catch (e) {
        console.warn("[Chat] threadWith failed:", e);
        if (alive) setMsgs([]); // render empty state rather than blanking
      }
    })();
    (async () => {
      try {
        if (thread.isGroup) {
          const g = await getGroup(thread.peerId);
          if (!alive) return;
          setPeerMeta({ group: g });
          const map = new Map<string, string>();
          for (const uid of g?.memberIds ?? []) {
            if (uid === me) { map.set(uid, "You"); continue; }
            const c = await getContact(uid);
            map.set(uid, c?.displayName ?? "Unknown");
          }
          if (alive) setPeers(map);
        } else {
          const c = await getContact(thread.peerId);
          if (!alive) return;
          setPeerMeta({ contact: c });
          setPeers(new Map([[thread.peerId, c?.displayName ?? "?"], [me, "You"]]));
        }
      } catch (e) {
        console.warn("[Chat] peer resolve failed:", e);
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

  // Scroll+pulse to the highlighted message once its DOM node exists.
  // Runs after msgs load so the bubble is actually rendered. If the
  // id isn't in this thread's current window, we quietly bail — a
  // future "load-around-message" pass will handle that case.
  useEffect(() => {
    if (!highlightMsgId || msgs.length === 0) return;
    // Give the browser one layout tick so the bubble is painted.
    const t = window.setTimeout(() => {
      const el = streamRef.current?.querySelector<HTMLElement>(
        `[data-msg-id="${CSS.escape(highlightMsgId)}"]`,
      );
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("msg-pulse");
      window.setTimeout(() => el.classList.remove("msg-pulse"), 1800);
    }, 60);
    return () => window.clearTimeout(t);
  }, [highlightMsgId, msgs.length]);

  // Typing indicator (only relevant sender ids).
  useEffect(() => {
    return onTyping(({ from, groupId }) => {
      if (thread.isGroup ? groupId === thread.peerId : from === thread.peerId) {
        setTyping((s) => new Set(s).add(from));
        window.setTimeout(() => setTyping((s) => { const n = new Set(s); n.delete(from); return n; }), 2500);
      }
    });
  }, [thread.peerId, thread.isGroup]);

  useEffect(() => {
    if (!thread.isGroup) { setAgentOn(false); return; }
    let live = true;
    import("../lib/api.js")
      .then((m) => m.api.getGroup(thread.peerId))
      .then((g) => { if (live) setAgentOn(g.settings?.agentPolicy === "members"); })
      .catch(() => { if (live) setAgentOn(false); });
    return () => { live = false; };
  }, [thread.peerId, thread.isGroup]);


  // Count messages that arrive while the user is scrolled up, so the
  // jump button can show how many they haven't seen. Resets on reaching
  // the bottom.
  useEffect(() => {
    const grew = msgs.length - prevLen.current;
    prevLen.current = msgs.length;
    if (grew > 0 && showJumpLatest) setUnseenNew((n) => n + grew);
  }, [msgs.length, showJumpLatest]);

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
        {onBack && (
          <Button variant="icon" onClick={onBack} aria-label="Back">
            {/* Point left — this collapses the chat back to the list. The
                raw chevron glyph points right, so flip it. */}
            <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}><Icon.chevron /></span>
          </Button>
        )}
        <Avatar
          name={thread.title}
          group={thread.isGroup}
          online={peerMeta.contact?.online}
          src={peerMeta.contact?.avatar}
        />
        <div
          style={{ minWidth: 0, flex: 1, cursor: thread.isGroup && onOpenGroupInfo ? "pointer" : "default" }}
          onClick={() => thread.isGroup && onOpenGroupInfo?.()}
        >
          <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {thread.title}
          </div>
          {/* Peer status takes the subtitle slot when present. */}
          {!thread.isGroup && peerMeta.contact?.statusText && (
            <div className="small" style={{ color: "var(--accent-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {peerMeta.contact.statusText}
            </div>
          )}
          <div className="small" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span>{subtitle}</span>
            {agentOn && (
              <span title="The assistant is on for this group" style={{
                fontSize: 10, padding: "1px 6px", borderRadius: 999,
                background: "rgba(138,125,255,0.18)", color: "var(--accent-strong)",
                border: "1px solid var(--line)",
              }}>🤖 assistant on</span>
            )}
          </div>
        </div>
        {onInvokeAgent && (
          <button
            type="button"
            onClick={() => onInvokeAgent(`About my chat with ${thread.title}: `)}
            aria-label={`Ask Aegent about this chat with ${thread.title}`}
            title="Ask Aegent about this chat"
            style={{
              all: "unset", cursor: "pointer",
              width: 36, height: 36, minWidth: 36, borderRadius: 10,
              background: "linear-gradient(135deg, var(--violet), var(--aqua))",
              color: "#10132a",
              display: "grid", placeItems: "center",
              boxShadow: "0 4px 12px rgba(138,125,255,0.3)",
            }}
          >
            <Icon.agent />
          </button>
        )}
        <span className="tag ok">end-to-end</span>
      </div>

      {fromAgent && onBackToAgent && (
        <button
          type="button"
          onClick={onBackToAgent}
          aria-label="Back to agent"
          style={{
            position: "absolute", zIndex: 50,
            top: "calc(var(--safe-top) + 70px)", left: "50%", transform: "translateX(-50%)",
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "8px 14px", minHeight: 36, borderRadius: 999,
            background: "var(--glass-bg-hi)", border: "1px solid var(--glass-border-hi)",
            color: "var(--text)", fontSize: 13, cursor: "pointer",
            boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
          }}
        >
          <span style={{ display: "inline-block", transform: "rotate(180deg)" }}><Icon.chevron /></span> Back to agent
        </button>
      )}

      <div
        ref={streamRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          // Lazy-load older when within 120px of the top.
          if (el.scrollTop < 120 && hasMoreOlder && !loadingOlder && msgs.length > 0) {
            setLoadingOlder(true);
            const prevHeight = el.scrollHeight;
            const prevTop = el.scrollTop;
            const oldestAt = msgs[0].createdAt;
            threadBefore(thread.peerId, oldestAt, PAGE_SIZE).then((older) => {
              if (older.length === 0) { setHasMoreOlder(false); setLoadingOlder(false); return; }
              setMsgs((cur) => [...older, ...cur]);
              // Preserve scroll position: wait a frame for layout, then
              // offset by the newly-prepended content height so the
              // user's eye stays on the same message.
              requestAnimationFrame(() => {
                if (!streamRef.current) return;
                const delta = streamRef.current.scrollHeight - prevHeight;
                streamRef.current.scrollTop = prevTop + delta;
                setLoadingOlder(false);
              });
            }).catch(() => setLoadingOlder(false));
          }
          // Jump-to-latest FAB: show when the user is >400px from the bottom.
          const distFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
          const up = distFromBottom > 400;
          setShowJumpLatest(up);
          if (!up) setUnseenNew(0);
        }}
        style={{
          flex: 1, overflowY: "auto", padding: "20px 22px", display: "flex", flexDirection: "column", gap: 10,
        }}
      >
        {loadingOlder && (
          <div className="small" style={{ textAlign: "center", padding: 8, color: "var(--text-mute)" }}>
            Loading older messages…
          </div>
        )}
        {msgs.length === 0 ? (
          <EmptyChat title={thread.title} isGroup={thread.isGroup} />
        ) : (
          withDayBreaks(msgs).map((entry) => {
            if (entry.kind === "day") return (
              <div key={`day-${entry.at}`} style={{ textAlign: "center", margin: "10px 0" }}>
                <span className="tag">{formatDay(entry.at)}</span>
              </div>
            );
            const m = entry.item;
            // Look up the actual previous *message* (not the previous
            // grouped entry, which might be a day separator) so
            // consecutive-sender collapsing is correct.
            const j = msgs.indexOf(m);
            const prev = j > 0 ? msgs[j - 1] : undefined;
            const isMine = m.senderId === me;
            const consecutive = !!prev
              && prev.senderId === m.senderId
              && Math.abs(m.createdAt - prev.createdAt) < 6 * 60_000;
            return (
              <div key={m.id} data-msg-id={m.id}>
              <MessageBubble
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
              </div>
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

      <AnimatePresence>
        {showJumpLatest && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.18 }}
            onClick={() => { setUnseenNew(0); streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" }); }}
            aria-label={unseenNew > 0 ? `${unseenNew} new message${unseenNew === 1 ? "" : "s"}, jump to latest` : "Jump to latest message"}
            style={{
              position: "absolute",
              right: 18, bottom: "calc(96px + var(--safe-bottom))",
              zIndex: 40, minWidth: 44, minHeight: 44,
              height: 44, padding: unseenNew > 0 ? "0 14px" : 0, width: unseenNew > 0 ? "auto" : 44,
              borderRadius: 999, border: "1px solid var(--glass-border-hi)",
              background: unseenNew > 0 ? "var(--accent)" : "var(--menu-bg)",
              color: unseenNew > 0 ? "#10132a" : "var(--text)",
              cursor: "pointer", display: "flex", alignItems: "center", gap: 6, justifyContent: "center",
              boxShadow: "0 10px 24px rgba(0,0,0,0.22)",
            }}
          >
            {unseenNew > 0 && <span style={{ fontSize: 13, fontWeight: 700 }}>{unseenNew}</span>}
            <span style={{ display: "inline-block", transform: "rotate(90deg)" }}><Icon.chevron /></span>
          </motion.button>
        )}
      </AnimatePresence>

      <Composer
        peerId={thread.peerId}
        isGroup={thread.isGroup}
        replyTo={reply}
        onClearReply={() => setReply(null)}
        editing={editing}
        onCancelEdit={() => setEditing(null)}
        onEditCommit={commitEdit}
        onSent={onSent}
        onInvokeAgent={onInvokeAgent}
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

function previewLabel(m: OpenedMessage): string {
  if (m.media) return `[${m.media.kind}]`;
  return "";
}
// unused import guard
void currentSession;
