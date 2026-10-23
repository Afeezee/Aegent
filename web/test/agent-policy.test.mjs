// What the agent is allowed to read.
//
// Before this existed, scope was a sentence in the system prompt and
// every search tool took `peerId` as an optional filter the model could
// omit — so one casual question could sweep every conversation on the
// device and send the bodies off to be summarised. These tests pin the
// enforcement, including the part that matters most: that filtering
// happens to the ROWS, not to the model's choice of arguments.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  agentPolicy, assertInScope, budget, filterInScope, inScope,
  resetAgentPolicy, setAgentPolicy, OutOfScopeError,
} from "../src/agent/policy.ts";

const msg = (peerId, body = "hello") => ({
  id: `m-${peerId}-${body}`, peerId, senderId: "someone", direction: "in",
  createdAt: Date.now(), body, editedBody: null, caption: null, media: null,
});

beforeEach(() => resetAgentPolicy());

describe("by default nothing changes for one-to-one use", () => {
  test("everything is in scope", () => {
    assert.equal(inScope("ada"), true);
    assert.equal(inScope("any-group"), true);
    const rows = [msg("ada"), msg("bo")];
    assert.equal(filterInScope(rows).length, 2);
  });
});

describe("denied threads", () => {
  beforeEach(() => setAgentPolicy({
    scope: { kind: "all" }, denied: new Set(["secret-group"]),
    maxRows: 300, maxBodyChars: 4000,
  }));

  test("a group with the assistant switched off is unreadable", () => {
    assert.equal(inScope("secret-group"), false);
    assert.equal(inScope("ada"), true);
  });

  test("its messages are filtered out of a cross-thread sweep", () => {
    // This is the case that mattered: a tool that reads every message
    // and does not pass a peer filter at all.
    const rows = [msg("ada", "fine"), msg("secret-group", "private"), msg("bo", "fine")];
    const visible = filterInScope(rows);
    assert.deepEqual(visible.map((m) => m.peerId), ["ada", "bo"]);
    assert.ok(!JSON.stringify(visible).includes("private"),
      "nothing from a denied thread may survive into what the model is shown");
  });

  test("addressing it by id is refused loudly, not silently emptied", () => {
    // The id-addressed tools never look at peerId, so they would read
    // straight past a filter. They throw instead, and the model reports
    // a boundary rather than inventing an answer from nothing.
    assert.throws(() => assertInScope("secret-group"), OutOfScopeError);
    assert.doesNotThrow(() => assertInScope("ada"));
  });
});

describe("a closed scope", () => {
  beforeEach(() => setAgentPolicy({
    scope: { kind: "peers", peerIds: ["group-1"] }, denied: new Set(),
    maxRows: 300, maxBodyChars: 4000,
  }));

  test("only the named threads are readable", () => {
    assert.equal(inScope("group-1"), true);
    assert.equal(inScope("group-2"), false);
    assert.equal(inScope("ada"), false);
    const rows = [msg("group-1", "in"), msg("group-2", "out"), msg("ada", "out")];
    assert.deepEqual(filterInScope(rows).map((m) => m.body), ["in"]);
  });

  test("deny wins over an allowed scope", () => {
    setAgentPolicy({
      scope: { kind: "peers", peerIds: ["group-1"] },
      denied: new Set(["group-1"]),
      maxRows: 300, maxBodyChars: 4000,
    });
    assert.equal(inScope("group-1"), false, "an explicit denial must not be overridable by scope");
  });
});

describe("egress budget", () => {
  test("row count is capped", () => {
    setAgentPolicy({ scope: { kind: "all" }, denied: new Set(), maxRows: 2, maxBodyChars: 4000 });
    assert.equal(budget([msg("a"), msg("a"), msg("a"), msg("a")]).length, 2);
  });

  test("long bodies are truncated rather than shipped whole", () => {
    setAgentPolicy({ scope: { kind: "all" }, denied: new Set(), maxRows: 10, maxBodyChars: 20 });
    const [out] = budget([msg("a", "x".repeat(500))]);
    assert.ok(out.body.length < 60);
    assert.match(out.body, /truncated/);
  });

  test("short bodies are left exactly as they are", () => {
    setAgentPolicy({ scope: { kind: "all" }, denied: new Set(), maxRows: 10, maxBodyChars: 20 });
    const [out] = budget([msg("a", "short")]);
    assert.equal(out.body, "short");
  });

  test("an edited body is budgeted too", () => {
    setAgentPolicy({ scope: { kind: "all" }, denied: new Set(), maxRows: 10, maxBodyChars: 10 });
    const row = { ...msg("a", "original"), editedBody: "y".repeat(200) };
    const [out] = budget([row]);
    assert.ok((out.body ?? "").length < 40, "the edited text is what gets read, so it is what gets capped");
  });
});

describe("the policy is a module-level switch", () => {
  test("reset restores the open default", () => {
    setAgentPolicy({ scope: { kind: "peers", peerIds: [] }, denied: new Set(), maxRows: 1, maxBodyChars: 1 });
    assert.equal(inScope("ada"), false);
    resetAgentPolicy();
    assert.equal(inScope("ada"), true);
    assert.equal(agentPolicy().maxRows, 300);
  });
});
