// Live-relay socket wrapper. Carries only ciphertext and routing
// metadata; decryption happens exclusively in the callers.
//
// Listener design: subscribers can register at any point — before OR
// after the socket connects. A durable registry re-attaches every
// registered handler each time a fresh socket comes up (login,
// reconnect, restore). The old shape (`sock?.on(...)` at register
// time) silently dropped subscriptions if the socket wasn't yet up.

import { io, type Socket } from "socket.io-client";
import type { Envelope } from "./api.js";

let sock: Socket | null = null;

type EnvelopeCb = (env: Envelope) => void;
type TypingCb = (info: { from: string; groupId?: string }) => void;
type ReadCb = (info: { id: string; at: number; by: string }) => void;
type PresenceCb = (info: { userId: string; online: boolean; at: number }) => void;
type ConnectedCb = () => void;

const onMessageCbs = new Set<EnvelopeCb>();
const onTypingCbs = new Set<TypingCb>();
const onReadCbs = new Set<ReadCb>();
const onPresenceCbs = new Set<PresenceCb>();
// Fires on every successful (re)connect. Subscribers use this to
// re-drain the inbox — any messages the server queued while the
// socket was down get pulled the instant we're back.
const onConnectedCbs = new Set<ConnectedCb>();

function fanout<T>(cbs: Set<(v: T) => void>, v: T) {
  for (const cb of cbs) {
    try { cb(v); } catch (e) { console.warn("[socket] listener threw:", e); }
  }
}

function wireListeners(s: Socket) {
  s.on("message",  (env: Envelope) => fanout(onMessageCbs, env));
  s.on("typing",   (info: Parameters<TypingCb>[0]) => fanout(onTypingCbs, info));
  s.on("read",     (info: Parameters<ReadCb>[0]) => fanout(onReadCbs, info));
  s.on("presence", (info: Parameters<PresenceCb>[0]) => fanout(onPresenceCbs, info));
  s.on("connect_error", (e) => console.warn("[socket] connect_error:", e.message));
  s.on("disconnect", (reason) => console.log("[socket] disconnected:", reason));
  s.on("connect", () => {
    console.log("[socket] connected");
    for (const cb of onConnectedCbs) {
      try { cb(); } catch (e) { console.warn("[socket] connect listener threw:", e); }
    }
  });
}

export function connectSocket(token: string): Socket {
  disconnectSocket();
  const url = import.meta.env.DEV
    ? "http://localhost:8787"
    : ((import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? location.origin);
  sock = io(url, {
    auth: { token },
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 8000,
  });
  wireListeners(sock);
  return sock;
}

export function disconnectSocket() { sock?.disconnect(); sock = null; }
export function socket(): Socket | null { return sock; }

// Subscribers can register at any time — even before connectSocket
// runs. If a socket later comes up, they'll receive events; if the
// socket restarts (reconnect), they stay wired.
export function onMessage(cb: EnvelopeCb): () => void {
  onMessageCbs.add(cb); return () => { onMessageCbs.delete(cb); };
}
export function onTyping(cb: TypingCb): () => void {
  onTypingCbs.add(cb); return () => { onTypingCbs.delete(cb); };
}
export function onRead(cb: ReadCb): () => void {
  onReadCbs.add(cb); return () => { onReadCbs.delete(cb); };
}
export function onPresence(cb: PresenceCb): () => void {
  onPresenceCbs.add(cb); return () => { onPresenceCbs.delete(cb); };
}
export function onConnected(cb: ConnectedCb): () => void {
  onConnectedCbs.add(cb); return () => { onConnectedCbs.delete(cb); };
}

export function sendCipher(
  recipientId: string,
  ciphertext: string,
  groupId?: string,
): Promise<{ ok: true; envelope: Envelope } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    if (!sock) return resolve({ ok: false, error: "not_connected" });
    sock.emit("send", { recipientId, ciphertext, groupId }, resolve);
  });
}

export function emitTyping(opts: { recipientId?: string; groupId?: string }) {
  sock?.emit("typing", opts);
}
