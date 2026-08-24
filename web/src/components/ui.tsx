// Small, opinionated UI primitives used across every screen. Each one
// leans on the tokens defined in styles.css so the whole app looks like
// it belongs to a single design system rather than a stack of screens.

import { AnimatePresence, motion, useReducedMotion, type MotionProps } from "framer-motion";
import { forwardRef, useEffect, useState, type CSSProperties, type MouseEvent, type PropsWithChildren, type ReactNode } from "react";

// ---- glass panels ----

export function Glass({
  children, className = "", raised = false, style,
}: PropsWithChildren<{ className?: string; raised?: boolean; style?: CSSProperties }>) {
  return (
    <div className={`glass ${raised ? "glass-hi" : ""} ${className}`} style={style}>
      {children}
    </div>
  );
}

// ---- avatar ----

export function Avatar({
  name = "?", size = "md", group = false, online, style,
}: {
  name?: string; size?: "sm" | "md" | "lg" | "xl"; group?: boolean;
  online?: boolean; style?: CSSProperties;
}) {
  const initials = (name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("") || "?").toUpperCase();
  const hue = hashHue(name);
  return (
    <div
      className={`avatar ${size} ${group ? "group" : ""}`}
      style={{ background: gradientFor(hue, group), ...style }}
      aria-label={name}
    >
      <span>{initials}</span>
      {online && <span className="presence-dot" title="online" />}
    </div>
  );
}
function hashHue(s: string): number {
  let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}
function gradientFor(hue: number, group: boolean): string {
  const a = `hsl(${hue}deg 80% 68%)`;
  const b = `hsl(${(hue + (group ? 60 : 40)) % 360}deg 82% 60%)`;
  return `linear-gradient(135deg, ${a}, ${b})`;
}

// ---- button (with a subtle press animation) ----

type BtnProps = PropsWithChildren<{
  variant?: "primary" | "ghost" | "danger" | "default" | "icon";
  size?: "small" | "default";
  pill?: boolean;
  disabled?: boolean;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  type?: "button" | "submit" | "reset";
  className?: string;
  title?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}>;

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { children, variant = "default", size = "default", pill, disabled, onClick, type = "button", className = "", title, style, ...rest },
  ref,
) {
  const cls = [
    "btn",
    variant !== "default" ? variant : "",
    size === "small" ? "small" : "",
    pill ? "pill" : "",
    className,
  ].filter(Boolean).join(" ");
  return (
    <motion.button
      ref={ref}
      className={cls}
      whileTap={{ scale: 0.96 }}
      whileHover={{ y: -1 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      onClick={onClick}
      disabled={disabled}
      type={type}
      title={title}
      style={style}
      aria-label={rest["aria-label"]}
    >
      {children}
    </motion.button>
  );
});

// ---- sheet / modal ----

export function Modal({
  open, onClose, title, children, footer, width = 460,
}: {
  open: boolean; onClose: () => void; title: ReactNode;
  children: ReactNode; footer?: ReactNode; width?: number;
}) {
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(4, 6, 16, 0.55)",
            display: "grid", placeItems: "center", padding: 20,
            backdropFilter: "blur(10px)",
          }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.18 }}
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            className="glass glass-hi"
            style={{ width: "100%", maxWidth: width, padding: 22, borderRadius: 20 }}
            initial={{ y: 24, scale: 0.98, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 12, scale: 0.98, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 26 }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <h2 style={{ fontSize: 18 }}>{title}</h2>
              <Button variant="icon" onClick={onClose} aria-label="Close">✕</Button>
            </div>
            <div>{children}</div>
            {footer && <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---- toast ----

export type Toast = { id: string; text: string; kind?: "info" | "ok" | "warn" | "error" };
const toastListeners = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = [];
export function toast(text: string, kind: Toast["kind"] = "info") {
  const t: Toast = { id: crypto.randomUUID(), text, kind };
  toasts = [...toasts, t];
  toastListeners.forEach((f) => f(toasts));
  window.setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    toastListeners.forEach((f) => f(toasts));
  }, 3500);
}

export function ToastHost() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => { toastListeners.add(setList); return () => { toastListeners.delete(setList); }; }, []);
  return (
    <div style={{ position: "fixed", right: 20, bottom: 20, display: "flex", flexDirection: "column", gap: 8, zIndex: 2000, maxWidth: 320 }}>
      <AnimatePresence>
        {list.map((t) => (
          <motion.div
            key={t.id}
            className="glass glass-hi"
            style={{ padding: "10px 14px", fontSize: 13, borderRadius: 12, minWidth: 220,
              color: t.kind === "error" ? "var(--danger)" : t.kind === "ok" ? "var(--ok)" : t.kind === "warn" ? "var(--amber)" : undefined,
            }}
            initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          >{t.text}</motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ---- motion helpers ----

export function FadeIn({ children, delay = 0, ...rest }: PropsWithChildren<{ delay?: number } & MotionProps>) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.22, delay, ease: [0.22, 1, 0.36, 1] }}
      {...rest}
    >{children}</motion.div>
  );
}

export function Stagger({ children, delay = 0, gap = 0.05 }: PropsWithChildren<{ delay?: number; gap?: number }>) {
  return (
    <motion.div
      initial="hidden" animate="show"
      variants={{ hidden: {}, show: { transition: { staggerChildren: gap, delayChildren: delay } } }}
    >{children}</motion.div>
  );
}

export const StaggerItem: React.FC<PropsWithChildren> = ({ children }) => (
  <motion.div variants={{
    hidden: { opacity: 0, y: 10 },
    show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } },
  }}>{children}</motion.div>
);

// ---- icons — small inline SVGs so we don't ship an icon font ----
// Every icon is a 20x20 line-icon that inherits `currentColor`.

const ico = (path: ReactNode, size = 20) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {path}
  </svg>
);

export const Icon = {
  send: () => ico(<><path d="M17 3L3 10l6 2 2 6 6-15z" /></>),
  search: () => ico(<><circle cx="9" cy="9" r="6" /><path d="M17 17l-3.5-3.5" /></>),
  plus: () => ico(<><path d="M10 4v12M4 10h12" /></>),
  users: () => ico(<><circle cx="7" cy="8" r="3" /><circle cx="14" cy="8" r="2.5" /><path d="M1 17c0-3 3-5 6-5s6 2 6 5" /><path d="M13 12c2 0 6 1 6 5" /></>),
  qr: () => ico(<><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="11" y="3" width="6" height="6" rx="1" /><rect x="3" y="11" width="6" height="6" rx="1" /><path d="M11 11h2v2h-2zM15 11h2v2h-2zM11 15h6" /></>),
  paperclip: () => ico(<><path d="M15.5 6.5l-7.4 7.4a3 3 0 104.2 4.3l7.7-7.8a4.7 4.7 0 10-6.6-6.7L5.7 12" /></>),
  mic: () => ico(<><rect x="7" y="2" width="6" height="10" rx="3" /><path d="M4 10a6 6 0 0012 0M10 16v3" /></>),
  smile: () => ico(<><circle cx="10" cy="10" r="7" /><path d="M7 12c1 1.5 4 1.5 5 0" /><circle cx="7.5" cy="8" r=".7" fill="currentColor" /><circle cx="12.5" cy="8" r=".7" fill="currentColor" /></>),
  reply: () => ico(<><path d="M10 5L4 10l6 5v-3c5 0 7 2 7 5 0-6-3-9-7-9V5z" /></>),
  edit: () => ico(<><path d="M14 3l3 3-9 9H5v-3l9-9z" /></>),
  trash: () => ico(<><path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11" /></>),
  forward: () => ico(<><path d="M10 5l6 5-6 5v-3c-5 0-7 2-7 5 0-6 3-9 7-9V5z" /></>),
  copy: () => ico(<><rect x="6" y="6" width="10" height="12" rx="2" /><path d="M4 14V4h10" /></>),
  x: () => ico(<><path d="M5 5l10 10M15 5L5 15" /></>),
  check: () => ico(<><path d="M4 10l4 4 8-8" /></>),
  checkDouble: () => ico(<><path d="M2 10l4 4 6-6M9 14l4 4 5-9" /></>),
  moon: () => ico(<><path d="M15 12A5 5 0 018 5a6 6 0 107 7z" /></>),
  agent: () => ico(<><path d="M10 3a5 5 0 015 5v2a3 3 0 01-3 3H8a3 3 0 01-3-3V8a5 5 0 015-5z" /><path d="M8 15v2M12 15v2M6 19h8" /></>),
  settings: () => ico(<><circle cx="10" cy="10" r="2.5" /><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.4 4.4l1.4 1.4M14.2 14.2l1.4 1.4M4.4 15.6l1.4-1.4M14.2 5.8l1.4-1.4" /></>),
  logout: () => ico(<><path d="M12 4H4v12h8M15 10H8M12 7l3 3-3 3" /></>),
  photo: () => ico(<><rect x="3" y="4" width="14" height="12" rx="2" /><circle cx="8" cy="9" r="1.6" /><path d="M17 14l-4-4-8 6" /></>),
  play: () => ico(<><path d="M6 4l10 6-10 6V4z" fill="currentColor" stroke="none" /></>),
  pause: () => ico(<><rect x="5" y="4" width="4" height="12" rx="1" fill="currentColor" stroke="none" /><rect x="11" y="4" width="4" height="12" rx="1" fill="currentColor" stroke="none" /></>),
  chevron: () => ico(<><path d="M6 4l6 6-6 6" /></>),
  link: () => ico(<><path d="M8 12l4-4M6 10a3.5 3.5 0 015-5l2 2M14 8a3.5 3.5 0 01-5 5l-2-2" /></>),
};
