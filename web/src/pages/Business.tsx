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

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Avatar, Button, Icon, toast, toastDismiss, toastUpdate } from "../components/ui.js";
import { api, type BusinessDetail, type ProductApi } from "../lib/api.js";
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

  return (
    <div className="glass" style={{
      padding: 12, borderRadius: 12,
      display: "flex", gap: 12, alignItems: "center",
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: 10, overflow: "hidden",
        background: "var(--glass-bg-hi)", flexShrink: 0,
        display: "grid", placeItems: "center",
      }}>
        {url
          ? <img src={url} alt={product.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : <Icon.photo />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {product.name}
        </div>
        <div className="small" style={{ color: "var(--accent-strong)" }}>
          {formatMoney(product.priceCents, product.currency)}
        </div>
        {product.description && (
          <div className="small" style={{ color: "var(--text-dim)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {product.description}
          </div>
        )}
      </div>
      <Button variant="ghost" onClick={() => setEditing(true)}><Icon.edit /></Button>
      <Button variant="ghost" onClick={() => void del()}><Icon.trash /></Button>
    </div>
  );
}

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
  // Store price as a string in state so the user can type freely —
  // parse on save. Keeps the input focused on cents to avoid any
  // float-rounding surprises in the server-side total.
  const [priceStr, setPriceStr] = useState(
    initial ? (initial.priceCents / 100).toFixed(2) : "",
  );
  const [currency, setCurrency] = useState(initial?.currency ?? "USD");
  const [image, setImage] = useState<MediaRef | null>((initial?.image as MediaRef | null) ?? null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function pickImage(file: File) {
    const id = toast("Encrypting image…", "info", { sticky: true });
    try {
      const picked = await pickFile(file);
      const media = await uploadMedia(picked,
        (frac) => toastUpdate(id, { text: `Uploading · ${Math.round(frac * 100)}%`, progress: frac }));
      setImage(media);
      toastUpdate(id, { text: "Image ready", kind: "ok", sticky: false, progress: undefined });
      setTimeout(() => toastDismiss(id), 1500);
    } catch (e) {
      toastUpdate(id, { text: `Couldn't upload: ${(e as Error).message}`, kind: "error", sticky: false, progress: undefined });
    }
  }

  async function save() {
    const n = name.trim();
    const cents = Math.round(parseFloat(priceStr) * 100);
    if (!n) { toast("Give the product a name.", "warn"); return; }
    if (!Number.isFinite(cents) || cents < 0) { toast("Enter a valid price.", "warn"); return; }
    setBusy(true);
    try {
      if (initial) {
        await api.updateProduct(businessId, initial.id, {
          name: n, description: desc.trim() || null,
          priceCents: cents, currency, image,
        });
        toast("Product updated", "ok");
      } else {
        await api.addProduct(businessId, {
          name: n, description: desc.trim() || null,
          priceCents: cents, currency, image,
        });
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
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{
          width: 72, height: 72, borderRadius: 10, overflow: "hidden",
          background: "var(--glass-bg-hi)", flexShrink: 0,
          display: "grid", placeItems: "center",
        }}>
          {image
            ? <ProductImagePreview media={image} />
            : <Icon.photo />}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <input ref={fileRef} type="file" accept="image/*" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pickImage(f); }} />
          <Button variant="ghost" onClick={() => fileRef.current?.click()}>
            <Icon.photo /> {image ? "Change" : "Add image"}
          </Button>
          {image && <Button variant="ghost" onClick={() => setImage(null)}>Remove</Button>}
        </div>
      </div>
      <label className="small" style={{ color: "var(--text-dim)" }}>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200}
        placeholder="e.g. Hand-knit beanie" style={{ width: "100%", marginBottom: 10 }} />

      <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 2 }}>
          <label className="small" style={{ color: "var(--text-dim)" }}>Price</label>
          <input value={priceStr} onChange={(e) => setPriceStr(e.target.value)}
            inputMode="decimal" placeholder="0.00"
            style={{ width: "100%" }} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="small" style={{ color: "var(--text-dim)" }}>Currency</label>
          <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            maxLength={3} style={{ width: "100%", textTransform: "uppercase" }} />
        </div>
      </div>

      <label className="small" style={{ color: "var(--text-dim)" }}>Description</label>
      <textarea value={desc} onChange={(e) => setDesc(e.target.value)}
        rows={2} maxLength={2000}
        placeholder="What the buyer gets."
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

// Formats a cents amount as a localised currency string. Falls back
// to a plain decimal if Intl.NumberFormat can't resolve the currency.
export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
