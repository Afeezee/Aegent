// Live-relay socket wrapper. Carries only ciphertext and routing
// metadata; decryption is exclusively on the callers.

import { io, type Socket } from "socket.io-client";
import type { Envelope } from "./api.js";

let sock: Socket | null = null;

export function connectSocket(token: string): Socket {
  disconnectSocket();
  // In dev the server runs on 8787; in prod, same origin.
  const url = import.meta.env.DEV ? "http://localhost:8787" : location.origin;
  sock = io(url, { auth: { token }, transports: ["websocket", "polling"] });
  return sock;
}

export function disconnectSocket() { sock?.disconnect(); sock = null; }
export function socket(): Socket | null { return sock; }

export function onMessage(cb: (envelope: Envelope) => void): () => void {
  sock?.on("message", cb); return () => { sock?.off("message", cb); };
}
export function onTyping(cb: (info: { from: string; groupId?: string }) => void): () => void {
  sock?.on("typing", cb); return () => { sock?.off("typing", cb); };
}
export function onRead(cb: (info: { id: string; at: number; by: string }) => void): () => void {
  sock?.on("read", cb); return () => { sock?.off("read", cb); };
}
export function onPresence(cb: (info: { userId: string; online: boolean; at: number }) => void): () => void {
  sock?.on("presence", cb); return () => { sock?.off("presence", cb); };
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
