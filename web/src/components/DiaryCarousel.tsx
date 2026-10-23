// A set of diary images.
//
// One image is just an image. More than one is a horizontal strip you
// swipe on a phone (native scroll-snap) and can see side by side on a
// wide screen, with dots showing where you are. Tapping any image opens
// the zoomable lightbox at that position, where you can still slide
// between them.
//
// Decrypting a blob is work, so images load lazily as they scroll into
// view rather than all at once.

import { useEffect, useRef, useState } from "react";
import type { MediaRef } from "../lib/store.js";
import { objectUrlFor } from "../lib/media.js";
import { AlbumLightbox } from "./MediaView.js";

export function DiaryCarousel({ images, caption }: { images: MediaRef[]; caption?: string }) {
  const [active, setActive] = useState(0);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  if (images.length === 1) {
    return <><Slide media={images[0]} onOpen={() => setLightbox(0)} single />
      {lightbox !== null && <AlbumLightbox images={images} index={lightbox} onClose={() => setLightbox(null)} />}</>;
  }

  return (
    <div>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setActive(Math.round(el.scrollLeft / el.clientWidth));
        }}
        style={{
          display: "flex", overflowX: "auto", scrollSnapType: "x mandatory",
          gap: 8, borderRadius: 12, scrollbarWidth: "none",
        }}
      >
        {images.map((m, i) => (
          <div key={m.blobId} style={{ flex: "0 0 100%", scrollSnapAlign: "center" }}>
            <Slide media={m} onOpen={() => setLightbox(i)} />
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 8 }}>
        {images.map((_, i) => (
          <span key={i} aria-hidden style={{
            width: active === i ? 18 : 6, height: 6, borderRadius: 999,
            background: active === i ? "var(--accent)" : "var(--line-strong)",
            transition: "width .2s, background .2s",
          }} />
        ))}
      </div>

      {lightbox !== null && (
        <AlbumLightbox images={images} index={lightbox} onClose={() => setLightbox(null)} />
      )}
      {caption && <span className="sr-only">{caption}</span>}
    </div>
  );
}

function Slide({ media, onOpen, single }: { media: MediaRef; onOpen: () => void; single?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const ref = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let live = true;
    // Lazy: only decrypt once the slide is near the viewport.
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        objectUrlFor(media).then((u) => { if (live) setUrl(u); }).catch(() => { /* leave blank */ });
        io.disconnect();
      }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => { live = false; io.disconnect(); };
  }, [media]);

  return (
    <button ref={ref} type="button" onClick={onOpen} aria-label="Open image"
      style={{
        all: "unset", cursor: "zoom-in", display: "block", width: "100%",
        aspectRatio: single ? undefined : "1 / 1",
        borderRadius: 12, overflow: "hidden", background: "var(--line)",
      }}>
      {url
        ? <img src={url} alt="" style={{
            width: "100%", height: single ? "auto" : "100%",
            maxHeight: single ? 420 : undefined, objectFit: "cover", display: "block",
          }} />
        : <span style={{ display: "block", width: "100%", height: single ? 240 : "100%", aspectRatio: single ? "4 / 3" : undefined }} />}
    </button>
  );
}
