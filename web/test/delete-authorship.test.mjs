// Who is allowed to tombstone a message.
//
// A `delete` payload used to be honoured on the sender's bare assertion:
// `applyDelete` took only a message id and never looked at who asked. Any
// peer who knew an id could erase it on your device — in 1:1 chats too,
// including messages you had sent yourself.
//
// The rule lives in a pure function precisely so it can be tested without
// standing up IndexedDB, and so there is one obvious place to change when
// group admins eventually gain the right to remove other people's
// messages (which will arrive server-attested, not as a payload).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mayDelete } from "../src/lib/store.ts";

describe("delete authorship", () => {
  test("the author may delete their own message", () => {
    assert.equal(mayDelete({ senderId: "alice" }, "alice"), true);
  });

  test("a recipient may not delete a message they received", () => {
    // The original hole, from the receiving side.
    assert.equal(mayDelete({ senderId: "alice" }, "bob"), false);
  });

  test("a third party may not delete someone else's message", () => {
    assert.equal(mayDelete({ senderId: "alice" }, "mallory"), false);
  });

  test("an empty or missing requester is refused, not waved through", () => {
    // Guards against a future caller that forgets to pass the sender:
    // defaulting to 'allow' is how the original bug would come back.
    assert.equal(mayDelete({ senderId: "alice" }, ""), false);
    assert.equal(mayDelete({ senderId: "alice" }, undefined), false);
  });

  test("ids are compared exactly", () => {
    assert.equal(mayDelete({ senderId: "alice" }, "Alice"), false);
    assert.equal(mayDelete({ senderId: "alice" }, "alice "), false);
  });
});
