// Day grouping and day naming.
//
// These are shared by the chat stream and the diary. The reason they are
// shared — and tested — is that a second copy drifts: one screen starts
// saying "Yesterday" while the other shows a date for the same day.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dayKeyFor, formatDay, withDayBreaks } from "../src/lib/daybreaks.ts";

const DAY = 86400_000;

describe("withDayBreaks", () => {
  test("inserts a marker before each new calendar day", () => {
    const now = Date.now();
    const rows = [
      { id: "a", createdAt: now - 2 * DAY },
      { id: "b", createdAt: now - 2 * DAY + 60_000 },
      { id: "c", createdAt: now },
    ];
    const out = withDayBreaks(rows);
    assert.deepEqual(out.map((e) => e.kind), ["day", "item", "item", "day", "item"]);
    assert.equal(out[1].item.id, "a");
    assert.equal(out[4].item.id, "c");
  });

  test("two moments on the same day share one marker", () => {
    const base = new Date(2026, 4, 2, 9, 0, 0).getTime();
    const out = withDayBreaks([
      { createdAt: base },
      { createdAt: base + 8 * 3600_000 },
    ]);
    assert.equal(out.filter((e) => e.kind === "day").length, 1);
  });

  test("an empty list produces nothing", () => {
    assert.deepEqual(withDayBreaks([]), []);
  });
});

describe("formatDay", () => {
  test("names today and yesterday", () => {
    assert.equal(formatDay(Date.now()), "Today");
    assert.equal(formatDay(Date.now() - DAY), "Yesterday");
  });

  test("falls back to a full date beyond a week", () => {
    const label = formatDay(Date.now() - 30 * DAY);
    assert.notEqual(label, "Today");
    assert.notEqual(label, "Yesterday");
    assert.match(label, /\d{4}/, "a distant day should carry its year");
  });
});

describe("dayKeyFor", () => {
  test("is YYYY-MM-DD", () => {
    assert.match(dayKeyFor(Date.now()), /^\d{4}-\d{2}-\d{2}$/);
  });

  test("uses the author's timezone, not the reader's", () => {
    // 2026-05-02 23:30 UTC. For an author at UTC+2 that is already the
    // 3rd; for one at UTC-5 it is still the 2nd. A diary page belongs to
    // the author's day, so the same instant must key differently.
    const t = Date.UTC(2026, 4, 2, 23, 30);
    assert.equal(dayKeyFor(t, 120), "2026-05-03");
    assert.equal(dayKeyFor(t, -300), "2026-05-02");
    assert.equal(dayKeyFor(t, 0), "2026-05-02");
  });

  test("a day boundary lands on the right side", () => {
    const justBefore = Date.UTC(2026, 4, 2, 23, 59, 59);
    const justAfter = Date.UTC(2026, 4, 3, 0, 0, 1);
    assert.equal(dayKeyFor(justBefore, 0), "2026-05-02");
    assert.equal(dayKeyFor(justAfter, 0), "2026-05-03");
  });
});
