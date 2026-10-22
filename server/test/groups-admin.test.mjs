// Roles, invites, moderation.
//
// The point of this suite is that every answer comes from one place:
// requireRole / canPost. The previous surface decided permissions ad hoc
// at each call site, which is exactly where the holes were.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  connect, emitSend, http, register, sealTo, startRelay, waitForEvent,
} from "./helpers.mjs";

let relay;
before(async () => { relay = await startRelay(); });
after(async () => { await relay?.stop(); });

async function makeGroup(owner, members = [], name = "Team") {
  const r = await http(relay, "/api/groups", {
    method: "POST", token: owner.token,
    body: { name, memberIds: members.map((m) => m.id) },
  });
  assert.equal(r.status, 200, r.text);
  return r.body.id;
}

describe("roles", () => {
  test("the creator owns the group; members do not administer it", async () => {
    const ada = await register(relay, "ga-ada");
    const bo = await register(relay, "ga-bo");
    const id = await makeGroup(ada, [bo]);

    const asOwner = await http(relay, `/api/groups/${id}`, { token: ada.token });
    assert.equal(asOwner.body.myRole, "owner");
    assert.equal(asOwner.body.members.find((m) => m.id === bo.id).role, "member");

    // A plain member cannot rename the group or add people.
    const rename = await http(relay, `/api/groups/${id}`, {
      method: "PATCH", token: bo.token, body: { name: "Hijacked" },
    });
    assert.equal(rename.status, 403);
    assert.equal(rename.body.error, "insufficient_role");

    const ok = await http(relay, `/api/groups/${id}`, {
      method: "PATCH", token: ada.token, body: { name: "Renamed", description: "ours" },
    });
    assert.equal(ok.status, 200);
    assert.equal((await http(relay, `/api/groups/${id}`, { token: ada.token })).body.name, "Renamed");
  });

  test("an owner can promote, and an admin can then act", async () => {
    const ada = await register(relay, "ga-ada2");
    const bo = await register(relay, "ga-bo2");
    const cal = await register(relay, "ga-cal2");
    const id = await makeGroup(ada, [bo]);

    assert.equal((await http(relay, `/api/groups/${id}/members/${bo.id}/role`, {
      method: "POST", token: bo.token, body: { role: "admin" },
    })).status, 403, "a member cannot promote themselves");

    assert.equal((await http(relay, `/api/groups/${id}/members/${bo.id}/role`, {
      method: "POST", token: ada.token, body: { role: "admin" },
    })).status, 200);

    const added = await http(relay, `/api/groups/${id}/members`, {
      method: "POST", token: bo.token, body: { userId: cal.id },
    });
    assert.equal(added.status, 200, "a promoted admin can add people");
    assert.ok(added.body.memberIds.includes(cal.id));
  });

  test("the owner cannot be removed, demoted or muted", async () => {
    const ada = await register(relay, "ga-ada3");
    const bo = await register(relay, "ga-bo3");
    const id = await makeGroup(ada, [bo]);
    await http(relay, `/api/groups/${id}/members/${bo.id}/role`, {
      method: "POST", token: ada.token, body: { role: "admin" },
    });

    assert.equal((await http(relay, `/api/groups/${id}/members/${ada.id}`, {
      method: "DELETE", token: bo.token,
    })).body.error, "cannot_remove_owner");
    assert.equal((await http(relay, `/api/groups/${id}/members/${ada.id}/mute`, {
      method: "POST", token: bo.token, body: { minutes: 60 },
    })).body.error, "cannot_mute_owner");
  });
});

describe("posting policy and mutes", () => {
  test("admins-only posting silences members at the relay", async () => {
    const ada = await register(relay, "gp-ada");
    const bo = await register(relay, "gp-bo");
    const id = await makeGroup(ada, [bo]);
    const boSock = await connect(relay, bo.token);

    const before = await emitSend(boSock, {
      recipientId: ada.id, groupId: id, ciphertext: sealTo("hi", ada.pub, bo.priv),
    });
    assert.equal(before.ok, true, "members can post by default");

    await http(relay, `/api/groups/${id}`, {
      method: "PATCH", token: ada.token, body: { postPolicy: "admins" },
    });
    // The socket caches membership briefly; a fresh connection asks again.
    const fresh = await connect(relay, bo.token);
    const after = await emitSend(fresh, {
      recipientId: ada.id, groupId: id, ciphertext: sealTo("hi again", ada.pub, bo.priv),
    });
    assert.equal(after.ok, false);
    assert.equal(after.error, "not_group_member");

    const owner = await connect(relay, ada.token);
    assert.equal((await emitSend(owner, {
      recipientId: bo.id, groupId: id, ciphertext: sealTo("admins still can", bo.pub, ada.priv),
    })).ok, true);
  });

  test("a muted member cannot post, and unmuting restores them", async () => {
    const ada = await register(relay, "gm-ada");
    const bo = await register(relay, "gm-bo");
    const id = await makeGroup(ada, [bo]);

    await http(relay, `/api/groups/${id}/members/${bo.id}/mute`, {
      method: "POST", token: ada.token, body: { minutes: 60 },
    });
    const muted = await connect(relay, bo.token);
    assert.equal((await emitSend(muted, {
      recipientId: ada.id, groupId: id, ciphertext: sealTo("let me in", ada.pub, bo.priv),
    })).ok, false);

    await http(relay, `/api/groups/${id}/members/${bo.id}/mute`, {
      method: "POST", token: ada.token, body: { minutes: 0 },
    });
    const free = await connect(relay, bo.token);
    assert.equal((await emitSend(free, {
      recipientId: ada.id, groupId: id, ciphertext: sealTo("thanks", ada.pub, bo.priv),
    })).ok, true);
  });
});

describe("invites", () => {
  test("a token joins; a tampered or revoked one does not", async () => {
    const ada = await register(relay, "gi-ada");
    const bo = await register(relay, "gi-bo");
    const id = await makeGroup(ada);
    await http(relay, `/api/groups/${id}`, {
      method: "PATCH", token: ada.token, body: { joinMode: "invite" },
    });

    const minted = await http(relay, `/api/groups/${id}/invites`, { method: "POST", token: ada.token, body: {} });
    assert.equal(minted.status, 200);
    const token = minted.body.token;

    // Only the hash is stored, so a guessed token is worthless.
    const tampered = await http(relay, "/api/groups/join", {
      method: "POST", token: bo.token, body: { token: token.slice(0, -3) + "aaa" },
    });
    assert.equal(tampered.status, 400);

    const joined = await http(relay, "/api/groups/join", {
      method: "POST", token: bo.token, body: { token },
    });
    assert.equal(joined.body.state, "joined");
    assert.ok(joined.body.group.memberIds.includes(bo.id));
  });

  test("a revoked invite stops working", async () => {
    const ada = await register(relay, "gi-ada2");
    const bo = await register(relay, "gi-bo2");
    const id = await makeGroup(ada);
    await http(relay, `/api/groups/${id}`, { method: "PATCH", token: ada.token, body: { joinMode: "invite" } });
    const minted = await http(relay, `/api/groups/${id}/invites`, { method: "POST", token: ada.token, body: {} });
    await http(relay, `/api/groups/${id}/invites/${minted.body.id}`, { method: "DELETE", token: ada.token });

    const r = await http(relay, "/api/groups/join", {
      method: "POST", token: bo.token, body: { token: minted.body.token },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "bad_invite");
  });

  test("a single-use invite is spent after one join", async () => {
    const ada = await register(relay, "gi-ada3");
    const bo = await register(relay, "gi-bo3");
    const cal = await register(relay, "gi-cal3");
    const id = await makeGroup(ada);
    await http(relay, `/api/groups/${id}`, { method: "PATCH", token: ada.token, body: { joinMode: "invite" } });
    const minted = await http(relay, `/api/groups/${id}/invites`, {
      method: "POST", token: ada.token, body: { maxUses: 1 },
    });
    assert.equal((await http(relay, "/api/groups/join", {
      method: "POST", token: bo.token, body: { token: minted.body.token },
    })).body.state, "joined");
    assert.equal((await http(relay, "/api/groups/join", {
      method: "POST", token: cal.token, body: { token: minted.body.token },
    })).status, 400);
  });

  test("a closed group refuses even a valid token", async () => {
    const ada = await register(relay, "gi-ada4");
    const bo = await register(relay, "gi-bo4");
    const id = await makeGroup(ada);   // join_mode defaults to closed
    const minted = await http(relay, `/api/groups/${id}/invites`, { method: "POST", token: ada.token, body: {} });
    const r = await http(relay, "/api/groups/join", {
      method: "POST", token: bo.token, body: { token: minted.body.token },
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "closed");
  });

  test("request mode queues the join for an admin", async () => {
    const ada = await register(relay, "gr-ada");
    const bo = await register(relay, "gr-bo");
    const id = await makeGroup(ada);
    await http(relay, `/api/groups/${id}`, { method: "PATCH", token: ada.token, body: { joinMode: "request" } });
    const minted = await http(relay, `/api/groups/${id}/invites`, { method: "POST", token: ada.token, body: {} });

    const asked = await http(relay, "/api/groups/join", {
      method: "POST", token: bo.token, body: { token: minted.body.token },
    });
    assert.equal(asked.body.state, "requested");
    assert.ok(!(await membersOfVia(ada, id)).includes(bo.id), "a request is not a membership");

    const pending = await http(relay, `/api/groups/${id}/requests`, { token: ada.token });
    assert.deepEqual(pending.body.map((p) => p.userId), [bo.id]);

    await http(relay, `/api/groups/${id}/requests/${bo.id}`, {
      method: "POST", token: ada.token, body: { approve: true },
    });
    assert.ok((await membersOfVia(ada, id)).includes(bo.id));
  });
});

describe("removal and bans", () => {
  test("a removed member loses access; a banned one cannot be re-added", async () => {
    const ada = await register(relay, "gb-ada");
    const bo = await register(relay, "gb-bo");
    const id = await makeGroup(ada, [bo]);

    await http(relay, `/api/groups/${id}/ban/${bo.id}`, { method: "POST", token: ada.token });
    assert.equal((await http(relay, `/api/groups/${id}`, { token: bo.token })).status, 404,
      "a banned member can no longer read the group");

    const readd = await http(relay, `/api/groups/${id}/members`, {
      method: "POST", token: ada.token, body: { userId: bo.id },
    });
    assert.equal(readd.status, 403);
    assert.equal(readd.body.error, "banned");

    await http(relay, `/api/groups/${id}/ban/${bo.id}`, { method: "DELETE", token: ada.token });
    assert.equal((await http(relay, `/api/groups/${id}/members`, {
      method: "POST", token: ada.token, body: { userId: bo.id },
    })).status, 200, "unbanning allows a re-add");
  });

  test("anyone may leave without being an admin", async () => {
    const ada = await register(relay, "gl-ada");
    const bo = await register(relay, "gl-bo");
    const id = await makeGroup(ada, [bo]);
    assert.equal((await http(relay, `/api/groups/${id}/members/${bo.id}`, {
      method: "DELETE", token: bo.token,
    })).status, 200);
    assert.ok(!(await membersOfVia(ada, id)).includes(bo.id));
  });
});

describe("events", () => {
  test("membership changes are recorded as metadata, in order", async () => {
    const ada = await register(relay, "ge-ada");
    const bo = await register(relay, "ge-bo");
    // Founding members are covered by "created" rather than one "added"
    // each — otherwise making a group of fifty opens with fifty lines of
    // history before anyone has said anything.
    const id = await makeGroup(ada);
    await http(relay, `/api/groups/${id}/members`, {
      method: "POST", token: ada.token, body: { userId: bo.id },
    });
    await http(relay, `/api/groups/${id}`, { method: "PATCH", token: ada.token, body: { name: "New name" } });
    await http(relay, `/api/groups/${id}/members/${bo.id}`, { method: "DELETE", token: ada.token });

    const events = await http(relay, `/api/groups/${id}/events`, { token: ada.token });
    const kinds = events.body.map((e) => e.kind);
    assert.deepEqual(kinds, ["created", "added", "updated", "removed"]);
    assert.deepEqual(events.body.map((e) => e.seq), [1, 2, 3, 4], "seq is contiguous and ordered");
    // Events are metadata: they must never carry message content.
    assert.ok(events.body.every((e) => typeof e.data !== "string" || !e.data.includes("ciphertext")));
  });

  test("a non-member cannot read a group's events", async () => {
    const ada = await register(relay, "ge-ada2");
    const mallory = await register(relay, "ge-mal2");
    const id = await makeGroup(ada);
    assert.equal((await http(relay, `/api/groups/${id}/events`, { token: mallory.token })).status, 403);
  });
});

async function membersOfVia(user, groupId) {
  const r = await http(relay, `/api/groups/${groupId}`, { token: user.token });
  return r.body?.memberIds ?? [];
}
