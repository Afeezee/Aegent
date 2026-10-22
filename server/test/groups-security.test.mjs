// Authorization around groups.
//
// Every case here was permitted by the relay before this suite existed.
// They are regression tests for real holes, not hypotheticals.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  connect, emitSend, http, register, sealTo, startRelay, waitForEvent,
} from "./helpers.mjs";

let relay;
before(async () => { relay = await startRelay(); });
after(async () => { await relay?.stop(); });

describe("group membership is enforced", () => {
  test("an outsider cannot join a group by knowing its id", async () => {
    const alice = await register(relay, "alice");
    const bob = await register(relay, "bob");
    const mallory = await register(relay, "mallory");

    const made = await http(relay, "/api/groups", {
      method: "POST", token: alice.token,
      body: { name: "Trip", memberIds: [bob.id] },
    });
    assert.equal(made.status, 200);
    const groupId = made.body.id;

    // The group id travels in deep links, so treating it as a joining
    // capability made every shared link a permanent membership grant.
    const joined = await http(relay, `/api/groups/${groupId}/join`, {
      method: "POST", token: mallory.token,
    });
    assert.equal(joined.status, 403);
    assert.equal(joined.body.error, "invites_required");

    // And the refusal is real, not cosmetic: she still cannot read it.
    const peek = await http(relay, `/api/groups/${groupId}`, { token: mallory.token });
    assert.equal(peek.status, 404);
  });

  test("an outsider cannot post into a group by addressing real members", async () => {
    const alice = await register(relay, "alice2");
    const bob = await register(relay, "bob2");
    const mallory = await register(relay, "mallory2");

    const made = await http(relay, "/api/groups", {
      method: "POST", token: alice.token,
      body: { name: "Standup", memberIds: [bob.id] },
    });
    const groupId = made.body.id;

    const mallorySock = await connect(relay, mallory.token);
    const bobSock = await connect(relay, bob.token);
    const inbound = waitForEvent(bobSock, "message", 600);

    // The relay used to check only that the RECIPIENT was a member, so
    // addressing a real member was enough to inject into the group.
    const ack = await emitSend(mallorySock, {
      recipientId: bob.id,
      groupId,
      ciphertext: sealTo("I do not belong here", bob.pub, mallory.priv),
    });
    assert.equal(ack.ok, false);
    assert.equal(ack.error, "not_group_member");
    assert.equal(await inbound, null, "bob must receive nothing");
  });

  test("a member can still post, and non-members cannot be addressed", async () => {
    const alice = await register(relay, "alice3");
    const bob = await register(relay, "bob3");
    const carol = await register(relay, "carol3");

    const made = await http(relay, "/api/groups", {
      method: "POST", token: alice.token,
      body: { name: "Book club", memberIds: [bob.id] },
    });
    const groupId = made.body.id;

    const aliceSock = await connect(relay, alice.token);
    const bobSock = await connect(relay, bob.token);
    const inbound = waitForEvent(bobSock, "message", 800);

    const ok = await emitSend(aliceSock, {
      recipientId: bob.id,
      groupId,
      ciphertext: sealTo("hello", bob.pub, alice.priv),
    });
    assert.equal(ok.ok, true, "a member must still be able to post");
    assert.ok(await inbound, "bob should receive it");

    // Carol is not in the group, so she is not a valid recipient for it.
    const bad = await emitSend(aliceSock, {
      recipientId: carol.id,
      groupId,
      ciphertext: sealTo("leak", carol.pub, alice.priv),
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "recipient_not_member");
  });

  test("an outsider cannot broadcast typing into a group", async () => {
    const alice = await register(relay, "alice4");
    const bob = await register(relay, "bob4");
    const mallory = await register(relay, "mallory4");

    const made = await http(relay, "/api/groups", {
      method: "POST", token: alice.token,
      body: { name: "Quiet", memberIds: [bob.id] },
    });
    const groupId = made.body.id;

    const mallorySock = await connect(relay, mallory.token);
    const bobSock = await connect(relay, bob.token);

    const seen = waitForEvent(bobSock, "typing", 500);
    mallorySock.emit("typing", { groupId });
    assert.equal(await seen, null, "a non-member must not reach the group");

    // A real member still gets through — the check must not break typing.
    const aliceSock = await connect(relay, alice.token);
    const real = waitForEvent(bobSock, "typing", 800);
    aliceSock.emit("typing", { groupId });
    const got = await real;
    assert.ok(got, "a member's typing should still arrive");
    assert.equal(got.from, alice.id);
  });
});

describe("group creation is validated", () => {
  test("members must exist", async () => {
    const alice = await register(relay, "alice5");
    const r = await http(relay, "/api/groups", {
      method: "POST", token: alice.token,
      body: { name: "Ghosts", memberIds: ["00000000-0000-0000-0000-000000000000"] },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "unknown_member");
  });

  test("membership is capped", async () => {
    const alice = await register(relay, "alice6");
    const bob = await register(relay, "bob6");
    // 300 ids, all of them bob's, collapse to 2 members after dedupe —
    // so this also pins that the cap counts distinct members.
    const ok = await http(relay, "/api/groups", {
      method: "POST", token: alice.token,
      body: { name: "Dupes", memberIds: new Array(300).fill(bob.id) },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.memberIds.length, 2);

    const tooMany = await http(relay, "/api/groups", {
      method: "POST", token: alice.token,
      body: { name: "Crowd", memberIds: Array.from({ length: 300 }, (_, i) => `u${i}`) },
    });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error, "too_many_members");
  });
});
