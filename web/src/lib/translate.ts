// Message translation.
//
// This is the one place in the app that genuinely breaks the end-to-end
// promise for whatever passes through it. The relay never sees a
// message; Google does. That trade-off belongs to the person asking
// for the translation, which is why:
//
//   * nothing is translated unless they tap "Translate" on a specific
//     message (no automatic translation of a thread, ever),
//   * the first use shows an explicit consent card naming the service,
//     and the choice is remembered per account,
//   * the target language lives in Settings.
//
// Backend: Google Translate's unauthenticated `translate_a/single`
// endpoint — the same one every community wrapper around "Google
// Translate" ultimately hits. No API key, no quota account, no
// billing. It is NOT a documented Google Cloud API; it is the
// endpoint translate.google.com itself calls, and the open-source
// `google-translate-api`/`translatepy` packages have used it for
// years. It can rate-limit per IP, but a messenger-shaped workload
// (one request per tap, deduped) stays well below the ceiling.

const ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const META_CONSENT = "aegent.translate-consent";
const META_TARGET = "aegent.translate.target";

export function translationConsentGranted(): boolean {
  try { return localStorage.getItem(META_CONSENT) === "1"; } catch { return false; }
}
export function grantTranslationConsent(): void {
  try { localStorage.setItem(META_CONSENT, "1"); } catch { /* ignore */ }
}
export function revokeTranslationConsent(): void {
  try { localStorage.removeItem(META_CONSENT); } catch { /* ignore */ }
}

// A short, curated list — this is what people change to. The free
// endpoint supports ~100 languages; the ones below are the common
// cases plus the ones most relevant to this app's audience.
export const TRANSLATION_TARGETS: Array<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "zh-CN", label: "Chinese (Simplified)" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "ru", label: "Russian" },
  { code: "sw", label: "Swahili" },
  { code: "yo", label: "Yoruba" },
  { code: "ig", label: "Igbo" },
  { code: "ha", label: "Hausa" },
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
    const raw = (navigator.language || "en").toLowerCase();
    const guess = raw.startsWith("zh") ? "zh-CN" : raw.split("-")[0];
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
      // The `dt=t` flag asks for translated text only; `client=gtx` is
      // the public widget client that doesn't require a token.
      const url = `${ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(trimmed)}`;
      const r = await fetch(url, { method: "GET" });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`translate_${r.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
      }
      // Shape: [[["Hola","Hello",null,null,1]], null, "en", ...]
      // For multi-sentence inputs there are several entries in [0] —
      // concatenate every [0][i][0] in order.
      const data = await r.json() as unknown;
      if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("bad_response");
      const parts: string[] = [];
      for (const seg of data[0] as unknown[]) {
        if (Array.isArray(seg) && typeof seg[0] === "string") parts.push(seg[0]);
      }
      const out = parts.join("");
      if (!out) throw new Error("empty_response");
      cache.set(key, out);
      return out;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, call);
  return call;
}
