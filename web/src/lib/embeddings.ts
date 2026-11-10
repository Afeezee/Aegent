// Local semantic index.
//
// Full-quality embeddings (sentence-transformers, MiniLM, etc.) shipped
// as WASM at 20-90MB are the right production choice — see the spec's
// "sqlite-vec (embeddings) + FTS5" line. For the prototype we use a
// deterministic hashed-bigram embedding that runs in a millisecond with
// no downloads. It's honest about being weaker than a real model, but
// good enough that "the payment project" matches "we discussed
// payments" better than pure keyword search does.
//
// Swap plan: replace embed() with a call to a local model, keep the
// vector dimension and cosine consumer the same.

const DIM = 128;

// Matches Unicode combining diacritical marks (U+0300–U+036F). Written
// with escapes so the file has no non-ASCII bytes.
const DIACRITICS = /[̀-ͯ]/g;

// Unicode-aware tokenizer. The old split on /[^a-z0-9]+/ threw away
// every non-Latin script — Arabic, Chinese, Japanese, Korean,
// Devanagari, Cyrillic, Thai, Hebrew, etc. — because those codepoints
// aren't a–z or 0–9. QA F21 reproduced this: tokenize("مرحبا") returned
// []. Now we split on anything that's NOT a Letter or Number in any
// script (\p{L}\p{N} with the /u flag), so every alphabet survives.
//
// Length filter is relaxed to ≥ 1 for CJK (where one character IS a
// token — 花, 日, 本 each carry meaning on their own); kept at ≥ 2 for
// everything else so short English stopwords like "a", "i", "of" that
// slip past STOPWORDS don't bloat the index. The language check is a
// simple "did we see a CJK codepoint" test — generous but cheap.
const NON_WORD = /[^\p{L}\p{N}]+/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().normalize("NFKD").replace(DIACRITICS, "");
  const hasCjk = CJK.test(normalized);
  const minLen = hasCjk ? 1 : 2;
  return normalized
    .split(NON_WORD)
    .filter((t) => t.length >= minLen && !STOPWORDS.has(t));
}

export function embed(text: string): number[] {
  const toks = tokenize(text);
  if (toks.length === 0) return new Array<number>(DIM).fill(0);
  // Short text: one embedding covers it. Long text: sliding-window
  // chunks (24 tokens with 8-token overlap), average-pool the chunk
  // embeddings — captures topic drift inside long messages so the
  // retrieval pipeline doesn't miss content buried in the middle of
  // a paragraph.
  if (toks.length <= 32) return embedTokens(toks);

  const WIN = 24, OVERLAP = 8, STEP = WIN - OVERLAP;
  const pooled = new Array<number>(DIM).fill(0);
  let n = 0;
  for (let i = 0; i < toks.length; i += STEP) {
    const chunk = toks.slice(i, i + WIN);
    if (chunk.length < 4 && n > 0) break;
    const v = embedTokens(chunk);
    for (let k = 0; k < DIM; k++) pooled[k] += v[k];
    n++;
    if (i + WIN >= toks.length) break;
  }
  if (n === 0) return embedTokens(toks);
  for (let k = 0; k < DIM; k++) pooled[k] /= n;
  // Re-normalise so cosine still == dot product.
  let mag = 0;
  for (const x of pooled) mag += x * x;
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < DIM; i++) pooled[i] /= mag;
  return pooled;
}

function embedTokens(toks: string[]): number[] {
  const v = new Array<number>(DIM).fill(0);
  const bump = (s: string, w: number) => {
    const h = hash(s);
    v[h % DIM] += w * (1 - ((h >>> 8) & 1) * 2);
  };
  for (const t of toks) {
    bump(t, 1);
    for (let i = 0; i < t.length - 1; i++) bump(t.slice(i, i + 2), 0.4);
  }
  let mag = 0;
  for (const x of v) mag += x * x;
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= mag;
  return v;
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// FNV-1a 32-bit, plenty for this hash-trick embedding.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","of","to","in","on","for","at","by",
  "is","am","are","was","were","be","been","being","do","does","did","have","has","had",
  "i","me","my","you","your","we","us","our","they","them","their","he","she","it","this","that",
  "with","from","as","so","not","no","yes","just","about","into","over","under","up","down","out",
]);
