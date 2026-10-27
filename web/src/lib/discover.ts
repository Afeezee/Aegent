// Discover — the public feed, client side.
//
// Read-only aggregation of other people's public diary posts. Nothing
// here is end-to-end: a discover post is public by construction, so the
// relay serves it in the clear and any signed-in viewer may read it,
// including its media blob (the content key rides in the MediaRef). The
// "slide into DM" action is not here — it is a plain openThread() in
// Home, which already auto-adds a non-contact before opening the chat.

import { api } from "./api.js";
import type { MediaRef } from "./store.js";

export type DiscoverPost = {
  id: string;
  authorId: string;
  kind: "text" | "image" | "voice";
  text: string | null;
  media: MediaRef | null;
  createdAt: number;
  author: { id: string; displayName: string; handle: string; publicKey: string; avatar: string | null };
};

export type DiscoverPage = { posts: DiscoverPost[]; nextBefore: number | null };

export async function fetchDiscoverFeed(before?: number, limit = 30): Promise<DiscoverPage> {
  const res = await api.discoverFeed({ before, limit });
  return {
    posts: res.posts.map((p) => ({
      id: p.id,
      authorId: p.authorId,
      kind: p.kind,
      text: p.text,
      media: (p.media as MediaRef | null) ?? null,
      createdAt: p.createdAt,
      author: p.author,
    })),
    nextBefore: res.nextBefore,
  };
}
