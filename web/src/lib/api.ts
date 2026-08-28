// HTTP surface for the relay.

export type PublicUser = {
  id: string;
  email: string;
  phone: string | null;
  displayName: string;
  handle: string;
  publicKey: string;
  presence?: { online: boolean; lastSeenAt: number | null };
};

export type Envelope = {
  id: string;
  senderId: string;
  recipientId: string;
  groupId: string | null;
  ciphertext: string;
  createdAt: number;
};

export type GroupApi = {
  id: string;
  name: string;
  created_by: string;
  created_at: number;
  memberIds: string[];
};

export type MeApi = PublicUser & {
  settings: { readReceipts: boolean; presence: boolean };
};

// Absolute base URL for the relay. In the web deploy the SPA and the
// relay share an origin, so relative paths ("/api/...") are correct
// and API_BASE stays empty. In a Capacitor APK the WebView's origin is
// `https://localhost` — relative paths would resolve to the local
// asset shell, so we prefix them with VITE_API_URL.
export const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
export function apiUrl(path: string): string {
  return API_BASE + path;
}

// Publicly shareable URL for invite links, QR codes, deep links, etc.
// - Web deploy: same as location.origin.
// - APK: location.origin is "https://localhost" (useless for sharing),
//   so we use the Railway base URL. Since our single-origin deploy
//   serves the SPA and the API together, the API base *is* the public
//   site URL.
export function siteUrl(path: string): string {
  const base = API_BASE || location.origin;
  return base + path;
}

let TOKEN: string | null = null;
export function setToken(t: string | null) {
  TOKEN = t;
  if (t) localStorage.setItem("aegent.token", t);
  else localStorage.removeItem("aegent.token");
}
export function loadToken(): string | null {
  if (!TOKEN) TOKEN = localStorage.getItem("aegent.token");
  return TOKEN;
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof Uint8Array) && !(init.body instanceof Blob)) {
    headers.set("content-type", "application/json");
  }
  const t = loadToken();
  if (t) headers.set("authorization", `Bearer ${t}`);
  const r = await fetch(apiUrl(path), { ...init, headers });
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const body = await r.json();
      msg = body.message || body.error || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export const api = {
  register: (body: {
    email: string; phone?: string; displayName: string; password: string;
    publicKey: string; wrappedPriv: string; kdfSalt: string;
  }) => req<{ user: PublicUser; token: string; handle: string }>("/api/register", {
    method: "POST", body: JSON.stringify(body),
  }),
  setPhone: (phone: string | null) => req<{ ok: true }>("/api/me/phone", {
    method: "PUT", body: JSON.stringify({ phone }),
  }),
  byPhone: (phone: string) => req<PublicUser>(`/api/users/by-phone/${encodeURIComponent(phone)}`),
  lookupPhones: (phones: string[]) => req<PublicUser[]>("/api/users/lookup-phones", {
    method: "POST", body: JSON.stringify({ phones }),
  }),
  login: (body: { email: string; password: string }) =>
    req<{ user: PublicUser; token: string; wrappedPriv: string; kdfSalt: string }>(
      "/api/login", { method: "POST", body: JSON.stringify(body) },
    ),
  me: () => req<MeApi>("/api/me"),
  updateSettings: (patch: { readReceipts?: boolean; presence?: boolean }) =>
    req<{ ok: true }>("/api/me/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  search: (q: string) => req<PublicUser[]>(`/api/users/search?q=${encodeURIComponent(q)}`),
  byEmail: (email: string) => req<PublicUser>(`/api/users/by-email/${encodeURIComponent(email)}`),
  byHandle: (handle: string) => req<PublicUser>(`/api/users/by-handle/${encodeURIComponent(handle.replace(/^@/, ""))}`),
  byId: (id: string) => req<PublicUser>(`/api/users/${id}`),

  createGroup: (name: string, memberIds: string[]) =>
    req<GroupApi>("/api/groups", { method: "POST", body: JSON.stringify({ name, memberIds }) }),
  listGroups: () => req<GroupApi[]>("/api/groups"),
  getGroup: (id: string) => req<GroupApi>(`/api/groups/${id}`),
  joinGroup: (id: string) => req<GroupApi>(`/api/groups/${id}/join`, { method: "POST" }),

  inbox: (opts: { all?: boolean; since?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.all) q.set("all", "true");
    if (opts.since) q.set("since", String(opts.since));
    const qs = q.toString();
    return req<Envelope[]>(`/api/inbox${qs ? `?${qs}` : ""}`);
  },
  ack: (ids: string[]) => req<{ ok: true }>("/api/ack", {
    method: "POST", body: JSON.stringify({ ids }),
  }),
  markRead: (ids: string[]) => req<{ ok: true; sent: number }>("/api/read", {
    method: "POST", body: JSON.stringify({ ids }),
  }),
  backupMeta: () => req<{ size: number; createdAt: number }>("/api/backup/meta"),

  // XHR-based so we can report real upload progress to the caller.
  // `fetch` has no upload-progress API in the WebView environment we
  // ship in. onProgress is called with a 0..1 fraction (or -1 during
  // the pre-flight body-preparation step, which is instantaneous).
  uploadBlob: (bytes: Uint8Array, mime: string, onProgress?: (fraction: number) => void):
    Promise<{ id: string; size: number }> => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl("/api/blobs"), true);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-mime", mime);
    const t = loadToken();
    if (t) xhr.setRequestHeader("authorization", `Bearer ${t}`);
    // Progress events on the upload stream — total is bytes queued
    // (roughly equal to bytes.byteLength once the platform has
    // consumed the body). `lengthComputable` is true for our
    // origin.
    xhr.upload.onprogress = (e) => {
      if (!onProgress) return;
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.upload.onloadstart = () => onProgress?.(0);
    xhr.upload.onload = () => onProgress?.(1);
    xhr.onerror = () => reject(new Error("network"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.onabort = () => reject(new Error("aborted"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch (e) { reject(new Error(`parse ${(e as Error).message}`)); }
      } else {
        reject(new Error(`upload ${xhr.status}`));
      }
    };
    xhr.timeout = 120_000; // 2 min hard cap for the whole upload
    xhr.send(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  }),
  downloadBlob: async (id: string): Promise<Uint8Array> => {
    const t = loadToken();
    const r = await fetch(apiUrl(`/api/blobs/${id}`), {
      headers: t ? { authorization: `Bearer ${t}` } : {},
    });
    if (!r.ok) throw new Error(`download ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  },
};
