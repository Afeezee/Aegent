// Archive attribution.
//
// A group's archive is sealed with a key the whole group shares, so the
// ciphertext alone cannot prove who wrote a message — the relay's
// recorded sender is the other half. Binding the sender INSIDE the
// sealed payload means a relay that rewrites its sender column is caught
// on read. The check was present but dead until the sender was actually
// stamped; these pin it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { attributionOk } from "../src/lib/protocol.ts";

describe("attributionOk", () => {
  test("accepts a payload whose sealed sender matches the recorded one", () => {
    assert.equal(attributionOk({ _from: "ada" }, "ada"), true);
  });

  test("rejects a mismatch — the relay claiming a different author", () => {
    assert.equal(attributionOk({ _from: "ada" }, "mallory"), false);
  });

  test("accepts a legacy payload with no sealed sender, on the relay's word", () => {
    // Older archive rows predate the stamp; dropping them would lose
    // real history over a check they couldn't have satisfied.
    assert.equal(attributionOk({}, "ada"), true);
    assert.equal(attributionOk({ _from: undefined }, "ada"), true);
  });
});
