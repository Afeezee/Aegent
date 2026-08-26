// Small retry + timeout helpers for network operations.
//
// Rules of thumb encoded here:
//   - 4xx (except 429) are permanent — no retry.
//   - 5xx and network-error / abort are transient — retry with jittered
//     exponential backoff, capped at 3 attempts by default.
//   - Every attempt has a timeout so a hung request can't block forever.
//
// Use `retryFetch` for any bearer/JSON request you want resilient. Use
// `retry(fn, opts)` when the retryable work isn't a plain fetch.

export type RetryOpts = {
  attempts?: number;      // max total attempts (default 3)
  baseMs?: number;        // initial backoff (default 400)
  maxMs?: number;         // backoff ceiling (default 4000)
  timeoutMs?: number;     // per-attempt timeout (default 15000)
  shouldRetry?: (err: unknown, attempt: number) => boolean;
};

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseMs ?? 400;
  const cap = opts.maxMs ?? 4000;
  const should = opts.shouldRetry ?? defaultShouldRetry;
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(i); }
    catch (e) {
      last = e;
      if (i === attempts || !should(e, i)) throw e;
      const delay = Math.min(cap, base * Math.pow(2, i - 1)) * (0.7 + Math.random() * 0.6);
      await sleep(delay);
    }
  }
  throw last;
}

export async function retryFetch(input: RequestInfo | URL, init: RequestInit = {}, opts: RetryOpts = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  return retry(async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(input, { ...init, signal: init.signal ?? controller.signal });
      if (r.status >= 500 || r.status === 429) {
        throw Object.assign(new Error(`http_${r.status}`), { status: r.status });
      }
      return r;
    } finally { clearTimeout(t); }
  }, opts);
}

function defaultShouldRetry(err: unknown): boolean {
  const e = err as { name?: string; status?: number; message?: string };
  if (e?.name === "AbortError") return true;                     // per-attempt timeout
  if (typeof e?.status === "number") return e.status >= 500 || e.status === 429;
  // Bare network failure — no status.
  return /network|fetch failed|failed to fetch|load failed/i.test(e?.message ?? "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
