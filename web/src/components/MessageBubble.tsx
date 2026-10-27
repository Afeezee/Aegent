// One message. Handles text, media, reply-to preview, reactions,
// per-side alignment, and a **kebab-menu-on-edge** action pattern:
// a small ⋯ button sits absolutely-positioned at the trailing edge
// of every bubble. Because it's absolute-positioned it can never
// push the bubble sideways when it appears (the old symptom the user
// hit). Clicking it opens a floating menu anchored to the button;
// the menu carries the quick-emoji strip *inside* it, so the reactor
// never floats up above the bubble and gets clipped.

import { AnimatePresence, motion } from "framer-motion";
import { grantTranslationConsent, translateText, translationConsentGranted } from "../lib/translate.js";
import { clearTranslation, getTranslation, markMessageViewed, saveTranslation } from "../lib/store.js";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Avatar, Icon } from "./ui.js";
import type { OpenedMessage } from "../lib/store.js";
import { MediaView } from "./MediaView.js";
import { AbuseReportDialog } from "./ReportDialogs.js";
import { EmojiPicker } from "./EmojiPicker.js";

// A single emoji glyph as a message body is rendered as a sticker:
// bigger, no bubble background. Uses grapheme segmentation so flag,
// ZWJ-sequence and skin-tone emoji still count as one glyph.
function isSingleEmojiMessage(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed || trimmed.length > 24) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Seg = (Intl as any).Segmenter;
    if (!Seg) return false;
    const seg = new Seg(undefined, { granularity: "grapheme" });
    const parts = Array.from(seg.segment(trimmed));
    if (parts.length !== 1) return false;
    const g = (parts[0] as { segment: string }).segment;
    // Must contain at least one extended-pictographic codepoint.
    return /\p{Extended_Pictographic}/u.test(g);
  } catch { return false; }
}

export type BubbleProps = {
  msg: OpenedMessage;
  isGroup: boolean;
  isMine: boolean;
  senderName: string;
  senderAvatar?: string | null;
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
  const [translated, setTranslated] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  // Rehydrate any previously cached translation on mount. The Dexie
  // row survives app restarts, reloads, and reinstalls (the cache is
  // keyed to the per-user store that reopens on sign-in).
  useEffect(() => {
    let alive = true;
    getTranslation(msg.id).then((row) => {
      if (alive && row) setTranslated(row.text);
    });
    return () => { alive = false; };
  }, [msg.id]);
  async function doTranslate() {
    const text = (msg.editedBody ?? msg.body ?? msg.caption ?? "").trim();
    if (!text) return;
    if (!translationConsentGranted()) {
      const ok = window.confirm(
        "Translation uses Google Translate. The text of this message will be sent to Google — your end-to-end encryption does not cover that trip. Continue?",
      );
      if (!ok) return;
      grantTranslationConsent();
    }
    setTranslating(true);
    try {
      const out = await translateText(text);
      setTranslated(out);
      // Persist so the next render / reload shows it without
      // another round-trip to Google.
      await saveTranslation({
        messageId: msg.id, sourceText: text, translatedText: out,
        targetLang: navigator.language?.split("-")[0] ?? "en",
      });
    }
    catch (e) { setTranslated(`(couldn't translate: ${(e as Error).message})`); }
    finally { setTranslating(false); }
  }
  async function hideTranslation() {
    setTranslated(null);
    // Also drop the cached row so the user truly "undoes" the
    // translation — otherwise re-opening the bubble would show it again.
    await clearTranslation(msg.id);
  }
  const longPress = useRef<number | null>(null);
  function openMenuAt(x: number, y: number) {
    setMenuPos({ x: isMine ? Math.max(12, x - 190) : x, y: y + 6 });
    setMenuOpen(true);
  }
  const rowRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent | TouchEvent) => {
      // The menu now lives on document.body (portal), so it's no longer
      // inside rowRef — check both. Without this, mousedown on a menu
      // item is treated as "outside" and closes the menu before the
      // button's click handler ever fires.
      const target = e.target as Node;
      if (rowRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setMenuOpen(false);
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
  // View-once reveal state. Clicking the placeholder flips `revealed`
  // on and persists `viewedAt` so later renders show "Viewed". We
  // don't gate the sender — they already know what they sent — but
  // we show them a small badge so they can tell at a glance.
  const isViewOnce = !!msg.media?.viewOnce && !deleted;
  const alreadyViewed = !!msg.viewedAt;
  const [revealed, setRevealed] = useState(false);
  async function revealViewOnce() {
    if (isMine) return; // sender always sees their own
    setRevealed(true);
    try { await markMessageViewed(msg.id); } catch { /* non-fatal */ }
  }
  // Single-emoji text? Render it as a sticker (no bubble, big glyph).
  const stickerText = !msg.media && !deleted && body && isSingleEmojiMessage(body) ? body : null;

  // Sticker — single emoji, no bubble, large glyph. Keeps the kebab
  // menu reachable so the user can still react / reply / forward it.
  if (stickerText && !msg.diaryRef) {
    return (
      <motion.div
        ref={rowRef}
        initial={{ opacity: 0, y: 8, scale: 0.9 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 22 }}
        style={{
          display: "flex", gap: 8, alignItems: "flex-end",
          justifyContent: isMine ? "flex-end" : "flex-start",
          position: "relative",
        }}
      >
        {!isMine && p.showAvatar && <Avatar name={p.senderName} src={p.senderAvatar} size="sm" />}
        {!isMine && !p.showAvatar && <div style={{ width: 30 }} />}
        <div style={{ position: "relative" }}
          onContextMenu={(e) => { e.preventDefault(); openMenuAt(e.clientX, e.clientY); }}>
          <div style={{
            fontSize: 72, lineHeight: 1, padding: "6px 4px",
            filter: "drop-shadow(0 6px 14px rgba(0,0,0,0.22))",
          }}>{stickerText}</div>
          <div style={{
            fontSize: 10, color: "var(--text-mute)", opacity: 0.7,
            textAlign: isMine ? "right" : "left",
          }}>{new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
        </div>
      </motion.div>
    );
  }

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
      {!isMine && p.showAvatar && <Avatar name={p.senderName} src={p.senderAvatar} size="sm" />}
      {!isMine && !p.showAvatar && <div style={{ width: 30 }} />}

      <div
        className={`bubble-row ${isMine ? "bubble-row--mine" : "bubble-row--theirs"}`}
        style={{ maxWidth: "min(72%, 560px)", position: "relative" }}
        onContextMenu={(e) => { if (deleted) return; e.preventDefault(); openMenuAt(e.clientX, e.clientY); }}
        onTouchStart={(e) => {
          if (deleted) return;
          const t = e.touches[0];
          longPress.current = window.setTimeout(() => openMenuAt(t.clientX, t.clientY), 450);
        }}
        onTouchEnd={() => { if (longPress.current) { clearTimeout(longPress.current); longPress.current = null; } }}
        onTouchMove={() => { if (longPress.current) { clearTimeout(longPress.current); longPress.current = null; } }}
      >
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
              {msg.media && isViewOnce ? (
                <ViewOncePane
                  media={msg.media}
                  caption={msg.caption ?? undefined}
                  isMine={isMine}
                  messageId={msg.id}
                  revealed={revealed || isMine}
                  viewedAt={msg.viewedAt ?? null}
                  onReveal={revealViewOnce}
                />
              ) : (
                msg.media && <MediaView media={msg.media} caption={msg.caption ?? undefined} isMine={isMine} messageId={msg.id} />
              )}
              {body && !msg.media && <span>{body}</span>}
              {body && msg.media && (
                <div style={{ padding: "8px 8px 4px", fontSize: 14 }}>{body}</div>
              )}
              {(translating || translated) && (
                <div style={{
                  marginTop: 6, padding: "6px 8px", borderRadius: 8,
                  background: "rgba(255,255,255,0.08)", fontSize: 13, lineHeight: 1.45,
                  color: isMine ? "rgba(16,19,42,0.9)" : "var(--text-dim)",
                  borderLeft: "2px solid var(--aqua)",
                }}>
                  {translating ? "Translating…" : translated}
                </div>
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
              <span title={msg.readAt ? "Read" : msg.deliveredAt ? "Delivered" : "Sent"}
                style={{ display: "inline-flex", alignItems: "center" }}>
                {msg.readAt
                  // Read: bright aqua double-check, clearly distinct from the
                  // muted grey of "delivered". Reads well on the violet
                  // sent-bubble in both themes.
                  ? <span style={{ color: "#17c3e6", filter: "drop-shadow(0 0 1px rgba(23,195,230,0.4))" }}><Icon.checkDouble /></span>
                  : msg.deliveredAt
                    // Delivered: double-check at normal opacity.
                    ? <span style={{ opacity: 0.85 }}><Icon.checkDouble /></span>
                    // Sent (reached server, not yet delivered): single check, dimmed.
                    : <span style={{ opacity: 0.55 }}><Icon.check /></span>}
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
                transition: "background .12s",
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
        {/* Portal to body — the whole bubble is wrapped in framer-motion
            divs that apply transforms, and a transformed ancestor turns
            position:fixed into "fixed relative to that ancestor" (the
            containing-block rule). Without the portal the menu renders
            hundreds of pixels off-screen, which looked like "the menu
            doesn't open on click" because the backdrop was visible but
            the panel wasn't. AnimatePresence lives INSIDE the portal
            because it only tracks motion children in its direct render
            output — wrapping it around the Portal makes it see no
            children and render nothing. */}
        {createPortal((
          <AnimatePresence>
            {menuOpen && !deleted && (
            <>
              <motion.div
                key="menu-backdrop"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }}
                style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(4,6,16,0.45)" }}
              />
              <motion.div
                key="menu-panel"
                ref={menuRef}
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
                {/* "+" opens the full emoji picker for any reaction. */}
                <button
                  onClick={() => setEmojiPickerOpen((v) => !v)}
                  aria-label="More reactions"
                  style={{
                    marginLeft: "auto", padding: "4px 8px", fontSize: 16,
                    background: "var(--glass-bg-hi)", border: "none",
                    cursor: "pointer", borderRadius: 6, color: "var(--text-dim)",
                  }}
                >＋</button>
              </div>
              {emojiPickerOpen && (
                <div style={{ marginBottom: 6 }}>
                  <EmojiPicker width={280}
                    onPick={(e) => { p.onReact(e); setEmojiPickerOpen(false); setMenuOpen(false); }}
                  />
                </div>
              )}

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
              {(msg.body || msg.editedBody || msg.caption) && (
                <MenuItem icon={<Icon.chevron />} label={translated ? "Hide translation" : "Translate"}
                  onClick={() => {
                    setMenuOpen(false);
                    if (translated) void hideTranslation();
                    else void doTranslate();
                  }} />
              )}
              {!isMine && (
                <MenuItem icon={<Icon.x />} label="Report"
                  onClick={() => { setMenuOpen(false); setReportOpen(true); }} />
              )}
              {isMine && (
                <MenuItem icon={<Icon.trash />} label="Delete" danger
                  onClick={() => { p.onDelete(); setMenuOpen(false); }} />
              )}
              </motion.div>
            </>
            )}
          </AnimatePresence>
        ), document.body)}
      </div>
      <AbuseReportDialog
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        reportedUserId={msg.senderId}
        reportedName={p.senderName}
        threadId={msg.peerId}
      />
    </motion.div>
  );
}

// Placeholder for a view-once attachment. Three states:
//   - sender: shows a "View once" badge and the content itself, so they
//     have context without the "revealed" moment ever burning. (They
//     already know what they sent.)
//   - receiver, unrevealed: "Tap to view once" button.
//   - receiver, revealed OR already-viewed persisted on disk: content
//     (or "Viewed" placeholder if the per-message `viewedAt` was set in
//     a prior session and the user navigated away — tapping again
//     would re-reveal, which defeats the point).
function ViewOncePane({
  media, caption, isMine, messageId, revealed, viewedAt, onReveal,
}: {
  media: import("../lib/store.js").MediaRef;
  caption?: string;
  isMine?: boolean;
  messageId?: string;
  revealed: boolean;
  viewedAt: number | null;
  onReveal: () => void;
}) {
  // Already-viewed sticks across reloads: the placeholder wins.
  if (!isMine && viewedAt && !revealed) {
    return (
      <div style={{
        display: "flex", flexDirection: "column", gap: 6, alignItems: "center",
        padding: "22px 24px", borderRadius: 12,
        background: "rgba(255,255,255,0.05)", border: "1px dashed var(--line-strong)",
        color: "var(--text-dim)", fontSize: 13, minWidth: 180,
      }}>
        <span style={{ fontSize: 22 }}>👁️</span>
        <span>Viewed</span>
      </div>
    );
  }

  if (!isMine && !revealed) {
    return (
      <button
        type="button"
        onClick={onReveal}
        style={{
          all: "unset", cursor: "pointer",
          display: "flex", flexDirection: "column", gap: 8, alignItems: "center",
          padding: "22px 24px", borderRadius: 12, minWidth: 200,
          background: "linear-gradient(135deg, rgba(138,125,255,0.18), rgba(23,195,230,0.18))",
          border: "1px solid var(--glass-border-hi)",
          color: "var(--text)",
        }}
      >
        <span style={{ fontSize: 28 }}>👁️</span>
        <strong>Tap to view once</strong>
        <span className="small" style={{ color: "var(--text-dim)" }}>
          {media.kind === "image" ? "Photo or text card" : media.kind === "voice" ? "Voice note" : media.kind === "audio" ? "Audio" : media.kind}
          {" • disappears after you open it"}
        </span>
      </button>
    );
  }

  // Sender's own copy OR a receiver who just revealed → show content
  // with a persistent "View once" tag so the intent is still legible.
  return (
    <div style={{ position: "relative" }}>
      <div style={{
        position: "absolute", top: 8, left: 8, zIndex: 2,
        padding: "2px 8px", borderRadius: 999, fontSize: 11,
        background: "rgba(0,0,0,0.55)", color: "#fff",
        display: "inline-flex", gap: 4, alignItems: "center",
      }}>
        <span>👁️</span> View once
      </div>
      <MediaView media={media} caption={caption} isMine={isMine} messageId={messageId} />
    </div>
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
