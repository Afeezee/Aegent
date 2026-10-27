// Server-side web-search proxy for the on-device agent.
//
// The agent's tool loop runs on the client, but the search API keys
// (Serper, Tavily) must stay server-side. The client POSTs a query to
// /api/agent/search and gets back a bounded list of {title, url,
// snippet, source} items the LLM can then cite in its reply.
//
// Two providers, chosen by env:
//   - SERPER_API_KEY  — Google-SERP mirror, fastest for "what happened
//     today in X" / "nearest restaurant" questions. Preferred when set.
//   - TAVILY_API_KEY  — Research-oriented, higher-quality snippets.
//     Used as fallback or when SEARCH_PROVIDER=tavily is set.
//
// If no keys are configured the endpoint returns 503 so the client UI
// can hide the feature cleanly. No search text is persisted on the
// server — the query flows through, hits the provider, and the result
// comes back. We log only the fact and the result count via
// logAgentEvent (metadata only), reusing the same analytics channel.

import type { Request, Response } from "express";
import { z } from "zod";

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: "serper" | "tavily";
};

const bodySchema = z.object({
  query: z.string().min(1).max(500),
  // Soft cap: Anthropic context + reasonable rendering budget.
  limit: z.number().int().min(1).max(10).default(5).optional(),
});

export function webSearchEnabled(): boolean {
  return !!(process.env.SERPER_API_KEY || process.env.TAVILY_API_KEY);
}

export async function webSearch(req: Request & { userId: string }, res: Response) {
  if (!webSearchEnabled()) {
    return res.status(503).json({
      error: "search_disabled",
      message: "No web-search provider configured. Set SERPER_API_KEY or TAVILY_API_KEY.",
    });
  }

  let parsed: z.infer<typeof bodySchema>;
  try { parsed = bodySchema.parse(req.body); }
  catch (e) { return res.status(400).json({ error: "bad_request", message: (e as Error).message }); }
  const limit = parsed.limit ?? 5;

  // Pick a provider: explicit override via SEARCH_PROVIDER, else prefer
  // Serper (faster), fall back to Tavily. If the preferred one errors
  // we try the other automatically.
  const prefer = (process.env.SEARCH_PROVIDER ?? "").toLowerCase();
  const providers: Array<"serper" | "tavily"> = [];
  if (prefer === "tavily") providers.push("tavily", "serper");
  else providers.push("serper", "tavily");

  let lastErr: string | null = null;
  for (const name of providers) {
    try {
      const results = name === "serper"
        ? await searchSerper(parsed.query, limit)
        : await searchTavily(parsed.query, limit);
      if (results) return res.json({ provider: name, results });
    } catch (e) {
      lastErr = (e as Error).message;
      // Keep trying the other provider.
    }
  }
  return res.status(502).json({
    error: "search_failed",
    message: lastErr ?? "No provider returned results.",
  });
}

// Serper: Google SERP mirror, ~fastest. Docs: https://serper.dev
async function searchSerper(query: string, limit: number): Promise<SearchResult[] | null> {
  const key = process.env.SERPER_API_KEY;
  if (!key) return null;
  const r = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": key, "content-type": "application/json" },
    body: JSON.stringify({ q: query, num: limit }),
    // Node 20+ supports AbortSignal.timeout for a safety net on a
    // provider hang; keep it short so the agent turn doesn't stall.
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`serper ${r.status}`);
  const body = await r.json() as {
    organic?: Array<{ title: string; link: string; snippet?: string }>;
    knowledgeGraph?: { title?: string; description?: string; website?: string };
    answerBox?: { title?: string; snippet?: string; link?: string };
  };
  const out: SearchResult[] = [];
  if (body.answerBox?.snippet) {
    out.push({
      title: body.answerBox.title ?? "Answer",
      url: body.answerBox.link ?? "",
      snippet: body.answerBox.snippet,
      source: "serper",
    });
  }
  for (const o of body.organic ?? []) {
    if (out.length >= limit) break;
    out.push({ title: o.title, url: o.link, snippet: o.snippet ?? "", source: "serper" });
  }
  return out;
}

// Tavily: research-oriented search. Docs: https://docs.tavily.com
async function searchTavily(query: string, limit: number): Promise<SearchResult[] | null> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: limit,
      search_depth: "basic",
      include_answer: true,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`tavily ${r.status}`);
  const body = await r.json() as {
    answer?: string;
    results?: Array<{ title: string; url: string; content: string }>;
  };
  const out: SearchResult[] = [];
  if (body.answer) {
    out.push({ title: "Summary", url: "", snippet: body.answer, source: "tavily" });
  }
  for (const o of body.results ?? []) {
    if (out.length >= limit) break;
    out.push({ title: o.title, url: o.url, snippet: o.content, source: "tavily" });
  }
  return out;
}
