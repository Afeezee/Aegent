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

export type GroupRole = "owner" | "admin" | "member";
export type GroupMember = {
  id: string; role: GroupRole; joinedAt: number; mutedUntil: number | null;
};
export type GroupSettings = {
  description: string | null;
  joinMode: "closed" | "invite" | "request";
  postPolicy: "all" | "admins";
  historyPolicy: "none" | "all";
  agentPolicy: "off" | "members";
};
export type GroupDetail = GroupApi & {
  members?: GroupMember[];
  settings?: GroupSettings;
  myRole?: GroupRole;
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
let REFRESH: string | null = null;
export function setToken(t: string | null) {
  TOKEN = t;
  if (t) localStorage.setItem("aegent.token", t);
  else localStorage.removeItem("aegent.token");
}
export function setRefreshToken(t: string | null) {
  REFRESH = t;
  if (t) localStorage.setItem("aegent.refresh", t);
  else localStorage.removeItem("aegent.refresh");
}
export function loadToken(): string | null {
  if (!TOKEN) TOKEN = localStorage.getItem("aegent.token");
  return TOKEN;
}
export function loadRefreshToken(): string | null {
  if (!REFRESH) REFRESH = localStorage.getItem("aegent.refresh");
  return REFRESH;
}

// Single-flight refresh. If several requests see a 401 at once, they
// all await the same /api/refresh call rather than firing N of them
// (which would also trip reuse detection if the second call ran
// before the first rotated the token out).
let refreshInFlight: Promise<boolean> | null = null;
async function attemptRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const rt = loadRefreshToken();
  if (!rt) return false;
  refreshInFlight = (async () => {
    try {
      const r = await fetch(apiUrl("/api/refresh"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!r.ok) {
        // 400/401 on refresh = session genuinely dead (expired, reused,
        // revoked). Clear tokens so the next boot shows the auth
        // screen cleanly. Only a *flaky connection* keeps us signed
        // in — not a server reject.
        if (r.status === 400 || r.status === 401) {
          setToken(null); setRefreshToken(null);
        }
        return false;
      }
      const body = await r.json() as { token: string; refreshToken: string };
      setToken(body.token); setRefreshToken(body.refreshToken);
      return true;
    } catch { return false; }
    finally { refreshInFlight = null; }
  })();
  return refreshInFlight;
}

async function req<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof Uint8Array) && !(init.body instanceof Blob)) {
    headers.set("content-type", "application/json");
  }
  const t = loadToken();
  if (t) headers.set("authorization", `Bearer ${t}`);
  const r = await fetch(apiUrl(path), { ...init, headers });
  if (r.status === 401 && !retried && path !== "/api/refresh") {
    // Try to refresh and retry once. If the refresh succeeds, the
    // retry picks up the new access token automatically.
    const ok = await attemptRefresh();
    if (ok) return req<T>(path, init, true);
  }
  if (!r.ok) {
    // Prefer a human-readable message if the server sent one; fall back
    // to the error code; last resort is the status. Everything is
    // String()-coerced so a non-string field (e.g. an object someone
    // forgot to serialize) never ends up printed verbatim as a JSON
    // blob in the auth error box.
    let msg = `${r.status}`;
    try {
      const body = await r.json();
      if (typeof body?.message === "string") msg = body.message;
      else if (typeof body?.error === "string") msg = body.error;
    } catch { /* non-JSON body — keep the status */ }
    throw new Error(String(msg));
  }
  return r.json() as Promise<T>;
}

export type InboxPage = {
  envelopes: Envelope[];
  more: boolean;
  cursor: { since: number; afterId: string } | null;
};

// A relay from before paging existed answers with a bare array. Accept
// both shapes so a client that outlives a deploy (or an APK pointed at
// an older relay) still drains instead of failing on `page.envelopes`.
function diaryQuery(opts: { since?: number; afterId?: string; limit?: number }): string {
  const q = new URLSearchParams();
  if (opts.since) q.set("since", String(opts.since));
  if (opts.afterId) q.set("afterId", opts.afterId);
  if (opts.limit) q.set("limit", String(opts.limit));
  const s = q.toString();
  return s ? `?${s}` : "";
}

function normalizeInbox(r: InboxPage | Envelope[]): InboxPage {
  const page: InboxPage = Array.isArray(r)
    ? { envelopes: r, more: false, cursor: null }
    : r;
  // A relay on Postgres may hand back BIGINT timestamps as strings.
  // They end up as IndexedDB keys, where a string sorts outside every
  // numeric range — so coerce here, once, for every caller.
  return {
    ...page,
    envelopes: page.envelopes.map((e) => ({ ...e, createdAt: Number(e.createdAt) || 0 })),
    cursor: page.cursor
      ? { since: Number(page.cursor.since) || 0, afterId: page.cursor.afterId }
      : null,
  };
}

export type InboxStats = {
  total: number;
  newestAt: number | null;
  oldestAt: number | null;
};

// A diary entry as the relay serves it: the sealed body plus our own
// grant. The key arrives wrapped to us and is useless to anyone else,
// including the relay that stored it.
export type DiaryEntryApi = {
  id: string;
  authorId: string;
  dayKey: string;
  tzOffsetMin: number;
  seq: number;
  kind: "text" | "media";
  bodyCt: string;
  wrappedKey: string;
  createdAt: number;
  expiresAt: number | null;   // null = our own entry, kept forever
  seenAt: number | null;
};

export type DiaryPage = {
  entries: DiaryEntryApi[];
  // The relay's clock. The client measures expiry against this rather
  // than its own, so a device whose clock moved backwards cannot
  // resurrect entries it should have dropped.
  serverNow: number;
  more: boolean;
  cursor: { since: number; afterId: string } | null;
};

export type RecoveryChallenge = {
  challengeId: string;
  serverPublicKey: string;
  boxed: string;
  wrappedPrivRec: string;
  recSalt: string;
  publicKey: string;
};

export const api = {
  register: (body: {
    email: string; phone?: string; displayName: string; password: string;
    publicKey: string; wrappedPriv: string; kdfSalt: string;
    wrappedPrivRec?: string; recSalt?: string;
    deviceLabel?: string;
  }) => req<{ user: PublicUser; token: string; refreshToken: string; handle: string }>(
    "/api/register", { method: "POST", body: JSON.stringify(body) },
  ),
  setPhone: (phone: string | null) => req<{ ok: true }>("/api/me/phone", {
    method: "PUT", body: JSON.stringify({ phone }),
  }),
  byPhone: (phone: string) => req<PublicUser>(`/api/users/by-phone/${encodeURIComponent(phone)}`),
  lookupPhones: (phones: string[]) => req<PublicUser[]>("/api/users/lookup-phones", {
    method: "POST", body: JSON.stringify({ phones }),
  }),
  login: (body: { email: string; password: string; deviceLabel?: string }) =>
    req<{
      user: PublicUser; token: string; refreshToken: string;
      wrappedPriv: string; kdfSalt: string; hasRecoveryKey?: boolean;
    }>("/api/login", { method: "POST", body: JSON.stringify(body) }),

  // ---- key vault / recovery ----
  recoveryStatus: () => req<{ enabled: boolean }>("/api/me/recovery"),
  putRecovery: (body: { wrappedPrivRec: string; recSalt: string }) =>
    req<{ ok: true }>("/api/me/recovery", { method: "PUT", body: JSON.stringify(body) }),
  changePassword: (body: {
    currentPassword: string; newPassword: string;
    wrappedPriv: string; kdfSalt: string;
  }) => req<{ ok: true }>("/api/password/change", { method: "POST", body: JSON.stringify(body) }),
  recoveryChallenge: (email: string) => req<RecoveryChallenge>(
    "/api/recovery/challenge", { method: "POST", body: JSON.stringify({ email }) },
  ),
  resetPassword: (body: {
    challengeId: string; proof: string; newPassword: string;
    wrappedPriv: string; kdfSalt: string; deviceLabel?: string;
  }) => req<{ user: PublicUser; token: string; refreshToken: string }>(
    "/api/password/reset", { method: "POST", body: JSON.stringify(body) },
  ),
  listSessions: () => req<Array<{
    id: string; deviceLabel: string | null; createdAt: number; lastUsedAt: number | null;
  }>>("/api/sessions"),
  revokeOtherSessions: (keepRefresh: string) => req<{ revoked: number }>(
    "/api/sessions/revoke-others",
    { method: "POST", body: JSON.stringify({ keepRefresh }) },
  ),
  revokeSession: (id: string) => req<{ ok: true }>(
    `/api/sessions/${encodeURIComponent(id)}/revoke`, { method: "POST" },
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
  listGroups: () => req<GroupDetail[]>("/api/groups"),
  getGroup: (id: string) => req<GroupDetail>(`/api/groups/${id}`),
  updateGroup: (id: string, patch: Partial<GroupSettings> & { name?: string }) =>
    req<{ ok: true; settings: GroupSettings }>(`/api/groups/${id}`, {
      method: "PATCH", body: JSON.stringify(patch),
    }),
  groupAddMember: (id: string, userId: string) => req<{ ok: true; memberIds: string[] }>(
    `/api/groups/${id}/members`, { method: "POST", body: JSON.stringify({ userId }) },
  ),
  groupRemoveMember: (id: string, userId: string) => req<{ ok: true }>(
    `/api/groups/${id}/members/${encodeURIComponent(userId)}`, { method: "DELETE" },
  ),
  groupSetRole: (id: string, userId: string, role: "admin" | "member") => req<{ ok: true }>(
    `/api/groups/${id}/members/${encodeURIComponent(userId)}/role`,
    { method: "POST", body: JSON.stringify({ role }) },
  ),
  groupMute: (id: string, userId: string, minutes: number) => req<{ ok: true }>(
    `/api/groups/${id}/members/${encodeURIComponent(userId)}/mute`,
    { method: "POST", body: JSON.stringify({ minutes }) },
  ),
  groupBan: (id: string, userId: string) => req<{ ok: true }>(
    `/api/groups/${id}/ban/${encodeURIComponent(userId)}`, { method: "POST" },
  ),
  groupCreateInvite: (id: string, opts: { expiresInMinutes?: number; maxUses?: number }) =>
    req<{ token: string; id: string }>(`/api/groups/${id}/invites`, {
      method: "POST", body: JSON.stringify(opts),
    }),
  groupRedeemInvite: (token: string) => req<{
    state: "joined" | "requested"; group: { id: string; name: string; memberIds?: string[] };
  }>("/api/groups/join", { method: "POST", body: JSON.stringify({ token }) }),
  groupEpochs: (id: string) => req<{ current: number; mine: number[] }>(`/api/groups/${id}/epochs`),
  groupEpochKeys: (id: string) => req<{
    keys: Array<{ epoch: number; wrappedKey: string; grantedBy: string }>;
  }>(`/api/groups/${id}/epochs/keys`),
  groupGrantEpochKeys: (id: string, grants: Array<{ memberId: string; epoch: number; wrappedKey: string }>) =>
    req<{ ok: true }>(`/api/groups/${id}/epochs/grant`, { method: "POST", body: JSON.stringify({ grants }) }),
  groupRotateEpoch: (id: string, grants: Array<{ memberId: string; wrappedKey: string }>) =>
    req<{ epoch: number }>(`/api/groups/${id}/epochs/rotate`, { method: "POST", body: JSON.stringify({ grants }) }),
  groupArchivePut: (id: string, body: { epoch: number; msgId: string; ciphertext: string; createdAt: number }) =>
    req<{ ok: true }>(`/api/groups/${id}/archive`, { method: "POST", body: JSON.stringify(body) }),
  groupArchive: (id: string, opts: { since?: number; afterId?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.since) q.set("since", String(opts.since));
    if (opts.afterId) q.set("afterId", opts.afterId);
    if (opts.limit) q.set("limit", String(opts.limit));
    const s = q.toString();
    return req<{
      messages: Array<{ id: string; epoch: number; senderId: string; msgId: string; ciphertext: string; createdAt: number }>;
      more: boolean; cursor: { since: number; afterId: string } | null;
    }>(`/api/groups/${id}/archive${s ? `?${s}` : ""}`);
  },
  groupRequests: (id: string) => req<Array<{ userId: string; requestedAt: number }>>(
    `/api/groups/${id}/requests`,
  ),
  groupResolveRequest: (id: string, userId: string, approve: boolean) => req<{ ok: true }>(
    `/api/groups/${id}/requests/${encodeURIComponent(userId)}`,
    { method: "POST", body: JSON.stringify({ approve }) },
  ),
  joinGroup: (id: string) => req<GroupApi>(`/api/groups/${id}/join`, { method: "POST" }),

  // One page of the drain. The server pages by the (createdAt, id)
  // keyset so `cursor` can be fed straight back in to continue.
  inbox: (opts: {
    all?: boolean; since?: number; afterId?: string; limit?: number;
  } = {}) => {
    const q = new URLSearchParams();
    if (opts.all) q.set("all", "true");
    if (opts.since) q.set("since", String(opts.since));
    if (opts.afterId) q.set("afterId", opts.afterId);
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return req<InboxPage | Envelope[]>(`/api/inbox${qs ? `?${qs}` : ""}`).then(normalizeInbox);
  },
  inboxStats: () => req<InboxStats>("/api/inbox/stats"),

  // ---- push ----
  pushRegister: (token: string, platform: string) => req<{ ok: true; enabled: boolean }>(
    "/api/push/register", { method: "POST", body: JSON.stringify({ token, platform }) },
  ),
  pushUnregister: (token: string) => req<{ ok: true }>(
    "/api/push/unregister", { method: "POST", body: JSON.stringify({ token }) },
  ),

  // ---- diary ----
  diaryPublish: (body: {
    id: string; dayKey: string; tzOffsetMin: number; seq: number;
    kind: "text" | "media"; createdAt: number; bodyCt: string; authorKey: string;
    grants: Array<{ viewerId: string; wrappedKey: string }>; blobIds: string[];
  }) => req<{ id: string; createdAt: number; expiresAt: number }>(
    "/api/diary/entries", { method: "POST", body: JSON.stringify(body) },
  ),
  diaryFeed: (opts: { since?: number; afterId?: string; limit?: number } = {}) =>
    req<DiaryPage>(`/api/diary/feed${diaryQuery(opts)}`),
  diaryMine: (opts: { since?: number; afterId?: string; limit?: number } = {}) =>
    req<DiaryPage>(`/api/diary/mine${diaryQuery(opts)}`),
  diarySeen: (entryIds: string[]) => req<{ ok: true }>("/api/diary/seen", {
    method: "POST", body: JSON.stringify({ entryIds }),
  }),
  diaryViews: (entryId: string) => req<{ count: number; viewers: Array<{ id: string; seenAt: number }> }>(
    `/api/diary/entries/${encodeURIComponent(entryId)}/views`,
  ),
  diaryGrants: (entryId: string, body: {
    add: Array<{ viewerId: string; wrappedKey: string }>; remove: string[];
  }) => req<{ ok: true }>(`/api/diary/entries/${encodeURIComponent(entryId)}/grants`, {
    method: "PATCH", body: JSON.stringify(body),
  }),
  diaryDelete: (entryId: string) => req<{ ok: true }>(
    `/api/diary/entries/${encodeURIComponent(entryId)}`, { method: "DELETE" },
  ),
  diaryEdit: (entryId: string, body: { bodyCt: string; kind?: "text" | "media" }) =>
    req<{ ok: true }>(`/api/diary/entries/${encodeURIComponent(entryId)}`, {
      method: "PATCH", body: JSON.stringify(body),
    }),
  // Exact reconciliation pair: every envelope id the relay holds for us,
  // and retrieval of specific envelopes by id.
  inboxIds: () => req<{ ids: string[]; truncated: boolean }>("/api/inbox/ids"),
  inboxFetch: (ids: string[]) => req<{ envelopes: Envelope[] }>("/api/inbox/fetch", {
    method: "POST", body: JSON.stringify({ ids }),
  }).then((r) => ({
    envelopes: r.envelopes.map((e) => ({ ...e, createdAt: Number(e.createdAt) || 0 })),
  })),
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
