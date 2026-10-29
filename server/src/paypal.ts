// PayPal checkout — server-side proxy for the Orders API v2.
//
// Mirrors websearch.ts's shape: a `*Enabled()` guard against unset
// credentials, exported (req, res) handlers, internal fetch helpers,
// AbortSignal.timeout(...) on every outbound call, zod body
// validation, no SDK dependency.
//
// Why two endpoints:
//   POST /api/checkout/orders          — buyer presses Pay (after
//     passing a LOCAL Checkout PIN gate on the client; the PIN never
//     reaches here). We recompute the total server-side from the
//     catalogue, insert an audit row, create the PayPal order, and
//     return the approve-link so the client can open PayPal's
//     hosted approval page.
//   POST /api/checkout/orders/:id/capture — buyer has approved via
//     PayPal's hosted page; capture the funds and mark the local
//     order row captured/failed.
//
// Payee of record (deliberate MVP simplification): purchase_units
// omits `payee`, so Aegent's own sandbox merchant (the account the
// PAYPAL_CLIENT_ID belongs to) is the receiver of every order.
// Reasons:
//   (a) The user's own sandbox has a Nigerian fund-reception
//       restriction that would reject a per-business payee here.
//   (b) Per-business PayPal merchant onboarding (Partner Referrals)
//       is a multi-week integration and sits firmly outside the
//       hackathon MVP scope.
// business_orders.business_id + items_json keeps the "which Aegent
// business was this for" audit internally — PayPal only ever sees
// Aegent as merchant.

import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db.js";

type AuthedReq = Request & { userId: string };

const PAYPAL_BASE = process.env.PAYPAL_ENV === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

export function paypalEnabled(): boolean {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

// Aegent's cut of every captured order, in basis points (1/100th of a
// percent). 500 = 5%. Deliberately low to minimise seller friction and
// shown openly in each seller's Earnings view — no hidden fees. If this
// ever needs to vary per-business, promote it to a column on
// `businesses` and read it per-order at create time. For now it's one
// visible number in one place, which is what a hackathon demo should
// show. Compare: Shopify ~2.9% + 30¢, Gumroad 10%, Etsy 6.5% + listing.
export const COMMISSION_BPS = 500;

// Module-level cache for the OAuth2 access token. PayPal access tokens
// expire in ~9 hours; cache with a 5s skew so a mid-flight request
// doesn't race the expiry.
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 5000) return tokenCache.token;
  const basic = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
  ).toString("base64");
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`paypal_auth_failed_${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json() as { access_token: string; expires_in: number };
  tokenCache = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

// ---- create order ----

const createSchema = z.object({
  businessId: z.string().min(1),
  items: z.array(z.object({
    productId: z.string().min(1),
    qty: z.number().int().min(1).max(50),
  })).min(1).max(20),
});

type ProductRow = {
  id: string; business_id: string; name: string;
  price_cents: number; currency: string; archived_at: number | null;
};
type BusinessRow = {
  id: string; owner_id: string; name: string; archived_at: number | null;
};

export async function createCheckoutOrder(req: AuthedReq, res: Response) {
  if (!paypalEnabled()) {
    return res.status(503).json({
      error: "paypal_disabled",
      message: "PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.",
    });
  }
  let body: z.infer<typeof createSchema>;
  try { body = createSchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: "bad_request", message: (e as Error).message }); }

  try {
    // Load business.
    const biz = await db.prepare(
      "SELECT id, owner_id, name, archived_at FROM businesses WHERE id = ? AND archived_at IS NULL",
    ).get<BusinessRow>(body.businessId);
    if (!biz) return res.status(404).json({ error: "unknown_business" });

    // Recompute total from the catalogue — never trust the client.
    const resolved: Array<{ productId: string; name: string; qty: number; unitPriceCents: number }> = [];
    let currency: string | null = null;
    for (const it of body.items) {
      const p = await db.prepare(
        "SELECT id, business_id, name, price_cents, currency, archived_at FROM business_products WHERE id = ? AND business_id = ? AND archived_at IS NULL",
      ).get<ProductRow>(it.productId, biz.id);
      if (!p) return res.status(404).json({ error: "unknown_product", message: it.productId });
      if (!currency) currency = p.currency;
      else if (currency !== p.currency) {
        return res.status(400).json({ error: "mixed_currency", message: "All items must share a currency." });
      }
      resolved.push({ productId: p.id, name: p.name, qty: it.qty, unitPriceCents: p.price_cents });
    }
    const totalCents = resolved.reduce((s, it) => s + it.unitPriceCents * it.qty, 0);
    const activeCurrency = currency ?? "USD";

    // Commission split, frozen on the row. The seller sees this exact
    // breakdown in their Earnings view. PayPal still charges the full
    // totalCents to the buyer; this is purely an internal ledger
    // between Aegent (merchant of record) and the seller.
    const feeCents = Math.floor(totalCents * COMMISSION_BPS / 10000);
    const netCents = totalCents - feeCents;

    // Insert the local audit row BEFORE calling PayPal, so a timeout
    // between create-order and our row-insert never leaves a PayPal
    // order with no local counterpart.
    const orderId = randomUUID();
    const now = Date.now();
    await db.prepare(
      `INSERT INTO business_orders
         (id, business_id, buyer_id, items_json, total_cents, currency,
          fee_cents, net_cents, fee_bps,
          paypal_order_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'created', ?, NULL)`,
    ).run(
      orderId, biz.id, req.userId, JSON.stringify(resolved), totalCents, activeCurrency,
      feeCents, netCents, COMMISSION_BPS,
      now,
    );

    // Create the PayPal order. intent CAPTURE lets us capture
    // immediately after the buyer approves; no separate authorize step.
    // custom_id ties PayPal's record back to our audit row.
    const token = await getAccessToken();
    const amount = (totalCents / 100).toFixed(2);
    const paypalBody = {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: orderId,
        custom_id: orderId,
        description: `Aegent · ${biz.name}`.slice(0, 127),
        amount: { currency_code: activeCurrency, value: amount },
        items: resolved.map((r) => ({
          name: r.name.slice(0, 127),
          quantity: String(r.qty),
          unit_amount: {
            currency_code: activeCurrency,
            value: (r.unitPriceCents / 100).toFixed(2),
          },
        })),
      }],
      application_context: {
        brand_name: "Aegent",
        user_action: "PAY_NOW",
        return_url: process.env.PAYPAL_RETURN_URL ?? "https://aegent.cereustechnologies.com/checkout/return",
        cancel_url: process.env.PAYPAL_CANCEL_URL ?? "https://aegent.cereustechnologies.com/checkout/cancel",
      },
    };
    const pr = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": orderId,
      },
      body: JSON.stringify(paypalBody),
      signal: AbortSignal.timeout(12_000),
    });
    if (!pr.ok) {
      const errText = await pr.text().catch(() => "");
      await db.prepare(
        "UPDATE business_orders SET status = 'failed', updated_at = ? WHERE id = ?",
      ).run(Date.now(), orderId);
      return res.status(502).json({
        error: "paypal_create_failed",
        message: `PayPal returned ${pr.status}`,
        detail: errText.slice(0, 500),
      });
    }
    const pj = await pr.json() as {
      id: string;
      status?: string;
      links?: Array<{ href: string; rel: string; method: string }>;
    };

    await db.prepare(
      "UPDATE business_orders SET paypal_order_id = ?, updated_at = ? WHERE id = ?",
    ).run(pj.id, Date.now(), orderId);

    const approve = pj.links?.find((l) => l.rel === "approve")?.href ?? null;
    res.json({
      orderId,
      paypalOrderId: pj.id,
      approveUrl: approve,
      status: pj.status ?? "CREATED",
    });
  } catch (e) {
    res.status(500).json({ error: "server_error", message: (e as Error).message });
  }
}

// ---- capture order ----

export async function captureCheckoutOrder(req: AuthedReq, res: Response) {
  if (!paypalEnabled()) {
    return res.status(503).json({ error: "paypal_disabled" });
  }
  const orderId = req.params.id;
  try {
    const row = await db.prepare(
      "SELECT * FROM business_orders WHERE id = ?",
    ).get<{
      id: string; business_id: string; buyer_id: string;
      paypal_order_id: string | null; status: string;
    }>(orderId);
    if (!row) return res.status(404).json({ error: "not_found" });
    if (row.buyer_id !== req.userId) {
      return res.status(403).json({ error: "not_your_order" });
    }
    if (!row.paypal_order_id) {
      return res.status(400).json({ error: "no_paypal_order", message: "This order was never created on PayPal." });
    }
    if (row.status === "captured") {
      // Idempotent — a double-tap on Pay shouldn't double-charge.
      return res.json({ ok: true, status: "captured" });
    }

    const token = await getAccessToken();
    const pr = await fetch(
      `${PAYPAL_BASE}/v2/checkout/orders/${encodeURIComponent(row.paypal_order_id)}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": `cap-${orderId}`,
        },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      },
    );
    const pj = await pr.json().catch(() => ({}));
    if (!pr.ok) {
      await db.prepare(
        "UPDATE business_orders SET status = 'failed', updated_at = ? WHERE id = ?",
      ).run(Date.now(), orderId);
      return res.status(502).json({
        error: "paypal_capture_failed",
        message: `PayPal returned ${pr.status}`,
        detail: JSON.stringify(pj).slice(0, 500),
      });
    }
    const status = (pj as { status?: string }).status ?? "COMPLETED";
    const nextStatus = status === "COMPLETED" ? "captured" : "failed";
    await db.prepare(
      "UPDATE business_orders SET status = ?, updated_at = ? WHERE id = ?",
    ).run(nextStatus, Date.now(), orderId);
    res.json({ ok: nextStatus === "captured", status: nextStatus });
  } catch (e) {
    res.status(500).json({ error: "server_error", message: (e as Error).message });
  }
}

// ---- list orders (buyer-side history, optional, cheap) ----

export async function listMyOrders(req: AuthedReq, res: Response) {
  try {
    const rows = await db.prepare(
      `SELECT id, business_id, items_json, total_cents, currency, status, created_at
         FROM business_orders WHERE buyer_id = ?
        ORDER BY created_at DESC LIMIT 50`,
    ).all<{
      id: string; business_id: string; items_json: string;
      total_cents: number; currency: string; status: string; created_at: number;
    }>(req.userId);
    res.json(rows.map((r) => ({
      id: r.id, businessId: r.business_id,
      items: safeArr(r.items_json),
      totalCents: r.total_cents, currency: r.currency,
      status: r.status, createdAt: r.created_at,
    })));
  } catch (e) {
    res.status(500).json({ error: "server_error", message: (e as Error).message });
  }
}

function safeArr(s: string): unknown[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}
