// Deep link plumbing.
//
// Supported shapes:
//   aegent://chat/<peerId>/message/<msgId>?group=1   (external, Android intent)
//   https://<host>/#/chat/<peerId>/message/<msgId>   (web, cold or hot)
//   https://<host>/#/i/<handle>                       (invite link, handled in App)
//
// On Android, Capacitor's App.addListener("appUrlOpen") fires every time
// the OS routes an aegent:// URL to the app (cold start included).
// On web, we read location.hash on mount and listen for hashchange.
//
// Rather than hard-coupling to Home.tsx, this module exposes a pub/sub
// so any mount-point can subscribe.

import { App as CapApp } from "@capacitor/app";

export type ChatDeepLink = {
  peerId: string;
  isGroup: boolean;
  msgId?: string;
};

type Listener = (link: ChatDeepLink) => void;
const listeners = new Set<Listener>();

export function onChatDeepLink(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function emit(link: ChatDeepLink): void {
  for (const cb of listeners) {
    try { cb(link); } catch (e) { console.warn("[deeplink] listener threw", e); }
  }
}

// Parse `aegent://chat/<peerId>/message/<msgId>?group=1`
// Also accepts `#/chat/<peerId>/message/<msgId>?group=1` from web hash.
export function parseChatLink(input: string): ChatDeepLink | null {
  try {
    // Strip the scheme/host so we're left with /chat/<peer>/message/<msg>?group=1
    let path = input;
    if (input.startsWith("aegent://")) {
      // aegent://chat/... has an empty "host" slot — use a dummy base.
      const u = new URL(input);
      path = u.pathname;
      const g = u.searchParams.get("group") === "1";
      const m = /^\/?chat\/([^/]+)(?:\/message\/([^/?]+))?$/.exec(path);
      if (!m) return null;
      return { peerId: decodeURIComponent(m[1]), msgId: m[2] ? decodeURIComponent(m[2]) : undefined, isGroup: g };
    }
    const hashMatch = /^#?\/?chat\/([^/]+)(?:\/message\/([^/?]+))?(?:\?(.*))?$/.exec(
      input.replace(/^#/, ""),
    );
    if (!hashMatch) return null;
    const qs = new URLSearchParams(hashMatch[3] ?? "");
    return {
      peerId: decodeURIComponent(hashMatch[1]),
      msgId: hashMatch[2] ? decodeURIComponent(hashMatch[2]) : undefined,
      isGroup: qs.get("group") === "1",
    };
  } catch { return null; }
}

export function buildChatLink(opts: ChatDeepLink): string {
  const base = `aegent://chat/${encodeURIComponent(opts.peerId)}`;
  const tail = opts.msgId ? `/message/${encodeURIComponent(opts.msgId)}` : "";
  const q = opts.isGroup ? "?group=1" : "";
  return base + tail + q;
}

let installed = false;
export function installDeepLinkHandlers(): void {
  if (installed) return;
  installed = true;

  // Web hash — fires on cold start and whenever the URL changes.
  const dispatchHash = () => {
    const h = location.hash || "";
    if (!/^#?\/?chat\//.test(h)) return;
    const link = parseChatLink(h);
    if (link) {
      emit(link);
      // Clear so a navigate-away-and-back doesn't re-fire.
      try { history.replaceState(null, "", location.pathname + location.search); } catch { /* ignore */ }
    }
  };
  dispatchHash();
  window.addEventListener("hashchange", dispatchHash);

  // Android: @capacitor/app routes the intent URL here. On native this
  // fires on cold start too — Capacitor queues the first event until
  // the WebView is ready. On web, addListener is a no-op.
  try {
    CapApp.addListener("appUrlOpen", (ev) => {
      const link = parseChatLink(ev.url);
      if (link) emit(link);
    }).catch(() => { /* ignore on web */ });
  } catch { /* web build */ }
}
