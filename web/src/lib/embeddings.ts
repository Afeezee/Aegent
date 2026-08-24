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

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function embed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  const toks = tokenize(text);
  if (toks.length === 0) return v;

  // Unigrams + character bigrams.
  const bump = (s: string, w: number) => {
    const h = hash(s);
    v[h % DIM] += w * (1 - ((h >>> 8) & 1) * 2); // signed contribution
  };
  for (const t of toks) {
    bump(t, 1);
    for (let i = 0; i < t.length - 1; i++) bump(t.slice(i, i + 2), 0.4);
  }
  // Normalize to unit length so cosine == dot product.
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
