// Businesses — profile + product catalogue.
//
// A business is a separate entity from its owning user (mirrors how
// `groups` is its own table rather than a flag on `users`). One user
// owns at most one business for MVP (enforced by UNIQUE on
// businesses.owner_id in the schema). A business DM is a normal 1:1
// thread with the owner's user id as peer; no new thread kind is
// needed and the existing encryption/agent/anchor machinery just works.
//
// Everything served here is PUBLIC: a business profile and its
// catalogue are what buyers browse in Discover, so there's no sealed
// payload and no grant-check. Media uses the discover "plaintext
// MediaRef with content key in the clear" pattern (image_json /
// avatar_json columns).

import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db.js";
import { AuthError, ForbiddenError } from "./auth.js";
import { COMMISSION_BPS } from "./paypal.js";

type AuthedReq = Request & { userId: string };

type BusinessRow = {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  avatar_json: string | null;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
};

type ProductRow = {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  image_json: string | null;
  extra_images_json: string | null;
  delivery_text: string | null;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
};

// Shape returned to the client. The avatar/image fields are decoded
// JSON here so callers don't have to repeat JSON.parse at every call
// site; a null column stays null (never "null"-the-string).
export type BusinessOut = {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  avatar: unknown | null;
  createdAt: number;
  updatedAt: number | null;
};

export type ProductOut = {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  image: unknown | null;
  extraImages: unknown[];       // never null — empty array if none, so client loops safely
  deliveryText: string | null;
  createdAt: number;
  updatedAt: number | null;
};

function toBusinessOut(r: BusinessRow): BusinessOut {
  return {
    id: r.id, ownerId: r.owner_id, name: r.name, description: r.description,
    avatar: r.avatar_json ? safeJson(r.avatar_json) : null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function toProductOut(r: ProductRow): ProductOut {
  const extras = r.extra_images_json ? safeJson(r.extra_images_json) : null;
  return {
    id: r.id, businessId: r.business_id, name: r.name, description: r.description,
    priceCents: r.price_cents, currency: r.currency,
    image: r.image_json ? safeJson(r.image_json) : null,
    extraImages: Array.isArray(extras) ? extras : [],
    deliveryText: r.delivery_text,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// MediaRef shape, used to validate what the client hands us for
// avatars and product images. Permissive enough to accept the full
// client MediaRef object including transcript/width/height etc.
const mediaRefSchema = z.object({
  kind: z.enum(["image", "video", "audio", "voice", "file"]),
  blobId: z.string(),
  mime: z.string(),
  byteSize: z.number().int().nonnegative(),
  contentKey: z.string(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  durationMs: z.number().int().optional(),
  filename: z.string().optional(),
  transcript: z.string().optional(),
  viewOnce: z.boolean().optional(),
}).passthrough();

// ---- business profile ----

export async function getMyBusiness(req: AuthedReq, res: Response) {
  try {
    const row = await db.prepare(
      "SELECT * FROM businesses WHERE owner_id = ? AND archived_at IS NULL",
    ).get<BusinessRow>(req.userId);
    if (!row) return res.json(null);
    const products = await listActiveProducts(row.id);
    res.json({ ...toBusinessOut(row), products });
  } catch (e) { handle(res, e); }
}

const profileSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).optional().nullable(),
  avatar: mediaRefSchema.optional().nullable(),
});

// Upsert — if the caller has no business yet, create one; otherwise
// update the fields they sent. Keeps the client's single
// "createOrUpdateBusiness" entry point simple.
export async function createOrUpdateBusiness(req: AuthedReq, res: Response) {
  try {
    const body = profileSchema.parse(req.body);
    const now = Date.now();
    const existing = await db.prepare(
      "SELECT * FROM businesses WHERE owner_id = ? AND archived_at IS NULL",
    ).get<BusinessRow>(req.userId);
    const avatarJson = body.avatar === null ? null
      : body.avatar === undefined ? (existing?.avatar_json ?? null)
      : JSON.stringify(body.avatar);
    const desc = body.description ?? existing?.description ?? null;
    if (existing) {
      await db.prepare(
        "UPDATE businesses SET name = ?, description = ?, avatar_json = ?, updated_at = ? WHERE id = ?",
      ).run(body.name, desc, avatarJson, now, existing.id);
      const row = await db.prepare("SELECT * FROM businesses WHERE id = ?")
        .get<BusinessRow>(existing.id);
      return res.json(toBusinessOut(row!));
    }
    const id = randomUUID();
    await db.prepare(
      `INSERT INTO businesses (id, owner_id, name, description, avatar_json, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(id, req.userId, body.name, desc, avatarJson, now);
    const row = await db.prepare("SELECT * FROM businesses WHERE id = ?")
      .get<BusinessRow>(id);
    return res.json(toBusinessOut(row!));
  } catch (e) { handle(res, e); }
}

// Public lookup, catalogue included. Any signed-in user may read any
// business — this is the "public profile" endpoint.
export async function getBusinessPublic(req: AuthedReq, res: Response) {
  try {
    const row = await db.prepare(
      "SELECT * FROM businesses WHERE id = ? AND archived_at IS NULL",
    ).get<BusinessRow>(req.params.id);
    if (!row) return res.status(404).json({ error: "not_found" });
    const products = await listActiveProducts(row.id);
    res.json({ ...toBusinessOut(row), products });
  } catch (e) { handle(res, e); }
}

// "Does this user own a business, and if so which one?" — the per-chat
// agent calls this once per thread so it knows whether the current
// peer runs a business and which catalogue to query.
export async function getBusinessByOwner(req: AuthedReq, res: Response) {
  try {
    const row = await db.prepare(
      "SELECT * FROM businesses WHERE owner_id = ? AND archived_at IS NULL",
    ).get<BusinessRow>(req.params.userId);
    if (!row) return res.json(null);
    const products = await listActiveProducts(row.id);
    res.json({ ...toBusinessOut(row), products });
  } catch (e) { handle(res, e); }
}

// ---- catalogue ----

async function listActiveProducts(businessId: string): Promise<ProductOut[]> {
  const rows = await db.prepare(
    `SELECT * FROM business_products
      WHERE business_id = ? AND archived_at IS NULL
      ORDER BY created_at DESC, id DESC`,
  ).all<ProductRow>(businessId);
  return rows.map(toProductOut);
}

async function requireOwned(businessId: string, userId: string): Promise<BusinessRow> {
  const row = await db.prepare(
    "SELECT * FROM businesses WHERE id = ? AND archived_at IS NULL",
  ).get<BusinessRow>(businessId);
  if (!row) throw new AuthError("not_found", "That business doesn't exist.");
  if (row.owner_id !== userId) throw new ForbiddenError("not_yours", "That isn't your business.");
  return row;
}

const productSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  priceCents: z.number().int().nonnegative().max(10_000_000),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  image: mediaRefSchema.optional().nullable(),
  // Up to 7 additional images (cover + 7 = 8 total, matching the diary
  // album cap already in play — a buyer scrolling through "all photos"
  // of a product is doing the same thing a reader is doing with a
  // multi-photo diary entry, so one limit covers both).
  extraImages: z.array(mediaRefSchema).max(7).optional().nullable(),
  deliveryText: z.string().trim().max(500).optional().nullable(),
});

export async function addProduct(req: AuthedReq, res: Response) {
  try {
    await requireOwned(req.params.id, req.userId);
    const body = productSchema.parse(req.body);
    const id = randomUUID();
    const now = Date.now();
    await db.prepare(
      `INSERT INTO business_products
         (id, business_id, name, description, price_cents, currency,
          image_json, extra_images_json, delivery_text,
          created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      id, req.params.id, body.name, body.description ?? null,
      body.priceCents, body.currency ?? "USD",
      body.image ? JSON.stringify(body.image) : null,
      body.extraImages && body.extraImages.length > 0 ? JSON.stringify(body.extraImages) : null,
      body.deliveryText ?? null,
      now,
    );
    const row = await db.prepare("SELECT * FROM business_products WHERE id = ?")
      .get<ProductRow>(id);
    res.json(toProductOut(row!));
  } catch (e) { handle(res, e); }
}

const productPatchSchema = productSchema.partial();

export async function updateProduct(req: AuthedReq, res: Response) {
  try {
    await requireOwned(req.params.id, req.userId);
    const body = productPatchSchema.parse(req.body);
    const existing = await db.prepare(
      "SELECT * FROM business_products WHERE id = ? AND business_id = ? AND archived_at IS NULL",
    ).get<ProductRow>(req.params.productId, req.params.id);
    if (!existing) return res.status(404).json({ error: "not_found" });
    const name = body.name ?? existing.name;
    const desc = body.description === undefined ? existing.description
      : body.description === null ? null : body.description;
    const price = body.priceCents ?? existing.price_cents;
    const currency = body.currency ?? existing.currency;
    const imageJson = body.image === undefined ? existing.image_json
      : body.image === null ? null : JSON.stringify(body.image);
    const extraJson = body.extraImages === undefined ? existing.extra_images_json
      : (body.extraImages === null || body.extraImages.length === 0)
        ? null
        : JSON.stringify(body.extraImages);
    const delivery = body.deliveryText === undefined ? existing.delivery_text
      : body.deliveryText === null ? null : body.deliveryText;
    await db.prepare(
      `UPDATE business_products
          SET name = ?, description = ?, price_cents = ?, currency = ?,
              image_json = ?, extra_images_json = ?, delivery_text = ?, updated_at = ?
        WHERE id = ?`,
    ).run(name, desc, price, currency, imageJson, extraJson, delivery, Date.now(), existing.id);
    const row = await db.prepare("SELECT * FROM business_products WHERE id = ?")
      .get<ProductRow>(existing.id);
    res.json(toProductOut(row!));
  } catch (e) { handle(res, e); }
}

// Soft-delete — the product disappears from catalogue listings and
// Discover ads, but a prior order's items_json still names it (we
// freeze the sold-at snapshot at order time).
export async function deleteProduct(req: AuthedReq, res: Response) {
  try {
    await requireOwned(req.params.id, req.userId);
    const existing = await db.prepare(
      "SELECT id FROM business_products WHERE id = ? AND business_id = ?",
    ).get<{ id: string }>(req.params.productId, req.params.id);
    if (!existing) return res.status(404).json({ error: "not_found" });
    await db.prepare(
      "UPDATE business_products SET archived_at = ? WHERE id = ?",
    ).run(Date.now(), existing.id);
    res.json({ ok: true });
  } catch (e) { handle(res, e); }
}

// ---- earnings + payouts (Addendum A) ----

type OrderRow = {
  id: string;
  business_id: string;
  items_json: string;
  total_cents: number;
  currency: string;
  fee_cents: number;
  net_cents: number;
  fee_bps: number;
  status: string;
  created_at: number;
};

type PayoutRow = {
  id: string;
  business_id: string;
  amount_cents: number;
  currency: string;
  destination: string | null;
  destination_kind: string | null;
  status: string;
  paypal_batch_id: string | null;
  requested_at: number;
  completed_at: number | null;
};

function toPayoutOut(r: PayoutRow) {
  return {
    id: r.id, businessId: r.business_id,
    amountCents: r.amount_cents, currency: r.currency,
    destination: r.destination, destinationKind: r.destination_kind,
    status: r.status, paypalBatchId: r.paypal_batch_id,
    requestedAt: r.requested_at, completedAt: r.completed_at,
  };
}

// Earnings view. One query from the server's perspective is a few
// aggregates + a bounded "recent orders" fetch — cheap even on a
// seller with thousands of orders because of the (business_id,
// created_at) index.
export async function getBusinessEarnings(req: AuthedReq, res: Response) {
  try {
    const biz = await requireOwned(req.params.id, req.userId);

    const captured = await db.prepare(
      `SELECT COALESCE(SUM(total_cents), 0) AS gross,
              COALESCE(SUM(fee_cents),   0) AS fee,
              COALESCE(SUM(net_cents),   0) AS net,
              MIN(currency)                 AS currency
         FROM business_orders
        WHERE business_id = ? AND status = 'captured'`,
    ).get<{ gross: number; fee: number; net: number; currency: string | null }>(biz.id);

    const payoutAgg = await db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN status = 'paid'      THEN amount_cents ELSE 0 END), 0) AS paid_out,
              COALESCE(SUM(CASE WHEN status = 'requested' THEN amount_cents ELSE 0 END), 0) AS pending
         FROM business_payouts
        WHERE business_id = ?`,
    ).get<{ paid_out: number; pending: number }>(biz.id);

    const totalGross = Number(captured?.gross ?? 0);
    const totalFee   = Number(captured?.fee   ?? 0);
    const totalNet   = Number(captured?.net   ?? 0);
    const paidOut    = Number(payoutAgg?.paid_out ?? 0);
    const pending    = Number(payoutAgg?.pending  ?? 0);
    // "Available" never goes negative — a defensive floor in case a
    // manual DB correction ever leaves the math upside down.
    const available  = Math.max(0, totalNet - paidOut - pending);

    const recent = await db.prepare(
      `SELECT id, business_id, items_json, total_cents, currency,
              fee_cents, net_cents, fee_bps, status, created_at
         FROM business_orders
        WHERE business_id = ?
        ORDER BY created_at DESC LIMIT 20`,
    ).all<OrderRow>(biz.id);

    res.json({
      totalGrossCents:    totalGross,
      totalFeeCents:      totalFee,
      totalNetCents:      totalNet,
      paidOutCents:       paidOut,
      pendingPayoutCents: pending,
      availableCents:     available,
      currency: captured?.currency ?? "USD",
      // The current take-rate, surfaced here so the UI can show
      // "Aegent takes 5% per sale" without hard-coding it client-side.
      commissionBps: COMMISSION_BPS,
      recentOrders: recent.map((r) => ({
        id: r.id,
        items: safeJson(r.items_json),
        totalCents: r.total_cents,
        feeCents: r.fee_cents,
        netCents: r.net_cents,
        feeBps:   r.fee_bps,
        currency: r.currency,
        status:   r.status,
        createdAt: Number(r.created_at),
      })),
    });
  } catch (e) { handle(res, e); }
}

const payoutRequestSchema = z.object({
  amountCents: z.number().int().positive().optional(),
  destination: z.string().trim().min(1).max(200),
  destinationKind: z.enum(["paypal"]).default("paypal"),
});

// Record a payout request. Does NOT move money; the follow-up PayPal
// Payouts call will flip status to 'paid' later. Guarded by the same
// available-balance arithmetic as the Earnings view so a seller can't
// request more than they've actually earned.
export async function requestPayout(req: AuthedReq, res: Response) {
  try {
    const biz = await requireOwned(req.params.id, req.userId);
    const body = payoutRequestSchema.parse(req.body);

    // Reuse the earnings math inline — cheaper than re-fetching the
    // whole response, and keeps the two paths in agreement.
    const net = await db.prepare(
      "SELECT COALESCE(SUM(net_cents), 0) AS net, MIN(currency) AS currency FROM business_orders WHERE business_id = ? AND status = 'captured'",
    ).get<{ net: number; currency: string | null }>(biz.id);
    const payoutAgg = await db.prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS used FROM business_payouts WHERE business_id = ? AND status IN ('paid','requested')",
    ).get<{ used: number }>(biz.id);
    const available = Math.max(0, Number(net?.net ?? 0) - Number(payoutAgg?.used ?? 0));
    const amount = body.amountCents ?? available;
    if (amount <= 0) {
      return res.status(400).json({ error: "no_balance", message: "Nothing available to pay out yet." });
    }
    if (amount > available) {
      return res.status(400).json({
        error: "insufficient_balance",
        message: `Only ${(available / 100).toFixed(2)} available; you asked for ${(amount / 100).toFixed(2)}.`,
      });
    }

    const id = randomUUID();
    const now = Date.now();
    await db.prepare(
      `INSERT INTO business_payouts
         (id, business_id, amount_cents, currency, destination, destination_kind,
          status, paypal_batch_id, requested_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'requested', NULL, ?, NULL)`,
    ).run(id, biz.id, amount, net?.currency ?? "USD", body.destination, body.destinationKind, now);

    const row = await db.prepare("SELECT * FROM business_payouts WHERE id = ?").get<PayoutRow>(id);
    res.json(toPayoutOut(row!));
  } catch (e) { handle(res, e); }
}

export async function listPayouts(req: AuthedReq, res: Response) {
  try {
    const biz = await requireOwned(req.params.id, req.userId);
    const rows = await db.prepare(
      `SELECT * FROM business_payouts WHERE business_id = ?
        ORDER BY requested_at DESC LIMIT 50`,
    ).all<PayoutRow>(biz.id);
    res.json(rows.map(toPayoutOut));
  } catch (e) { handle(res, e); }
}

// ---- business-ad feed row (helper for the Discover feed UNION) ----

export type BusinessAdFeedRow = {
  business_id: string;
  owner_id: string;
  business_name: string;
  product_id: string;
  product_name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  image_json: string | null;
  created_at: number;
  // Author profile for the Discover card header (business owner).
  display_name: string;
  handle: string;
  public_key: string;
  avatar: string | null;
};

// One row per business, carrying its NEWEST product — so a business
// with 20 products contributes one ad to the global feed, not 20. The
// per-business MAX(created_at) is computed by a correlated subquery
// to avoid relying on window functions (works on both SQLite and PG).
// `viewerId` excludes the viewer's own business (you don't discover
// yourself). `before` paginates on the ad's effective created_at.
export async function discoverBusinessAds(
  viewerId: string, opts: { before?: number; limit?: number },
): Promise<BusinessAdFeedRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const args: unknown[] = [viewerId];
  let before = "";
  if (opts.before) { before = " AND p.created_at < ?"; args.push(opts.before); }
  return db.prepare(
    `SELECT b.id            AS business_id,
            b.owner_id      AS owner_id,
            b.name          AS business_name,
            p.id            AS product_id,
            p.name          AS product_name,
            p.description   AS description,
            p.price_cents   AS price_cents,
            p.currency      AS currency,
            p.image_json    AS image_json,
            p.created_at    AS created_at,
            u.display_name  AS display_name,
            u.handle        AS handle,
            u.public_key    AS public_key,
            u.avatar        AS avatar
       FROM businesses b
       JOIN business_products p ON p.business_id = b.id AND p.archived_at IS NULL
       JOIN users u ON u.id = b.owner_id
      WHERE b.archived_at IS NULL
        AND b.owner_id != ?
        AND p.created_at = (
          SELECT MAX(pp.created_at) FROM business_products pp
           WHERE pp.business_id = b.id AND pp.archived_at IS NULL
        )
        ${before}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${limit}`,
  ).all<BusinessAdFeedRow>(...args);
}

// ---- shared error handler ----
//
// Mirrors the lightweight pattern used elsewhere in the server:
// known auth/forbidden errors return a tagged 4xx, anything else is
// a 500 with the message in a stable shape.
function handle(res: Response, e: unknown) {
  if (e instanceof ForbiddenError) {
    return res.status(403).json({ error: e.code, message: e.message });
  }
  if (e instanceof AuthError) {
    return res.status(400).json({ error: e.code, message: e.message });
  }
  if (e instanceof z.ZodError) {
    return res.status(400).json({ error: "bad_request", message: e.message });
  }
  const msg = (e as Error)?.message ?? String(e);
  res.status(500).json({ error: "server_error", message: msg });
}
