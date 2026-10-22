// Grouping a time-ordered list into days, and naming a day.
//
// Extracted from Chat.tsx so the chat stream and the diary share one
// implementation. Two copies of "is this Today, Yesterday, or a date?"
// drift apart the moment one of them gains a case, and the result is a
// list that calls the same day two different things depending on which
// screen you are looking at.

export type Grouped<T> =
  | { kind: "day"; at: number }
  | { kind: "item"; item: T };

// Walk oldest-to-newest, inserting a day marker whenever the calendar
// day changes. The input is assumed already sorted; this does not sort,
// because callers order by different things (messages by arrival, diary
// entries by their author's sequence).
export function withDayBreaks<T extends { createdAt: number }>(rows: T[]): Array<Grouped<T>> {
  const out: Array<Grouped<T>> = [];
  let lastDay = "";
  for (const row of rows) {
    const day = new Date(row.createdAt).toDateString();
    if (day !== lastDay) {
      out.push({ kind: "day", at: row.createdAt });
      lastDay = day;
    }
    out.push({ kind: "item", item: row });
  }
  return out;
}

// "Today" / "Yesterday" / a weekday within the last week / a full date.
//
// `tzOffsetMin` (minutes east of UTC) renders the label in someone
// else's timezone rather than the reader's — a diary page belongs to the
// author's day, so its heading should say what day it was for them, even
// while the individual entry times below it read in local time.
export function formatDay(t: number, opts: { tzOffsetMin?: number } = {}): string {
  const shift = opts.tzOffsetMin === undefined
    ? 0
    : (opts.tzOffsetMin + new Date(t).getTimezoneOffset()) * 60_000;
  const d = new Date(t + shift);
  const now = new Date(Date.now() + shift);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  const week = 7 * 86400_000;
  if (now.getTime() - d.getTime() < week) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

// The author's calendar day for a moment, as 'YYYY-MM-DD'.
//
// Computed on the author's device and then treated as an opaque string
// everywhere else: the relay never derives a date, and a viewer never
// re-buckets a page into their own timezone, because a page is an
// authored artefact — re-bucketing would split one day across two or
// merge two into one.
export function dayKeyFor(t: number, tzOffsetMin = -new Date(t).getTimezoneOffset()): string {
  const local = new Date(t + (tzOffsetMin + new Date(t).getTimezoneOffset()) * 60_000);
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, "0");
  const d = String(local.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
