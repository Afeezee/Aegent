// Discover — the public feed, client side.
//
// Read-only aggregation of other people's public diary posts. Nothing
// here is end-to-end: a discover post is public by construction, so the
// relay serves it in the clear and any signed-in viewer may read it,
// including its media blob (the content key rides in the MediaRef). The
// "slide into DM" action is not here — it is a plain openThread() in
// Home, which already auto-adds a non-contact before opening the chat.

import { api, type ProductApi } from "./api.js";
import type { MediaRef } from "./store.js";

export type DiscoverPostPersonal = {
  adKind?: undefined;
  id: string;
  authorId: string;
  kind: "text" | "image" | "voice";
  text: string | null;
  media: MediaRef | null;
  createdAt: number;
  author: { id: string; displayName: string; handle: string; publicKey: string; avatar: string | null };
};

// Business-ad card in the merged feed. Carries the product inline so
// the card renders thumbnail + name + price + "Message {business}"
// without a second round trip. `authorId` is the business OWNER's user
// id so the existing openThread() "slide into DM" path works unchanged.
export type DiscoverPostAd = {
  adKind: "business_ad";
  id: string;                 // product id
  businessId: string;
  businessOwnerId: string;
  businessName: string;
  product: ProductApi;
  createdAt: number;
  authorId: string;           // = businessOwnerId
  author: { id: string; displayName: string; handle: string; publicKey: string; avatar: string | null };
};

export type DiscoverPost = DiscoverPostPersonal | DiscoverPostAd;
export type DiscoverPage = { posts: DiscoverPost[]; nextBefore: number | null };

export async function fetchDiscoverFeed(before?: number, limit = 30): Promise<DiscoverPage> {
  const res = await api.discoverFeed({ before, limit });
  return {
    posts: res.posts.map((p): DiscoverPost => {
      if (p.adKind === "business_ad") {
        return {
          adKind: "business_ad",
          id: p.id,
          businessId: p.businessId,
          businessOwnerId: p.businessOwnerId,
          businessName: p.businessName,
          product: p.product,
          createdAt: p.createdAt,
          authorId: p.authorId,
          author: p.author,
        };
      }
      return {
        id: p.id,
        authorId: p.authorId,
        kind: p.kind,
        text: p.text,
        media: (p.media as MediaRef | null) ?? null,
        createdAt: p.createdAt,
        author: p.author,
      };
    }),
    nextBefore: res.nextBefore,
  };
}
