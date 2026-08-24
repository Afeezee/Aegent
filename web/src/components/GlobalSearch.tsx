// Cmd-K overlay. Runs a hybrid keyword + semantic search across every
// message in the local encrypted store and clicking a result jumps you
// straight to that thread.

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Avatar, Glass, Icon } from "./ui.js";
import { everyMessage, getContact, getGroup } from "../lib/store.js";
import { cosine, embed, tokenize } from "../lib/embeddings.js";

type Hit = {
  msgId: string;
  peerId: string;
  isGroup: boolean;
  title: string;
  preview: string;
  when: number;
  score: number;
};

export function GlobalSearch({
  open, onClose, onOpenThread,
}: {
  open: boolean;
  onClose: () => void;
  onOpenThread: (peerId: string, isGroup: boolean, jumpToMsg?: string) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) { setQ(""); setHits([]); return; }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    let cancelled = false;
    if (!q.trim()) { setHits([]); return; }
    setBusy(true);
    const t = window.setTimeout(async () => {
      const results = await runSearch(q.trim());
      if (!cancelled) { setHits(results); setBusy(false); }
    }, 120);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [q]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
          style={{
            position: "fixed", inset: 0, zIndex: 900,
            background: "rgba(4,6,16,0.55)",
            backdropFilter: "blur(10px)",
            padding: "10vh 20px",
            display: "flex", justifyContent: "center", alignItems: "flex-start",
          }}
        >
          <motion.div
            initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 8, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 26 }}
            style={{ width: "min(640px, 100%)" }}
          >
            <Glass raised style={{ padding: 12, borderRadius: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 10 }}>
                <Icon.search />
                <input value={q} onChange={(e) => setQ(e.target.value)}
                  placeholder="Search every conversation…"
                  autoFocus
                  style={{ background: "transparent", border: "none", padding: 0, fontSize: 16 }} />
                <span className="kbd">esc</span>
              </div>
              <div style={{ borderTop: "1px solid var(--line)" }}>
                {busy && <div className="small" style={{ padding: 16 }}>searching…</div>}
                {!busy && q && hits.length === 0 && (
                  <div className="small" style={{ padding: 16 }}>No matches. Try what you meant, not what you said.</div>
                )}
                {!q && (
                  <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 13 }}>
                    Try <em>“the pricing chat with the design team”</em> or <em>“invoice from last month”</em>.
                    Aegent understands meaning, not just keywords.
                  </div>
                )}
                <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
                  {hits.map((h) => (
                    <motion.button key={h.msgId}
                      whileHover={{ x: 3 }}
                      onClick={() => { onOpenThread(h.peerId, h.isGroup, h.msgId); onClose(); }}
                      style={{
                        display: "flex", gap: 10, alignItems: "flex-start", padding: 12,
                        background: "transparent", border: "none", width: "100%",
                        textAlign: "left", cursor: "pointer", borderTop: "1px solid var(--line)",
                      }}>
                      <Avatar name={h.title} group={h.isGroup} size="sm" />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                          <div style={{ fontWeight: 600 }}>{h.title}</div>
                          <div className="small">{new Date(h.when).toLocaleDateString()}</div>
                        </div>
                        <div className="small" style={{
                          color: "var(--text-dim)", overflow: "hidden",
                          textOverflow: "ellipsis", display: "-webkit-box",
                          WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                        }}>{h.preview}</div>
                      </div>
                    </motion.button>
                  ))}
                </div>
              </div>
            </Glass>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

async function runSearch(q: string): Promise<Hit[]> {
  const qv = embed(q);
  const qToks = new Set(tokenize(q));
  const rows = await everyMessage();
  const out: Hit[] = [];
  const cacheTitle = new Map<string, { title: string; isGroup: boolean }>();
  for (const m of rows) {
    if (!m.embedding.length) continue;
    if (m.deletedAt) continue;
    const text = m.editedBody ?? m.body ?? m.caption ?? "";
    if (!text) continue;
    const semantic = cosine(qv, m.embedding);
    const mToks = new Set((m.tokens || "").split(" "));
    let overlap = 0; qToks.forEach((t) => mToks.has(t) && overlap++);
    const keyword = qToks.size ? overlap / qToks.size : 0;
    const score = semantic * 0.7 + keyword * 0.3;
    if (score > 0.08) {
      let meta = cacheTitle.get(m.peerId);
      if (!meta) {
        const c = await getContact(m.peerId);
        if (c) meta = { title: c.displayName, isGroup: false };
        else {
          const g = await getGroup(m.peerId);
          meta = g ? { title: g.name, isGroup: true } : { title: "Unknown", isGroup: false };
        }
        cacheTitle.set(m.peerId, meta);
      }
      out.push({
        msgId: m.id, peerId: m.peerId, isGroup: meta.isGroup,
        title: meta.title, preview: text, when: m.createdAt, score,
      });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 12);
}
