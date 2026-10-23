// User discovery is deliberate, not browsable.
//
// You find people by an identifier they chose to share — exact phone,
// exact email, or their @handle. A fragment of any of those surfaces
// nobody: the directory is not a people-search engine.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { http, register, startRelay } from "./helpers.mjs";

let relay;
before(async () => { relay = await startRelay(); });
after(async () => { await relay?.stop(); });

async function search(seeker, q) {
  const r = await http(relay, `/api/users/search?q=${encodeURIComponent(q)}`, { token: seeker.token });
  return r.body ?? [];
}

describe("discovery", () => {
  test("a fragment of a name/handle finds nobody", async () => {
    const me = await register(relay, "discme");
    const target = await register(relay, "montgomery");   // handle: montgomery
    assert.equal((await search(me, "mont")).length, 0, "a prefix is name search in disguise");
    assert.equal((await search(me, "gomery")).length, 0, "an infix even more so");
  });

  test("the exact handle finds them", async () => {
    const me = await register(relay, "discme2");
    const target = await register(relay, "montgomery2");
    const found = await search(me, "@montgomery2");
    assert.equal(found.length, 1);
    assert.equal(found[0].id, target.id);
  });

  test("a fragment of an email finds no one; the full address does", async () => {
    const me = await register(relay, "discme3");
    const target = await register(relay, "disctarget3");
    assert.equal((await search(me, "@test.local")).length, 0, "a domain is not enough");
    const found = await search(me, target.email);
    assert.equal(found.length, 1);
    assert.equal(found[0].id, target.id);
  });

  test("you never find yourself", async () => {
    const me = await register(relay, "discself");
    assert.equal((await search(me, "@" + me.id.slice(0, 4))).length, 0);
  });
});
