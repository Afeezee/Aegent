// Messages must read as a conversation.
//
// They stopped doing that: every message you had sent bunched together,
// separated from the replies they belonged beside. Two causes, both
// pinned here.
//
// 1. The background replicator uploads messages that existed only on
//    this device. The self-copy carried no authored time, so the relay
//    stamped it with the moment of upload and ingesting it overwrote the
//    original — re-dating a whole history to whenever the backup ran.
// 2. Thread queries bounded the range at the DEVICE's clock, so if the
//    relay ran even slightly ahead, the newest messages sorted past the
//    bound and did not render at all.

import "fake-indexeddb/auto";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import {
  closeStore, openStore, repairSentTimes, saveTextMessage, threadWith,
} from "../src/lib/store.ts";
import { newMsgId, sentTimeFromMsgId } from "../src/lib/protocol.ts";

const KEY = nacl.randomBytes(32);
const MIN = 60_000;
let n = 0;
let uid;
beforeEach(() => { uid = `order-${++n}-${Date.now()}`; openStore(uid, KEY); });
afterEach(() => { closeStore(); });

const save = (id, dir, at, body) => saveTextMessage({
  id, peerId: "ada", senderId: dir === "out" ? "me" : "ada",
  direction: dir, createdAt: at, body,
});

describe("thread ordering", () => {
  test("sent and received interleave by time", async () => {
    const t = Date.now() - 10 * MIN;
    await save("a", "out", t, "are you around?");
    await save("b", "in", t + MIN, "yes, what's up");
    await save("c", "out", t + 2 * MIN, "can you call me");
    await save("d", "in", t + 3 * MIN, "calling now");

    const thread = await threadWith("ada");
    assert.deepEqual(thread.map((m) => m.body),
      ["are you around?", "yes, what's up", "can you call me", "calling now"],
      "a conversation must read in the order it happened, not grouped by who spoke");
  });

  test("a message dated ahead of the device clock still renders", async () => {
    // The relay's clock, a little ahead of this device's.
    await save("past", "in", Date.now() - MIN, "earlier");
    await save("ahead", "in", Date.now() + 5 * MIN, "from a relay running fast");
    const thread = await threadWith("ada");
    assert.equal(thread.length, 2,
      "bounding the query at the local clock silently hides the newest messages");
    assert.equal(thread[1].body, "from a relay running fast");
  });
});

describe("recovering an overwritten send time", () => {
  test("a message id carries the time it was composed", () => {
    const before = Date.now();
    const id = newMsgId();
    const t = sentTimeFromMsgId(id);
    assert.ok(t !== null);
    assert.ok(Math.abs(t - before) < 2000, "the id's first segment is the authored time");
  });

  test("ids that are not timestamps are left alone", () => {
    assert.equal(sentTimeFromMsgId("not-an-id"), null);
    assert.equal(sentTimeFromMsgId(""), null);
    assert.equal(sentTimeFromMsgId("0-0-x"), null, "the epoch is not a plausible send time");
  });

  test("re-dated sent messages are put back in order", async () => {
    // Reconstruct the damage: three messages written minutes apart, all
    // re-stamped with the moment the replicator uploaded them.
    const realTimes = [Date.now() - 30 * MIN, Date.now() - 20 * MIN, Date.now() - 10 * MIN];
    const ids = realTimes.map((t) => `${t.toString(36)}-1-abc${t % 97}`);
    const backupMoment = Date.now();
    for (const id of ids) await save(id, "out", backupMoment, `sent at ${id}`);
    await save("reply", "in", Date.now() - 15 * MIN, "a reply in the middle");

    // Before: everything we sent is stacked at the end, after the reply.
    const broken = await threadWith("ada");
    assert.equal(broken[0].body, "a reply in the middle",
      "this is the reported symptom — the reply sorts before messages that predate it");

    const moved = await repairSentTimes();
    assert.equal(moved, 3);

    const fixed = await threadWith("ada");
    assert.deepEqual(fixed.map((m) => m.direction), ["out", "out", "in", "out"],
      "the reply belongs between the second and third thing we sent");
  });

  test("inbound messages are never re-dated", async () => {
    // Their timestamp is the relay's receipt time, which was never wrong
    // — and rewriting it from the id would import the sender's clock.
    const t = Date.now() - 5 * MIN;
    const id = `${(t - 60 * MIN).toString(36)}-1-zz`;
    await save(id, "in", t, "from ada");
    assert.equal(await repairSentTimes(), 0);
    assert.equal((await threadWith("ada"))[0].createdAt, t);
  });

  test("small differences are left as jitter", async () => {
    const t = Date.now() - MIN;
    const id = `${t.toString(36)}-1-aa`;
    await save(id, "out", t + 5_000, "composed, then sent a moment later");
    assert.equal(await repairSentTimes(), 0, "five seconds is not a bug worth rewriting");
  });
});
