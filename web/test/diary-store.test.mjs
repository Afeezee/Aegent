// The diary's local half.
//
// Two things matter here and they pull in opposite directions: an entry
// we were lent has to disappear on time, and an entry we wrote has to
// survive everything — including the one-off re-key that happens on the
// first boot after a build change.

import "fake-indexeddb/auto";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import {
  closeStore, deleteDiaryEntry, diaryEntryCount, gcDiaryEntries, getDiaryAudience,
  getDiaryEntry, liveDiaryEntries, markDiarySeenLocal, myDiaryEntries, openStore,
  rekeyLocalStore, saveDiaryEntry, setDiaryAudience, setDiaryViewCount,
  enqueueDiaryPublish, listDiaryPublishQueue, dequeueDiaryPublish,
} from "../src/lib/store.ts";

const KEY_A = nacl.randomBytes(32);
const KEY_B = nacl.randomBytes(32);
const HOUR = 3600_000;
const ME = "me";

let n = 0;
let uid;
beforeEach(() => { uid = `diary-user-${++n}-${Date.now()}`; openStore(uid, KEY_A); });
afterEach(() => { closeStore(); });

const mine = (id, over = {}) => ({
  id, authorId: ME, dayKey: "2026-05-02", tzOffsetMin: 60, seq: 0,
  kind: "text", createdAt: Date.now(), expiresAt: null, text: `entry ${id}`, ...over,
});
const lent = (id, expiresAt, over = {}) => ({
  id, authorId: "ada", dayKey: "2026-05-02", tzOffsetMin: 60, seq: 0,
  kind: "text", createdAt: Date.now() - HOUR, expiresAt, text: `from ada ${id}`, ...over,
});

describe("storing and opening entries", () => {
  test("text is sealed at rest and comes back intact", async () => {
    await saveDiaryEntry(mine("a", { text: "a long day at the market" }));
    const row = await getDiaryEntry("a");
    assert.equal(row.text, "a long day at the market");
    assert.equal(row.expiresAt, null, "our own entries never expire");
  });

  test("re-ingesting does not un-see an entry or lose its view count", async () => {
    await saveDiaryEntry(lent("b", Date.now() + HOUR));
    await markDiarySeenLocal(["b"]);
    await setDiaryViewCount("b", 7);

    // The same entry arriving again from a later sync page.
    await saveDiaryEntry(lent("b", Date.now() + HOUR));
    const row = await getDiaryEntry("b");
    assert.ok(row.seenAt, "seen state must survive a re-sync");
    assert.equal(row.viewCount, 7);
  });

  test("media entries keep their reference", async () => {
    const media = { kind: "image", blobId: "blob-1", mime: "image/jpeg", byteSize: 10, contentKey: "k" };
    await saveDiaryEntry(mine("c", { kind: "media", text: null, caption: "at the beach", media }));
    const row = await getDiaryEntry("c");
    assert.equal(row.caption, "at the beach");
    assert.equal(row.media.blobId, "blob-1");
  });
});

describe("formatting", () => {
  test("format and alignment survive a round trip", async () => {
    const markup = ["## Market day", "It was **loud**."].join("\n");
    await saveDiaryEntry(mine("f1", { text: markup, format: "md", align: "justify" }));
    const row = await getDiaryEntry("f1");
    assert.equal(row.format, "md");
    assert.equal(row.align, "justify");
    assert.equal(row.text, markup,
      "markup is stored verbatim and rendered on display, never pre-rendered into the store");
  });

  test("entries written before formatting existed stay plain", async () => {
    // No format/align supplied, as an older client would send.
    await saveDiaryEntry(mine("f2", { text: "just words" }));
    const row = await getDiaryEntry("f2");
    assert.equal(row.format, "plain", "defaulting to md would reinterpret old text as markup");
    assert.equal(row.align, "left");
  });
});

describe("expiry", () => {
  test("a lapsed entry is dropped and its image released", async () => {
    await saveDiaryEntry(mine("keep"));
    await saveDiaryEntry(lent("fresh", Date.now() + HOUR));
    await saveDiaryEntry(lent("stale", Date.now() - HOUR, {
      kind: "media", text: null, media: { kind: "image", blobId: "gone-1", mime: "image/jpeg", byteSize: 1, contentKey: "k" },
    }));

    const { removed, blobIds } = await gcDiaryEntries(Date.now());
    assert.equal(removed, 1);
    assert.deepEqual(blobIds, ["gone-1"],
      "the caller needs these to release the decrypted bytes, not just the row");
    assert.equal(await diaryEntryCount(), 2);
    assert.ok(await getDiaryEntry("keep"), "our own entry must never be swept");
    assert.ok(await getDiaryEntry("fresh"));
  });

  test("reads filter by expiry even when nothing has swept", async () => {
    // Belt and braces: a device that has been asleep must not flash an
    // expired entry on screen before the sweep catches up.
    await saveDiaryEntry(mine("ours"));
    await saveDiaryEntry(lent("lapsed", Date.now() - 1));
    const live = await liveDiaryEntries(Date.now());
    assert.deepEqual(live.map((e) => e.id), ["ours"]);
    assert.equal(await diaryEntryCount(), 2, "still on disk — just not readable");
  });

  test("a sweep with nothing to do is harmless", async () => {
    await saveDiaryEntry(mine("x"));
    assert.deepEqual(await gcDiaryEntries(Date.now()), { removed: 0, blobIds: [] });
  });
});

describe("the archive survives a key change", () => {
  test("diary text re-keys with everything else", async () => {
    await saveDiaryEntry(mine("k1", { text: "written under the old key" }));
    await enqueueDiaryPublish("k1", '{"id":"k1"}');
    closeStore();

    openStore(uid, KEY_B);
    const r = await rekeyLocalStore(KEY_A);
    assert.equal(r.failed, 0);

    assert.equal((await getDiaryEntry("k1")).text, "written under the old key",
      "'<corrupt>' here means diaryEntries was left out of the sealed-table registry");
    const queued = await listDiaryPublishQueue();
    assert.equal(queued.length, 1, "a queued publish must survive the key change too");
    assert.equal(queued[0].payload, '{"id":"k1"}');
  });
});

describe("my own page", () => {
  test("entries come back in order, scoped to a day", async () => {
    const base = Date.now();
    await saveDiaryEntry(mine("m2", { createdAt: base + 2000, seq: 1 }));
    await saveDiaryEntry(mine("m1", { createdAt: base + 1000, seq: 0 }));
    await saveDiaryEntry(mine("other", { createdAt: base, dayKey: "2026-05-01" }));

    assert.deepEqual((await myDiaryEntries(ME, "2026-05-02")).map((e) => e.id), ["m1", "m2"]);
    assert.equal((await myDiaryEntries(ME)).length, 3);
    assert.equal((await myDiaryEntries("someone-else")).length, 0);
  });

  test("an entry can be removed locally", async () => {
    await saveDiaryEntry(mine("d1"));
    await deleteDiaryEntry("d1");
    assert.equal(await getDiaryEntry("d1"), undefined);
  });
});

describe("audience rules", () => {
  test("are stored per day", async () => {
    await setDiaryAudience({ dayKey: "2026-05-02", mode: "except", ids: ["boss"] });
    const rule = await getDiaryAudience("2026-05-02");
    assert.equal(rule.mode, "except");
    assert.deepEqual(rule.ids, ["boss"]);
    assert.equal(await getDiaryAudience("2026-05-03"), undefined,
      "a rule for one day must not leak into the next");
  });
});

describe("the publish queue", () => {
  test("holds a failed publish and lets it go once sent", async () => {
    await enqueueDiaryPublish("q1", '{"id":"q1","bodyCt":"..."}');
    assert.equal((await listDiaryPublishQueue()).length, 1);
    await dequeueDiaryPublish("q1");
    assert.equal((await listDiaryPublishQueue()).length, 0);
  });
});
