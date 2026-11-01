// Paystack checkout — the second rail alongside PayPal.
//
// Paystack settles the currencies PayPal won't: NGN, GHS, ZAR, KES
// (and USD, which lets a buyer in Africa pay in local tender while
// the seller still prices in dollars if they prefer). Dispatch is
// currency-driven: an order in a Paystack-only currency goes down
// this rail, an order in a PayPal-only currency goes down the other,
// and USD can go either way (we prefer Paystack when both are
// configured, because Paystack-NG resolves naira cards natively).
//
// Shape mirrors paypal.ts: single secret key (PAYSTACK_SECRET_KEY),
// REST calls via fetch with AbortSignal.timeout, no SDK dependency.
// The server does the whole flow — Paystack doesn't need a client
// key for the hosted-checkout path. Public key would only be needed
// for their inline (iframe) widget, which we deliberately skip for
// MVP so the same "open approve URL + visibilitychange" rail used by
// PayPal continues to work.
//
// Error handling learns from the PayPal round: translate named
// errors to prose, surface them to the client, and don't flip the
// local row to 'failed' on retryable states (buyer closed the tab,
// provider is slow, etc.).

import type { Request } from "express";

const PAYSTACK_BASE = "https://api.paystack.co";

// Paystack's current merchant-settlement list (per
// https://paystack.com/docs/payments/multicurrency — valid as of
// 2025-11). Narrow enough to be worth hard-coding; expand when
// Paystack adds a region. USD is here because Paystack-NG now
// supports USD settlement for export sellers.
export const PAYSTACK_SUPPORTED_CURRENCIES = new Set([
  "NGN", "GHS", "ZAR", "KES", "USD",
]);

export function paystackEnabled(): boolean {
  return !!process.env.PAYSTACK_SECRET_KEY;
}

export type PaystackInitInput = {
  orderId: string;
  totalCents: number;
  currency: string;
  buyerEmail: string;
  businessName: string;
  callbackUrl: string;
  // Just for the metadata panel in Paystack's merchant dashboard —
  // nothing structural depends on this.
  itemsSummary: string;
};

export type PaystackInitResult = {
  reference: string;
  authorizationUrl: string;
};

// Create a Paystack transaction and get back the hosted-checkout URL.
// Throws a Error whose .message is already client-safe — the server
// handler can forward it verbatim.
export async function paystackInit(input: PaystackInitInput): Promise<PaystackInitResult> {
  if (!paystackEnabled()) throw new Error("Paystack isn't configured on the server.");
  // Paystack takes the amount in the smallest subunit of the
  // currency — kobo for NGN, pesewas for GHS, cents for USD/KES/ZAR.
  // All five use ×100, so totalCents is already correct.
  const payload = {
    email: input.buyerEmail,
    amount: input.totalCents,
    currency: input.currency,
    // Our own order id doubles as the Paystack reference, so a
    // retry (idempotent on their side) resolves to the same txn.
    reference: input.orderId,
    callback_url: input.callbackUrl,
    metadata: {
      aegent_order_id: input.orderId,
      business: input.businessName,
      items: input.itemsSummary,
    },
  };
  const r = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await r.json().catch(() => ({})) as {
    status?: boolean;
    message?: string;
    data?: { authorization_url?: string; access_code?: string; reference?: string };
  };
  if (!r.ok || !body.status || !body.data?.authorization_url || !body.data?.reference) {
    const msg = body.message ?? `Paystack returned ${r.status}`;
    throw new Error(translatePaystackMessage(msg, r.status));
  }
  return {
    reference: body.data.reference,
    authorizationUrl: body.data.authorization_url,
  };
}

export type PaystackVerifyResult = {
  // 'captured' | 'failed' | 'pending' — same vocabulary as our
  // business_orders.status column so callers write it directly.
  nextStatus: "captured" | "failed" | "pending";
  paystackStatus: string;
};

// Verify a Paystack transaction after the buyer returns from the
// hosted checkout. Paystack's /verify is idempotent and returns the
// authoritative state, so this is the ONLY call needed on return —
// no separate "capture" step the way PayPal has.
export async function paystackVerify(reference: string): Promise<PaystackVerifyResult> {
  if (!paystackEnabled()) throw new Error("Paystack isn't configured on the server.");
  const r = await fetch(
    `${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  const body = await r.json().catch(() => ({})) as {
    status?: boolean;
    message?: string;
    data?: { status?: string; reference?: string; amount?: number; currency?: string };
  };
  if (!r.ok || !body.status) {
    throw new Error(translatePaystackMessage(body.message ?? `Paystack returned ${r.status}`, r.status));
  }
  const s = body.data?.status ?? "unknown";
  // Paystack transaction states: success, failed, abandoned, reversed,
  // ongoing, processing, pending, queued, timeout.
  if (s === "success") return { nextStatus: "captured", paystackStatus: s };
  if (s === "pending" || s === "ongoing" || s === "processing" || s === "queued") {
    // Buyer may still be mid-flow — don't fail the local row yet.
    return { nextStatus: "pending", paystackStatus: s };
  }
  return { nextStatus: "failed", paystackStatus: s };
}

// Resolve a Paystack-side error (or a status string) to one line of
// seller/buyer prose. Falls back to the raw message if we don't
// recognise it, so we never swallow context the way the PayPal 422
// used to.
function translatePaystackMessage(msg: string, httpStatus: number): string {
  const lower = msg.toLowerCase();
  if (lower.includes("invalid key") || lower.includes("no authorization") || httpStatus === 401) {
    return "Paystack rejected the server's secret key — set PAYSTACK_SECRET_KEY to a valid test (sk_test_...) or live (sk_live_...) key and restart.";
  }
  if (lower.includes("currency not supported") || lower.includes("currency is not")) {
    return "Paystack says this merchant isn't configured for that currency. Enable the currency in your Paystack dashboard, or set the product to NGN / USD.";
  }
  if (lower.includes("amount") && lower.includes("minimum")) {
    return "This amount is below Paystack's minimum. Raise the product price and try again.";
  }
  if (lower.includes("duplicate")) {
    return "That transaction reference was already used on Paystack — reload and start a new order.";
  }
  if (lower.includes("abandoned")) {
    return "The Paystack checkout was abandoned without a payment. Reopen the approval tab and complete it, or start a new order.";
  }
  if (lower.includes("failed")) {
    return "Paystack reports this transaction as failed. Check the card/account used and retry — your Aegent order is still waiting.";
  }
  // Fall back to Paystack's own wording. HTTP status rides along for debugging.
  return `Paystack (${httpStatus}): ${msg}`;
}

// Build the callback URL Paystack redirects the buyer back to on
// completion. Same rules as PayPal: respect PAYSTACK_CALLBACK_URL if
// it points somewhere sensible, else derive from the request so dev
// and prod both work out of the box.
export function resolvePaystackCallback(req: Request & { userId: string }): string {
  const configured = process.env.PAYSTACK_CALLBACK_URL;
  const path = "/checkout/return";
  if (configured && !configured.includes("/api/")) {
    try {
      const u = new URL(configured);
      if (u.pathname === "/" || u.pathname === "") return `${u.origin}${path}`;
      return configured;
    } catch { /* fall through */ }
  }
  const origin = req.get("origin");
  if (origin && /^https?:\/\//.test(origin) && !origin.startsWith("capacitor:")) {
    return `${origin}${path}`;
  }
  const host = req.get("host");
  const proto = (req.get("x-forwarded-proto") ?? req.protocol ?? "https").split(",")[0].trim();
  if (host) return `${proto}://${host}${path}`;
  return `https://aegent.cereustechnologies.com${path}`;
}
