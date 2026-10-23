// One message. Handles text, media, reply-to preview, reactions,
// per-side alignment, and a **kebab-menu-on-edge** action pattern:
// a small ⋯ button sits absolutely-positioned at the trailing edge
// of every bubble. Because it's absolute-positioned it can never
// push the bubble sideways when it appears (the old symptom the user
// hit). Clicking it opens a floating menu anchored to the button;
// the menu carries the quick-emoji strip *inside* it, so the reactor
// never floats up above the bubble and gets clipped.

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const isNarrow = typeof window !== "undefined" && window.innerWidth < 720;
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent | TouchEvent) => {
      if (!rowRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc, { passive: true });
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [menuOpen]);

  const body = msg.editedBody ?? msg.body;
  const deleted = !!msg.deletedAt;

  // A reaction to a diary entry arrives as a message whose whole content
  // is one emoji. Giving it a full bubble would bury the conversation
  // under hearts, so it renders as a quiet one-line note instead.
  if (msg.diaryRef?.kind === "reaction" && !deleted) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
        style={{
          display: "flex", justifyContent: "center",
          fontSize: 12, color: "var(--text-dim)", padding: "2px 0 6px", gap: 6,
        }}
      >
        <span style={{ fontSize: 15 }}>{msg.diaryRef.emoji ?? body}</span>
        <span>{isMine ? "You reacted to their diary" : `${p.senderName} reacted to your diary`}</span>
      </motion.div>
    );
  }

  return (
    <motion.div
      ref={rowRef}
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 380, damping: 30 }}
      style={{
        display: "flex", gap: 8,
        justifyContent: isMine ? "flex-end" : "flex-start",
        alignItems: "flex-end",
      }}
    >
      {!isMine && p.showAvatar && <Avatar name={p.senderName} size="sm" />}
      {!isMine && !p.showAvatar && <div style={{ width: 30 }} />}

      <div style={{ maxWidth: "min(72%, 560px)", position: "relative" }}>
        {p.isGroup && !isMine && p.showAvatar && (
          <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "0 12px 4px" }}>
            {p.senderName}
          </div>
        )}

        {msg.diaryRef?.kind === "reply" && (
          <div style={{
            padding: "6px 10px", marginBottom: 4, borderRadius: 10,
            background: "rgba(255,255,255,0.05)", border: "1px solid var(--line)",
            borderLeft: "3px solid var(--aqua)",
            fontSize: 12, color: "var(--text-dim)",
          }}>
            {isMine ? "You replied to a diary entry" : "Replied to your diary entry"}
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
              {msg.media && <MediaView media={msg.media} caption={msg.caption ?? undefined} isMine={isMine} messageId={msg.id} />}
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

          {/* Kebab — absolute-positioned on the bubble's trailing edge.
              Because it's absolute, its appearance/disappearance never
              shifts the bubble's own layout. */}
          {!deleted && (
            <button
              className="bubble-kebab"
              onClick={(e) => {
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMenuPos({ x: isMine ? r.left - 170 : r.right, y: r.bottom + 6 });
                setMenuOpen((o) => !o);
              }}
              aria-label="Message actions"
              style={{
                position: "absolute",
                top: 4,
                [isMine ? "left" : "right"]: -32,
                width: 28, height: 28, borderRadius: 999,
                border: "none", cursor: "pointer",
                display: "grid", placeItems: "center",
                background: menuOpen ? "var(--glass-bg-hi)" : "transparent",
                color: "var(--text-dim)",
                opacity: menuOpen ? 1 : 0.65,
                transition: "opacity .12s, background .12s",
              } as React.CSSProperties}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = menuOpen ? "1" : "0.65")}
            >
              <Icon.kebab />
            </button>
          )}
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
                  display: "inline-flex", gap: 4, alignItems: "center", cursor: "pointer",
                }}>
                <span>{emoji}</span><span style={{ opacity: 0.8 }}>{users.length}</span>
              </button>
            ))}
          </div>
        )}

        {/* Action menu. A dimmed backdrop plus a solid surface: on a
            phone a bottom sheet that is always fully on screen; on
            desktop a popover near the bubble, clamped inside the
            viewport. Solid, so nothing bleeds through. */}
        <AnimatePresence>
          {menuOpen && !deleted && (
            <>
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }}
                style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(4,6,16,0.45)" }}
              />
              <motion.div
                role="menu"
                initial={{ opacity: 0, y: isNarrow ? 24 : -4, scale: isNarrow ? 1 : 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: isNarrow ? 24 : -4, scale: isNarrow ? 1 : 0.96 }}
                transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                style={(isNarrow ? {
                  position: "fixed", left: 12, right: 12,
                  bottom: "calc(12px + var(--tabbar-h) + var(--safe-bottom))",
                  zIndex: 1101, padding: 8, display: "flex", flexDirection: "column", gap: 2,
                  borderRadius: 16, boxShadow: "var(--shadow-md)",
                  background: "var(--menu-bg)", border: "1px solid var(--line-strong)",
                } : {
                  position: "fixed", zIndex: 1101,
                  top: Math.min(menuPos.y, window.innerHeight - 320),
                  left: Math.max(12, Math.min(menuPos.x, window.innerWidth - 212)),
                  padding: 6, display: "flex", flexDirection: "column", gap: 2,
                  borderRadius: 12, boxShadow: "var(--shadow-md)", minWidth: 190,
                  background: "var(--menu-bg)", border: "1px solid var(--line-strong)",
                }) as React.CSSProperties}
                onClick={(e) => e.stopPropagation()}
              >
              {/* Quick emoji strip — inside the menu, never floats up. */}
              <div style={{
                display: "flex", gap: 2, padding: 4,
                borderBottom: "1px solid var(--line)", marginBottom: 4,
              }}>
                {QUICK_EMOJI.map((e) => (
                  <button key={e}
                    onClick={() => { p.onReact(e); setMenuOpen(false); }}
                    style={{
                      padding: "4px 8px", fontSize: 18, background: "none",
                      border: "none", cursor: "pointer", borderRadius: 6,
                    }}
                  >{e}</button>
                ))}
              </div>

              <MenuItem icon={<Icon.reply />} label="Reply"
                onClick={() => { p.onReply(); setMenuOpen(false); }} />
              {isMine && !msg.media && (
                <MenuItem icon={<Icon.edit />} label="Edit"
                  onClick={() => { p.onEdit(); setMenuOpen(false); }} />
              )}
              <MenuItem icon={<Icon.forward />} label="Forward"
                onClick={() => { p.onForward(); setMenuOpen(false); }} />
              <MenuItem icon={<Icon.copy />} label="Copy"
                onClick={() => { p.onCopy(); setMenuOpen(false); }} />
              {isMine && (
                <MenuItem icon={<Icon.trash />} label="Delete" danger
                  onClick={() => { p.onDelete(); setMenuOpen(false); }} />
              )}
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function MenuItem({ icon, label, onClick, danger }: {
  icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "8px 10px", borderRadius: 8,
        background: "transparent", border: "none",
        color: danger ? "var(--danger)" : "var(--text)",
        cursor: "pointer", fontSize: 13, textAlign: "left",
        transition: "background .1s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span style={{ display: "inline-flex", opacity: 0.8 }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
