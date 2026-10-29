// Small, opinionated UI primitives used across every screen. Each one
// leans on the tokens defined in styles.css so the whole app looks like
// it belongs to a single design system rather than a stack of screens.

import { AnimatePresence, motion, useReducedMotion, type MotionProps } from "framer-motion";
import { Component, forwardRef, useEffect, useState, type CSSProperties, type ErrorInfo, type MouseEvent, type PropsWithChildren, type ReactNode } from "react";

// ---- error boundary ----
// Wraps any subtree so an exception during render or in an effect
// shows an inline retry card instead of nuking the whole page to a
// blank white screen. Used around Chat, Agent, and Modal contents.

type EBState = { error: Error | null };
export class ErrorBoundary extends Component<PropsWithChildren<{ label?: string }>, EBState> {
  state: EBState = { error: null };
  static getDerivedStateFromError(error: Error): EBState { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface once in the console so USB-debugging picks it up. Never
    // toasts — a toast would just re-render into whatever tore up.
    console.error(`[ErrorBoundary${this.props.label ? ` ${this.props.label}` : ""}]`, error, info.componentStack);
  }
  reset = () => this.setState({ error: null });
  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)" }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
        <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
          Something went sideways rendering this view.
        </div>
        <div className="small" style={{ marginBottom: 12, wordBreak: "break-word" }}>
          {this.state.error.message}
        </div>
        <button className="btn small" onClick={this.reset}>Try again</button>
      </div>
    );
  }
}

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
  name = "?", size = "md", group = false, online, style, src,
}: {
  name?: string; size?: "sm" | "md" | "lg" | "xl"; group?: boolean;
  online?: boolean; style?: CSSProperties;
  // Optional profile image (base64 data URI). Falls back to initials.
  src?: string | null;
}) {
  const initials = (name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("") || "?").toUpperCase();
  const hue = hashHue(name);
  return (
    <div
      className={`avatar ${size} ${group ? "group" : ""}`}
      style={{ background: src ? "transparent" : gradientFor(hue, group), ...style }}
      aria-label={name}
    >
      {src
        ? <img src={src} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit", display: "block" }} />
        : <span>{initials}</span>}
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
            display: "grid", placeItems: "center",
            // Safe-area padding so the modal doesn't clip under the
            // Android nav bar or a top notch.
            paddingTop: "calc(20px + var(--safe-top))",
            paddingBottom: "calc(20px + var(--tabbar-h) + var(--safe-bottom))",
            paddingLeft: "calc(20px + var(--safe-left))",
            paddingRight: "calc(20px + var(--safe-right))",
            backdropFilter: "blur(10px)",
          }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.18 }}
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            className="glass glass-hi"
            style={{
              width: "100%", maxWidth: width, borderRadius: 20,
              // Fit inside the viewport with safe-area on both sides.
              // Body scrolls when it would overflow; header + footer stay put.
              maxHeight: "calc(var(--app-h) - 40px - var(--safe-top) - var(--safe-bottom))",
              display: "flex", flexDirection: "column",
              overflow: "hidden",
              // Never scroll sideways — every child wraps or scrolls-its-own.
              overflowX: "hidden",
            }}
            initial={{ y: 24, scale: 0.98, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 12, scale: 0.98, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 26 }}
          >
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 12,
              padding: "18px 18px 12px", flexShrink: 0,
              borderBottom: "1px solid var(--line)",
              minWidth: 0,
            }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 18 }}>{title}</div>
              <Button variant="icon" onClick={onClose} aria-label="Close">✕</Button>
            </div>
            <div style={{
              flex: 1, minHeight: 0, overflowY: "auto",
              padding: "16px 22px",
            }}>{children}</div>
            {footer && (
              <div style={{
                display: "flex", gap: 8, justifyContent: "flex-end",
                padding: "12px 22px 18px", flexShrink: 0,
                borderTop: "1px solid var(--line)",
              }}>{footer}</div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---- toast ----

export type Toast = {
  id: string;
  text: string;
  kind?: "info" | "ok" | "warn" | "error";
  progress?: number; // 0..1 — when present, render a slim progress bar under the text
  sticky?: boolean;  // if true, never auto-dismiss (caller manages via toastDismiss)
};
const toastListeners = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = [];
const AUTO_DISMISS_MS = 3500;
const scheduled = new Map<string, number>();

function notify() { toastListeners.forEach((f) => f(toasts)); }
function scheduleDismiss(id: string) {
  const prev = scheduled.get(id);
  if (prev) window.clearTimeout(prev);
  const h = window.setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== id);
    scheduled.delete(id);
    notify();
  }, AUTO_DISMISS_MS);
  scheduled.set(id, h);
}

// Show a transient status. Returns an id the caller can update or
// dismiss. For long-running work (uploads, transcription) pass
// `sticky: true` so it stays put and use toastUpdate/toastDismiss.
export function toast(text: string, kind: Toast["kind"] = "info", opts: { sticky?: boolean; progress?: number } = {}): string {
  const t: Toast = { id: crypto.randomUUID(), text, kind, progress: opts.progress, sticky: opts.sticky };
  toasts = [...toasts, t];
  notify();
  if (!opts.sticky) scheduleDismiss(t.id);
  return t.id;
}
export function toastUpdate(id: string, patch: Partial<Omit<Toast, "id">>): void {
  toasts = toasts.map((t) => t.id === id ? { ...t, ...patch } : t);
  notify();
  // If the caller changed sticky → false, re-schedule dismissal.
  if (patch.sticky === false) scheduleDismiss(id);
}
export function toastDismiss(id: string): void {
  toasts = toasts.filter((t) => t.id !== id);
  const h = scheduled.get(id); if (h) window.clearTimeout(h);
  scheduled.delete(id);
  notify();
}

export function ToastHost() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => { toastListeners.add(setList); return () => { toastListeners.delete(setList); }; }, []);
  return (
    <div style={{
      position: "fixed",
      right: "calc(20px + var(--safe-right))",
      bottom: "calc(20px + var(--tabbar-h) + var(--safe-bottom))",
      display: "flex", flexDirection: "column", gap: 8, zIndex: 2000, maxWidth: 320,
    }}>
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
          >
            <div>{t.text}</div>
            {typeof t.progress === "number" && (
              <div style={{
                marginTop: 8, height: 4, borderRadius: 999,
                background: "rgba(255,255,255,0.1)", overflow: "hidden",
              }}>
                <div style={{
                  width: `${Math.max(0, Math.min(1, t.progress)) * 100}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, var(--violet), var(--aqua))",
                  transition: "width .18s ease-out",
                }} />
              </div>
            )}
          </motion.div>
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
  chat: () => ico(<><path d="M3 6a2 2 0 012-2h10a2 2 0 012 2v6a2 2 0 01-2 2H8l-4 3v-3a2 2 0 01-1-2V6z" /></>),
  diary: () => ico(<><path d="M5 3h9a1 1 0 011 1v12a1 1 0 01-1 1H5a2 2 0 01-2-2V5a2 2 0 012-2z" /><path d="M3 14.5A2 2 0 015 13h10" /><path d="M7 7h5" /></>),
  clock: () => ico(<><circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.5 2" /></>),
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
  // Delivery ticks. Both built from one identical check shape so the
  // single and double read as the same mark; the double is just two of
  // them nested with a fixed 5px offset, the way every messaging app
  // draws them. Rendered a touch larger than the timestamp text so they
  // sit cleanly on the baseline rather than looming over it.
  check: () => ico(<><path d="M5 10.5l3 3 5.5-6" /></>, 15),
  checkDouble: () => ico(<><path d="M2.5 10.5l3 3 5.5-6" /><path d="M7.5 10.5l3 3 5.5-6" /></>, 15),
  moon: () => ico(<><path d="M15 12A5 5 0 018 5a6 6 0 107 7z" /></>),
  // Sparkles — the near-universal AI-assistant glyph. A big 4-point star
  // plus two smaller companions.
  agent: () => ico(<>
    <path d="M10 2.5l1.4 4 4 1.4-4 1.4L10 13.5 8.6 9.3 4.6 7.9l4-1.4z" fill="currentColor" stroke="none" />
    <path d="M15.5 12l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" fill="currentColor" stroke="none" />
    <path d="M5.2 14.2l.4 1.1 1.1.4-1.1.4-.4 1.1-.4-1.1-1.1-.4 1.1-.4z" fill="currentColor" stroke="none" />
  </>),
  // Cog with real teeth — silhouette rather than the compass-lookalike
  // we had before.
  settings: () => ico(<>
    <path d="M10 1.6l1 .3.3 1.4a5.5 5.5 0 011.6.7l1.3-.7 1.5 1.5-.7 1.3a5.5 5.5 0 01.7 1.6l1.4.3v2.2l-1.4.3a5.5 5.5 0 01-.7 1.6l.7 1.3-1.5 1.5-1.3-.7a5.5 5.5 0 01-1.6.7l-.3 1.4h-2.2l-.3-1.4a5.5 5.5 0 01-1.6-.7l-1.3.7-1.5-1.5.7-1.3a5.5 5.5 0 01-.7-1.6L1.6 11V8.9l1.4-.3a5.5 5.5 0 01.7-1.6l-.7-1.3 1.5-1.5 1.3.7a5.5 5.5 0 011.6-.7l.3-1.4L9 1.6z" />
    <circle cx="10" cy="10" r="2.4" />
  </>),
  // Contacts book — for the "import from phone" affordance.
  contacts: () => ico(<>
    <rect x="4" y="3" width="12" height="14" rx="2" />
    <path d="M4 7h-1M4 10h-1M4 13h-1" />
    <circle cx="10" cy="9" r="2" />
    <path d="M6.5 14a3.5 3.5 0 017 0" />
  </>),
  // Phone handset — for the SMS invite affordance.
  phone: () => ico(<>
    <path d="M4 3h3l1.5 4-2 1.5a10 10 0 005 5L13 11.5 17 13v3a2 2 0 01-2 2A12 12 0 013 5a2 2 0 011-2z" />
  </>),
  logout: () => ico(<><path d="M12 4H4v12h8M15 10H8M12 7l3 3-3 3" /></>),
  photo: () => ico(<><rect x="3" y="4" width="14" height="12" rx="2" /><circle cx="8" cy="9" r="1.6" /><path d="M17 14l-4-4-8 6" /></>),
  play: () => ico(<><path d="M6 4l10 6-10 6V4z" fill="currentColor" stroke="none" /></>),
  pause: () => ico(<><rect x="5" y="4" width="4" height="12" rx="1" fill="currentColor" stroke="none" /><rect x="11" y="4" width="4" height="12" rx="1" fill="currentColor" stroke="none" /></>),
  chevron: () => ico(<><path d="M6 4l6 6-6 6" /></>),
  link: () => ico(<><path d="M8 12l4-4M6 10a3.5 3.5 0 015-5l2 2M14 8a3.5 3.5 0 01-5 5l-2-2" /></>),
  kebab: () => ico(<><circle cx="10" cy="4.5" r="1.4" fill="currentColor" stroke="none" /><circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none" /><circle cx="10" cy="15.5" r="1.4" fill="currentColor" stroke="none" /></>),
  transcribe: () => ico(<><path d="M4 4h8M4 8h12M4 12h9M4 16h6" /><path d="M15 14l3 3" /><circle cx="15" cy="14" r="2.5" /></>),
  pin: () => ico(<><path d="M9 2.5h2l.6 5.2 2.4 2.1v1.4H5.4v-1.4l2.4-2.1L8.4 2.5" /><path d="M10 12.7V17" /></>),
  archive: () => ico(<><rect x="3" y="4" width="14" height="4" rx="1" /><path d="M4.5 8v6.5a1 1 0 001 1h9a1 1 0 001-1V8M8 11h4" /></>),
  compass: () => ico(<><circle cx="10" cy="10" r="7.5" /><path d="M13.2 6.8l-2 4.4-4.4 2 2-4.4 4.4-2z" /></>),
  // Sticker: a rounded tile with its bottom-right corner peeled up — the
  // universal sticker glyph, plus a tiny smile so it reads as playful
  // rather than as a document.
  sticker: () => ico(<>
    <path d="M4.5 3.5h11A1.5 1.5 0 0117 5v6.5L11.5 17H4.5A1.5 1.5 0 013 15.5V5a1.5 1.5 0 011.5-1.5z" />
    <path d="M11.5 17v-4a1.5 1.5 0 011.5-1.5h4" />
    <path d="M7 8.5h.01M11 8.5h.01M7.4 11.5a2.2 2.2 0 003.2 0" />
  </>),
  // View-once: an eye, clean line-art. The toggle itself glows when ON,
  // so the glyph only has to say "visibility", which an eye does best.
  viewOnce: () => ico(<>
    <path d="M2.5 10S5.2 5 10 5s7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5z" />
    <circle cx="10" cy="10" r="2.2" />
  </>),
  // Business/storefront: a shop awning over a doorway. Reads as "trade"
  // rather than "wallet" so it stays coherent with the Discover and
  // Diary glyphs (buildings/surfaces, not money).
  business: () => ico(<>
    <path d="M3 7l1.5-3h11L17 7" />
    <path d="M3 7v9a1 1 0 001 1h12a1 1 0 001-1V7" />
    <path d="M8 17v-5h4v5" />
  </>),
  // Pin used specifically for the anchored product strip. Simpler than
  // the "pinned chat" push-pin — a thumbtack silhouette is clearer at
  // 16px than a repurposed location pin.
  anchor: () => ico(<>
    <path d="M10 3v9" />
    <path d="M6 7l4-4 4 4" />
    <path d="M5 14h10" />
    <path d="M7 17l3-3 3 3" />
  </>),
};
