// Message translation.
//
// This is the one place in the app that genuinely breaks the end-to-end
// promise for whatever passes through it. The relay never sees a
// message; the translation service does. That trade-off belongs to the
// person asking for the translation, which is why:
//
//   * nothing is translated unless they tap "Translate" on a specific
//     message (no automatic translation of a thread, ever),
//   * the first use shows an explicit consent card naming the service,
//     and the choice is remembered per account,
//   * the target language and provider URL live in Settings, so the
//     person can self-host a LibreTranslate instance and point here —
//     the free public endpoint is a convenience, not a lock-in.
//
// LibreTranslate is the default: open-source, no API key required for
// most self-hosts, and public instances exist (quality varies, and the
// most popular one rate-limits aggressively, so we expect the person to
// bring their own URL for serious use).

const DEFAULT_ENDPOINT = "https://translate.disroot.org";   // free, no key, run by Disroot
const META_CONSENT = () => `aegent.translate-consent`;
const META_URL = "aegent.translate.url";
const META_TARGET = "aegent.translate.target";

export function translationConsentGranted(): boolean {
  try { return localStorage.getItem(META_CONSENT()) === "1"; } catch { return false; }
}
export function grantTranslationConsent(): void {
  try { localStorage.setItem(META_CONSENT(), "1"); } catch { /* ignore */ }
}
export function revokeTranslationConsent(): void {
  try { localStorage.removeItem(META_CONSENT()); } catch { /* ignore */ }
}

export function translationEndpoint(): string {
  try { return localStorage.getItem(META_URL) || DEFAULT_ENDPOINT; } catch { return DEFAULT_ENDPOINT; }
}
export function setTranslationEndpoint(url: string): void {
  try {
    const trimmed = url.trim().replace(/\/+$/, "");
    if (trimmed) localStorage.setItem(META_URL, trimmed);
    else localStorage.removeItem(META_URL);
  } catch { /* ignore */ }
}

// A short, curated list — this is what people change to; the raw
// LibreTranslate /languages endpoint lists ~40, most of which nobody
// needs. "auto" tells the server to detect the source.
export const TRANSLATION_TARGETS: Array<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "ru", label: "Russian" },
  { code: "sw", label: "Swahili" },
  { code: "yo", label: "Yoruba" },
];

export function targetLanguage(): string {
  try { return localStorage.getItem(META_TARGET) || defaultTarget(); } catch { return defaultTarget(); }
}
export function setTargetLanguage(code: string): void {
  try { localStorage.setItem(META_TARGET, code); } catch { /* ignore */ }
}
function defaultTarget(): string {
  // Honour the browser's language if we can translate TO it, else English.
  try {
    const guess = (navigator.language || "en").toLowerCase().split("-")[0];
    return TRANSLATION_TARGETS.some((t) => t.code === guess) ? guess : "en";
  } catch { return "en"; }
}

// Per-session cache keyed by (text, target). A chat full of hearts and
// "ok"s would otherwise re-hit the API constantly for identical strings.
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export async function translateText(text: string, target = targetLanguage()): Promise<string> {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  const key = `${target}|${trimmed}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const call = (async () => {
    try {
      const r = await fetch(`${translationEndpoint()}/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: trimmed, source: "auto", target, format: "text" }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        // Some instances answer non-JSON errors; keep the message useful.
        throw new Error(`translate_${r.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
      }
      const data = await r.json() as { translatedText?: string; error?: string };
      if (!data.translatedText) throw new Error(data.error || "no_translation");
      const out = data.translatedText;
      cache.set(key, out);
      return out;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, call);
  return call;
}
