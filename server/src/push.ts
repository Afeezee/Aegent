// Content-free push wake-ups.
//
// When a recipient's app is backgrounded Android freezes its WebView, so
// nothing syncs until they reopen it. FCM is the only thing that can
// reach a frozen app. We use it to send a NUDGE, never content: a
// generic "you have a message" the system tray shows, plus a data flag
// that tells the app to drain its inbox when it wakes. The plaintext
// never leaves the device, so the end-to-end promise is intact — the
// relay only learns what it already knows (who has a message waiting),
// and Google learns one bit of metadata (a device was pinged).
//
// No Firebase Admin SDK: it is a large dependency for one HTTP call. We
// mint an OAuth token from the service account with jsonwebtoken (already
// a dependency) and POST to the FCM v1 endpoint. If no service account
// is configured the whole module is a no-op, so the relay runs fine
// without push — it just doesn't wake frozen apps.

import jwt from "jsonwebtoken";
import { db } from "./db.js";

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

function loadServiceAccount(): ServiceAccount | null {
  // On Render the JSON lives in an env var; a file path is supported too
  // for hosts where a mounted secret file is easier (e.g. a VPS).
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (raw) {
    try { return JSON.parse(raw); }
    catch { console.error("[push] FCM_SERVICE_ACCOUNT is not valid JSON; push disabled"); return null; }
  }
  const path = process.env.FCM_SERVICE_ACCOUNT_FILE;
  if (path) {
    try {
      // Lazy require so the fs import isn't paid for when unused.
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      return JSON.parse(readFileSync(path, "utf8"));
    } catch { console.error("[push] FCM_SERVICE_ACCOUNT_FILE unreadable; push disabled"); return null; }
  }
  return null;
}

const SA = loadServiceAccount();
export const pushEnabled = !!SA;
if (SA) console.log(`[push] FCM enabled for project ${SA.project_id}`);
else console.log("[push] FCM not configured; wake-ups disabled");

// Access tokens last an hour; mint a little early and cache.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string | null> {
  if (!SA) return null;
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.value;

  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: SA.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    SA.private_key,
    { algorithm: "RS256" },
  );

  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!r.ok) { console.error("[push] token exchange failed:", r.status, await r.text()); return null; }
    const body = await r.json() as { access_token: string; expires_in: number };
    cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  } catch (e) {
    console.error("[push] token exchange threw:", (e as Error).message);
    return null;
  }
}

// ---- device tokens ----

export async function registerToken(userId: string, token: string, platform: string): Promise<void> {
  const now = Date.now();
  // A token belongs to one device, but the user it maps to can change if
  // two accounts share a phone — upsert on the token, not the pair.
  await db.tx(async () => {
    await db.prepare("DELETE FROM device_tokens WHERE token = ?").run(token);
    await db.prepare(
      "INSERT INTO device_tokens (token, user_id, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
    ).run(token, userId, platform, now, now);
  });
}

export async function unregisterToken(token: string): Promise<void> {
  await db.prepare("DELETE FROM device_tokens WHERE token = ?").run(token);
}

async function tokensFor(userId: string): Promise<string[]> {
  const rows = await db.prepare(
    "SELECT token FROM device_tokens WHERE user_id = ?",
  ).all<{ token: string }>(userId);
  return rows.map((r) => r.token);
}

// ---- sending ----
//
// One generic notification per device. The body is static, so nothing
// about the message leaks; `data.type` tells the app to sync on open.
// A token the endpoint reports as dead is pruned, or they accumulate
// forever and every send wastes a call on a device that's gone.
export async function wake(userId: string): Promise<void> {
  if (!SA) return;
  const tokens = await tokensFor(userId);
  if (tokens.length === 0) return;
  const bearer = await accessToken();
  if (!bearer) return;

  const url = `https://fcm.googleapis.com/v1/projects/${SA.project_id}/messages:send`;
  for (const token of tokens) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: "Aegent", body: "New encrypted message" },
            data: { type: "sync" },
            android: { priority: "high", notification: { channel_id: "aegent_messages" } },
          },
        }),
      });
      if (r.status === 404 || r.status === 403) {
        // UNREGISTERED / SenderId mismatch: the token is dead.
        await unregisterToken(token).catch(() => { /* ignore */ });
      } else if (!r.ok) {
        console.warn("[push] send failed:", r.status, (await r.text()).slice(0, 160));
      }
    } catch (e) {
      console.warn("[push] send threw:", (e as Error).message);
    }
  }
}
