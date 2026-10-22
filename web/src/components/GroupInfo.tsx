// Group info and administration.
//
// Mounted on the hook Chat.tsx has always declared and nothing ever
// passed: tapping a group's header. Everything here is permission-gated
// by the role the relay reports, and the relay enforces the same rules
// again — the buttons hide what you cannot do, they do not decide it.

import { useCallback, useEffect, useState } from "react";
import { Avatar, Button, Icon, Modal, toast } from "./ui.js";
import { api, siteUrl, type GroupDetail, type GroupMember } from "../lib/api.js";
import { getContact } from "../lib/store.js";
import { currentSession, ensureContact } from "../lib/session.js";
import { shareInvite } from "../lib/contacts-integration.js";

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
          <div className="small" style={{ marginBottom: 14 }}>
            {detail.members?.length ?? 0} members
            {detail.settings?.description ? ` · ${detail.settings.description}` : ""}
          </div>

          {isAdmin && <Settings detail={detail} busy={busy} act={act} groupId={groupId} />}

          {requests.length > 0 && (
            <Section title="REQUESTS TO JOIN">
              {requests.map((r) => (
                <Row key={r.userId} name={names[r.userId] ?? r.userId.slice(0, 6)} sub="wants to join">
                  <Button size="small" variant="primary" disabled={busy}
                    onClick={() => act(() => api.groupResolveRequest(groupId, r.userId, true), "Approved")}>
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

          <Section title="MEMBERS">
            {(detail.members ?? []).map((m) => (
              <MemberRow
                key={m.id} m={m} name={names[m.id] ?? m.id.slice(0, 6)}
                isMe={m.id === me} isAdmin={!!isAdmin} isOwner={!!isOwner} busy={busy}
                onPromote={() => act(() => api.groupSetRole(groupId, m.id, m.role === "admin" ? "member" : "admin"), "Role updated")}
                onMute={() => act(() => api.groupMute(groupId, m.id, m.mutedUntil ? 0 : 60), m.mutedUntil ? "Unmuted" : "Muted for an hour")}
                onRemove={() => act(() => api.groupRemoveMember(groupId, m.id), "Removed")}
                onBan={() => act(() => api.groupBan(groupId, m.id), "Removed and banned")}
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
      <div className="small" style={{ marginTop: 6, lineHeight: 1.5 }}>
        New members see messages from the moment they join. Older messages
        were encrypted to the people who were here then, so they cannot be
        handed over by the relay.
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
