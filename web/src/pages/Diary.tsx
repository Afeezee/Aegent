// The Diary screen.
//
// Two states: the list of pages (yours pinned at the top, then whoever
// has written today), and the reader — one author's page, top to bottom,
// oldest first, because a diary is read downwards.
//
// The reader deliberately does not snap like a stories pager. Entries
// here can be several paragraphs, and a pager that steals the scroll
// mid-sentence makes long writing unreadable. Instead the page ends with
// a plain invitation to continue to the next person.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Avatar, Button, Glass, Icon, toast } from "../components/ui.js";
import { MediaView } from "../components/MediaView.js";
import { DiaryComposer } from "../components/DiaryComposer.js";
import { formatDay } from "../lib/daybreaks.js";
import {
  diaryNow, refreshViewCount, removeDiaryEntry, reportSeen, syncDiary,
} from "../lib/diary.js";
import { currentSession } from "../lib/session.js";
import {
  getContact, liveDiaryEntries, type OpenedDiaryEntry,
} from "../lib/store.js";

type Page = {
  authorId: string;
  authorName: string;
  mine: boolean;
  entries: OpenedDiaryEntry[];
  unseen: number;
  latestAt: number;
};

export function Diary({ refreshKey }: { refreshKey: number }) {
  const me = currentSession()?.user;
  const [pages, setPages] = useState<Page[]>([]);
  const [openAuthor, setOpenAuthor] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!me) return;
    const rows = await liveDiaryEntries(diaryNow());
    const byAuthor = new Map<string, OpenedDiaryEntry[]>();
    for (const row of rows) {
      const list = byAuthor.get(row.authorId) ?? [];
      list.push(row);
      byAuthor.set(row.authorId, list);
    }
    const out: Page[] = [];
    for (const [authorId, entries] of byAuthor) {
      entries.sort((a, b) => a.createdAt - b.createdAt);
      const contact = authorId === me.id ? null : await getContact(authorId);
      out.push({
        authorId,
        authorName: authorId === me.id ? "Your diary" : contact?.displayName ?? "Someone",
        mine: authorId === me.id,
        entries,
        unseen: entries.filter((e) => !e.seenAt && e.authorId !== me.id).length,
        latestAt: entries[entries.length - 1]?.createdAt ?? 0,
      });
    }
    // Ours first, then unseen, then most recent.
    out.sort((a, b) => {
      if (a.mine !== b.mine) return a.mine ? -1 : 1;
      if ((a.unseen > 0) !== (b.unseen > 0)) return a.unseen > 0 ? -1 : 1;
      return b.latestAt - a.latestAt;
    });
    setPages(out);
    setLoading(false);
  }, [me]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  // One pull on open: arriving at the tab is the moment someone most
  // wants it to be current.
  useEffect(() => { syncDiary().then(load).catch(() => { /* the loop retries */ }); }, [load]);

  const mine = pages.find((p) => p.mine);
  const others = pages.filter((p) => !p.mine);
  const reading = openAuthor ? pages.find((p) => p.authorId === openAuthor) : null;

  return (
    <Glass raised style={{ display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      <AnimatePresence mode="wait">
        {reading ? (
          <motion.div key={`read-${reading.authorId}`}
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            style={{ height: "100%", display: "flex", flexDirection: "column" }}
          >
            <Reader
              page={reading}
              nextName={nextAfter(others, reading.authorId)?.authorName ?? null}
              onNext={() => {
                const next = nextAfter(others, reading.authorId);
                setOpenAuthor(next ? next.authorId : null);
              }}
              onBack={() => { setOpenAuthor(null); void load(); }}
              onDeleted={load}
            />
          </motion.div>
        ) : (
          <motion.div key="list"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}
          >
            <header style={{ padding: "16px 18px 10px" }}>
              <h2 style={{ margin: 0, fontSize: 19 }}>Diary</h2>
              <div className="small" style={{ marginTop: 2 }}>
                Yours forever. Your contacts can read each entry for 24 hours.
              </div>
            </header>

            <div style={{ overflowY: "auto", padding: "4px 14px 24px", flex: 1, minHeight: 0 }}>
              <TodayCard
                page={mine}
                onCompose={() => setComposing(true)}
                onOpen={() => mine && setOpenAuthor(mine.authorId)}
              />

              <div style={{ margin: "20px 4px 8px", fontSize: 12, color: "var(--text-dim)", letterSpacing: 0.05 }}>
                TODAY'S PAGES
              </div>
              {loading ? (
                <div className="small" style={{ padding: "10px 4px" }}>Loading…</div>
              ) : others.length === 0 ? (
                <div className="small" style={{ padding: "10px 4px", lineHeight: 1.6 }}>
                  Nobody you know has written today. When they do, their page
                  appears here for a day.
                </div>
              ) : (
                others.map((p) => (
                  <PageRow key={p.authorId} page={p} onClick={() => setOpenAuthor(p.authorId)} />
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <DiaryComposer
        open={composing}
        onClose={() => setComposing(false)}
        onPosted={() => { setComposing(false); void load(); }}
      />
    </Glass>
  );
}

function nextAfter(pages: Page[], authorId: string): Page | null {
  const i = pages.findIndex((p) => p.authorId === authorId);
  if (i < 0) return pages[0] ?? null;
  return pages[i + 1] ?? null;
}

// ---- the list ----

function TodayCard({
  page, onCompose, onOpen,
}: { page?: Page; onCompose: () => void; onOpen: () => void }) {
  const today = page?.entries.filter((e) => isToday(e.createdAt)) ?? [];
  return (
    <div className="glass" style={{ padding: 14, borderRadius: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 12, display: "grid", placeItems: "center",
          background: "linear-gradient(135deg, var(--violet), var(--aqua))", color: "#10132a",
        }}>
          <Icon.diary />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>Today's page</div>
          <div className="small">
            {today.length === 0
              ? "Blank so far — write anything."
              : `${today.length} ${today.length === 1 ? "entry" : "entries"}`}
          </div>
        </div>
        <Button variant="primary" size="small" onClick={onCompose}>
          <Icon.plus /> Write
        </Button>
      </div>
      {today.length > 0 && (
        <button type="button" onClick={onOpen}
          style={{
            all: "unset", cursor: "pointer", display: "block", width: "100%",
            marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)",
            color: "var(--accent-strong)", fontSize: 13,
          }}>
          Read your page →
        </button>
      )}
    </div>
  );
}

function PageRow({ page, onClick }: { page: Page; onClick: () => void }) {
  const last = page.entries[page.entries.length - 1];
  return (
    <button type="button" onClick={onClick}
      style={{
        all: "unset", cursor: "pointer", display: "flex", gap: 12, alignItems: "center",
        width: "100%", boxSizing: "border-box", padding: "10px 10px", borderRadius: 14,
        marginTop: 6,
      }}>
      <span style={{
        borderRadius: "50%", padding: 2,
        background: page.unseen > 0
          ? "linear-gradient(135deg, var(--violet), var(--aqua))"
          : "transparent",
      }}>
        <Avatar name={page.authorName} size="md" />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontWeight: page.unseen > 0 ? 650 : 500 }}>
          {page.authorName}
        </span>
        <span className="small" style={{
          display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {page.entries.length} {page.entries.length === 1 ? "entry" : "entries"}
          {last && ` · ${timeOf(last.createdAt)}`}
        </span>
      </span>
      {page.unseen > 0 && (
        <span className="tag ok" style={{ fontSize: 11 }}>{page.unseen} new</span>
      )}
    </button>
  );
}

// ---- the reader ----

function Reader({
  page, nextName, onNext, onBack, onDeleted,
}: {
  page: Page;
  nextName: string | null;
  onNext: () => void;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const seen = useRef(new Set<string>());

  // Mark entries read once they have actually been looked at — half on
  // screen for a moment, not merely rendered off the bottom of a scroll
  // container. One observer for the whole page.
  useEffect(() => {
    if (page.mine) return;
    const root = scroller.current;
    if (!root) return;
    const timers = new Map<string, number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.entryId;
        if (!id) continue;
        if (e.isIntersecting && e.intersectionRatio >= 0.5) {
          if (timers.has(id) || seen.current.has(id)) continue;
          timers.set(id, window.setTimeout(() => {
            seen.current.add(id);
            timers.delete(id);
            void reportSeen([id]);
          }, 800));
        } else {
          const t = timers.get(id);
          if (t) { clearTimeout(t); timers.delete(id); }
        }
      }
    }, { root, threshold: [0.5] });

    for (const el of root.querySelectorAll("[data-entry-id]")) io.observe(el);
    return () => { io.disconnect(); for (const t of timers.values()) clearTimeout(t); };
  }, [page.authorId, page.entries.length, page.mine]);

  const days = useMemo(() => groupByDay(page.entries), [page.entries]);

  return (
    <>
      <header style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "12px 14px", borderBottom: "1px solid var(--line)",
      }}>
        <Button variant="icon" onClick={onBack} aria-label="Back"><Icon.chevron /></Button>
        <Avatar name={page.authorName} size="sm" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>
            {page.authorName}
          </div>
          <div className="small">
            {page.mine ? "Only you keep this" : "Visible to you for 24 hours"}
          </div>
        </div>
      </header>

      <div ref={scroller} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 16px 28px" }}>
        {days.map(({ dayKey, tzOffsetMin, entries }) => (
          <section key={dayKey}>
            <div style={{ textAlign: "center", margin: "14px 0 6px" }}>
              <span className="tag">{formatDay(entries[0].createdAt, { tzOffsetMin })}</span>
            </div>
            {entries.map((e) => (
              <Entry key={e.id} entry={e} mine={page.mine} onDeleted={onDeleted} />
            ))}
          </section>
        ))}

        <div style={{ textAlign: "center", padding: "26px 0 8px" }}>
          {nextName ? (
            <Button onClick={onNext}>Next: {nextName} ↓</Button>
          ) : (
            <div className="small">You're all caught up.</div>
          )}
        </div>
      </div>
    </>
  );
}

function Entry({
  entry, mine, onDeleted,
}: { entry: OpenedDiaryEntry; mine: boolean; onDeleted: () => void }) {
  const [views, setViews] = useState<number | null>(entry.viewCount);

  useEffect(() => {
    if (!mine) return;
    refreshViewCount(entry.id).then((n) => { if (n !== null) setViews(n); }).catch(() => { /* ignore */ });
  }, [entry.id, mine]);

  return (
    <article data-entry-id={entry.id} style={{ margin: "10px 0 18px" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        fontSize: 11, color: "var(--text-mute)", marginBottom: 6,
      }}>
        <span>{timeOf(entry.createdAt)}</span>
        {mine && views !== null && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            · {views} {views === 1 ? "view" : "views"}
          </span>
        )}
        {mine && (
          <button type="button"
            onClick={async () => {
              if (!window.confirm("Delete this entry? It goes from your archive and from anyone still reading it.")) return;
              await removeDiaryEntry(entry.id);
              toast("Entry deleted", "ok");
              onDeleted();
            }}
            style={{
              all: "unset", cursor: "pointer", marginLeft: "auto",
              color: "var(--text-mute)", fontSize: 11,
            }}>
            Delete
          </button>
        )}
      </div>

      {entry.media ? (
        <>
          <MediaView media={entry.media} caption={entry.caption ?? undefined} />
          {entry.caption && (
            <div style={{ marginTop: 8, fontSize: 15, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {entry.caption}
            </div>
          )}
        </>
      ) : (
        <div style={{ fontSize: 15, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
          {entry.text}
        </div>
      )}
    </article>
  );
}

// ---- small helpers ----

function groupByDay(entries: OpenedDiaryEntry[]) {
  const out: Array<{ dayKey: string; tzOffsetMin: number; entries: OpenedDiaryEntry[] }> = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.dayKey === e.dayKey) last.entries.push(e);
    else out.push({ dayKey: e.dayKey, tzOffsetMin: e.tzOffsetMin, entries: [e] });
  }
  return out;
}

function isToday(t: number): boolean {
  return new Date(t).toDateString() === new Date().toDateString();
}

// Entry times render in the READER's timezone — "3 hours ago" has to be
// true for whoever is looking — while the day heading above them belongs
// to the author's day.
function timeOf(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
