// Message ordering, at the source.
//
// The reported symptom — every sent message bunched together below every
// received one — was the relay stamping created_at = now on EVERY
// envelope. The device-backfill path re-uploads old locally-only
// messages as self-copies; stamped "now", they all landed at the current
// moment, out of conversation order, on whatever device drained them.
//
// The relay now honours the sender's original timestamp (clamped to
// not-future), so created_at is a stable ordering key that survives
// backfill and device change.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { connect, emitSend, http, register, sealTo, startRelay } from "./helpers.mjs";

let relay;
before(async () => { relay = await startRelay(); });
after(async () => { await relay?.stop(); });

const send = (sock, to, pub, priv, body, sentAt) =>
  emitSend(sock, { recipientId: to, ciphertext: sealTo(body, pub, priv), ...(sentAt ? { sentAt } : {}) });

async function drainOrder(user) {
  const r = await http(relay, "/api/inbox?all=true&limit=500", { token: user.token });
  return r.body.envelopes.map((e) => e.createdAt);
}

describe("the relay honours the authored time", () => {
  test("a backfilled message keeps its original time, not the upload time", async () => {
    const ada = await register(relay, "ord-ada");
    const sock = await connect(relay, ada.token);

    const longAgo = Date.now() - 6 * 3600_000;   // six hours back
    const ack = await send(sock, ada.id, ada.pub, ada.priv, "old note", longAgo);
    assert.equal(ack.ok, true);
    // Stored at its original time, within a second — NOT re-dated to now.
    assert.ok(Math.abs(ack.envelope.createdAt - longAgo) < 1000,
      `expected ~${longAgo}, got ${ack.envelope.createdAt} (re-dating is the bug)`);
  });

  test("a live send with no timestamp is stamped now", async () => {
    const ada = await register(relay, "ord-ada2");
    const sock = await connect(relay, ada.token);
    const before = Date.now();
    const ack = await send(sock, ada.id, ada.pub, ada.priv, "live");
    assert.ok(ack.envelope.createdAt >= before && ack.envelope.createdAt <= Date.now() + 1000);
  });

  test("a future timestamp is clamped to now", async () => {
    const ada = await register(relay, "ord-ada3");
    const sock = await connect(relay, ada.token);
    const future = Date.now() + 10 * 86400_000;
    const ack = await send(sock, ada.id, ada.pub, ada.priv, "from a fast clock", future);
    assert.ok(ack.envelope.createdAt <= Date.now() + 1000, "a fast client clock cannot post into the future");
  });
});

describe("an interleaved conversation keeps its order through backfill", () => {
  test("old messages drain between the live ones they belong beside", async () => {
    const ada = await register(relay, "ord-conv-ada");
    const bo = await register(relay, "ord-conv-bo");
    const aSock = await connect(relay, ada.token);
    const bSock = await connect(relay, bo.token);

    // A real back-and-forth, in true time order.
    const t0 = Date.now() - 60_000;
    const script = [
      { who: "a", at: t0 + 1000, body: "hey" },          // ada → bo
      { who: "b", at: t0 + 2000, body: "hi" },           // bo → ada
      { who: "a", at: t0 + 3000, body: "free later?" },  // ada → bo
      { who: "b", at: t0 + 4000, body: "yep" },          // bo → ada
    ];

    // ada's three OWN messages reach her other devices only via backfill
    // self-copies, uploaded now but timed to when she wrote them.
    for (const m of script) {
      if (m.who === "a") {
        await send(aSock, bo.id, bo.pub, ada.priv, m.body, m.at);        // to bo (live)
        await send(aSock, ada.id, ada.pub, ada.priv, m.body, m.at);      // self-copy (backfill-shaped)
      } else {
        await send(bSock, ada.id, ada.pub, bo.priv, m.body, m.at);       // to ada
      }
    }

    // What ada's device sees, ordered by the canonical created_at.
    const times = await drainOrder(ada);
    const sorted = [...times].sort((x, y) => x - y);
    assert.deepEqual(times, sorted, "the inbox drains in created_at order");
    // And her own messages are interleaved among bo's, not clustered at now.
    assert.ok(times.every((t) => t < Date.now() - 1000),
      "every message sorts at its authored minute, not the upload moment");
  });
});
