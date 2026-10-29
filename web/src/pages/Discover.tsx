// Discover — a vertical feed of other people's public posts.
//
// Each public diary post becomes a full-width card you scroll through
// like a status reel. The card carries one thing — an image, a voice
// note, or up to 500 characters of text — plus who posted it and a way
// to slide straight into their DMs. "Message" works even if the author
// isn't a contact yet: Home's openThread auto-adds them first.

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Avatar, Button, Icon } from "../components/ui.js";
import { MediaView } from "../components/MediaView.js";
import { fetchDiscoverFeed, type DiscoverPost } from "../lib/discover.js";

function relTime(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d` : new Date(ts).toLocaleDateString();
}

// Autolink bare URLs in public text. Links are allowed in a post; we
// render them as real anchors but open in a new tab with noopener so a
// linked page can never reach back into the app.
function linkify(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  const re = /(https?:\/\/[^\s]+)/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <a key={i++} href={m[0]} target="_blank" rel="noopener noreferrer"
        style={{ color: "var(--aqua)", wordBreak: "break-all" }}>{m[0]}</a>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function Discover({ onMessage }: { onMessage: (authorId: string) => void }) {
  const [posts, setPosts] = useState<DiscoverPost[]>([]);
  const [before, setBefore] = useState<number | undefined>(undefined);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seen = useRef(new Set<string>());

  const loadMore = useCallback(async () => {
    if (loading || done) return;
    setLoading(true); setErr(null);
    try {
      const page = await fetchDiscoverFeed(before);
      const fresh = page.posts.filter((p) => !seen.current.has(p.id));
      fresh.forEach((p) => seen.current.add(p.id));
      setPosts((prev) => [...prev, ...fresh]);
      if (page.nextBefore == null || page.posts.length === 0) setDone(true);
      else setBefore(page.nextBefore);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setLoading(false); }
  }, [before, loading, done]);

  useEffect(() => { void loadMore(); /* first page */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the next page when the sentinel at the bottom scrolls into view.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore();
    }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "6px 16px 10px", display: "flex", alignItems: "center", gap: 8 }}>
        <Icon.compass />
        <div style={{ fontWeight: 700, fontSize: 18 }}>Discover</div>
        <div className="small" style={{ marginLeft: "auto" }}>Public posts from everyone</div>
      </div>

      <div
        style={{
          flex: 1, minHeight: 0, overflowY: "auto",
          display: "flex", flexDirection: "column", gap: 14,
          padding: "0 16px 16px",
          scrollSnapType: "y proximity",
        }}
      >
        {posts.length === 0 && done && !err && (
          <div className="small" style={{
            textAlign: "center", padding: "48px 16px", color: "var(--text-dim)",
          }}>
            Nothing here yet. Post a diary entry and set it to <b>Public</b> to show up in Discover.
          </div>
        )}

        {posts.map((p) => (
          <DiscoverCard key={p.id} post={p} onMessage={onMessage} />
        ))}

        {err && (
          <div style={{ textAlign: "center", padding: 16 }}>
            <div className="small" style={{ color: "var(--danger)", marginBottom: 8 }}>Couldn't load: {err}</div>
            <Button size="small" onClick={() => void loadMore()}>Retry</Button>
          </div>
        )}
        {loading && <div className="small" style={{ textAlign: "center", padding: 16, color: "var(--text-dim)" }}>Loading…</div>}
        <div ref={sentinel} style={{ height: 1 }} />
      </div>
    </div>
  );
}

function DiscoverCard({ post, onMessage }: { post: DiscoverPost; onMessage: (authorId: string) => void }) {
  // Business ads look visibly different from personal posts: a small
  // "Business" tag, product image prominent, name + price, and a
  // "Message {BusinessName}" CTA. Same openThread-based "slide into
  // DM" plumbing — the id passed is the business owner's user id.
  if (post.adKind === "business_ad") {
    return <BusinessAdCard post={post} onMessage={onMessage} />;
  }
  return (
    <motion.article
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      className="glass"
      style={{
        scrollSnapAlign: "start",
        borderRadius: 18, padding: 14, display: "flex", flexDirection: "column", gap: 12,
        border: "1px solid var(--glass-border-hi)",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Avatar name={post.author.displayName} src={post.author.avatar ?? undefined} size="sm" />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 650, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {post.author.displayName}
          </div>
          <div className="small">@{post.author.handle} · {relTime(post.createdAt)}</div>
        </div>
        <Button size="small" variant="primary" style={{ marginLeft: "auto" }}
          onClick={() => onMessage(post.authorId)}>
          <Icon.send /> Message
        </Button>
      </header>

      {post.kind === "text" ? (
        <div style={{
          fontSize: 15.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
          padding: "6px 2px",
        }}>
          {post.text ? linkify(post.text) : null}
        </div>
      ) : post.media ? (
        <div>
          <MediaView media={post.media} caption={post.text ?? undefined} />
          {post.text && (
            <div style={{ fontSize: 14, lineHeight: 1.45, marginTop: 8, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {linkify(post.text)}
            </div>
          )}
        </div>
      ) : (
        <div className="small" style={{ color: "var(--text-dim)" }}>(media unavailable)</div>
      )}
    </motion.article>
  );
}

function BusinessAdCard({
  post, onMessage,
}: {
  post: Extract<DiscoverPost, { adKind: "business_ad" }>;
  onMessage: (authorId: string) => void;
}) {
  const image = post.product.image as import("../lib/store.js").MediaRef | null;
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!image) { setImgUrl(null); return; }
    let live = true;
    import("../lib/media.js").then((m) => m.objectUrlFor(image))
      .then((u) => { if (live) setImgUrl(u); })
      .catch(() => { if (live) setImgUrl(null); });
    return () => { live = false; };
  }, [image?.blobId]);
  const price = `${(post.product.priceCents / 100).toFixed(2)} ${post.product.currency}`;
  return (
    <motion.article
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      className="glass"
      style={{
        scrollSnapAlign: "start",
        borderRadius: 18, padding: 14, display: "flex", flexDirection: "column", gap: 12,
        border: "1px solid var(--accent)",
        background: "linear-gradient(135deg, rgba(138,125,255,0.08), rgba(23,195,230,0.06))",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Avatar name={post.author.displayName} src={post.author.avatar ?? undefined} size="sm" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 650, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {post.businessName}
          </div>
          <div className="small">@{post.author.handle} · {relTime(post.createdAt)}</div>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase",
          padding: "3px 8px", borderRadius: 999,
          background: "linear-gradient(135deg, var(--violet), var(--aqua))",
          color: "#10132a",
        }}>Business</span>
      </header>
      {imgUrl && (
        <div style={{ borderRadius: 12, overflow: "hidden", maxHeight: 320 }}>
          <img src={imgUrl} alt={post.product.name}
            style={{ width: "100%", height: "auto", display: "block", objectFit: "cover" }} />
        </div>
      )}
      <div style={{ padding: "0 4px" }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{post.product.name}</div>
        <div style={{ fontSize: 15, color: "var(--accent-strong)", marginTop: 2 }}>{price}</div>
        {post.product.description && (
          <div className="small" style={{ color: "var(--text-dim)", marginTop: 6, lineHeight: 1.4 }}>
            {post.product.description}
          </div>
        )}
      </div>
      <Button variant="primary" style={{ marginTop: 4 }} onClick={() => onMessage(post.authorId)}>
        <Icon.send /> Message {post.businessName}
      </Button>
    </motion.article>
  );
}
