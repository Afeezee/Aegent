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
  const r = await fetch(path, { ...init, headers });
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

  inbox: () => req<Envelope[]>("/api/inbox"),
  ack: (ids: string[]) => req<{ ok: true }>("/api/ack", {
    method: "POST", body: JSON.stringify({ ids }),
  }),
  markRead: (ids: string[]) => req<{ ok: true; sent: number }>("/api/read", {
    method: "POST", body: JSON.stringify({ ids }),
  }),

  uploadBlob: async (bytes: Uint8Array, mime: string): Promise<{ id: string; size: number }> => {
    const headers = new Headers();
    headers.set("content-type", "application/octet-stream");
    headers.set("x-mime", mime);
    const t = loadToken();
    if (t) headers.set("authorization", `Bearer ${t}`);
    // Blob constructor's typing narrows to ArrayBuffer; a plain Uint8Array
    // is fine at runtime but TS 5+ objects to the SharedArrayBuffer overlap.
    const r = await fetch("/api/blobs", {
      method: "POST",
      body: new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
      headers,
    });
    if (!r.ok) throw new Error(`upload ${r.status}`);
    return r.json();
  },
  downloadBlob: async (id: string): Promise<Uint8Array> => {
    const t = loadToken();
    const r = await fetch(`/api/blobs/${id}`, {
      headers: t ? { authorization: `Bearer ${t}` } : {},
    });
    if (!r.ok) throw new Error(`download ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  },
};
