// Discover — the public feed.
//
// A discover post is the PUBLIC twin of a diary entry the author marked
// public. Unlike the diary, it is stored in the clear: the whole feature
// is "let people who aren't your contacts find you through what you
// post", which a per-viewer sealed grant cannot express. The private
// diary path is untouched — a public entry is still published there
// normally; this module only holds the extra, openly-readable copy that
// the global feed aggregates.
//
// A post is one of: text (<=500 chars, links allowed), a single image,
// or a voice note. The media's content key lives in the clear inside
// `media_json` because the media is public anyway; the blob is served to
// any signed-in viewer via the discover_blobs binding (see readBlobFor).

import { db } from "./db.js";
import { AuthError, ForbiddenError } from "./auth.js";

// Matches the client-side guard. A card is a glance, not an essay.
export const MAX_DISCOVER_TEXT = 500;
export const MAX_DISCOVER_FEED = 100;

// Personal Discover posts mirror the diary's 24-hour visibility
// contract: a diary entry's grants to viewers expire in 24 hours; the
// public copy should expire with them. Business ads live in the
// `business_products` table (not `discover_posts`), so they stay
// visible for as long as the business keeps the product live —
// which is the ad's own natural duration, and the right behaviour for
// something a seller actively published.
export const DISCOVER_PERSONAL_TTL_MS = 24 * 60 * 60 * 1000;

export type DiscoverPostRow = {
  id: string;
  author_id: string;
  kind: string;
  text: string | null;
  media_json: string | null;
  created_at: number;
  revoked_at: number | null;
};

export type PublicInput = {
  id: string;                       // same id as the originating diary entry
  kind: "text" | "image" | "voice";
  text?: string;
  mediaJson?: string;               // JSON MediaRef, for image/voice
  blobId?: string;                  // the media blob to bind, author's own
};

export async function publishPublic(authorId: string, input: PublicInput): Promise<{ id: string }> {
  const text = (input.text ?? "").trim();
  if (input.kind === "text") {
    if (!text) throw new AuthError("empty", "A public post needs some text.");
  }
  if (text.length > MAX_DISCOVER_TEXT) {
    throw new AuthError("text_too_long", `Public posts are limited to ${MAX_DISCOVER_TEXT} characters.`);
  }
  if ((input.kind === "image" || input.kind === "voice")) {
    if (!input.mediaJson || !input.blobId) {
      throw new AuthError("media_required", "That post is missing its media.");
    }
    const b = await db.prepare("SELECT owner_id FROM blobs WHERE id = ?").get<{ owner_id: string }>(input.blobId);
    if (!b) throw new AuthError("unknown_blob", "That attachment no longer exists.");
    if (b.owner_id !== authorId) throw new ForbiddenError("not_your_blob", "That attachment isn't yours.");
  }

  const existing = await db.prepare("SELECT author_id FROM discover_posts WHERE id = ?")
    .get<{ author_id: string }>(input.id);
  if (existing) {
    // Idempotent re-publish, author only.
    if (existing.author_id !== authorId) throw new ForbiddenError("not_yours", "That post id is taken.");
    return { id: input.id };
  }

  await db.tx(async () => {
    await db.prepare(
      `INSERT INTO discover_posts (id, author_id, kind, text, media_json, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run(input.id, authorId, input.kind, text || null, input.mediaJson ?? null, Date.now());
    if (input.blobId) {
      await db.prepare("INSERT INTO discover_blobs (blob_id, post_id) VALUES (?, ?)")
        .run(input.blobId, input.id);
    }
  });
  return { id: input.id };
}

export type DiscoverFeedRow = DiscoverPostRow & {
  display_name: string; handle: string; public_key: string; avatar: string | null;
};

// Newest-first global feed, excluding the viewer's own posts (you don't
// discover yourself), anything revoked, and anything past the 24-hour
// TTL. `before` pages backwards in time: pass the oldest created_at
// you've seen to get the next page.
export async function discoverFeed(
  viewerId: string, opts: { before?: number; limit?: number },
): Promise<DiscoverFeedRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), MAX_DISCOVER_FEED);
  const cutoff = Date.now() - DISCOVER_PERSONAL_TTL_MS;
  const args: unknown[] = [viewerId, cutoff];
  let where = "p.revoked_at IS NULL AND p.author_id != ? AND p.created_at >= ?";
  if (opts.before) { where += " AND p.created_at < ?"; args.push(opts.before); }
  return db.prepare(
    `SELECT p.*, u.display_name, u.handle, u.public_key, u.avatar
       FROM discover_posts p
       JOIN users u ON u.id = p.author_id
      WHERE ${where}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${limit}`,
  ).all<DiscoverFeedRow>(...args);
}

// Opportunistic hygiene — hard-delete personal Discover posts past
// the 24h TTL (and their blob bindings). Called from the feed handler
// so cleanup runs with real traffic and we don't need a separate cron.
// Business ads are NOT touched; they come from `business_products`.
let lastSweep = 0;
const SWEEP_THROTTLE_MS = 10 * 60 * 1000;
export async function sweepExpiredDiscoverPosts(): Promise<void> {
  const now = Date.now();
  if (now - lastSweep < SWEEP_THROTTLE_MS) return;
  lastSweep = now;
  const cutoff = now - DISCOVER_PERSONAL_TTL_MS;
  try {
    const expired = await db.prepare(
      "SELECT id FROM discover_posts WHERE created_at < ? AND revoked_at IS NULL",
    ).all<{ id: string }>(cutoff);
    for (const row of expired) {
      // Soft-delete first (so an in-flight feed query that saw the id
      // doesn't 404 on a blob fetch), then drop the blob binding.
      await db.prepare("UPDATE discover_posts SET revoked_at = ? WHERE id = ?").run(now, row.id);
      await db.prepare("DELETE FROM discover_blobs WHERE post_id = ?").run(row.id);
    }
  } catch { /* non-critical hygiene */ }
}

// Mixed feed: personal public posts + one ad per business (newest
// product). Returns a single list sorted by created_at DESC, each
// item tagged with `source` so the caller/UI can render differently.
//
// Why a server-side union instead of merging two client-side lists:
// keyset pagination (`before`) stays correct across pages — a client
// merge would risk interleaving errors as the two streams drift.
import { discoverBusinessAds, type BusinessAdFeedRow } from "./business.js";

export type MixedFeedItem =
  | { source: "post"; row: DiscoverFeedRow }
  | { source: "business_ad"; row: BusinessAdFeedRow };

export async function discoverMixedFeed(
  viewerId: string, opts: { before?: number; limit?: number },
): Promise<MixedFeedItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), MAX_DISCOVER_FEED);
  // Over-fetch each side by the full page so the merge has enough
  // candidates even if one side dominates the recency ordering.
  const [posts, ads] = await Promise.all([
    discoverFeed(viewerId, { before: opts.before, limit }),
    discoverBusinessAds(viewerId, { before: opts.before, limit }),
  ]);
  const merged: MixedFeedItem[] = [
    ...posts.map((r) => ({ source: "post" as const, row: r })),
    ...ads.map((r) => ({ source: "business_ad" as const, row: r })),
  ];
  merged.sort((a, b) => {
    const ca = a.source === "post" ? a.row.created_at : a.row.created_at;
    const cb = b.source === "post" ? b.row.created_at : b.row.created_at;
    if (cb !== ca) return cb - ca;
    const ia = a.source === "post" ? a.row.id : a.row.product_id;
    const ib = b.source === "post" ? b.row.id : b.row.product_id;
    return ib.localeCompare(ia);
  });
  return merged.slice(0, limit);
}

// Pull a post from the feed. The diary entry it came from is independent
// and is deleted through its own path; this only removes the public copy.
export async function unpublishPublic(authorId: string, postId: string): Promise<void> {
  const row = await db.prepare("SELECT author_id FROM discover_posts WHERE id = ?")
    .get<{ author_id: string }>(postId);
  if (!row) return;
  if (row.author_id !== authorId) throw new ForbiddenError("not_yours", "That isn't your post.");
  await db.prepare("UPDATE discover_posts SET revoked_at = ? WHERE id = ?").run(Date.now(), postId);
}
