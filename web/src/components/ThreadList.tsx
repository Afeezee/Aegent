// Left rail — every conversation, most-recent first.

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Avatar, Button, Icon, StaggerItem } from "./ui.js";
import { listThreads, type Thread } from "../lib/store.js";

export function ThreadList({
  activeId, onSelect, onCompose, onOpenSearch, refreshKey,
}: {
  activeId: string | null;
  onSelect: (t: Thread) => void;
  onCompose: () => void;
  onOpenSearch: () => void;
  refreshKey: number;
}) {
  const [threads, setThreads] = useState<Thread[]>([]);
  useEffect(() => { (async () => setThreads(await listThreads()))(); }, [refreshKey]);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
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

      <div style={{ overflowY: "auto", padding: "6px 8px 20px", flex: 1 }}>
        {threads.length === 0 && <EmptyThreadHint onCompose={onCompose} />}
        <AnimatePresence initial={false}>
          {threads.map((t) => (
            <StaggerItem key={t.peerId}>
              <ThreadRow t={t} active={t.peerId === activeId} onClick={() => onSelect(t)} />
            </StaggerItem>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ThreadRow({ t, active, onClick }: { t: Thread; active: boolean; onClick: () => void }) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ x: 2 }}
      transition={{ type: "spring", stiffness: 400, damping: 34 }}
      style={{
        width: "100%", display: "flex", alignItems: "center", gap: 12,
        padding: 12, borderRadius: 14, background: active ? "var(--glass-bg-hi)" : "transparent",
        border: active ? "1px solid var(--glass-border-hi)" : "1px solid transparent",
        textAlign: "left", cursor: "pointer",
      }}
    >
      <Avatar name={t.title} group={t.isGroup} online={t.online} size="md" />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
          <div style={{
            fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{t.title}</div>
          <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{formatTime(t.updatedAt)}</div>
        </div>
        <div style={{
          fontSize: 13, color: "var(--text-dim)", overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{t.subtitle}</div>
      </div>
      {t.unread > 0 && (
        <div style={{
          background: "var(--accent)", color: "#0f1226", borderRadius: 999,
          padding: "2px 8px", fontSize: 11, fontWeight: 700, minWidth: 22, textAlign: "center",
        }}>{t.unread > 99 ? "99+" : t.unread}</div>
      )}
    </motion.button>
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

function formatTime(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const oneDay = 86400_000;
  if (now.getTime() - t < 7 * oneDay) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
