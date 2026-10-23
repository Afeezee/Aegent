// History for people who weren't there yet.
//
// On the per-recipient rail a joiner has no envelopes addressed to them,
// so "show new members the history" is impossible by construction. The
// archive rail makes it a question of which epoch keys they are handed —
// and the relay enforces that independently of whether they could
// decrypt, so neither gate stands alone.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { b64, http, register, startRelay } from "./helpers.mjs";

let relay;
before(async () => { relay = await startRelay(); });
after(async () => { await relay?.stop(); });

const wrapTo = (key, toPub, fromPriv) => {
  const n = nacl.randomBytes(24);
  const c = nacl.box(key, n, toPub, fromPriv);
  const o = new Uint8Array(n.length + c.length);
  o.set(n); o.set(c, n.length);
  return b64.encode(o);
};
const unwrap = (wrapped, fromPub, toPriv) => {
  const w = b64.decode(wrapped);
  return nacl.box.open(w.slice(24), w.slice(0, 24), fromPub, toPriv);
};
const seal = (key, text) => {
  const n = nacl.randomBytes(24);
  const c = nacl.secretbox(new TextEncoder().encode(text), n, key);
  const o = new Uint8Array(n.length + c.length);
  o.set(n); o.set(c, n.length);
  return b64.encode(o);
};
const open_ = (key, ct) => {
  const b = b64.decode(ct);
  const pt = nacl.secretbox.open(b.slice(24), b.slice(0, 24), key);
  return pt ? new TextDecoder().decode(pt) : null;
};

// Establish an epoch and archive one message under it.
async function post(owner, groupId, key, epoch, body, members = [owner]) {
  await http(relay, `/api/groups/${groupId}/archive`, {
    method: "POST", token: owner.token,
    body: {
      epoch, msgId: `m-${body.replace(/\s/g, "")}-${Math.random().toString(36).slice(2, 7)}`,
      ciphertext: seal(key, JSON.stringify({ v: 1, t: "text", body })),
      createdAt: Date.now(),
    },
  });
  void members;
}

async function makeGroup(owner, name = "History") {
  const r = await http(relay, "/api/groups", {
    method: "POST", token: owner.token, body: { name, memberIds: [] },
  });
  return r.body.id;
}

async function openEpoch(owner, groupId, members) {
  const key = nacl.randomBytes(32);
  const grants = members.map((m) => ({
    memberId: m.id, wrappedKey: wrapTo(key, m.pub, owner.priv),
  }));
  const r = await http(relay, `/api/groups/${groupId}/epochs/rotate`, {
    method: "POST", token: owner.token, body: { grants },
  });
  return { key, epoch: r.body.epoch };
}

describe("history policy is key distribution", () => {
  test("'all' lets a joiner read what came before; 'none' does not", async () => {
    const ada = await register(relay, "gh-ada");
    const bo = await register(relay, "gh-bo");
    const id = await makeGroup(ada);
    const { key, epoch } = await openEpoch(ada, id, [ada]);
    await post(ada, id, key, epoch, "before bo arrived");

    // Default policy is 'none': bo joins and sees nothing old.
    await http(relay, `/api/groups/${id}/members`, {
      method: "POST", token: ada.token, body: { userId: bo.id },
    });
    const noKeys = await http(relay, `/api/groups/${id}/archive`, { token: bo.token });
    assert.equal(noKeys.body.messages.length, 0, "no key, and no rows served either");

    // Handing over the key is what grants history — and the relay still
    // refuses rows from before history_from.
    await http(relay, `/api/groups/${id}/epochs/grant`, {
      method: "POST", token: ada.token,
      body: { grants: [{ memberId: bo.id, epoch, wrappedKey: wrapTo(key, bo.pub, ada.priv) }] },
    });
    const stillGated = await http(relay, `/api/groups/${id}/archive`, { token: bo.token });
    assert.equal(stillGated.body.messages.length, 0,
      "the key alone is not enough: joining under 'none' bounds them to messages from now on");

    // Now the same group with the policy set to 'all'.
    const cal = await register(relay, "gh-cal");
    await http(relay, `/api/groups/${id}`, {
      method: "PATCH", token: ada.token, body: { historyPolicy: "all" },
    });
    await http(relay, `/api/groups/${id}/members`, {
      method: "POST", token: ada.token, body: { userId: cal.id },
    });
    await http(relay, `/api/groups/${id}/epochs/grant`, {
      method: "POST", token: ada.token,
      body: { grants: [{ memberId: cal.id, epoch, wrappedKey: wrapTo(key, cal.pub, ada.priv) }] },
    });
    const seen = await http(relay, `/api/groups/${id}/archive`, { token: cal.token });
    assert.equal(seen.body.messages.length, 1);
    const theirKey = unwrap(
      (await http(relay, `/api/groups/${id}/epochs/keys`, { token: cal.token })).body.keys[0].wrappedKey,
      ada.pub, cal.priv,
    );
    assert.ok(theirKey, "the grant opens with their own key");
    assert.equal(
      JSON.parse(open_(theirKey, seen.body.messages[0].ciphertext)).body,
      "before bo arrived",
    );
  });

  test("you cannot hand over an epoch you do not hold", async () => {
    const ada = await register(relay, "gh-ada2");
    const bo = await register(relay, "gh-bo2");
    const mallory = await register(relay, "gh-mal2");
    const id = await makeGroup(ada);
    const { epoch } = await openEpoch(ada, id, [ada]);
    await http(relay, `/api/groups/${id}`, {
      method: "PATCH", token: ada.token, body: { joinMode: "invite" },
    });
    const inv = await http(relay, `/api/groups/${id}/invites`, { method: "POST", token: ada.token, body: {} });
    await http(relay, "/api/groups/join", { method: "POST", token: mallory.token, body: { token: inv.body.token } });

    // Mallory is a member but holds no key for that epoch, so she cannot
    // pass it to anyone — the relay checks possession even though it
    // cannot read the key itself.
    const r = await http(relay, `/api/groups/${id}/epochs/grant`, {
      method: "POST", token: mallory.token,
      body: { grants: [{ memberId: bo.id, epoch, wrappedKey: "not-a-real-key" }] },
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "not_your_epoch");
  });

  test("a non-member gets no archive at all", async () => {
    const ada = await register(relay, "gh-ada3");
    const mallory = await register(relay, "gh-mal3");
    const id = await makeGroup(ada);
    const { key, epoch } = await openEpoch(ada, id, [ada]);
    await post(ada, id, key, epoch, "members only");
    const r = await http(relay, `/api/groups/${id}/archive`, { token: mallory.token });
    assert.equal(r.status, 403);
  });
});

describe("rotation", () => {
  test("a removed member cannot read what is said next", async () => {
    const ada = await register(relay, "gr2-ada");
    const bo = await register(relay, "gr2-bo");
    const id = await makeGroup(ada);
    await http(relay, `/api/groups/${id}/members`, {
      method: "POST", token: ada.token, body: { userId: bo.id },
    });
    await http(relay, `/api/groups/${id}`, {
      method: "PATCH", token: ada.token, body: { historyPolicy: "all" },
    });

    const first = await openEpoch(ada, id, [ada, bo]);
    await post(ada, id, first.key, first.epoch, "while bo was here");
    assert.equal((await http(relay, `/api/groups/${id}/archive`, { token: bo.token })).body.messages.length, 1);

    // Bo leaves, the group rotates, and the next message is sealed with
    // a key he was never given.
    await http(relay, `/api/groups/${id}/members/${bo.id}`, { method: "DELETE", token: ada.token });
    const second = await openEpoch(ada, id, [ada]);
    await post(ada, id, second.key, second.epoch, "after bo left");

    const afterLeaving = await http(relay, `/api/groups/${id}/archive`, { token: bo.token });
    assert.equal(afterLeaving.status, 403, "and he is no longer a member, so nothing is served");

    // Re-added, he gets the current epoch but the relay still bounds him
    // by when he rejoined.
    await http(relay, `/api/groups/${id}`, {
      method: "PATCH", token: ada.token, body: { historyPolicy: "none" },
    });
    await http(relay, `/api/groups/${id}/members`, {
      method: "POST", token: ada.token, body: { userId: bo.id },
    });
    await http(relay, `/api/groups/${id}/epochs/grant`, {
      method: "POST", token: ada.token,
      body: { grants: [{ memberId: bo.id, epoch: second.epoch, wrappedKey: wrapTo(second.key, bo.pub, ada.priv) }] },
    });
    const rejoined = await http(relay, `/api/groups/${id}/archive`, { token: bo.token });
    assert.equal(rejoined.body.messages.length, 0,
      "rejoining under 'none' does not reopen what was said while he was away");
  });
});

describe("the archive does not disturb the live rail", () => {
  test("archiving changes nothing about inbox accounting", async () => {
    const ada = await register(relay, "ga2-ada");
    const bo = await register(relay, "ga2-bo");
    const id = await makeGroup(ada);
    await http(relay, `/api/groups/${id}/members`, {
      method: "POST", token: ada.token, body: { userId: bo.id },
    });
    const before = await http(relay, "/api/inbox/stats", { token: bo.token });
    const { key, epoch } = await openEpoch(ada, id, [ada, bo]);
    for (let i = 0; i < 3; i++) await post(ada, id, key, epoch, `archived ${i}`);
    const after = await http(relay, "/api/inbox/stats", { token: bo.token });
    assert.deepEqual(after.body, before.body,
      "the archive is a second rail; the envelope ledger must not learn about it");
  });

  test("only someone allowed to post may archive", async () => {
    const ada = await register(relay, "ga3-ada");
    const bo = await register(relay, "ga3-bo");
    const id = await makeGroup(ada);
    await http(relay, `/api/groups/${id}/members`, {
      method: "POST", token: ada.token, body: { userId: bo.id },
    });
    const { key, epoch } = await openEpoch(ada, id, [ada, bo]);
    await http(relay, `/api/groups/${id}/members/${bo.id}/mute`, {
      method: "POST", token: ada.token, body: { minutes: 60 },
    });
    const r = await http(relay, `/api/groups/${id}/archive`, {
      method: "POST", token: bo.token,
      body: { epoch, msgId: "muted-1", ciphertext: seal(key, "{}"), createdAt: Date.now() },
    });
    assert.equal(r.status, 403, "a mute that only covers the live rail would be no mute at all");
  });
});
