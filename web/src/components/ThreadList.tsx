// Left rail — every conversation. Pinned first, then most-recent.
// Supports pin (max 10), archive, and delete, via a per-row menu, a
// long-press multi-select mode, and an Archived section.

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { createPortal } from "react-dom";
import { Avatar, Button, Icon, StaggerItem, toast } from "./ui.js";
import {
  countPinned, deleteConversation, listThreads, MAX_PINNED,
  setThreadArchived, setThreadPinned, type Thread,
} from "../lib/store.js";
import { currentSession } from "../lib/session.js";

export function ThreadList({
  activeId, onSelect, onCompose, onOpenSearch, refreshKey, filter = "all",
}: {
  activeId: string | null;
  onSelect: (t: Thread) => void;
  onCompose: () => void;
  onOpenSearch: () => void;
  refreshKey: number;
  filter?: "all" | "direct" | "group";
}) {
  const [all, setAll] = useState<Thread[]>([]);
  const [localRefresh, setLocalRefresh] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  // Multi-select state.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Single-row action menu.
  const [menuFor, setMenuFor] = useState<{ t: Thread; x: number; y: number } | null>(null);

  const reload = () => listThreads().then(setAll);
  useEffect(() => { reload(); }, [refreshKey, localRefresh]);

  const typed = all.filter((t) =>
    filter === "all" ? true : filter === "group" ? t.isGroup : !t.isGroup);
  const archivedCount = typed.filter((t) => t.archived).length;
  const threads = typed.filter((t) => showArchived ? t.archived : !t.archived);

  function exitSelect() { setSelectMode(false); setSelected(new Set()); }

  function toggleSelected(peerId: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(peerId)) n.delete(peerId); else n.add(peerId);
      return n;
    });
  }

  async function pin(t: Thread) {
    const ok = await setThreadPinned(t.peerId, !t.pinned);
    if (!ok) toast(`You can pin up to ${MAX_PINNED} chats.`, "warn");
    setLocalRefresh((k) => k + 1);
  }
  async function archive(t: Thread) {
    await setThreadArchived(t.peerId, !t.archived);
    setLocalRefresh((k) => k + 1);
  }
  async function del(t: Thread) {
    if (!window.confirm(`Delete your conversation with ${t.title}? This clears it from this device. ${t.isGroup ? "" : "They can still message you."}`)) return;
    await deleteConversation(t.peerId, t.isGroup);
    setLocalRefresh((k) => k + 1);
  }

  async function bulkArchive() {
    for (const peerId of selected) {
      const t = all.find((x) => x.peerId === peerId);
      if (t) await setThreadArchived(peerId, !t.archived);
    }
    exitSelect(); setLocalRefresh((k) => k + 1);
  }
  async function bulkDelete() {
    if (!window.confirm(`Delete ${selected.size} conversation${selected.size === 1 ? "" : "s"} from this device?`)) return;
    for (const peerId of selected) {
      const t = all.find((x) => x.peerId === peerId);
      if (t) await deleteConversation(peerId, t.isGroup);
    }
    exitSelect(); setLocalRefresh((k) => k + 1);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      {!selectMode ? (
        <div style={{ padding: "16px 16px 8px", display: "flex", gap: 8 }}>
          <Button className="glass" style={{ flex: 1, background: "rgba(255,255,255,0.03)" }}
            onClick={onOpenSearch}>
            <Icon.search /> <span style={{ opacity: 0.8 }}>Search everything</span>
            <span className="kbd" style={{ marginLeft: "auto" }}>⌘K</span>
          </Button>
          <Button variant="primary" onClick={onCompose} title="New chat or group" aria-label="New chat">
            <Icon.plus />
          </Button>
        </div>
      ) : (
        <div style={{ padding: "16px 16px 8px", display: "flex", gap: 8, alignItems: "center" }}>
          <Button variant="ghost" size="small" onClick={exitSelect} aria-label="Cancel selection">
            <Icon.x />
          </Button>
          <div style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>{selected.size} selected</div>
          <Button variant="ghost" size="small" onClick={bulkArchive} disabled={selected.size === 0}>Archive</Button>
          <Button variant="danger" size="small" onClick={bulkDelete} disabled={selected.size === 0}>Delete</Button>
        </div>
      )}

      <div style={{ overflowY: "auto", padding: "6px 8px 20px", flex: 1 }}>
        {/* Archived toggle — only when some archived threads exist and
            we're not already in the archived view. */}
        {!selectMode && archivedCount > 0 && (
          <button onClick={() => setShowArchived((v) => !v)}
            style={{
              all: "unset", cursor: "pointer", width: "100%",
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 12px", borderRadius: 12, color: "var(--text-dim)", fontSize: 13,
            }}>
            <Icon.archive />
            <span style={{ flex: 1 }}>{showArchived ? "Back to chats" : `Archived (${archivedCount})`}</span>
            <span style={{ transform: showArchived ? "rotate(90deg)" : "none" }}><Icon.chevron /></span>
          </button>
        )}

        {threads.length === 0 && !showArchived && <EmptyThreadHint onCompose={onCompose} />}
        {threads.length === 0 && showArchived && (
          <div style={{ padding: 20, textAlign: "center", color: "var(--text-mute)", fontSize: 13 }}>No archived chats.</div>
        )}

        <AnimatePresence initial={false}>
          {threads.map((t) => (
            <StaggerItem key={t.peerId}>
              <ThreadRow
                t={t}
                active={t.peerId === activeId}
                selectMode={selectMode}
                selected={selected.has(t.peerId)}
                onClick={() => {
                  if (selectMode) toggleSelected(t.peerId);
                  else onSelect(t);
                }}
                onLongPress={() => {
                  if (!selectMode) { setSelectMode(true); setSelected(new Set([t.peerId])); }
                }}
                onMenu={(x, y) => setMenuFor({ t, x, y })}
              />
            </StaggerItem>
          ))}
        </AnimatePresence>
      </div>

      {menuFor && createPortal(
        <RowMenu
          t={menuFor.t} x={menuFor.x} y={menuFor.y}
          onClose={() => setMenuFor(null)}
          onPin={() => { pin(menuFor.t); setMenuFor(null); }}
          onArchive={() => { archive(menuFor.t); setMenuFor(null); }}
          onDelete={() => { del(menuFor.t); setMenuFor(null); }}
          onSelect={() => { setSelectMode(true); setSelected(new Set([menuFor.t.peerId])); setMenuFor(null); }}
        />, document.body)}
    </div>
  );
}

function ThreadRow({
  t, active, selectMode, selected, onClick, onLongPress, onMenu,
}: {
  t: Thread; active: boolean; selectMode: boolean; selected: boolean;
  onClick: () => void; onLongPress: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const pressTimer = useRef<number | null>(null);
  const [hover, setHover] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  function startPress() {
    pressTimer.current = window.setTimeout(() => { onLongPress(); }, 500);
  }
  function endPress() {
    if (pressTimer.current) { window.clearTimeout(pressTimer.current); pressTimer.current = null; }
  }

  function openMenu(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    const r = rowRef.current?.getBoundingClientRect();
    onMenu(r ? Math.min(r.right - 180, window.innerWidth - 190) : e.clientX, r ? r.top + 36 : e.clientY);
  }

  return (
    <div
      ref={rowRef}
      onContextMenu={openMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); endPress(); }}
      onTouchStart={startPress}
      onTouchEnd={endPress}
      onTouchMove={endPress}
      style={{ position: "relative" }}
    >
      <motion.button
        onClick={onClick}
        whileHover={{ x: 2 }}
        transition={{ type: "spring", stiffness: 400, damping: 34 }}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          padding: 12, borderRadius: 14,
          background: selected ? "var(--glass-bg-hi)" : active ? "var(--glass-bg-hi)" : "transparent",
          border: (selected || active) ? "1px solid var(--glass-border-hi)" : "1px solid transparent",
          textAlign: "left", cursor: "pointer",
        }}
      >
        {selectMode && (
          <span style={{
            width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
            border: selected ? "none" : "2px solid var(--line-strong)",
            background: selected ? "var(--accent)" : "transparent",
            color: "#0f1226", display: "grid", placeItems: "center",
          }}>{selected && <Icon.check />}</span>
        )}
        <Avatar name={t.title} group={t.isGroup} online={t.online} src={rowAvatar(t)} size="md" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
            <div style={{
              fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              display: "flex", alignItems: "center", gap: 6,
            }}>
              {t.pinned && <span style={{ color: "var(--accent)", display: "inline-flex" }} title="Pinned"><Icon.pin /></span>}
              {t.title}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{formatTime(t.updatedAt)}</div>
          </div>
          <div style={{
            fontSize: 13, color: "var(--text-dim)", overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{t.subtitle}</div>
        </div>
        {t.unread > 0 && !selectMode && (
          <div style={{
            background: "var(--accent)", color: "#0f1226", borderRadius: 999,
            padding: "2px 8px", fontSize: 11, fontWeight: 700, minWidth: 22, textAlign: "center",
          }}>{t.unread > 99 ? "99+" : t.unread}</div>
        )}
      </motion.button>
      {/* Desktop hover kebab for quick single-row actions. */}
      {!selectMode && hover && (
        <button
          onClick={openMenu}
          aria-label="Chat options"
          style={{
            all: "unset", cursor: "pointer", position: "absolute",
            right: 10, top: "50%", transform: "translateY(-50%)",
            width: 28, height: 28, borderRadius: 8, display: "grid", placeItems: "center",
            background: "var(--glass-bg-hi)", color: "var(--text)",
          }}
        >
          <Icon.kebab />
        </button>
      )}
    </div>
  );
}

function RowMenu({
  t, x, y, onClose, onPin, onArchive, onDelete, onSelect,
}: {
  t: Thread; x: number; y: number; onClose: () => void;
  onPin: () => void; onArchive: () => void; onDelete: () => void; onSelect: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", close, true); };
  }, [onClose]);
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.12 }}
      onClick={(e) => e.stopPropagation()}
      className="glass"
      style={{
        position: "fixed", left: x, top: y, zIndex: 900,
        width: 180, padding: 6, borderRadius: 12,
        display: "flex", flexDirection: "column", gap: 2,
      }}
    >
      <MenuRow icon={<Icon.pin />} label={t.pinned ? "Unpin" : "Pin"} onClick={onPin} />
      <MenuRow icon={<Icon.archive />} label={t.archived ? "Unarchive" : "Archive"} onClick={onArchive} />
      <MenuRow icon={<Icon.check />} label="Select" onClick={onSelect} />
      <MenuRow icon={<Icon.trash />} label="Delete" danger onClick={onDelete} />
    </motion.div>
  );
}

function MenuRow({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick}
      style={{
        all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
        padding: "9px 10px", minHeight: 40, borderRadius: 8, fontSize: 14,
        color: danger ? "var(--danger)" : "var(--text)",
      }}>
      {icon} {label}
    </button>
  );
}

function EmptyThreadHint({ onCompose }: { onCompose: () => void }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      style={{ padding: 20, textAlign: "center", color: "var(--text-dim)" }}>
      <div style={{ fontSize: 34, marginBottom: 8 }}>💬</div>
      <div style={{ marginBottom: 12 }}>No conversations yet. Start one.</div>
      <Button variant="primary" onClick={onCompose}><Icon.plus /> New chat</Button>
    </motion.div>
  );
}

// A "note to self" thread's peer id IS the current user's id, which
// never has a contacts row (contacts = other people), so t.avatar
// comes back null and the row shows a lonely initial. Patch it with
// the signed-in user's own profile photo so self-chats look right.
function rowAvatar(t: Thread): string | null | undefined {
  if (t.avatar) return t.avatar;
  const me = currentSession()?.user;
  if (me && !t.isGroup && t.peerId === me.id) return me.avatar ?? undefined;
  return t.avatar;
}

function formatTime(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const oneDay = 86400_000;
  if (now.getTime() - t < 7 * oneDay) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
