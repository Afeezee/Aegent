// Top-level navigation: a bottom bar on phones, a rail on wide screens.
//
// One component for both because the only real difference is the axis.
// Keeping them together means a destination can never exist in one and
// be missing from the other.
//
// The bar is hidden inside an open chat on mobile, which is what every
// messenger does: the composer lives at the bottom of a conversation and
// two bars stacked there is a tap-target fight nobody wins.

import { motion } from "framer-motion";
import { Icon } from "./ui.js";

export type Dest = "chats" | "groups" | "diary" | "discover";

const DESTS: Array<{ id: Dest; label: string; icon: () => JSX.Element }> = [
  { id: "chats", label: "Chats", icon: Icon.chat },
  { id: "groups", label: "Groups", icon: Icon.users },
  { id: "diary", label: "Diary", icon: Icon.diary },
  { id: "discover", label: "Discover", icon: Icon.compass },
];

export function TabBar({
  dest, onSelect, unread,
}: {
  dest: Dest;
  onSelect: (d: Dest) => void;
  unread?: Partial<Record<Dest, number>>;
}) {
  return (
    <nav
      aria-label="Sections"
      style={{
        position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 300,
        display: "grid", gridTemplateColumns: `repeat(${DESTS.length}, 1fr)`,
        height: "calc(var(--tabbar-h) + var(--safe-bottom))",
        paddingBottom: "var(--safe-bottom)",
        background: "rgba(10,13,28,0.86)",
        backdropFilter: "blur(18px)",
        borderTop: "1px solid var(--line)",
      }}
    >
      {DESTS.map((d) => (
        <TabButton key={d.id} d={d} active={dest === d.id} badge={unread?.[d.id] ?? 0}
          onSelect={onSelect} orientation="horizontal" />
      ))}
    </nav>
  );
}

export function NavRail({
  dest, onSelect, unread,
}: {
  dest: Dest;
  onSelect: (d: Dest) => void;
  unread?: Partial<Record<Dest, number>>;
}) {
  return (
    <nav
      aria-label="Sections"
      className="glass"
      style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        gap: 6, padding: "14px 6px", borderRadius: 18, overflow: "hidden",
      }}
    >
      {DESTS.map((d) => (
        <TabButton key={d.id} d={d} active={dest === d.id} badge={unread?.[d.id] ?? 0}
          onSelect={onSelect} orientation="vertical" />
      ))}
    </nav>
  );
}

function TabButton({
  d, active, badge, onSelect, orientation,
}: {
  d: { id: Dest; label: string; icon: () => JSX.Element };
  active: boolean;
  badge: number;
  onSelect: (x: Dest) => void;
  orientation: "horizontal" | "vertical";
}) {
  const Ico = d.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(d.id)}
      aria-label={d.label}
      aria-current={active ? "page" : undefined}
      style={{
        all: "unset",
        cursor: "pointer",
        position: "relative",
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", gap: 3,
        width: orientation === "vertical" ? 48 : "auto",
        height: orientation === "vertical" ? 48 : "100%",
        borderRadius: 14,
        color: active ? "var(--text)" : "var(--text-mute)",
        background: active ? "rgba(138,125,255,0.16)" : "transparent",
        transition: "color .15s var(--ease), background .15s var(--ease)",
      }}
    >
      <span style={{ position: "relative", display: "grid", placeItems: "center" }}>
        <Ico />
        {badge > 0 && (
          <span
            aria-label={`${badge} new`}
            style={{
              position: "absolute", top: -3, right: -6, minWidth: 8, height: 8,
              borderRadius: 999, background: "var(--aqua)",
              boxShadow: "0 0 0 2px rgba(10,13,28,0.9)",
            }}
          />
        )}
      </span>
      {orientation === "horizontal" && (
        <span style={{ fontSize: 10.5, letterSpacing: 0.2 }}>{d.label}</span>
      )}
      {active && orientation === "vertical" && (
        <motion.span
          layoutId="rail-active"
          style={{
            position: "absolute", left: -6, top: 12, bottom: 12, width: 3,
            borderRadius: 999, background: "linear-gradient(var(--violet), var(--aqua))",
          }}
        />
      )}
    </button>
  );
}
