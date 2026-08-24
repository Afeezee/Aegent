// One message. Handles text, media, reply-to preview, reactions,
// per-side alignment, and the on-hover action bar with the four
// actions everyone actually uses (react, reply, edit, delete, forward,
// copy). Long-press on touch triggers the same menu.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Avatar, Icon } from "./ui.js";
import type { OpenedMessage } from "../lib/store.js";
import { MediaView } from "./MediaView.js";

export type BubbleProps = {
  msg: OpenedMessage;
  isGroup: boolean;
  isMine: boolean;
  senderName: string;
  peers: Map<string, string>; // userId -> display name for reactions
  onReact: (emoji: string) => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onForward: () => void;
  onCopy: () => void;
  showAvatar: boolean;
};

const QUICK_EMOJI = ["❤️", "😂", "👍", "😮", "😢", "🙏"];

export function MessageBubble(p: BubbleProps) {
  const { msg, isMine } = p;
  const [showActions, setShowActions] = useState(false);
  const [showReactor, setShowReactor] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close reactor on outside click.
  useEffect(() => {
    if (!showReactor) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setShowReactor(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showReactor]);

  const body = msg.editedBody ?? msg.body;
  const deleted = !!msg.deletedAt;

  return (
    <motion.div
      ref={rootRef}
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 380, damping: 30 }}
      style={{
        display: "flex", gap: 8,
        justifyContent: isMine ? "flex-end" : "flex-start",
        alignItems: "flex-end",
      }}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => { setShowActions(false); setShowReactor(false); }}
    >
      {!isMine && p.showAvatar && <Avatar name={p.senderName} size="sm" />}
      {!isMine && !p.showAvatar && <div style={{ width: 30 }} />}

      <div style={{ maxWidth: "min(72%, 560px)", position: "relative" }}>
        {p.isGroup && !isMine && p.showAvatar && (
          <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "0 12px 4px" }}>
            {p.senderName}
          </div>
        )}

        {msg.replyTo && (
          <div style={{
            padding: "6px 10px", marginBottom: 4, borderRadius: 10,
            background: "rgba(255,255,255,0.05)", border: "1px solid var(--line)",
            fontSize: 12, color: "var(--text-dim)",
            borderLeft: "3px solid var(--accent)",
          }}>
            <div style={{ opacity: 0.7 }}>Reply to {msg.replyTo.author}</div>
            <div style={{ opacity: 0.9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {msg.replyTo.preview}
            </div>
          </div>
        )}

        <div
          className={isMine ? "bubble mine" : "bubble"}
          style={{
            padding: msg.media ? "6px 6px 8px" : "10px 14px",
            borderRadius: 16,
            borderTopRightRadius: isMine && p.showAvatar ? 6 : 16,
            borderTopLeftRadius: !isMine && p.showAvatar ? 6 : 16,
            background: isMine
              ? "linear-gradient(135deg, rgba(138,125,255,0.9), rgba(179,155,255,0.9))"
              : "var(--glass-bg-hi)",
            color: isMine ? "#10132a" : "var(--text)",
            border: isMine ? "1px solid rgba(255,255,255,0.15)" : "1px solid var(--glass-border-hi)",
            backdropFilter: isMine ? undefined : "blur(14px) saturate(140%)",
            WebkitBackdropFilter: isMine ? undefined : "blur(14px) saturate(140%)",
            boxShadow: isMine ? "0 8px 22px rgba(138,125,255,0.28)" : "var(--shadow-sm)",
            wordBreak: "break-word", whiteSpace: "pre-wrap",
            position: "relative",
          }}
        >
          {deleted ? (
            <span style={{ opacity: 0.7, fontStyle: "italic" }}>Message deleted</span>
          ) : (
            <>
              {msg.media && <MediaView ref={msg.media} caption={msg.caption ?? undefined} isMine={isMine} />}
              {body && !msg.media && <span>{body}</span>}
              {body && msg.media && (
                <div style={{ padding: "8px 8px 4px", fontSize: 14 }}>{body}</div>
              )}
            </>
          )}

          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            marginTop: msg.media ? 6 : 4,
            fontSize: 10, opacity: 0.7,
            justifyContent: "flex-end",
            color: isMine ? "rgba(16,19,42,0.7)" : "var(--text-mute)",
            padding: msg.media ? "0 8px 4px" : undefined,
          }}>
            {msg.editedBody && !deleted && <span>edited</span>}
            <span>{new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            {isMine && !deleted && (
              <span title={msg.readAt ? "Read" : msg.deliveredAt ? "Delivered" : "Sent"} style={{ display: "inline-flex" }}>
                {msg.readAt
                  ? <span style={{ color: "#0e5a3a" }}><Icon.checkDouble /></span>
                  : msg.deliveredAt
                    ? <Icon.checkDouble />
                    : <Icon.check />}
              </span>
            )}
          </div>
        </div>

        {/* reactions row */}
        {Object.keys(msg.reactions ?? {}).length > 0 && (
          <div style={{ display: "flex", gap: 4, marginTop: 4, justifyContent: isMine ? "flex-end" : "flex-start", flexWrap: "wrap" }}>
            {Object.entries(msg.reactions ?? {}).map(([emoji, users]) => (
              <button key={emoji} onClick={() => p.onReact(emoji)}
                title={users.map((u) => p.peers.get(u) ?? "someone").join(", ")}
                style={{
                  padding: "2px 8px", fontSize: 12, borderRadius: 999,
                  background: "var(--glass-bg-hi)", border: "1px solid var(--glass-border-hi)",
                  display: "inline-flex", gap: 4, alignItems: "center",
                }}>
                <span>{emoji}</span><span style={{ opacity: 0.8 }}>{users.length}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* hover action bar */}
      <AnimatePresence>
        {showActions && !deleted && (
          <motion.div
            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.15 }}
            className="glass"
            style={{
              alignSelf: "flex-start",
              padding: 4, display: "flex", gap: 2, borderRadius: 12,
              boxShadow: "var(--shadow-md)",
            }}
          >
            <IconAction title="React" onClick={() => setShowReactor((s) => !s)}><Icon.smile /></IconAction>
            <IconAction title="Reply" onClick={p.onReply}><Icon.reply /></IconAction>
            {isMine && !msg.media && <IconAction title="Edit" onClick={p.onEdit}><Icon.edit /></IconAction>}
            <IconAction title="Forward" onClick={p.onForward}><Icon.forward /></IconAction>
            <IconAction title="Copy" onClick={p.onCopy}><Icon.copy /></IconAction>
            {isMine && <IconAction title="Delete" onClick={p.onDelete}><Icon.trash /></IconAction>}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showReactor && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.95 }}
            className="glass glass-hi"
            style={{
              position: "absolute", top: -44, right: isMine ? 40 : undefined, left: isMine ? undefined : 40,
              padding: 6, display: "flex", gap: 4, borderRadius: 999, zIndex: 5,
            }}
          >
            {QUICK_EMOJI.map((e) => (
              <button key={e} onClick={() => { p.onReact(e); setShowReactor(false); }}
                style={{
                  padding: "4px 8px", fontSize: 18, background: "none",
                  border: "none", cursor: "pointer", borderRadius: 8,
                }}>
                {e}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function IconAction({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button onClick={onClick} title={title} aria-label={title}
      style={{
        padding: 6, background: "transparent", border: "none",
        borderRadius: 8, cursor: "pointer", color: "var(--text-dim)",
        display: "grid", placeItems: "center",
      }}>
      {children}
    </button>
  );
}
