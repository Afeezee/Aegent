// Device-side push: register for wake-ups, and act on them.
//
// Native Android only. The push plugin needs the OS, and web push is a
// separate mechanism (service worker + VAPID) we are not building —
// desktop/web keep syncing on focus and visibility as before. On any
// non-native platform every function here is a quiet no-op.
//
// What arrives is never content: a generic "new message" the system
// shows, plus a `type: sync` flag. Receiving it (or tapping it) just
// tells the app to drain its inbox, which is where the real, encrypted
// message is fetched and decrypted. So the push path learns nothing the
// relay didn't already know.

import { Capacitor } from "@capacitor/core";
import { api } from "./api.js";
import { pullInbox } from "./session.js";

let REGISTERED_TOKEN: string | null = null;
let WIRED = false;

function native(): boolean {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
}

// Called once the session is up. Asks permission, registers with FCM,
// and ships the token to the relay. Safe to call more than once.
export async function initPush(): Promise<void> {
  if (!native() || WIRED) return;
  WIRED = true;
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");

    const perm = await PushNotifications.checkPermissions();
    let granted = perm.receive === "granted";
    if (!granted && perm.receive === "prompt") {
      granted = (await PushNotifications.requestPermissions()).receive === "granted";
    }
    if (!granted) return;   // the user declined; the app still works, just without wake-ups

    // Android 8+ drops notifications with no channel. The server targets
    // this id, so it must exist before the first push lands.
    try {
      await PushNotifications.createChannel({
        id: "aegent_messages",
        name: "Messages",
        description: "New encrypted messages",
        importance: 4,
        visibility: 1,
      });
    } catch { /* older Android ignores channels */ }

    // The token comes back asynchronously on the 'registration' event.
    await PushNotifications.addListener("registration", async (t) => {
      REGISTERED_TOKEN = t.value;
      try { await api.pushRegister(t.value, "android"); } catch { /* retried next boot */ }
    });
    await PushNotifications.addListener("registrationError", (e) => {
      console.warn("[push] registration error", JSON.stringify(e));
    });

    // Foreground delivery: we got pinged while open, so just sync.
    await PushNotifications.addListener("pushNotificationReceived", () => {
      void pullInbox({ reason: "push" });
    });
    // The user tapped the notification: bring the app current.
    await PushNotifications.addListener("pushNotificationActionPerformed", () => {
      void pullInbox({ reason: "push-tap" });
    });

    await PushNotifications.register();
  } catch (e) {
    console.warn("[push] init failed", (e as Error).message);
  }
}

// On sign-out, drop this device's token so a logged-out phone stops
// being woken for an account that's no longer on it.
export async function teardownPush(): Promise<void> {
  if (!REGISTERED_TOKEN) return;
  const token = REGISTERED_TOKEN;
  REGISTERED_TOKEN = null;
  try { await api.pushUnregister(token); } catch { /* best effort */ }
}
