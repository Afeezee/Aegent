// Re-keying the local store.
//
// The local-store key is derived from the identity private key, so it
// changes exactly once per device: on the first boot after the build
// that stopped deriving it from the password. At that moment every
// sealed row has to move from the old key to the new one.
//
// The old implementation walked `messages` and nothing else, which meant
// a message sitting in the offline outbox became permanently unreadable
// the moment the key changed. This suite pins the registry that fixes
// it — and would fail again the day someone adds a sealed table and
// forgets to register it.

import "fake-indexeddb/auto";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import {
  closeStore, enqueueOutbox, everyMessage, listOutbox, openStore,
  rekeyLocalStore, saveTextMessage,
} from "../src/lib/store.ts";

const KEY_A = nacl.randomBytes(32);
const KEY_B = nacl.randomBytes(32);

let user = 0;
function freshUser() { return `rekey-user-${++user}-${Date.now()}`; }

describe("rekeyLocalStore", () => {
  let uid;
  beforeEach(() => { uid = freshUser(); });

  test("moves message bodies to the new key", async () => {
    openStore(uid, KEY_A);
    await saveTextMessage({
      id: "m1", peerId: "peer", senderId: "me", direction: "out",
      createdAt: Date.now(), body: "the body under the old key",
    });
    closeStore();

    // Exactly what openLocalStore does on that first boot: open under the
    // new key, then convert what was written under the old one.
    openStore(uid, KEY_B);
    const r = await rekeyLocalStore(KEY_A);
    assert.equal(r.failed, 0);
    assert.ok(r.rekeyed >= 1);

    const [m] = await everyMessage();
    assert.equal(m.body, "the body under the old key",
      "a body that reads '<corrupt>' means the row was left under the old key");
    closeStore();
  });

  test("moves the offline outbox too — the row the old code missed", async () => {
    openStore(uid, KEY_A);
    await enqueueOutbox({ id: "q1", peerId: "peer", isGroup: false, packed: '{"v":1,"t":"text","body":"queued"}' });
    closeStore();

    openStore(uid, KEY_B);
    await rekeyLocalStore(KEY_A);

    const queued = await listOutbox();
    assert.equal(queued.length, 1, "a queued message must survive the key change");
    assert.equal(queued[0].packed, '{"v":1,"t":"text","body":"queued"}');
    closeStore();
  });

  test("both tables convert in one pass", async () => {
    openStore(uid, KEY_A);
    await saveTextMessage({
      id: "m2", peerId: "p", senderId: "me", direction: "out",
      createdAt: Date.now(), body: "message",
    });
    await enqueueOutbox({ id: "q2", peerId: "p", isGroup: false, packed: "queued payload" });
    closeStore();

    openStore(uid, KEY_B);
    const r = await rekeyLocalStore(KEY_A);
    assert.equal(r.failed, 0);
    assert.equal((await everyMessage())[0].body, "message");
    assert.equal((await listOutbox())[0].packed, "queued payload");
    closeStore();
  });

  test("a row that cannot be opened is left alone, not overwritten", async () => {
    // Rows already under the new key (a half-finished earlier run) must
    // survive a second pass. Overwriting them would turn a recoverable
    // state into an unrecoverable one.
    openStore(uid, KEY_B);
    await saveTextMessage({
      id: "m3", peerId: "p", senderId: "me", direction: "out",
      createdAt: Date.now(), body: "already converted",
    });

    const r = await rekeyLocalStore(KEY_A);   // wrong old key for this row
    assert.equal(r.rekeyed, 0);
    assert.equal(r.failed, 1);
    assert.equal((await everyMessage())[0].body, "already converted",
      "the row must still be readable under the current key");
    closeStore();
  });

  test("an empty store is a no-op", async () => {
    openStore(uid, KEY_B);
    assert.deepEqual(await rekeyLocalStore(KEY_A), { rekeyed: 0, failed: 0 });
    closeStore();
  });
});
