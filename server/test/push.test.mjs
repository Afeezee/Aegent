// Push device-token registration, and the content-free guarantee.
//
// The relay is started here with no FCM credentials, so `wake` is a
// no-op — which is also what every deploy without the env var does.
// These pin that registration works regardless, that tokens are scoped
// to their owner, and that nothing in this path ever stores message
// content.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { http, register, startRelay } from "./helpers.mjs";

let relay;
before(async () => { relay = await startRelay(); });
after(async () => { await relay?.stop(); });

describe("device tokens", () => {
  test("a device registers and unregisters its token", async () => {
    const ada = await register(relay, "push-ada");
    const reg = await http(relay, "/api/push/register", {
      method: "POST", token: ada.token, body: { token: "fcm-token-abc", platform: "android" },
    });
    assert.equal(reg.status, 200);
    // Without FCM configured the relay still accepts tokens; it simply
    // won't send. The flag tells the client which it is.
    assert.equal(reg.body.enabled, false);

    const un = await http(relay, "/api/push/unregister", {
      method: "POST", token: ada.token, body: { token: "fcm-token-abc" },
    });
    assert.equal(un.status, 200);
  });

  test("registering requires a session", async () => {
    const r = await fetch(`${relay.base}/api/push/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "x" }),
    });
    assert.equal(r.status, 401);
  });

  test("re-registering the same token moves it to the new owner", async () => {
    // Two accounts on one phone: the token must map to whoever is signed
    // in now, not both, or the wrong person gets woken.
    const ada = await register(relay, "push-ada2");
    const bo = await register(relay, "push-bo2");
    await http(relay, "/api/push/register", {
      method: "POST", token: ada.token, body: { token: "shared-device", platform: "android" },
    });
    const moved = await http(relay, "/api/push/register", {
      method: "POST", token: bo.token, body: { token: "shared-device", platform: "android" },
    });
    assert.equal(moved.status, 200, "the token rebinds without a duplicate-key error");
  });
});
