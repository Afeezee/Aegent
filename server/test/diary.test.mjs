// Diary: who can read what, and for how long.
//
// The claim this suite has to hold up is specific: a contact can open an
// entry for 24 hours, the author keeps it forever, and when the window
// closes the relay will not serve the ciphertext, the key, or the image
// to that contact again. Expiry here is the deletion of a key grant, so
// these tests check the key path rather than a flag.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { b64, connect, http, register, startRelay, waitForEvent } from "./helpers.mjs";

let relay;
before(async () => { relay = await startRelay(); });
after(async () => { await relay?.stop(); });

// Seal an entry the way the client does: one random key per entry, the
// body sealed with it, and that key boxed to each reader.
function makeEntry(author, viewers, { body = "a day", createdAt = Date.now(), id } = {}) {
  const entryKey = nacl.randomBytes(32);
  const nonce = nacl.randomBytes(24);
  const ct = nacl.secretbox(new TextEncoder().encode(JSON.stringify({ v: 1, t: "text", body })), nonce, entryKey);
  const sealed = new Uint8Array(nonce.length + ct.length);
  sealed.set(nonce); sealed.set(ct, nonce.length);

  const wrap = (toPub) => {
    const n = nacl.randomBytes(24);
    const c = nacl.box(entryKey, n, toPub, author.priv);
    const o = new Uint8Array(n.length + c.length);
    o.set(n); o.set(c, n.length);
    return b64.encode(o);
  };

  return {
    entryKey,
    payload: {
      id: id ?? `e-${Math.random().toString(36).slice(2)}`,
      dayKey: "2026-05-02",
      tzOffsetMin: 60,
      seq: 0,
      kind: "text",
      createdAt,
      bodyCt: b64.encode(sealed),
      authorKey: wrap(author.pub),
      grants: viewers.map((v) => ({ viewerId: v.id, wrappedKey: wrap(v.pub) })),
      blobIds: [],
    },
  };
}

function openEntry(entry, reader, authorPub) {
  const w = b64.decode(entry.wrappedKey);
  const key = nacl.box.open(w.slice(24), w.slice(0, 24), authorPub, reader.priv);
  assert.ok(key, "the grant must open with the reader's own key");
  const body = b64.decode(entry.bodyCt);
  const pt = nacl.secretbox.open(body.slice(24), body.slice(0, 24), key);
  assert.ok(pt, "the entry key must open the body");
  return JSON.parse(new TextDecoder().decode(pt));
}

describe("publishing and reading", () => {
  test("a contact can read it; a stranger cannot see it at all", async () => {
    const ada = await register(relay, "d-ada");
    const bo = await register(relay, "d-bo");
    const stranger = await register(relay, "d-stranger");

    const { payload } = makeEntry(ada, [bo], { body: "went to the market" });
    const pub = await http(relay, "/api/diary/entries", { method: "POST", token: ada.token, body: payload });
    assert.equal(pub.status, 200);
    assert.ok(pub.body.expiresAt > pub.body.createdAt);

    const boFeed = await http(relay, "/api/diary/feed", { token: bo.token });
    assert.equal(boFeed.body.entries.length, 1);
    assert.equal(openEntry(boFeed.body.entries[0], bo, ada.pub).body, "went to the market");

    const strangerFeed = await http(relay, "/api/diary/feed", { token: stranger.token });
    assert.equal(strangerFeed.body.entries.length, 0, "no grant means the entry does not exist for you");
  });

  test("the author's own copy never expires and is not in their feed", async () => {
    const ada = await register(relay, "d-ada2");
    const bo = await register(relay, "d-bo2");
    const { payload } = makeEntry(ada, [bo], { body: "mine forever" });
    await http(relay, "/api/diary/entries", { method: "POST", token: ada.token, body: payload });

    const mine = await http(relay, "/api/diary/mine", { token: ada.token });
    assert.equal(mine.body.entries.length, 1);
    assert.equal(mine.body.entries[0].expiresAt, null, "the author's grant must never expire");
    assert.equal(openEntry(mine.body.entries[0], ada, ada.pub).body, "mine forever",
      "the archive must be readable from the account's own key alone");

    // The feed is other people's pages; your own belongs in your archive.
    const own = await http(relay, "/api/diary/feed", { token: ada.token });
    assert.equal(own.body.entries.length, 0);
  });

  test("a viewer is notified live, with metadata only", async () => {
    const ada = await register(relay, "d-ada3");
    const bo = await register(relay, "d-bo3");
    const boSock = await connect(relay, bo.token);
    const heard = waitForEvent(boSock, "diary", 1500);

    const { payload } = makeEntry(ada, [bo]);
    await http(relay, "/api/diary/entries", { method: "POST", token: ada.token, body: payload });

    const event = await heard;
    assert.ok(event, "a grantee should be told there is something to pull");
    assert.equal(event.authorId, ada.id);
    // The socket must never be a second delivery path for the content.
    assert.equal(event.bodyCt, undefined);
    assert.equal(event.wrappedKey, undefined);
  });

  test("the relay owns the expiry clock", async () => {
    const ada = await register(relay, "d-ada4");
    const bo = await register(relay, "d-bo4");

    // A client claiming the distant future would otherwise be choosing
    // its own expiry — including "never".
    const far = makeEntry(ada, [bo], { createdAt: Date.now() + 40 * 86400_000 });
    const rejected = await http(relay, "/api/diary/entries", { method: "POST", token: ada.token, body: far.payload });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, "clock_skew");

    // A slightly-fast clock is clamped rather than rejected.
    const skewed = makeEntry(ada, [bo], { createdAt: Date.now() + 60_000 });
    const ok = await http(relay, "/api/diary/entries", { method: "POST", token: ada.token, body: skewed.payload });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.expiresAt <= Date.now() + 24 * 3600_000 + 5_000, "expiry is computed from the relay's clock");
  });
});

describe("expiry", () => {
  test("once the grant lapses the viewer gets nothing back", async () => {
    const ada = await register(relay, "d-ada5");
    const bo = await register(relay, "d-bo5");

    // Dated a day and a bit ago, so the 24h window is already closed.
    const { payload } = makeEntry(ada, [bo], {
      body: "yesterday's page", createdAt: Date.now() - 25 * 3600_000,
    });
    await http(relay, "/api/diary/entries", { method: "POST", token: ada.token, body: payload });

    const boFeed = await http(relay, "/api/diary/feed", { token: bo.token });
    assert.equal(boFeed.body.entries.length, 0,
      "an expired entry must not come back with its key attached");

    // And the author still has it — that is the whole asymmetry.
    const mine = await http(relay, "/api/diary/mine", { token: ada.token });
    assert.equal(mine.body.entries.length, 1);
    assert.equal(openEntry(mine.body.entries[0], ada, ada.pub).body, "yesterday's page");
  });
});

describe("images are gated too", () => {
  test("a diary blob needs a live grant; a chat blob is unchanged", async () => {
    const ada = await register(relay, "d-ada6");
    const bo = await register(relay, "d-bo6");
    const stranger = await register(relay, "d-str6");

    const upload = async (token) => {
      const r = await fetch(`${relay.base}/api/blobs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-mime": "image/jpeg" },
        body: Buffer.from(nacl.randomBytes(64)),
      });
      return (await r.json()).id;
    };
    const get = (id, token) => fetch(`${relay.base}/api/blobs/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });

    // A chat attachment keeps the capability model it always had.
    const chatBlob = await upload(ada.token);
    assert.equal((await get(chatBlob, stranger.token)).status, 200,
      "chat blobs must keep working exactly as before");

    // A diary-bound one does not.
    const diaryBlob = await upload(ada.token);
    const live = makeEntry(ada, [bo], { body: "with a photo" });
    live.payload.kind = "media";
    live.payload.blobIds = [diaryBlob];
    assert.equal((await http(relay, "/api/diary/entries", {
      method: "POST", token: ada.token, body: live.payload,
    })).status, 200);

    assert.equal((await get(diaryBlob, ada.token)).status, 200, "the author always can");
    assert.equal((await get(diaryBlob, bo.token)).status, 200, "a live grantee can");
    assert.equal((await get(diaryBlob, stranger.token)).status, 404, "nobody else can");

    // Expired grant: the image goes with the text. Without this a viewer
    // who saved the blob id and content key would keep the picture for
    // ever and the 24-hour promise would be decoration.
    const oldBlob = await upload(ada.token);
    const old = makeEntry(ada, [bo], { createdAt: Date.now() - 25 * 3600_000 });
    old.payload.kind = "media";
    old.payload.blobIds = [oldBlob];
    await http(relay, "/api/diary/entries", { method: "POST", token: ada.token, body: old.payload });
    assert.equal((await get(oldBlob, bo.token)).status, 404, "an expired grant must not still open the image");
    assert.equal((await get(oldBlob, ada.token)).status, 200, "the author keeps it");
  });

  test("an author cannot bind someone else's attachment", async () => {
    const ada = await register(relay, "d-ada7");
    const bo = await register(relay, "d-bo7");
    const r = await fetch(`${relay.base}/api/blobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${bo.token}`, "content-type": "application/octet-stream", "x-mime": "image/jpeg" },
      body: Buffer.from(nacl.randomBytes(32)),
    });
    const bosBlob = (await r.json()).id;

    // Binding is what makes a blob ACL-able, so letting an author bind a
    // stranger's upload would let them lock its owner out of it.
    const { payload } = makeEntry(ada, [bo]);
    payload.blobIds = [bosBlob];
    const res = await http(relay, "/api/diary/entries", { method: "POST", token: ada.token, body: payload });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "not_your_blob");
  });
});

describe("audience, views and deletion", () => {
  test("the author can revoke a reader mid-window", async () => {
    const ada = await register(relay, "d-ada8");
    const bo = await register(relay, "d-bo8");
    const { payload } = makeEntry(ada, [bo]);
    await http(relay, "/api/diary/entries", { method: "POST", token: ada.token, body: payload });
    assert.equal((await http(relay, "/api/diary/feed", { token: bo.token })).body.entries.length, 1);

    await http(relay, `/api/diary/entries/${payload.id}/grants`, {
      method: "PATCH", token: ada.token, body: { remove: [bo.id] },
    });
    assert.equal((await http(relay, "/api/diary/feed", { token: bo.token })).body.entries.length, 0,
      "revoking is immediate, because the key goes with the grant");
  });

  test("views count always; names only for viewers who send receipts", async () => {
    const ada = await register(relay, "d-ada9");
    const quiet = await register(relay, "d-quiet");
    const open = await register(relay, "d-open");

    // `open` opts into read receipts; `quiet` keeps the default (off).
    await http(relay, "/api/me/settings", { method: "PATCH", token: open.token, body: { readReceipts: true } });

    const { payload } = makeEntry(ada, [quiet, open]);
    await http(relay, "/api/diary/entries", { method: "POST", token: ada.token, body: payload });
    await http(relay, "/api/diary/seen", { method: "POST", token: quiet.token, body: { entryIds: [payload.id] } });
    await http(relay, "/api/diary/seen", { method: "POST", token: open.token, body: { entryIds: [payload.id] } });

    const views = await http(relay, `/api/diary/entries/${payload.id}/views`, { token: ada.token });
    assert.equal(views.body.count, 2, "the count is the engagement signal and is never withheld");
    assert.deepEqual(views.body.viewers.map((v) => v.id), [open.id],
      "identity follows the reader's existing read-receipts choice");

    const nosy = await http(relay, `/api/diary/entries/${payload.id}/views`, { token: open.token });
    assert.equal(nosy.status, 403, "only the author sees who read their page");
  });

  test("deleting an entry shreds it for everyone, author included", async () => {
    const ada = await register(relay, "d-ada10");
    const bo = await register(relay, "d-bo10");
    const { payload } = makeEntry(ada, [bo]);
    await http(relay, "/api/diary/entries", { method: "POST", token: ada.token, body: payload });

    const del = await http(relay, `/api/diary/entries/${payload.id}`, { method: "DELETE", token: ada.token });
    assert.equal(del.status, 200);
    assert.equal((await http(relay, "/api/diary/feed", { token: bo.token })).body.entries.length, 0);
    assert.equal((await http(relay, "/api/diary/mine", { token: ada.token })).body.entries.length, 0);
  });

  test("only the author can delete", async () => {
    const ada = await register(relay, "d-ada11");
    const bo = await register(relay, "d-bo11");
    const { payload } = makeEntry(ada, [bo]);
    await http(relay, "/api/diary/entries", { method: "POST", token: ada.token, body: payload });
    const res = await http(relay, `/api/diary/entries/${payload.id}`, { method: "DELETE", token: bo.token });
    assert.equal(res.status, 403);
    assert.equal((await http(relay, "/api/diary/mine", { token: ada.token })).body.entries.length, 1);
  });
});

describe("the diary stays off the message rail", () => {
  test("publishing changes nothing about inbox accounting", async () => {
    const ada = await register(relay, "d-ledger");
    const bo = await register(relay, "d-ledger-bo");

    const before = await http(relay, "/api/inbox/stats", { token: bo.token });
    const beforeIds = await http(relay, "/api/inbox/ids", { token: bo.token });

    for (let i = 0; i < 3; i++) {
      const { payload } = makeEntry(ada, [bo], { body: `entry ${i}` });
      await http(relay, "/api/diary/entries", { method: "POST", token: ada.token, body: payload });
    }

    const after = await http(relay, "/api/inbox/stats", { token: bo.token });
    const afterIds = await http(relay, "/api/inbox/ids", { token: bo.token });

    // If a diary entry ever became an envelope, reconciliation would list
    // ids that vanish 24 hours later and the client would record a
    // permanent deficit it could never close.
    assert.deepEqual(after.body, before.body, "inbox stats must be untouched by diary activity");
    assert.deepEqual(afterIds.body.ids, beforeIds.body.ids, "the envelope ledger must not learn about diary entries");
  });
});
