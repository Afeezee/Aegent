// Business — the "manage my business" page.
//
// Self-contained like Diary: owns its own data fetch, no refreshKey
// prop needed because the server is the source of truth and we can
// re-pull on demand.
//
// Two states:
//   - no business yet → "Create your business" CTA with a name /
//     description / avatar form. On submit, api.createOrUpdateBusiness
//     mints the business row and we re-fetch into the manage view.
//   - business exists → profile header (Edit opens the same form
//     pre-filled) + the catalogue (list of products with Edit/Delete)
//     + "Add product" form (name, price, currency, description, image).
//
// Everything public: a business profile and its catalogue are the
// bytes that surface in Discover. The avatar / product images use the
// same pickFile→uploadMedia pipeline chat already uses — the resulting
// MediaRef carries the content key in the clear, matching how
// discover_posts.media_json already treats public media.
//
// A buyer's "view this business" experience is NOT this page — a buyer
// opens the business's DM via the Discover ad card and the per-chat
// agent (with the catalogue in scope) + the anchored product strip do
// the rest. This page is strictly "I am the owner, I manage mine."

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Avatar, Button, Icon, toast, toastDismiss, toastUpdate } from "../components/ui.js";
import {
  api, type BusinessDetail, type EarningsResponse, type PayoutRow, type ProductApi,
} from "../lib/api.js";
import { pickFile, uploadMedia } from "../lib/media.js";
import type { MediaRef } from "../lib/store.js";

export function Business() {
  const [loading, setLoading] = useState(true);
  const [biz, setBiz] = useState<BusinessDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);

  async function reload() {
    setLoading(true); setErr(null);
    try { setBiz(await api.getMyBusiness()); }
    catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, []);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "var(--text-mute)" }}>
        Loading your business…
      </div>
    );
  }
  if (err) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "var(--danger)" }}>
        Couldn't load: {err}
        <div style={{ marginTop: 10 }}>
          <Button onClick={() => void reload()}>Retry</Button>
        </div>
      </div>
    );
  }

  // No business yet, or we're explicitly editing the profile → form.
  if (!biz || editing) {
    return (
      <ProfileForm
        initial={biz}
        onCancel={biz ? () => setEditing(false) : undefined}
        onSaved={async () => { setEditing(false); await reload(); }}
      />
    );
  }

  return (
    <div style={{ padding: "20px 22px", overflowY: "auto", height: "100%" }}>
      <ProfileHeader biz={biz} onEdit={() => setEditing(true)} />

      <EarningsPanel businessId={biz.id} />

      <div style={{ marginTop: 24, display: "flex", alignItems: "center", gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Catalogue</h2>
        <span className="small" style={{ color: "var(--text-mute)" }}>
          {biz.products?.length ?? 0} product{(biz.products?.length ?? 0) === 1 ? "" : "s"}
        </span>
        <Button variant="primary" style={{ marginLeft: "auto" }}
          onClick={() => setAdding(true)}><Icon.plus /> Add product</Button>
      </div>

      <AnimatePresence>
        {adding && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <ProductForm
              businessId={biz.id}
              onCancel={() => setAdding(false)}
              onSaved={async () => { setAdding(false); await reload(); }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
        {(biz.products ?? []).length === 0 && !adding && (
          <div className="glass" style={{ padding: 24, textAlign: "center", color: "var(--text-dim)" }}>
            No products yet. Add one — it'll surface in Discover for everyone to find.
          </div>
        )}
        {(biz.products ?? []).map((p) => (
          <ProductRow key={p.id} businessId={biz.id} product={p} onChanged={reload} />
        ))}
      </div>
    </div>
  );
}

function ProfileHeader({ biz, onEdit }: { biz: BusinessDetail; onEdit: () => void }) {
  const avatar = biz.avatar as MediaRef | null;
  return (
    <div style={{
      display: "flex", gap: 16, alignItems: "center",
      padding: 16, borderRadius: 16,
      background: "linear-gradient(135deg, rgba(138,125,255,0.12), rgba(23,195,230,0.08))",
      border: "1px solid var(--glass-border-hi)",
    }}>
      <BusinessAvatar avatar={avatar} name={biz.name} size={64} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 20, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {biz.name}
        </div>
        {biz.description && (
          <div className="small" style={{ color: "var(--text-dim)", marginTop: 2, lineHeight: 1.4 }}>
            {biz.description}
          </div>
        )}
      </div>
      <Button variant="ghost" onClick={onEdit}><Icon.edit /> Edit</Button>
    </div>
  );
}

function BusinessAvatar({ avatar, name, size }: { avatar: MediaRef | null; name: string; size: number }) {
  // Resolves the public MediaRef into an object URL for display. The
  // MediaRef carries its own content key, so this is the same pipeline
  // chat media uses — just that for a public business avatar the key
  // is non-sensitive by design.
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!avatar) { setUrl(null); return; }
    let live = true;
    import("../lib/media.js").then((m) => m.objectUrlFor(avatar))
      .then((u) => { if (live) setUrl(u); })
      .catch(() => { if (live) setUrl(null); });
    return () => { live = false; };
  }, [avatar?.blobId]);
  if (!url) {
    return <Avatar name={name} size="lg" />;
  }
  return (
    <img src={url} alt={name} style={{
      width: size, height: size, borderRadius: 16, objectFit: "cover",
      border: "1px solid var(--glass-border-hi)",
    }} />
  );
}

function ProfileForm({
  initial, onCancel, onSaved,
}: {
  initial: BusinessDetail | null;
  onCancel?: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [desc, setDesc] = useState(initial?.description ?? "");
  const [avatar, setAvatar] = useState<MediaRef | null>((initial?.avatar as MediaRef | null) ?? null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function pickAvatar(file: File) {
    const id = toast("Encrypting avatar…", "info", { sticky: true });
    try {
      const picked = await pickFile(file);
      const media = await uploadMedia(picked,
        (frac) => toastUpdate(id, { text: `Uploading · ${Math.round(frac * 100)}%`, progress: frac }));
      setAvatar(media);
      toastUpdate(id, { text: "Avatar ready", kind: "ok", sticky: false, progress: undefined });
      setTimeout(() => toastDismiss(id), 1500);
    } catch (e) {
      toastUpdate(id, { text: `Couldn't upload: ${(e as Error).message}`, kind: "error", sticky: false, progress: undefined });
    }
  }

  async function save() {
    const n = name.trim();
    if (!n) { toast("Give your business a name first.", "warn"); return; }
    setBusy(true);
    try {
      await api.createOrUpdateBusiness({
        name: n, description: desc.trim() || null, avatar,
      });
      toast(initial ? "Business updated" : "Business created", "ok");
      await onSaved();
    } catch (e) { toast(`Couldn't save: ${(e as Error).message}`, "error"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ padding: "20px 22px", overflowY: "auto", height: "100%" }}>
      <h1 style={{ margin: "0 0 6px", fontSize: 22 }}>
        {initial ? "Edit your business" : "Create your business"}
      </h1>
      <div className="small" style={{ color: "var(--text-dim)", marginBottom: 20 }}>
        {initial
          ? "Changes show up in Discover and in buyer chats the next time anyone pulls a feed."
          : "Your profile is public — anyone can see your name, description, and products in Discover."}
      </div>

      <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 14 }}>
        <BusinessAvatar avatar={avatar} name={name || "?"} size={72} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <input ref={fileRef} type="file" accept="image/*" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pickAvatar(f); }} />
          <Button variant="ghost" onClick={() => fileRef.current?.click()}>
            <Icon.photo /> {avatar ? "Change avatar" : "Add avatar"}
          </Button>
          {avatar && (
            <Button variant="ghost" onClick={() => setAvatar(null)}>Remove</Button>
          )}
        </div>
      </div>

      <label className="small" style={{ color: "var(--text-dim)" }}>Business name</label>
      <input value={name} onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Thoria's Thrift" maxLength={100}
        style={{ width: "100%", marginBottom: 12 }} />

      <label className="small" style={{ color: "var(--text-dim)" }}>Description</label>
      <textarea value={desc} onChange={(e) => setDesc(e.target.value)}
        placeholder="What you sell, who it's for." rows={3} maxLength={2000}
        style={{ width: "100%", marginBottom: 16, resize: "vertical" }} />

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button variant="primary" onClick={save} disabled={busy || !name.trim()}>
          {busy ? "Saving…" : initial ? "Save changes" : "Create business"}
        </Button>
      </div>
    </div>
  );
}

function ProductRow({
  businessId, product, onChanged,
}: { businessId: string; product: ProductApi; onChanged: () => void | Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const image = product.image as MediaRef | null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!image) { setUrl(null); return; }
    let live = true;
    import("../lib/media.js").then((m) => m.objectUrlFor(image))
      .then((u) => { if (live) setUrl(u); })
      .catch(() => { if (live) setUrl(null); });
    return () => { live = false; };
  }, [image?.blobId]);

  async function del() {
    if (!confirm(`Delete "${product.name}"? Existing orders keep their record.`)) return;
    try {
      await api.deleteProduct(businessId, product.id);
      toast("Product deleted", "ok");
      await onChanged();
    } catch (e) { toast(`Couldn't delete: ${(e as Error).message}`, "error"); }
  }

  if (editing) {
    return (
      <ProductForm
        businessId={businessId}
        initial={product}
        onCancel={() => setEditing(false)}
        onSaved={async () => { setEditing(false); await onChanged(); }}
      />
    );
  }

  const album = productAlbum(product);
  const [lightbox, setLightbox] = useState(false);
  return (
    <div className="glass" style={{
      padding: 12, borderRadius: 12,
      display: "flex", gap: 12, alignItems: "center",
    }}>
      <button type="button" onClick={() => album.length > 0 && setLightbox(true)}
        aria-label={album.length > 1 ? `View ${album.length} photos` : "View photo"}
        style={{
          all: "unset", cursor: album.length > 0 ? "zoom-in" : "default",
          position: "relative",
          width: 64, height: 64, borderRadius: 10, overflow: "hidden",
          background: "var(--glass-bg-hi)", flexShrink: 0,
          display: "grid", placeItems: "center",
        }}>
        {url
          ? <img src={url} alt={product.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : <Icon.photo />}
        {album.length > 1 && (
          <span style={{
            position: "absolute", right: 3, bottom: 3,
            padding: "1px 6px", borderRadius: 999, fontSize: 10, fontWeight: 700,
            background: "rgba(0,0,0,0.65)", color: "#fff",
          }}>+{album.length - 1}</span>
        )}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {product.name}
        </div>
        <div className="small" style={{ color: "var(--accent-strong)" }}>
          {formatMoney(product.priceCents, product.currency)}
        </div>
        {product.deliveryText && (
          <div className="small" style={{ color: "var(--text-dim)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            🚚 {product.deliveryText}
          </div>
        )}
        {product.description && (
          <div className="small" style={{ color: "var(--text-dim)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {product.description}
          </div>
        )}
      </div>
      <Button variant="ghost" onClick={() => setEditing(true)}><Icon.edit /></Button>
      <Button variant="ghost" onClick={() => void del()}><Icon.trash /></Button>
      {lightbox && (
        <ProductLightbox images={album} onClose={() => setLightbox(false)} />
      )}
    </div>
  );
}

// Up to 8 images per product (1 cover + 7 extras). Mirrors the diary
// album cap so a buyer scrolling through a product and a reader
// scrolling through a diary entry hit the same ceiling.
const MAX_PRODUCT_IMAGES = 8;

// Common delivery options. The seller picks one as a starting point;
// the "Custom…" option opens a free-text field so they can describe
// anything else ("Pickup only — Yaba, Lagos", "Ships Mon/Wed", etc.).
// The field is one column server-side (delivery_text) — this UI just
// nudges toward answers that are useful on the buyer's side.
const DELIVERY_PRESETS = [
  { value: "Delivery included", label: "Delivery included" },
  { value: "Buyer pays delivery", label: "Buyer pays delivery" },
  { value: "Digital — no delivery needed", label: "Digital (no delivery)" },
  { value: "Pickup only", label: "Pickup only" },
] as const;

function ProductForm({
  businessId, initial, onCancel, onSaved,
}: {
  businessId: string;
  initial?: ProductApi;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [desc, setDesc] = useState(initial?.description ?? "");
  // Price as a string so the user can type freely with or without
  // thousands separators / currency symbols — normalise on save.
  const [priceStr, setPriceStr] = useState(
    initial ? (initial.priceCents / 100).toFixed(2) : "",
  );
  const [currency, setCurrency] = useState(initial?.currency ?? "USD");
  // Cover + extras kept as ONE array in form state; index 0 is the
  // cover, the rest are the carousel tail. Simpler than tracking the
  // cover and extras separately; we split them on save for the API.
  const [images, setImages] = useState<MediaRef[]>(() => {
    const cover = (initial?.image as MediaRef | null) ?? null;
    const extras = ((initial?.extraImages as MediaRef[] | undefined) ?? []);
    return cover ? [cover, ...extras] : [];
  });
  const [delivery, setDelivery] = useState<string>(initial?.deliveryText ?? "");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function pickImages(files: FileList) {
    const list = Array.from(files).slice(0, MAX_PRODUCT_IMAGES - images.length);
    if (list.length === 0) {
      toast(`Max ${MAX_PRODUCT_IMAGES} images per product.`, "warn");
      return;
    }
    const toastId = toast(list.length > 1 ? `Encrypting ${list.length} images…` : "Encrypting image…", "info", { sticky: true });
    try {
      const uploaded: MediaRef[] = [];
      for (let i = 0; i < list.length; i++) {
        const picked = await pickFile(list[i]);
        const media = await uploadMedia(picked, (frac) => {
          const overall = ((i + frac) / list.length) * 100;
          toastUpdate(toastId, { text: `Uploading · ${Math.round(overall)}%`, progress: (i + frac) / list.length });
        });
        uploaded.push(media);
      }
      setImages((xs) => [...xs, ...uploaded]);
      toastUpdate(toastId, {
        text: uploaded.length > 1 ? `${uploaded.length} images added` : "Image ready",
        kind: "ok", sticky: false, progress: undefined,
      });
      setTimeout(() => toastDismiss(toastId), 1500);
    } catch (e) {
      toastUpdate(toastId, { text: `Couldn't upload: ${(e as Error).message}`, kind: "error", sticky: false, progress: undefined });
    }
  }

  function removeImageAt(i: number) {
    setImages((xs) => xs.filter((_, j) => j !== i));
  }
  function makeCover(i: number) {
    if (i === 0) return;
    setImages((xs) => {
      const next = xs.slice();
      const [picked] = next.splice(i, 1);
      next.unshift(picked);
      return next;
    });
  }

  async function save() {
    const n = name.trim();
    const cents = parsePriceToCents(priceStr);
    if (!n) { toast("Give the product a name.", "warn"); return; }
    if (cents === null) { toast("Enter a valid price — e.g. 1999.99 or 1,999.99.", "warn"); return; }
    const cover = images[0] ?? null;
    const extras = images.slice(1);
    setBusy(true);
    try {
      const payload = {
        name: n,
        description: desc.trim() || null,
        priceCents: cents,
        currency,
        image: cover,
        extraImages: extras,
        deliveryText: delivery.trim() || null,
      };
      if (initial) {
        await api.updateProduct(businessId, initial.id, payload);
        toast("Product updated", "ok");
      } else {
        await api.addProduct(businessId, payload);
        toast("Product added", "ok");
      }
      await onSaved();
    } catch (e) { toast(`Couldn't save: ${(e as Error).message}`, "error"); }
    finally { setBusy(false); }
  }

  return (
    <div className="glass" style={{ padding: 16, borderRadius: 14, marginTop: 10 }}>
      <h3 style={{ margin: "0 0 10px", fontSize: 16 }}>
        {initial ? "Edit product" : "New product"}
      </h3>

      {/* Image strip: cover (left) + extras + an "Add" tile. Tap any
          non-cover image to promote it to cover; tap × to remove. */}
      <div style={{
        display: "flex", gap: 8, overflowX: "auto",
        padding: "4px 0 10px", marginBottom: 6,
      }}>
        {images.map((img, i) => (
          <div key={img.blobId} style={{
            position: "relative", width: 80, height: 80, borderRadius: 10, overflow: "hidden",
            background: "var(--glass-bg-hi)", flexShrink: 0,
            border: i === 0 ? "2px solid var(--accent)" : "1px solid var(--line)",
          }}>
            <button type="button"
              onClick={() => makeCover(i)}
              aria-label={i === 0 ? "Cover image" : "Make this the cover"}
              title={i === 0 ? "Cover" : "Tap to make cover"}
              style={{ all: "unset", cursor: i === 0 ? "default" : "pointer", width: "100%", height: "100%", display: "block" }}>
              <ProductImagePreview media={img} />
            </button>
            {i === 0 && (
              <span style={{
                position: "absolute", top: 3, left: 3,
                padding: "1px 6px", borderRadius: 999, fontSize: 9.5, fontWeight: 700,
                background: "var(--accent)", color: "#10132a",
              }}>COVER</span>
            )}
            <button type="button" onClick={() => removeImageAt(i)} aria-label="Remove image"
              style={{
                all: "unset", cursor: "pointer", position: "absolute", top: 2, right: 2,
                width: 20, height: 20, borderRadius: 999, display: "grid", placeItems: "center",
                background: "rgba(0,0,0,0.55)", color: "#fff", fontSize: 12,
              }}>×</button>
          </div>
        ))}
        {images.length < MAX_PRODUCT_IMAGES && (
          <button type="button" onClick={() => fileRef.current?.click()}
            aria-label="Add image"
            style={{
              all: "unset", cursor: "pointer",
              width: 80, height: 80, borderRadius: 10, flexShrink: 0,
              background: "var(--glass-bg-hi)", border: "1px dashed var(--line-strong)",
              display: "grid", placeItems: "center", color: "var(--text-dim)", fontSize: 13,
            }}>
            <div style={{ textAlign: "center", lineHeight: 1.2 }}>
              <div style={{ fontSize: 20 }}>＋</div>
              <div style={{ fontSize: 10 }}>Add</div>
            </div>
          </button>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden
        onChange={(e) => { const fs = e.target.files; e.target.value = ""; if (fs && fs.length) void pickImages(fs); }} />
      <div className="small" style={{ color: "var(--text-mute)", marginBottom: 10 }}>
        First image is the cover shoppers see in Discover. Tap another to promote it. Up to {MAX_PRODUCT_IMAGES} images; buyers swipe through them.
      </div>

      <label className="small" style={{ color: "var(--text-dim)" }}>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200}
        placeholder="e.g. Hand-knit beanie" style={{ width: "100%", marginBottom: 10 }} />

      <div style={{ display: "flex", gap: 10, marginBottom: 4 }}>
        <div style={{ flex: 2 }}>
          <label className="small" style={{ color: "var(--text-dim)" }}>Price</label>
          <input value={priceStr} onChange={(e) => setPriceStr(e.target.value)}
            inputMode="decimal" placeholder="0.00"
            style={{ width: "100%" }} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="small" style={{ color: "var(--text-dim)" }}>Currency</label>
          <CurrencySelect value={currency} onChange={setCurrency} />
        </div>
      </div>
      <div className="small" style={{ color: "var(--text-mute)", marginBottom: 10, lineHeight: 1.4 }}>
        Commas optional. Use a <strong>period</strong> for the decimal — e.g.{" "}
        <code>1999.99</code> or <code>1,999.99</code>. Preview:{" "}
        <strong>{previewMoney(priceStr, currency)}</strong>.
      </div>
      {!providerLabel(currency) && (
        <div className="small" style={{
          marginBottom: 10, padding: "8px 10px", borderRadius: 10, lineHeight: 1.45,
          background: "rgba(255, 196, 110, 0.10)",
          border: "1px solid rgba(255, 196, 110, 0.30)",
          color: "var(--text)",
        }}>
          ⚠️ Neither PayPal nor Paystack accepts <strong>{currency}</strong>, so buyers can't check this out. Use <strong>USD</strong> (both gateways), <strong>NGN / GHS / ZAR / KES</strong> (Paystack), or <strong>EUR / GBP / …</strong> (PayPal).
        </div>
      )}

      {/* Delivery — presets + a nudge-only free text. One column
          server-side; this UI just helps the seller write something a
          buyer can act on. */}
      <label className="small" style={{ color: "var(--text-dim)" }}>Delivery</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        {DELIVERY_PRESETS.map((p) => (
          <button key={p.value} type="button" onClick={() => setDelivery(p.value)}
            aria-pressed={delivery === p.value}
            style={{
              all: "unset", cursor: "pointer",
              padding: "6px 10px", borderRadius: 999, fontSize: 12,
              background: delivery === p.value ? "rgba(138,125,255,0.18)" : "transparent",
              border: `1px solid ${delivery === p.value ? "var(--accent)" : "var(--line)"}`,
              color: delivery === p.value ? "var(--text)" : "var(--text-dim)",
            }}>
            {p.label}
          </button>
        ))}
      </div>
      <input value={delivery} onChange={(e) => setDelivery(e.target.value)}
        placeholder="Or describe it: 'Ships Mon/Wed, 2–3 days, Lagos'"
        maxLength={500}
        style={{ width: "100%", marginBottom: 10 }} />

      <label className="small" style={{ color: "var(--text-dim)" }}>Description</label>
      <textarea value={desc} onChange={(e) => setDesc(e.target.value)}
        rows={3} maxLength={2000}
        placeholder="What the buyer gets — size, materials, quantity. Delivery goes above."
        style={{ width: "100%", marginBottom: 12, resize: "vertical" }} />

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={busy || !name.trim() || !priceStr.trim()}>
          {busy ? "Saving…" : initial ? "Save changes" : "Add product"}
        </Button>
      </div>
    </div>
  );
}

// Normalises what the seller typed into integer cents, or null if it's
// unparseable. Accepts "1999", "1999.99", "1,999.99", "$1,999.99" —
// strips currency symbols, strips thousands separators, requires a
// period for the decimal. Returns null for anything else (callers show
// a toast with the rule).
function parsePriceToCents(input: string): number | null {
  const trimmed = input.replace(/[\s,]/g, "").replace(/[^\d.-]/g, "");
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

// Live preview rendered under the price input so the seller sees
// exactly what buyers will see. "—" when the input isn't a number yet.
function previewMoney(input: string, currency: string): string {
  const cents = parsePriceToCents(input);
  if (cents === null) return "—";
  return formatMoney(cents, currency);
}

// Currencies each gateway will actually settle. Pulled from each
// provider's docs — anything outside the union of these two sets
// WILL fail at checkout, so the picker surfaces a badge per
// provider and the ProductForm warns on an unsupported currency.
const PAYPAL_OK = new Set([
  "AUD", "BRL", "CAD", "CNY", "CZK", "DKK", "EUR", "HKD", "HUF", "ILS",
  "INR", "JPY", "MYR", "MXN", "NOK", "NZD", "PHP", "PLN", "GBP", "RUB",
  "SGD", "SEK", "CHF", "THB", "TWD", "USD",
]);
const PAYSTACK_OK = new Set(["NGN", "GHS", "ZAR", "KES", "USD"]);
function providerLabel(code: string): string | null {
  const pp = PAYPAL_OK.has(code);
  const ps = PAYSTACK_OK.has(code);
  if (pp && ps) return "Both";
  if (pp) return "PayPal";
  if (ps) return "Paystack";
  return null;
}

// ISO 4217 currency codes the dropdown offers. Not every valid code —
// a curated set weighted toward Africa + the major reserve currencies
// so the picker opens on something a Nigerian seller probably wants
// without scrolling. "Add your own" is covered by typing a 3-letter
// code into the search box; the server accepts any 3-letter string
// (though PAYPAL_OK gates what will actually check out).
const CURRENCIES: Array<{ code: string; name: string }> = [
  { code: "NGN", name: "Nigerian Naira" },
  { code: "USD", name: "US Dollar" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "British Pound" },
  { code: "GHS", name: "Ghanaian Cedi" },
  { code: "KES", name: "Kenyan Shilling" },
  { code: "ZAR", name: "South African Rand" },
  { code: "EGP", name: "Egyptian Pound" },
  { code: "XOF", name: "West African CFA Franc" },
  { code: "XAF", name: "Central African CFA Franc" },
  { code: "MAD", name: "Moroccan Dirham" },
  { code: "TND", name: "Tunisian Dinar" },
  { code: "DZD", name: "Algerian Dinar" },
  { code: "UGX", name: "Ugandan Shilling" },
  { code: "TZS", name: "Tanzanian Shilling" },
  { code: "RWF", name: "Rwandan Franc" },
  { code: "ETB", name: "Ethiopian Birr" },
  { code: "SLL", name: "Sierra Leonean Leone" },
  { code: "ZMW", name: "Zambian Kwacha" },
  { code: "MWK", name: "Malawian Kwacha" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "AUD", name: "Australian Dollar" },
  { code: "NZD", name: "New Zealand Dollar" },
  { code: "JPY", name: "Japanese Yen" },
  { code: "CNY", name: "Chinese Yuan" },
  { code: "INR", name: "Indian Rupee" },
  { code: "BRL", name: "Brazilian Real" },
  { code: "MXN", name: "Mexican Peso" },
  { code: "ARS", name: "Argentine Peso" },
  { code: "CHF", name: "Swiss Franc" },
  { code: "SEK", name: "Swedish Krona" },
  { code: "NOK", name: "Norwegian Krone" },
  { code: "DKK", name: "Danish Krone" },
  { code: "PLN", name: "Polish Zloty" },
  { code: "AED", name: "UAE Dirham" },
  { code: "SAR", name: "Saudi Riyal" },
  { code: "QAR", name: "Qatari Riyal" },
  { code: "TRY", name: "Turkish Lira" },
  { code: "HKD", name: "Hong Kong Dollar" },
  { code: "SGD", name: "Singapore Dollar" },
  { code: "KRW", name: "South Korean Won" },
  { code: "THB", name: "Thai Baht" },
  { code: "IDR", name: "Indonesian Rupiah" },
  { code: "MYR", name: "Malaysian Ringgit" },
  { code: "PHP", name: "Philippine Peso" },
  { code: "PKR", name: "Pakistani Rupee" },
  { code: "BDT", name: "Bangladeshi Taka" },
];

// Searchable currency picker. Click opens a filterable list; type to
// narrow by code OR name ("naira" or "NGN" both land on the same
// row). Keyboard-friendly for desktop, tap-friendly for phone. Accepts
// any 3-letter string the seller types — "Enter" commits whatever is
// in the search field so a rare currency not in the preset list still
// works without us shipping the full ISO 4217 catalogue.
function CurrencySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? CURRENCIES.filter((c) =>
        c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    : CURRENCIES;

  function commit(code: string) {
    const up = code.trim().toUpperCase();
    if (up.length === 3) onChange(up);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox" aria-expanded={open}
        style={{
          all: "unset", cursor: "pointer", width: "100%", boxSizing: "border-box",
          padding: "8px 10px", borderRadius: 10, border: "1px solid var(--line)",
          background: "var(--glass-bg-hi)", color: "var(--text)",
          display: "flex", alignItems: "center", gap: 6,
        }}>
        <strong>{value}</strong>
        <span style={{ marginLeft: "auto", opacity: 0.6, fontSize: 12 }}>▾</span>
      </button>
      {open && (
        <div className="glass" style={{
          position: "absolute", left: 0, right: 0, top: "calc(100% + 4px)",
          zIndex: 20, padding: 6, borderRadius: 10,
          display: "flex", flexDirection: "column", gap: 4,
          border: "1px solid var(--glass-border-hi)",
          boxShadow: "0 10px 24px rgba(0,0,0,0.2)",
          maxHeight: 280, overflow: "hidden",
        }}>
          <input autoFocus value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (filtered.length > 0) commit(filtered[0].code);
                else commit(query);
              }
            }}
            placeholder="Search by code or name — e.g. naira, NGN"
            style={{ padding: "6px 8px", fontSize: 13 }} />
          <div style={{ overflowY: "auto", maxHeight: 220, display: "flex", flexDirection: "column" }}>
            {filtered.length === 0 && (
              <div className="small" style={{ padding: 10, color: "var(--text-mute)", textAlign: "center" }}>
                Press Enter to use "{query.toUpperCase()}" anyway.
              </div>
            )}
            {filtered.map((c) => {
              const label = providerLabel(c.code);
              return (
                <button key={c.code} type="button" onClick={() => commit(c.code)}
                  style={{
                    all: "unset", cursor: "pointer",
                    padding: "7px 8px", borderRadius: 8,
                    display: "flex", alignItems: "center", gap: 10,
                    background: c.code === value ? "rgba(138,125,255,0.14)" : "transparent",
                  }}
                  onMouseEnter={(ev) => { (ev.currentTarget as HTMLElement).style.background = "var(--glass-bg-hi)"; }}
                  onMouseLeave={(ev) => { (ev.currentTarget as HTMLElement).style.background = c.code === value ? "rgba(138,125,255,0.14)" : "transparent"; }}>
                  <strong style={{ width: 42 }}>{c.code}</strong>
                  <span className="small" style={{ color: "var(--text-dim)", flex: 1 }}>{c.name}</span>
                  {label && (
                    <span title={label === "Both"
                      ? "PayPal AND Paystack will accept this currency at checkout"
                      : `${label} will accept this currency at checkout`}
                      style={{
                        fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3,
                        padding: "2px 7px", borderRadius: 999,
                        background: "rgba(127,230,161,0.14)", color: "var(--ok)",
                        border: "1px solid rgba(127,230,161,0.28)",
                      }}>{label}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ProductImagePreview({ media }: { media: MediaRef }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    import("../lib/media.js").then((m) => m.objectUrlFor(media))
      .then((u) => { if (live) setUrl(u); })
      .catch(() => { if (live) setUrl(null); });
    return () => { live = false; };
  }, [media.blobId]);
  if (!url) return <Icon.photo />;
  return <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />;
}

// Flatten the cover + extras into one swipeable album, filtering nulls
// so callers can loop safely. Exported so Discover/Chat anchor-strip
// callers can share the same ordering rule.
export function productAlbum(p: ProductApi): MediaRef[] {
  const out: MediaRef[] = [];
  if (p.image) out.push(p.image as MediaRef);
  for (const x of (p.extraImages ?? []) as MediaRef[]) if (x) out.push(x);
  return out;
}

// Thin wrapper around MediaView's AlbumLightbox so Business.tsx (and
// soon Discover + Chat anchor strip) don't each import MediaView
// directly. Opens on index 0 — the cover.
export function ProductLightbox({ images, onClose }: { images: MediaRef[]; onClose: () => void }) {
  // Lazy-import to keep MediaView out of the Business bundle on first
  // paint — the user has to tap a photo before this ever loads.
  const [Comp, setComp] = useState<React.ComponentType<{ images: MediaRef[]; index: number; onClose: () => void }> | null>(null);
  useEffect(() => {
    let live = true;
    import("../components/MediaView.js").then((m) => {
      if (live) setComp(() => m.AlbumLightbox);
    });
    return () => { live = false; };
  }, []);
  if (!Comp) return null;
  return <Comp images={images} index={0} onClose={onClose} />;
}

// Formats a cents amount as a localised currency string. Falls back
// to a plain decimal if Intl.NumberFormat can't resolve the currency.
export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

// Seller-only earnings dashboard. Three visible units:
//   1. Headline numbers (available / earned / commission / pending).
//   2. Request-payout action (collects PayPal email lazily on first use).
//   3. Payout history + recent-orders table.
// Collapsed by default so a seller landing on the Business page sees
// the catalogue first; one tap expands the numbers. Loads earnings
// data on expand so a seller with no sales yet pays nothing to render.
function EarningsPanel({ businessId }: { businessId: string }) {
  const [open, setOpen] = useState(false);
  const [earnings, setEarnings] = useState<EarningsResponse | null>(null);
  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [payoutOpen, setPayoutOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [e, p] = await Promise.all([
        api.getBusinessEarnings(businessId),
        api.listPayouts(businessId),
      ]);
      setEarnings(e); setPayouts(p);
    } catch (ex) { setErr((ex as Error).message); }
    finally { setLoading(false); }
  }, [businessId]);

  useEffect(() => { if (open) void reload(); }, [open, reload]);

  const commissionPct = earnings ? (earnings.commissionBps / 100).toFixed(1).replace(/\.0$/, "") : "5";

  return (
    <div className="glass" style={{ marginTop: 16, padding: 14, borderRadius: 14 }}>
      <button
        type="button" onClick={() => setOpen((v) => !v)}
        style={{
          all: "unset", cursor: "pointer", width: "100%",
          display: "flex", alignItems: "center", gap: 10,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>Earnings</h2>
        {earnings && (
          <span className="small" style={{ color: "var(--text-dim)" }}>
            Available {formatMoney(earnings.availableCents, earnings.currency)}
          </span>
        )}
        <span style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
          <Icon.chevron />
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 14 }}>
          {loading && <div className="small" style={{ color: "var(--text-mute)" }}>Loading…</div>}
          {err && (
            <div className="small" style={{ color: "var(--danger)" }}>
              Couldn't load earnings: {err}
              <Button size="small" variant="ghost" onClick={() => void reload()}>Retry</Button>
            </div>
          )}
          {earnings && (
            <>
              <div style={{
                display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10,
              }}>
                <Stat label="Available to withdraw" value={formatMoney(earnings.availableCents, earnings.currency)} big />
                <Stat label="Total earned" value={formatMoney(earnings.totalNetCents, earnings.currency)} />
                <Stat label={`Aegent fee (${commissionPct}%)`} value={formatMoney(earnings.totalFeeCents, earnings.currency)} dim />
                <Stat label="Pending payout" value={formatMoney(earnings.pendingPayoutCents, earnings.currency)} dim />
              </div>
              <div className="small" style={{ color: "var(--text-dim)", lineHeight: 1.5 }}>
                Aegent takes a flat <strong>{commissionPct}%</strong> of each captured sale and is the merchant of record on PayPal. The rest is yours; request a payout any time.
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Button variant="primary" onClick={() => setPayoutOpen((v) => !v)}
                  disabled={earnings.availableCents <= 0}>
                  <Icon.send /> Request payout
                </Button>
                {earnings.availableCents <= 0 && (
                  <span className="small" style={{ color: "var(--text-mute)", alignSelf: "center" }}>
                    Nothing available yet — your first captured sale will land here.
                  </span>
                )}
              </div>
              {payoutOpen && (
                <PayoutForm
                  businessId={businessId}
                  maxCents={earnings.availableCents}
                  currency={earnings.currency}
                  onCancel={() => setPayoutOpen(false)}
                  onDone={async () => { setPayoutOpen(false); await reload(); }}
                />
              )}
              {payouts.length > 0 && (
                <div>
                  <div className="small" style={{ color: "var(--text-mute)", marginBottom: 6 }}>Payout history</div>
                  <div style={{ display: "grid", gap: 6 }}>
                    {payouts.map((p) => (
                      <div key={p.id} style={{
                        display: "flex", alignItems: "center", gap: 10, padding: "6px 10px",
                        borderRadius: 10, background: "var(--glass-bg-hi)",
                      }}>
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {formatMoney(p.amountCents, p.currency)}
                          {p.destination ? ` → ${p.destination}` : ""}
                        </span>
                        <span className="small" style={{ color: p.status === "paid" ? "var(--ok)" : "var(--text-dim)" }}>
                          {p.status}
                        </span>
                        <span className="small" style={{ color: "var(--text-mute)" }}>
                          {new Date(p.requestedAt).toLocaleDateString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {earnings.recentOrders.length > 0 && (
                <div>
                  <div className="small" style={{ color: "var(--text-mute)", marginBottom: 6 }}>Recent orders</div>
                  <div style={{ display: "grid", gap: 4 }}>
                    {earnings.recentOrders.map((o) => (
                      <OrderLine key={o.id} order={o} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, big, dim }: { label: string; value: string; big?: boolean; dim?: boolean }) {
  return (
    <div style={{
      padding: 10, borderRadius: 10,
      background: big
        ? "linear-gradient(135deg, rgba(138,125,255,0.18), rgba(23,195,230,0.12))"
        : "var(--glass-bg-hi)",
      border: "1px solid var(--glass-border-hi)",
    }}>
      <div className="small" style={{ color: "var(--text-dim)" }}>{label}</div>
      <div style={{
        fontSize: big ? 22 : 16, fontWeight: 700, marginTop: 2,
        color: dim ? "var(--text-dim)" : "var(--text)",
      }}>{value}</div>
    </div>
  );
}

function OrderLine({ order }: { order: import("../lib/api.js").EarningsOrderRow }) {
  // items_json is an array of {name, qty, unitPriceCents}; summarise.
  const items = Array.isArray(order.items) ? order.items : [];
  const label = items.map((it) => {
    const i = it as { qty?: number; name?: string };
    return `${i.qty ?? 1}× ${i.name ?? "item"}`;
  }).join(", ") || "(no items)";
  const captured = order.status === "captured";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "6px 10px",
      borderRadius: 10, background: "var(--glass-bg-hi)",
      opacity: captured ? 1 : 0.6,
    }}>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
        {label}
      </span>
      <span className="small" style={{ color: "var(--text-dim)" }}>
        gross {formatMoney(order.totalCents, order.currency)}
      </span>
      <span className="small" style={{ color: captured ? "var(--accent-strong)" : "var(--text-mute)" }}>
        you {formatMoney(order.netCents, order.currency)}
      </span>
      {!captured && <span className="small" style={{ color: "var(--text-mute)" }}>{order.status}</span>}
    </div>
  );
}

function PayoutForm({
  businessId, maxCents, currency, onCancel, onDone,
}: {
  businessId: string;
  maxCents: number;
  currency: string;
  onCancel: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [dest, setDest] = useState("");
  const [amountStr, setAmountStr] = useState((maxCents / 100).toFixed(2));
  const [busy, setBusy] = useState(false);

  async function submit() {
    const d = dest.trim();
    if (!d) { toast("Add a PayPal email.", "warn"); return; }
    const cents = Math.round(parseFloat(amountStr) * 100);
    if (!Number.isFinite(cents) || cents <= 0) { toast("Enter a valid amount.", "warn"); return; }
    if (cents > maxCents) { toast(`Only ${formatMoney(maxCents, currency)} available.`, "warn"); return; }
    setBusy(true);
    try {
      await api.requestPayout(businessId, { amountCents: cents, destination: d, destinationKind: "paypal" });
      toast("Payout requested", "ok");
      await onDone();
    } catch (e) { toast(`Couldn't request payout: ${(e as Error).message}`, "error"); }
    finally { setBusy(false); }
  }

  return (
    <div className="glass" style={{ padding: 12, borderRadius: 12, border: "1px solid var(--accent)" }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Request a payout</div>
      <label className="small" style={{ color: "var(--text-dim)" }}>PayPal email</label>
      <input value={dest} onChange={(e) => setDest(e.target.value)} type="email"
        placeholder="you@example.com" style={{ width: "100%", marginBottom: 8 }} />
      <label className="small" style={{ color: "var(--text-dim)" }}>Amount ({currency})</label>
      <input value={amountStr} onChange={(e) => setAmountStr(e.target.value)}
        inputMode="decimal" style={{ width: "100%", marginBottom: 8 }} />
      <div className="small" style={{ color: "var(--text-dim)", marginBottom: 10 }}>
        Max available: {formatMoney(maxCents, currency)}. This records the request on your account; actual PayPal payout wiring is coming — for now the amount moves from Available to Pending.
      </div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={busy || !dest.trim()}>
          {busy ? "Submitting…" : "Request"}
        </Button>
      </div>
    </div>
  );
}
