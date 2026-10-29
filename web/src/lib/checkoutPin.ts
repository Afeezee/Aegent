// Checkout PIN — a short local secret the buyer enters to confirm an
// agentic checkout before any PayPal call fires.
//
// Verified ENTIRELY on-device. The PIN itself never reaches the server
// or PayPal: we store a salt + a small canary wrapped by the key
// derived from the PIN, and verification is "derive from the attempted
// PIN → try to open the canary → catch failure = wrong PIN." This is
// the same shape login password verification already uses to unwrap
// `wrapped_priv` — just with its own domain-separated KDF context
// ("checkout-pin") so neither key can impersonate the other.
//
// Trust model consequence: "forgot PIN" has no server-side recovery by
// design. The only remedy is clearing the local meta row below — which
// loses nothing but the canary wrap; no funds, no messages, nothing
// else is encrypted with this key.
//
// Storage: a single `getMeta`/`setMeta` row — no Dexie schema version
// bump, no new table. Two tiny base64 strings in one JSON blob.

import { getMeta, setMeta } from "./store.js";
import { b64, deriveKey, newKdfSalt, secretBoxOpen, secretBoxSeal } from "./crypto.js";

const META_KEY = "checkoutPin";
// Canary string the wrapped-under-PIN secretbox is sealed over. Its
// value is irrelevant — only "did it decrypt" matters. A versioned
// literal lets a future rotation re-wrap without ambiguity.
const CANARY = "aegent-checkout-pin-v1";

type PinRecord = { salt: string; wrapped: string };

async function readRecord(): Promise<PinRecord | null> {
  const raw = await getMeta(META_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as PinRecord; } catch { return null; }
}

export async function hasCheckoutPin(): Promise<boolean> {
  return (await readRecord()) !== null;
}

// Sets (or replaces) the PIN. 4-6 digits is the UI contract, but we
// accept any non-empty string here so this helper stays general.
export async function setCheckoutPin(pin: string): Promise<void> {
  const trimmed = pin.trim();
  if (!trimmed) throw new Error("empty_pin");
  const salt = newKdfSalt();
  const key = await deriveKey(trimmed, salt, "checkout-pin");
  const wrapped = secretBoxSeal(key, new TextEncoder().encode(CANARY));
  const rec: PinRecord = { salt: b64.encode(salt), wrapped };
  await setMeta(META_KEY, JSON.stringify(rec));
}

export async function verifyCheckoutPin(pin: string): Promise<boolean> {
  const trimmed = pin.trim();
  if (!trimmed) return false;
  const rec = await readRecord();
  if (!rec) return false;
  try {
    const key = await deriveKey(trimmed, b64.decode(rec.salt), "checkout-pin");
    // Attempt-decrypt is itself the verification; a wrong key throws.
    secretBoxOpen(key, rec.wrapped);
    return true;
  } catch {
    return false;
  }
}

// Explicit "forget PIN" — the user can re-set a new one on next
// checkout. See the file-top comment for why there's no server
// recovery.
export async function clearCheckoutPin(): Promise<void> {
  await setMeta(META_KEY, "");
}
