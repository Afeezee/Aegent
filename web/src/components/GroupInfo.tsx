// Group info and administration.
//
// Mounted on the hook Chat.tsx has always declared and nothing ever
// passed: tapping a group's header. Everything here is permission-gated
// by the role the relay reports, and the relay enforces the same rules
// again — the buttons hide what you cannot do, they do not decide it.

import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar, Button, Icon, Modal, toast } from "./ui.js";
import { api, siteUrl, type GroupDetail, type GroupMember } from "../lib/api.js";
import { getContact, listContacts, type ContactRow } from "../lib/store.js";
import { currentSession, ensureContact } from "../lib/session.js";
import { shareInvite } from "../lib/contacts-integration.js";
import { grantHistoryTo, rotateAfterDeparture } from "../lib/groupkeys.js";

export function GroupInfo({
  open, groupId, onClose, onChanged,
}: {
  open: boolean;
  groupId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const me = currentSession()?.user.id;
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [requests, setRequests] = useState<Array<{ userId: string; requestedAt: number }>>([]);
  const [adding, setAdding] = useState(false);
  const [candidates, setCandidates] = useState<ContactRow[]>([]);

  const load = useCallback(async () => {
    if (!groupId) return;
    try {
      const d = await api.getGroup(groupId);
      setDetail(d);
      const map: Record<string, string> = {};
      for (const m of d.members ?? []) {
        if (m.id === me) { map[m.id] = "You"; continue; }
        const c = await getContact(m.id) ?? await ensureContact(m.id);
        map[m.id] = c?.displayName ?? "Someone";
      }
      setNames(map);
      if (d.myRole === "owner" || d.myRole === "admin") {
        setRequests(await api.groupRequests(groupId).catch(() => []));
      } else {
        setRequests([]);
      }
    } catch (e) {
      toast(`Couldn't load the group: ${(e as Error).message}`, "error");
    }
  }, [groupId, me]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  if (!open || !groupId) return null;
  const isAdmin = detail?.myRole === "owner" || detail?.myRole === "admin";
  const isOwner = detail?.myRole === "owner";

  async function act(what: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await what();
      if (done) toast(done, "ok");
      await load();
      onChanged();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={detail?.name ?? "Group"} width={520}>
      {!detail ? (
        <div className="small">Loading…</div>
      ) : (
        <>
          <GroupHeader detail={detail} isAdmin={isAdmin} busy={busy} act={act} groupId={groupId} />

          {isAdmin && <Settings detail={detail} busy={busy} act={act} groupId={groupId} />}

          {requests.length > 0 && (
            <Section title="REQUESTS TO JOIN">
              {requests.map((r) => (
                <Row key={r.userId} name={names[r.userId] ?? r.userId.slice(0, 6)} sub="wants to join">
                  <Button size="small" variant="primary" disabled={busy}
                    onClick={() => act(async () => {
                      await api.groupResolveRequest(groupId, r.userId, true);
                      // Only a member device holds the epoch keys, so the
                      // person approving is the one who can hand over
                      // history. If this doesn't run they simply see
                      // nothing older than their arrival.
                      await grantHistoryTo(groupId, r.userId);
                    }, "Approved")}>
                    Approve
                  </Button>
                  <Button size="small" disabled={busy}
                    onClick={() => act(() => api.groupResolveRequest(groupId, r.userId, false))}>
                    Deny
                  </Button>
                </Row>
              ))}
            </Section>
          )}

          {isAdmin && (
            <div style={{ margin: "4px 0 10px" }}>
              <Button size="small" disabled={busy} onClick={async () => {
                if (adding) { setAdding(false); return; }
                // Only contacts who aren't already in the group.
                const here = new Set((detail.members ?? []).map((m) => m.id));
                setCandidates((await listContacts()).filter((c) => !here.has(c.id)));
                setAdding(true);
              }}>
                <Icon.plus /> Add member
              </Button>
              {adding && (
                <div className="glass" style={{ marginTop: 8, padding: 8, borderRadius: 12, maxHeight: 220, overflowY: "auto" }}>
                  {candidates.length === 0 ? (
                    <div className="small" style={{ padding: 6 }}>
                      Everyone in your contacts is already here.
                    </div>
                  ) : candidates.map((c) => (
                    <Row key={c.id} name={c.displayName} sub={`@${c.handle}`}>
                      <Button size="small" variant="primary" disabled={busy}
                        onClick={() => act(async () => {
                          await api.groupAddMember(groupId, c.id);
                          // Hand over whatever history the policy allows,
                          // which only this device can do — the relay holds
                          // no keys. Harmless if the policy is "from join".
                          await grantHistoryTo(groupId, c.id);
                          setAdding(false);
                        }, `Added ${c.displayName}`)}>
                        Add
                      </Button>
                    </Row>
                  ))}
                </div>
              )}
            </div>
          )}

          <Section title="MEMBERS">
            {(detail.members ?? []).map((m) => (
              <MemberRow
                key={m.id} m={m} name={names[m.id] ?? m.id.slice(0, 6)}
                isMe={m.id === me} isAdmin={!!isAdmin} isOwner={!!isOwner} busy={busy}
                onPromote={() => act(() => api.groupSetRole(groupId, m.id, m.role === "admin" ? "member" : "admin"), "Role updated")}
                onMute={() => act(() => api.groupMute(groupId, m.id, m.mutedUntil ? 0 : 60), m.mutedUntil ? "Unmuted" : "Muted for an hour")}
                onRemove={() => act(async () => {
                  await api.groupRemoveMember(groupId, m.id);
                  // New key from here on, so what is said next is sealed
                  // with one they do not hold. What they already read is
                  // theirs — rotation looks forward only.
                  await rotateAfterDeparture(groupId);
                }, "Removed")}
                onBan={() => act(async () => {
                  await api.groupBan(groupId, m.id);
                  await rotateAfterDeparture(groupId);
                }, "Removed and banned")}
              />
            ))}
          </Section>

          <div style={{ display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap" }}>
            {isAdmin && (
              <Button size="small" disabled={busy} onClick={async () => {
                setBusy(true);
                try {
                  const { token } = await api.groupCreateInvite(groupId, {});
                  const url = siteUrl(`/#/g/${encodeURIComponent(token)}`);
                  const how = await shareInvite({
                    url,
                    title: `Join ${detail.name} on Aegent`,
                    text: `You're invited to ${detail.name}.`,
                  });
                  toast(how === "copied" ? "Invite link copied" : "Invite link shared", "ok");
                } catch (e) {
                  toast(`Couldn't create a link: ${(e as Error).message}`, "error");
                } finally { setBusy(false); }
              }}>
                <Icon.link /> Invite link
              </Button>
            )}
            <Button size="small" variant="danger" style={{ marginLeft: "auto" }} disabled={busy}
              onClick={() => {
                if (!window.confirm(isOwner
                  ? "You own this group. Leaving means nobody can administer it. Continue?"
                  : "Leave this group?")) return;
                void act(() => api.groupRemoveMember(groupId, me!), "You left the group").then(onClose);
              }}>
              Leave group
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

// Editable identity block: group avatar, name, description. Admins see
// inline edit controls; everyone else sees the read-only header. This is
// the group page's "own distinguishing factor" — its own picture and
// blurb, not just a name borrowed from the chat list.
function GroupHeader({
  detail, isAdmin, busy, act, groupId,
}: {
  detail: GroupDetail; isAdmin: boolean; busy: boolean;
  act: (what: () => Promise<unknown>, done?: string) => Promise<void>;
  groupId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(detail.name);
  const [desc, setDesc] = useState(detail.settings?.description ?? "");
  const fileRef = useRef<HTMLInputElement>(null);
  const avatar = detail.settings?.avatar ?? null;

  useEffect(() => { setName(detail.name); setDesc(detail.settings?.description ?? ""); }, [detail.name, detail.settings?.description]);

  async function pickAvatar(file: File) {
    try {
      const data = await resizeSquare(file, 256, 0.82);
      await act(() => api.updateGroup(groupId, { avatar: data }), "Photo updated");
    } catch (e) { toast(`Couldn't load image: ${(e as Error).message}`, "error"); }
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ position: "relative" }}>
          <Avatar name={detail.name} group src={avatar} size="xl" />
          {isAdmin && (
            <button onClick={() => fileRef.current?.click()} aria-label="Change group photo" disabled={busy}
              style={{
                all: "unset", cursor: "pointer", position: "absolute", right: -4, bottom: -4,
                width: 30, height: 30, borderRadius: 999, display: "grid", placeItems: "center",
                background: "linear-gradient(135deg, var(--violet), var(--aqua))", color: "#10132a",
              }}><Icon.photo /></button>
          )}
          <input ref={fileRef} type="file" accept="image/*" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) pickAvatar(f); }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80}
              style={{ width: "100%", fontWeight: 700 }} placeholder="Group name" />
          ) : (
            <div style={{ fontWeight: 700, fontSize: 18 }}>{detail.name}</div>
          )}
          <div className="small" style={{ color: "var(--text-dim)" }}>{detail.members?.length ?? 0} members</div>
        </div>
        {isAdmin && !editing && (
          <Button size="small" variant="ghost" onClick={() => setEditing(true)}><Icon.edit /> Edit</Button>
        )}
      </div>

      {editing ? (
        <div style={{ marginTop: 10 }}>
          <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} maxLength={500}
            placeholder="Group description — what's this group about?" style={{ width: "100%" }} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
            <Button size="small" variant="ghost" onClick={() => { setEditing(false); setName(detail.name); setDesc(detail.settings?.description ?? ""); }}>Cancel</Button>
            <Button size="small" variant="primary" disabled={busy || !name.trim()}
              onClick={() => act(async () => {
                await api.updateGroup(groupId, { name: name.trim(), description: desc.trim() || null });
                setEditing(false);
              }, "Group updated")}>Save</Button>
          </div>
        </div>
      ) : (
        detail.settings?.description && (
          <div style={{ marginTop: 10, fontSize: 14, color: "var(--text-dim)", lineHeight: 1.5 }}>
            {detail.settings.description}
          </div>
        )
      )}
    </div>
  );
}

// Centre-crop + resize to a square JPEG data URI (shared shape with the
// profile avatar).
async function resizeSquare(file: File, size: number, quality: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2, sy = (bitmap.height - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas context");
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", quality);
}

function Settings({
  detail, busy, act, groupId,
}: {
  detail: GroupDetail; busy: boolean; groupId: string;
  act: (fn: () => Promise<unknown>, done?: string) => Promise<void>;
}) {
  const s = detail.settings;
  return (
    <Section title="SETTINGS">
      <Choice
        label="Who can send messages" value={s?.postPolicy ?? "all"} disabled={busy}
        options={[["all", "Everyone"], ["admins", "Admins only"]]}
        onChange={(v) => act(() => api.updateGroup(groupId, { postPolicy: v as "all" | "admins" }), "Saved")}
      />
      <Choice
        label="Who can join" value={s?.joinMode ?? "closed"} disabled={busy}
        options={[["closed", "Nobody"], ["invite", "Anyone with a link"], ["request", "Ask an admin"]]}
        onChange={(v) => act(() => api.updateGroup(groupId, { joinMode: v as "closed" | "invite" | "request" }), "Saved")}
      />
      <Choice
        label="What new members can read" value={s?.historyPolicy ?? "none"} disabled={busy}
        options={[["none", "From when they join"], ["all", "Everything"]]}
        onChange={(v) => act(() => api.updateGroup(groupId, { historyPolicy: v as "none" | "all" }), "Saved")}
      />
      <Choice
        label="Assistant" value={s?.agentPolicy ?? "off"} disabled={busy}
        options={[["off", "Off"], ["members", "Members can ask about this group"]]}
        onChange={(v) => act(() => api.updateGroup(groupId, { agentPolicy: v as "off" | "members" }), "Saved")}
      />
      {s?.agentPolicy === "members" && (
        <div className="small" style={{ marginTop: 4, lineHeight: 1.5, color: "var(--warn, var(--text-dim))" }}>
          When someone asks the assistant about this group, excerpts of
          these messages are sent to Anthropic to answer. Everyone here
          should know that. Turning it off stops this app from doing it —
          it cannot stop someone copying out what they can already read.
        </div>
      )}
      <div className="small" style={{ marginTop: 6, lineHeight: 1.5 }}>
        History is handed over as keys by whoever admits someone, so it
        needs a member's device — not the relay, which cannot read any of
        it. If nobody is around to admit them, they still join and simply
        see nothing older than their arrival.
      </div>
    </Section>
  );
}

function MemberRow({
  m, name, isMe, isAdmin, isOwner, busy, onPromote, onMute, onRemove, onBan,
}: {
  m: GroupMember; name: string; isMe: boolean; isAdmin: boolean; isOwner: boolean; busy: boolean;
  onPromote: () => void; onMute: () => void; onRemove: () => void; onBan: () => void;
}) {
  const muted = !!m.mutedUntil && m.mutedUntil > Date.now();
  const canAct = isAdmin && !isMe && m.role !== "owner";
  return (
    <Row
      name={name}
      sub={[m.role !== "member" ? m.role : null, muted ? "muted" : null].filter(Boolean).join(" · ") || undefined}
    >
      {canAct && (
        <>
          {isOwner && (
            <Button size="small" variant="ghost" disabled={busy} onClick={onPromote}>
              {m.role === "admin" ? "Demote" : "Make admin"}
            </Button>
          )}
          <Button size="small" variant="ghost" disabled={busy} onClick={onMute}>
            {muted ? "Unmute" : "Mute"}
          </Button>
          <Button size="small" variant="ghost" disabled={busy} onClick={onRemove}>Remove</Button>
          <Button size="small" variant="danger" disabled={busy} onClick={onBan}>Ban</Button>
        </>
      )}
    </Row>
  );
}

function Row({ name, sub, children }: { name: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 0",
      borderBottom: "1px solid var(--line)", flexWrap: "wrap",
    }}>
      <Avatar name={name} size="sm" />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
        {sub && <div className="small">{sub}</div>}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--text-dim)", letterSpacing: 0.05, marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </section>
  );
}

function Choice({
  label, value, options, onChange, disabled,
}: {
  label: string; value: string; disabled?: boolean;
  options: Array<[string, string]>;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 13, marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {options.map(([v, text]) => (
          <button key={v} type="button" disabled={disabled} onClick={() => onChange(v)}
            style={{
              all: "unset", cursor: disabled ? "default" : "pointer",
              padding: "5px 10px", borderRadius: 999, fontSize: 12.5,
              border: `1px solid ${value === v ? "var(--accent)" : "var(--line)"}`,
              background: value === v ? "rgba(138,125,255,0.18)" : "rgba(255,255,255,0.03)",
              color: value === v ? "var(--text)" : "var(--text-dim)",
            }}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
