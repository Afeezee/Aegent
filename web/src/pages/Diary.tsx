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
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Avatar, Button, Glass, Icon, toast } from "../components/ui.js";
import { MediaView } from "../components/MediaView.js";
import { DiaryCarousel } from "../components/DiaryCarousel.js";
import { DiaryComposer } from "../components/DiaryComposer.js";
import { formatDay } from "../lib/daybreaks.js";
import { objectUrlFor } from "../lib/media.js";
import {
  diaryNow, editDiaryText, reactToEntry, refreshViewCount, removeDiaryEntry, replyToEntry,
  reportSeen, responsesFor, syncDiary, type EntryResponses,
} from "../lib/diary.js";
import { dayKeyFor } from "../lib/daybreaks.js";
import { currentSession } from "../lib/session.js";
import {
  getContact, liveDiaryEntries, type OpenedDiaryEntry,
} from "../lib/store.js";

type Page = {
  authorId: string;
  authorName: string;
  avatar?: string | null;
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
        avatar: authorId === me.id ? ((me as unknown as { avatar?: string | null }).avatar ?? null) : (contact?.avatar ?? null),
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
  }, [me?.id]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  // One pull on open: arriving at the tab is the moment someone most
  // wants it to be current.
  useEffect(() => { syncDiary().then(load).catch(() => { /* the loop retries */ }); }, [load]);

  const mine = pages.find((p) => p.mine);
  const others = pages.filter((p) => !p.mine);
  const reading = openAuthor ? pages.find((p) => p.authorId === openAuthor) : null;

  return (
    <Glass raised style={{ display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      {reading ? (
          <motion.div key={`read-${reading.authorId}`}
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            style={{ height: "100%", display: "flex", flexDirection: "column" }}
          >
            <Reader
              page={reading}
              nextName={nextAfter(others, reading.authorId)?.authorName ?? null}
              prevName={prevBefore(others, reading.authorId)?.authorName ?? null}
              onNext={() => {
                const next = nextAfter(others, reading.authorId);
                setOpenAuthor(next ? next.authorId : null);
              }}
              onPrev={() => {
                const prev = prevBefore(others, reading.authorId);
                if (prev) setOpenAuthor(prev.authorId);
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
              ) : (
                <>
                  {/* Your own page sits in the list like everyone else's,
                      with the same preview — a status list that hides the
                      owner's own entry makes you check twice whether it
                      posted. */}
                  {mine && (
                    <PageRow key={mine.authorId} page={mine} onClick={() => setOpenAuthor(mine.authorId)} />
                  )}
                  {others.map((p) => (
                    <PageRow key={p.authorId} page={p} onClick={() => setOpenAuthor(p.authorId)} />
                  ))}
                  {others.length === 0 && (
                    <div className="small" style={{ padding: "10px 4px", lineHeight: 1.6 }}>
                      Nobody you know has written today. When they do, their page
                      appears here for a day.
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}

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

function prevBefore(pages: Page[], authorId: string): Page | null {
  const i = pages.findIndex((p) => p.authorId === authorId);
  if (i <= 0) return null;
  return pages[i - 1] ?? null;
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
      <PagePreview page={page} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontWeight: page.unseen > 0 ? 650 : 500 }}>
          {page.authorName}
        </span>
        <span className="small" style={{
          display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {page.entries.length} {page.entries.length === 1 ? "entry" : "entries"}
          {last && ` · ${timeOf(last.createdAt)}`}
          {page.mine && " · only you keep this"}
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
  page, nextName, prevName, onNext, onPrev, onBack, onDeleted,
}: {
  page: Page;
  nextName: string | null;
  prevName: string | null;
  onNext: () => void;
  onPrev: () => void;
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
        <Button variant="icon" onClick={onBack} aria-label="Back to diary list">
          <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}><Icon.chevron /></span>
        </Button>
        <Avatar name={page.authorName} src={page.avatar} size="sm" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>
            {page.authorName}
          </div>
          <div className="small">
            {page.mine ? "Only you keep this" : "Visible to you for 24 hours"}
          </div>
        </div>
        {/* Jump straight to the previous / next contact's page. */}
        {prevName && (
          <Button variant="icon" onClick={onPrev} aria-label={`Previous: ${prevName}`} title={`Previous: ${prevName}`}>
            <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}><Icon.chevron /></span>
          </Button>
        )}
        {nextName && (
          <Button variant="icon" onClick={onNext} aria-label={`Next: ${nextName}`} title={`Next: ${nextName}`}>
            <Icon.chevron />
          </Button>
        )}
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

        <div style={{ textAlign: "center", padding: "26px 0 8px", display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
          {prevName && <Button variant="ghost" onClick={onPrev}>↑ Previous: {prevName}</Button>}
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // Editable only on the day the entry was posted. After that it is
  // history, not a scratch pad. Only text entries can be edited — a
  // photo swap is a different operation and would need re-uploading the
  // blob.
  const today = dayKeyFor(diaryNow(), entry.tzOffsetMin);
  const canEdit = mine && !entry.media && entry.dayKey === today;

  useEffect(() => {
    if (!mine) return;
    refreshViewCount(entry.id).then((n) => { if (n !== null) setViews(n); }).catch(() => { /* ignore */ });
  }, [entry.id, mine]);

  return (
    <article data-entry-id={entry.id} style={{
      margin: "0 0 4px", padding: "14px 0",
      borderTop: "1px solid var(--line)",
    }}>
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
        {canEdit && !editing && (
          <button type="button"
            onClick={() => { setDraft(entry.text ?? ""); setEditing(true); }}
            style={{ all: "unset", cursor: "pointer", marginLeft: "auto", color: "var(--text-mute)", fontSize: 11 }}>
            Edit
          </button>
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
              all: "unset", cursor: "pointer", marginLeft: canEdit ? 10 : "auto",
              color: "var(--text-mute)", fontSize: 11,
            }}>
            Delete
          </button>
        )}
      </div>

      {entry.media ? (
        <>
          {entry.album && entry.album.length > 1
            ? <DiaryCarousel images={entry.album} caption={entry.caption ?? undefined} />
            : <MediaView media={entry.media} caption={entry.caption ?? undefined} />}
          {entry.caption && (
            <div style={{ marginTop: 8, fontSize: 15, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {entry.caption}
            </div>
          )}
        </>
      ) : editing ? (
        <div>
          <textarea
            value={draft} onChange={(e) => setDraft(e.target.value)}
            autoFocus rows={6}
            style={{
              width: "100%", boxSizing: "border-box", resize: "vertical",
              minHeight: 100, fontSize: 15, lineHeight: 1.6, textAlign: entry.align,
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={() => setEditing(false)}
              style={{ all: "unset", cursor: "pointer", padding: "6px 12px", fontSize: 13, color: "var(--text-dim)" }}>
              Cancel
            </button>
            <button type="button"
              onClick={async () => {
                const next = draft.trim();
                if (!next || next === entry.text) { setEditing(false); return; }
                try {
                  await editDiaryText(entry.id, next);
                  toast("Entry updated", "ok");
                  setEditing(false);
                  onDeleted();   // triggers reload
                } catch (e) {
                  toast((e as Error).message === "edit_window_closed"
                    ? "You can only edit today's entries"
                    : `Couldn't save: ${(e as Error).message}`, "error");
                }
              }}
              style={{
                all: "unset", cursor: "pointer", padding: "6px 14px", fontSize: 13,
                borderRadius: 999, background: "var(--accent)", color: "#10132a", fontWeight: 600,
              }}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <EntryText entry={entry} />
      )}

      {!editing && <Responses entry={entry} mine={mine} />}
    </article>
  );
}

// Markdown is rendered, never injected: react-markdown builds elements
// rather than setting innerHTML, so a diary entry cannot smuggle markup
// into someone else's page.
function EntryText({ entry }: { entry: OpenedDiaryEntry }) {
  const align = entry.align ?? "left";
  if (entry.format !== "md") {
    return (
      <div style={{ fontSize: 15, lineHeight: 1.7, whiteSpace: "pre-wrap", textAlign: align }}>
        {entry.text}
      </div>
    );
  }
  return (
    <div className="agent-md" style={{ fontSize: 15, lineHeight: 1.7, textAlign: align }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text ?? ""}</ReactMarkdown>
    </div>
  );
}

// A small picture of the last thing written, the way a status list shows
// one. An image gets its own thumbnail; text gets a pen, so a glance
// tells you which kind of day it was.
function PagePreview({ page }: { page: Page }) {
  const last = page.entries[page.entries.length - 1];
  const [url, setUrl] = useState<string | null>(null);

  // Only still images make a visual thumbnail. Voice / audio / files
  // have no picture, so loading their blob into an <img> showed a
  // broken image — those fall back to the author's avatar + a kind
  // badge instead.
  const isImageLike = last?.media?.kind === "image" || last?.media?.kind === "video";
  useEffect(() => {
    let live = true;
    if (!last?.media || !isImageLike) { setUrl(null); return; }
    objectUrlFor(last.media).then((u) => { if (live) setUrl(u); }).catch(() => { /* leave the avatar */ });
    return () => { live = false; };
  }, [last?.id, last?.media, isImageLike]);

  // Badge glyph by entry kind.
  const badge = !last?.media ? "✎"
    : last.media.kind === "voice" ? "🎙"
    : last.media.kind === "audio" ? "♪"
    : last.media.kind === "image" ? "▣"
    : last.media.kind === "video" ? "▶"
    : "📎";

  const ring = page.unseen > 0 || (page.mine && page.entries.length > 0);
  return (
    <span style={{
      position: "relative", display: "inline-grid", placeItems: "center",
      borderRadius: "50%", padding: 2,
      background: ring ? "linear-gradient(135deg, var(--violet), var(--aqua))" : "transparent",
    }}>
      {url ? (
        <img src={url} alt="" width={40} height={40}
          style={{ width: 40, height: 40, borderRadius: "50%", objectFit: "cover", display: "block" }} />
      ) : (
        <Avatar name={page.authorName} src={page.avatar} size="md" />
      )}
      <span aria-hidden style={{
        position: "absolute", right: -2, bottom: -2,
        width: 16, height: 16, borderRadius: "50%",
        display: "grid", placeItems: "center",
        background: "var(--ink-2)", border: "1px solid var(--line)",
        fontSize: 9, color: "var(--text-dim)",
      }}>
        {badge}
      </span>
    </span>
  );
}

const QUICK = ["❤️", "😂", "🔥", "👏", "😮"];

// Responding is one-directional: everything a reader sends goes to the
// author alone, as an ordinary encrypted message in their normal chat.
// Nobody else reading this page sees it — which is precisely why there
// is nothing here to moderate.
function Responses({ entry, mine }: { entry: OpenedDiaryEntry; mine: boolean }) {
  const [state, setState] = useState<EntryResponses | null>(null);
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    responsesFor(entry.id).then(setState).catch(() => setState(null));
  }, [entry.id]);
  useEffect(load, [load]);

  async function react(emoji: string) {
    if (busy) return;
    setBusy(true);
    try {
      await reactToEntry({ id: entry.id, authorId: entry.authorId }, emoji);
      load();
    } catch (e) {
      toast(`Couldn't send that: ${(e as Error).message}`, "error");
    } finally { setBusy(false); }
  }

  async function sendReply() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await replyToEntry({ id: entry.id, authorId: entry.authorId }, body);
      setDraft(""); setReplying(false);
      toast("Sent privately", "ok");
      load();
    } catch (e) {
      toast(`Couldn't send that: ${(e as Error).message}`, "error");
    } finally { setBusy(false); }
  }

  const counts = state?.reactions ?? [];

  // On your own entry this is a report, not a control panel.
  if (mine) {
    const replies = state?.replies ?? 0;
    return (
      <div style={{
        marginTop: 10, display: "flex", gap: 10, alignItems: "center",
        flexWrap: "wrap", fontSize: 12, color: "var(--text-dim)",
      }}>
        {counts.length === 0 && replies === 0 ? (
          <span style={{ opacity: 0.7 }}>No reactions yet</span>
        ) : (
          <>
            {counts.map((r) => (
              <span key={r.emoji} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 15 }}>{r.emoji}</span> {r.from.length}
              </span>
            ))}
            {replies > 0 && <span>{replies} {replies === 1 ? "reply" : "replies"}</span>}
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {QUICK.map((emoji) => {
          const picked = state?.mine === emoji;
          const count = counts.find((r) => r.emoji === emoji)?.from.length ?? 0;
          return (
            <button key={emoji} type="button" disabled={busy} onClick={() => react(emoji)}
              aria-label={`React ${emoji}`}
              style={{
                all: "unset", cursor: busy ? "default" : "pointer",
                padding: "4px 9px", borderRadius: 999, fontSize: 15, lineHeight: 1,
                border: `1px solid ${picked ? "var(--accent)" : "var(--line)"}`,
                background: picked ? "rgba(138,125,255,0.18)" : "rgba(255,255,255,0.03)",
              }}>
              {emoji}
              {count > 0 && (
                <span style={{ fontSize: 11, marginLeft: 4, color: "var(--text-dim)" }}>{count}</span>
              )}
            </button>
          );
        })}
        <button type="button" onClick={() => setReplying((v) => !v)}
          style={{ all: "unset", cursor: "pointer", marginLeft: 4, fontSize: 12, color: "var(--accent-strong)" }}>
          {replying ? "Cancel" : "Reply privately"}
        </button>
      </div>

      {replying && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void sendReply(); }}
            placeholder="Only they will see this"
            style={{ flex: 1 }}
          />
          <Button size="small" variant="primary" disabled={busy || !draft.trim()} onClick={sendReply}>
            Send
          </Button>
        </div>
      )}
    </div>
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
