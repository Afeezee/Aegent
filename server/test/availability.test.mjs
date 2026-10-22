// The availability guarantee.
//
// These protect the promise the product is built on: every message this
// account has ever sent or received is reachable from any device, on
// demand. Each case here corresponds to a bug that actually shipped —
// a new device showing an empty inbox, a drain that paged past what it
// failed to ingest, and Postgres BIGINT timestamps arriving as strings
// and sorting outside every numeric range query.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import {
  b64, connect, emitSend, http, register, sealTo, startRelay, waitForEvent,
} from "./helpers.mjs";

let relay;
before(async () => { relay = await startRelay(); });
after(async () => { await relay?.stop(); });

// Mirrors the client's drain: keyset paging with an id ledger, so a page
// can safely overlap or repeat.
async function drain(user, { limit = 25 } = {}) {
  const ledger = new Map();
  let cursor = null, pages = 0;
  for (;;) {
    const q = new URLSearchParams({ all: "true", limit: String(limit) });
    if (cursor) { q.set("since", String(cursor.since)); q.set("afterId", cursor.afterId); }
    const r = await http(relay, `/api/inbox?${q}`, { token: user.token });
    assert.equal(r.status, 200);
    pages++;
    for (const env of r.body.envelopes) {
      if (ledger.has(env.id)) continue;
      ledger.set(env.id, env);
    }
    if (!r.body.more) break;
    cursor = r.body.cursor;
    if (pages > 200) throw new Error("runaway paging");
  }
  return { ledger, pages };
}

function selfCopy(user, body, thread) {
  return sealTo(JSON.stringify({ v: 1, t: "text", msgId: body, body, _thread: thread }), user.pub, user.priv);
}

describe("a new device rebuilds the whole account", () => {
  test("every sent and received message comes back, in pages", async () => {
    const alice = await register(relay, "av-alice");
    const bob = await register(relay, "av-bob");
    const aliceSock = await connect(relay, alice.token);
    const bobSock = await connect(relay, bob.token);

    const SENT = 40;
    for (let i = 0; i < SENT; i++) {
      const text = JSON.stringify({ v: 1, t: "text", msgId: `m${i}`, body: `hello ${i}`, _thread: bob.id });
      assert.equal((await emitSend(aliceSock, { recipientId: bob.id, ciphertext: sealTo(text, bob.pub, alice.priv) })).ok, true);
      // The self-copy is what makes the sender's own history durable.
      assert.equal((await emitSend(aliceSock, { recipientId: alice.id, ciphertext: sealTo(text, alice.pub, alice.priv) })).ok, true);
    }
    for (let i = 0; i < 2; i++) {
      const text = JSON.stringify({ v: 1, t: "text", msgId: `b${i}`, body: `reply ${i}`, _thread: alice.id });
      await emitSend(bobSock, { recipientId: alice.id, ciphertext: sealTo(text, alice.pub, bob.priv) });
    }

    const { ledger, pages } = await drain(alice);
    assert.equal(ledger.size, SENT + 2, "every envelope addressed to alice");
    assert.ok(pages > 1, `paging should actually page (got ${pages})`);

    // Everything decrypts with the account's identity key alone — which
    // is what "sign in on a new device and it all comes back" means.
    for (const env of ledger.values()) {
      const peerPub = env.senderId === alice.id ? alice.pub : bob.pub;
      const raw = b64.decode(env.ciphertext);
      const pt = nacl.box.open(raw.slice(24), raw.slice(0, 24), peerPub, alice.priv);
      assert.ok(pt, `envelope ${env.id} must decrypt`);
    }

    const again = await drain(alice);
    assert.equal(again.ledger.size, ledger.size, "re-draining is idempotent");

    const stats = await http(relay, "/api/inbox/stats", { token: alice.token });
    assert.equal(stats.body.total, ledger.size, "stats must agree with what paging returns");
  });

  test("timestamps are numbers, not strings", async () => {
    // The production-only bug: node-postgres returns BIGINT as a string,
    // and `createdAt` becomes an IndexedDB key — where strings sort after
    // every number, so the message stored fine and rendered nowhere.
    const alice = await register(relay, "av-ts");
    const sock = await connect(relay, alice.token);
    const ack = await emitSend(sock, { recipientId: alice.id, ciphertext: selfCopy(alice, "tick", alice.id) });
    assert.equal(typeof ack.envelope.createdAt, "number", "live socket envelope");

    const page = await http(relay, "/api/inbox?all=true&limit=5", { token: alice.token });
    for (const e of page.body.envelopes) assert.equal(typeof e.createdAt, "number", "drained envelope");
    assert.equal(typeof page.body.cursor.since, "number", "paging cursor");

    const stats = await http(relay, "/api/inbox/stats", { token: alice.token });
    assert.equal(typeof stats.body.total, "number");
    assert.equal(typeof stats.body.newestAt, "number");
  });
});

describe("reconciliation by id", () => {
  test("the id listing agrees with paging, and fetch returns exactly those", async () => {
    const alice = await register(relay, "rec-alice");
    const sock = await connect(relay, alice.token);
    for (let i = 0; i < 7; i++) {
      await emitSend(sock, { recipientId: alice.id, ciphertext: selfCopy(alice, `r${i}`, alice.id) });
    }

    const ids = await http(relay, "/api/inbox/ids", { token: alice.token });
    assert.equal(ids.body.ids.length, 7);
    assert.equal(ids.body.truncated, false);

    const paged = await http(relay, "/api/inbox?all=true&limit=500", { token: alice.token });
    assert.deepEqual(
      [...ids.body.ids].sort(),
      paged.body.envelopes.map((e) => e.id).sort(),
      "ids and paging must describe the same set — if ids lists what fetch declines, the client records a permanent phantom deficit",
    );

    const fetched = await http(relay, "/api/inbox/fetch", {
      method: "POST", token: alice.token, body: { ids: ids.body.ids },
    });
    assert.equal(fetched.body.envelopes.length, 7);
    for (const e of fetched.body.envelopes) {
      assert.equal(typeof e.createdAt, "number");
      assert.ok(e.ciphertext.length > 0);
    }
  });

  test("one account cannot fetch another's envelopes by id", async () => {
    const alice = await register(relay, "rec-a2");
    const mallory = await register(relay, "rec-m2");
    const sock = await connect(relay, alice.token);
    await emitSend(sock, { recipientId: alice.id, ciphertext: selfCopy(alice, "private", alice.id) });

    const ids = await http(relay, "/api/inbox/ids", { token: alice.token });
    const stolen = await http(relay, "/api/inbox/fetch", {
      method: "POST", token: mallory.token, body: { ids: ids.body.ids },
    });
    assert.equal(stolen.body.envelopes.length, 0, "fetch is scoped to the caller");

    const theirIds = await http(relay, "/api/inbox/ids", { token: mallory.token });
    assert.equal(theirIds.body.ids.length, 0, "the id listing is scoped to the caller");
  });

  test("an oversized fetch is refused", async () => {
    const alice = await register(relay, "rec-a3");
    const r = await http(relay, "/api/inbox/fetch", {
      method: "POST", token: alice.token, body: { ids: new Array(400).fill("x") },
    });
    assert.equal(r.status, 400);
  });
});

describe("a second device of the same account", () => {
  test("is pushed the self-copy live, and catches up on what it missed", async () => {
    const alice = await register(relay, "md-alice");
    const bob = await register(relay, "md-bob");
    const deviceA = await connect(relay, alice.token);
    const deviceB = await connect(relay, alice.token);   // same account, second socket

    const live = waitForEvent(deviceB, "message", 900);
    await emitSend(deviceA, { recipientId: alice.id, ciphertext: selfCopy(alice, "typed on A", bob.id) });
    const got = await live;
    assert.ok(got, "a sibling device should be pushed the self-copy immediately");
    const raw = b64.decode(got.ciphertext);
    const pt = nacl.box.open(raw.slice(24), raw.slice(0, 24), alice.pub, alice.priv);
    assert.ok(pt, "and be able to decrypt it with its own key");

    // Device B goes away; A keeps sending.
    const before = (await drain(alice)).ledger.size;
    deviceB.close();
    for (let i = 0; i < 5; i++) {
      await emitSend(deviceA, { recipientId: alice.id, ciphertext: selfCopy(alice, `while away ${i}`, bob.id) });
    }
    const after = await drain(alice);
    assert.equal(after.ledger.size, before + 5, "a device that was closed catches up on its next drain");
  });
});
