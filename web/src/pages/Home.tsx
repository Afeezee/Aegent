// Main app shell — sidebar, chat, floating agent, and the four
// overlays (compose, search, settings, agent, forward).

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Avatar, Button, ErrorBoundary, Glass, Icon } from "../components/ui.js";
import { NavRail, TabBar, type Dest } from "../components/TabBar.js";
import { Diary } from "./Diary.js";
import { Chat } from "../components/Chat.js";
import { ThreadList } from "../components/ThreadList.js";
import { ComposeOverlay } from "../components/ComposeOverlay.js";
import { GlobalSearch } from "../components/GlobalSearch.js";
import { Settings } from "../components/Settings.js";
import { AgentSheet, pushAgentEvent } from "../components/Agent.js";
import { ForwardSheet } from "../components/ForwardSheet.js";
import { ContactsSheet } from "../components/Contacts.js";
import { GroupInfo } from "../components/GroupInfo.js";
import { Brand } from "./Onboarding.js";
import { api } from "../lib/api.js";
import {
  bumpInboxCursor,
  currentSession, ensureContact, ensureGroup, flushOutbox, ingestEnvelope, pullInbox,
} from "../lib/session.js";
import { onConnected, onDelivered, onMessage, onPresence, onRead } from "../lib/socket.js";
import { onReplication, replicationSummary, type ReplicationState } from "../lib/replication.js";
import { onChatDeepLink } from "../lib/deeplinks.js";
import { WelcomeTour, consumeTourPending } from "../components/WelcomeTour.js";
import { diaryNow } from "../lib/diary.js";
import {
  getContact, listGroups, listThreads, liveDiaryEntries, markDelivered, markRead, setContactPresence,
  takeDueScheduledBackups,
  upsertContact, upsertGroup, type OpenedMessage, type Thread,
} from "../lib/store.js";
import { backup_thread } from "../agent/tools.js";
import { setActiveThread } from "../agent/llm.js";
import { setAgentPolicy } from "../agent/policy.js";
import { toast } from "../components/ui.js";
import { siteUrl } from "../lib/api.js";
import { shareInvite } from "../lib/contacts-integration.js";

export function Home({ onSignedOut }: { onSignedOut: () => void }) {
  const [thread, setThread] = useState<Thread | null>(null);
  // Whenever the visible thread changes, tell the agent so its
  // per-turn "current context" section names it — that's what lets
  // the LLM treat "reply to him" as unambiguous when a chat is open.
  useEffect(() => {
    setActiveThread(thread
      ? { peerId: thread.peerId, label: thread.title, isGroup: thread.isGroup }
      : null);
  }, [thread]);
  const [refresh, setRefresh] = useState(0);
  const [compose, setCompose] = useState(false);
  const [search, setSearch] = useState(false);
  const [settings, setSettings] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [forwardMsg, setForwardMsg] = useState<OpenedMessage | null>(null);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [groupInfoFor, setGroupInfoFor] = useState<string | null>(null);
  // Agent-driven "jump to message" target. Chat consumes highlight.msgId
  // when thread.peerId === highlight.peerId. We keep peerId in the
  // target so an open-another-chat-later doesn't accidentally re-pulse
  // the previous match. Cleared ~2.5s after it's set so re-entering the
  // same chat later doesn't re-pulse an old match.
  // Welcome tour: fires once per account after signup. consumeTourPending
  // atomically reads and clears the "aegent.pending-tour" flag set by
  // Auth.tsx on successful register(). Returning users (login) never
  // trigger this.
  const [tourOpen, setTourOpen] = useState<boolean>(() => consumeTourPending());
  // When Composer intercepts "/agent …" we open the agent sheet with
  // this query pre-populated and auto-fired. One-shot, cleared by
  // AgentSheet after it consumes the query.
  const [pendingAgentQuery, setPendingAgentQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<{ peerId: string; msgId: string } | null>(null);
  // True when the current thread was opened by the agent — enables the
  // "Back to agent" pill in Chat. Clears when the user navigates away
  // (thread change) or taps the pill.
  const [cameFromAgent, setCameFromAgent] = useState(false);
  useEffect(() => {
    if (!highlight) return;
    const t = window.setTimeout(() => setHighlight(null), 2500);
    return () => window.clearTimeout(t);
  }, [highlight]);
  useEffect(() => { setCameFromAgent(false); }, [thread?.peerId]);

  const me = currentSession()?.user;

  // Unseen entries from other people — the dot on the Diary tab, and
  // the cheapest reason to come back to the app.
  const [diaryUnread, setDiaryUnread] = useState(0);

  // Which top-level destination is showing. Chats and Groups share one
  // list (groups already flow through listThreads) and differ only by
  // filter; Diary is its own surface.
  const [dest, setDest] = useState<Dest>("chats");

  useEffect(() => {
    (async () => {
      try {
        const meId = currentSession()?.user.id;
        const rows = await liveDiaryEntries(diaryNow());
        setDiaryUnread(rows.filter((e) => e.authorId !== meId && !e.seenAt).length);
      } catch { setDiaryUnread(0); }
    })();
  }, [refresh]);

  // Replication status. Two jobs: tell the user their history is safe
  // (or on its way), and re-render the thread list as restored messages
  // land, so a new device fills in front of them without a tap.
  const [rep, setRep] = useState<ReplicationState | null>(null);
  useEffect(() => onReplication((s) => {
    setRep((prev) => {
      if (prev && s.localTotal !== prev.localTotal) setRefresh((k) => k + 1);
      return s;
    });
  }), []);

  // Initial sync: pull known groups + drain inbox.
  //
  // The drain always uses the watermark-scoped pullInbox — no
  // "looksEmpty" guard. That way an existing device with cached
  // threads still re-catches any undelivered/queued messages the
  // server has for us. Zero-loss even if the local Dexie is stale
  // (browser cache clear, app reinstall over old data, WebView
  // migration, etc.). Nothing is trusted from Dexie's presence
  // alone — every boot pulls from the server.
  useEffect(() => {
    (async () => {
      try {
        const gs = await api.listGroups();
        // Groups whose owners have not switched the assistant on are
        // off-limits to it — enforced in the agent's retrieval layer,
        // not merely hidden in its prompt.
        setAgentPolicy({
          scope: { kind: "all" },
          denied: new Set(gs.filter((g) => g.settings?.agentPolicy !== "members").map((g) => g.id)),
          maxRows: 300,
          maxBodyChars: 4000,
        });
        for (const g of gs) {
          await upsertGroup({
            id: g.id, name: g.name, memberIds: g.memberIds,
            createdBy: g.created_by, createdAt: g.created_at, lastSeenAt: g.created_at,
          });
          for (const uid of g.memberIds) await ensureContact(uid);
        }
      } catch { /* ignore */ }
      try { await pullInbox({ reason: "boot" }); }
      catch (err) { console.warn("[boot] pullInbox failed", err); }
      flushOutbox().catch((err) => console.warn("[boot] flushOutbox failed", err));
      setRefresh((k) => k + 1);
    })();
  }, []);

  // Re-drain on window focus / app returning to foreground. Covers
  // the Android "back from another app" and the desktop tab-switch
  // case where a message may have landed while the socket was idle.
  useEffect(() => {
    const onFocus = () => {
      pullInbox().then((r) => { if (r.pulled > 0) setRefresh((k) => k + 1); })
        .catch((err) => console.warn("[focus] pullInbox failed", err));
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) onFocus();
    });
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Re-drain on every successful socket (re)connect. If we were
  // offline while the sender pushed, the server queued for us —
  // this catches those envelopes the instant we come back up,
  // instead of waiting for the next focus/boot.
  useEffect(() => {
    return onConnected(() => {
      pullInbox().then((r) => { if (r.pulled > 0) setRefresh((k) => k + 1); })
        .catch((err) => console.warn("[reconnect] pullInbox failed", err));
      // Anything composed while the socket was down goes out now.
      flushOutbox().then((r) => { if (r.sent > 0) setRefresh((k) => k + 1); })
        .catch((err) => console.warn("[reconnect] flushOutbox failed", err));
    });
  }, []);

  // Live delivery.
  useEffect(() => {
    return onMessage(async (env) => {
      let handled = false;
      try {
        const res = await ingestEnvelope(env);
        handled = !!res;
      } catch (err) {
        // Never silent — a swallowed error here means the user
        // literally can't see incoming messages. Log so USB debugging
        // catches the specific cause.
        console.error("[live] ingest failed for envelope", env.id, err);
      }
      // Advance the drain watermark so the next pullInbox doesn't
      // waste bandwidth re-fetching this envelope.
      bumpInboxCursor(env);
      // Bump refresh EVEN on ingest failure. Any partial state
      // change (e.g. ack landed but decrypt didn't) still deserves
      // a re-read so the UI stays consistent with the store.
      setRefresh((k) => k + 1);
      if (handled && document.hidden && Notification?.permission === "granted") {
        new Notification("Aegent", { body: "New encrypted message" });
      }
    });
  }, []);
  // Presence updates.
  useEffect(() => {
    return onPresence(({ userId, online, at }) => {
      setContactPresence(userId, online, at).then(() => setRefresh((k) => k + 1));
    });
  }, []);
  // Sender's copy: mark read when the peer reports it.
  useEffect(() => {
    return onRead(({ id, at }) => { markRead(id, at).then(() => setRefresh((k) => k + 1)); });
  }, []);
  // Sender's copy: mark delivered when the peer's device acks it. This
  // is what flips the single check to a double check on the sender's
  // bubble — previously nothing ever set deliveredAt sender-side.
  useEffect(() => {
    return onDelivered(({ id, at }) => { markDelivered(id, at).then(() => setRefresh((k) => k + 1)); });
  }, []);

  // Request notification permission once, quietly.
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => { /* ignore */ });
    }
  }, []);

  // Poll for due scheduled backups: on load and every minute after. Each
  // due backup surfaces a confirm card in the Agent panel — we auto-open
  // the panel so the user can't miss it.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      const due = await takeDueScheduledBackups();
      if (cancelled || due.length === 0) return;
      setAgentOpen(true);
      for (const b of due) {
        const r = await backup_thread({
          peerId: b.peerId, recipientEmail: b.recipientEmail, note: b.note,
        });
        if (r.ok && r.kind === "pending") {
          pushAgentEvent({
            kind: "reply",
            text: `Scheduled backup of ${b.peerLabel} is due — I've prepared it. Confirm to send.`,
          });
          pushAgentEvent({ kind: "confirm", action: r.action, explain: r.explain });
        } else if (!r.ok) {
          toast(`Scheduled backup for ${b.peerLabel} failed: ${r.error}`, "error");
        }
      }
    }
    tick();
    const iv = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(iv); };
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") { e.preventDefault(); setSearch(true); }
      else if (meta && e.key.toLowerCase() === "j") { e.preventDefault(); setAgentOpen((s) => !s); }
      else if (meta && e.key.toLowerCase() === "n") { e.preventDefault(); setCompose(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openThread = async (peerId: string, isGroup: boolean) => {
    if (isGroup) {
      await ensureGroup(peerId);
      // Pull whatever of this group's past we hold keys for. Cheap after
      // the first time: the cursor makes it incremental.
      void import("../lib/groupkeys.js")
        .then((m) => m.syncGroupHistory(peerId))
        .then((n) => { if (n > 0) setRefresh((k) => k + 1); })
        .catch(() => { /* history is best-effort */ });
    }
    else await ensureContact(peerId);
    const threads = await listThreads();
    const found = threads.find((t) => t.peerId === peerId) ?? await synthThread(peerId, isGroup);
    setThread(found);
  };

  // "Jump to message" from the agent sheet. Open the chat, record
  // the highlight target so Chat scrolls to it on load. `fromAgent`
  // marks that the user got here via the agent — the chat then
  // renders a "Back to agent" pill.
  const openMessage = async (peerId: string, isGroup: boolean, msgId: string, fromAgent = true) => {
    await openThread(peerId, isGroup);
    setHighlight({ peerId, msgId });
    setCameFromAgent(fromAgent);
  };

  // Deep link listener: an aegent://chat/.../message/... intent or a
  // #/chat/... web URL opens the chat (and highlights the message
  // when one is given). Cold-start and runtime both covered.
  useEffect(() => {
    return onChatDeepLink(async ({ peerId, isGroup, msgId }) => {
      if (msgId) await openMessage(peerId, isGroup, msgId, false);
      else await openThread(peerId, isGroup);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bp = useBreakpoint();
  const barVisible = bp === "sm" && !thread;
  useEffect(() => {
    document.documentElement.style.setProperty("--tabbar-h", barVisible ? "56px" : "0px");
    return () => document.documentElement.style.setProperty("--tabbar-h", "0px");
  }, [barVisible]);
  const showSidebar = bp !== "sm" || !thread;
  const showChat = bp !== "sm" || !!thread;

  const chatPane = (
    <AnimatePresence mode="wait">
      {thread ? (
        <motion.div key={thread.peerId}
          initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          style={{ height: "100%", display: "flex", flexDirection: "column" }}
        >
          <ErrorBoundary label="Chat">
            <Chat
              thread={thread}
              refreshKey={refresh}
              onOpenForward={(m) => setForwardMsg(m)}
              onBack={bp === "sm" ? () => setThread(null) : undefined}
              onSent={() => setRefresh((k) => k + 1)}
              highlightMsgId={highlight?.peerId === thread.peerId ? highlight.msgId : null}
              fromAgent={cameFromAgent}
              onBackToAgent={() => { setCameFromAgent(false); setAgentOpen(true); }}
              onInvokeAgent={(q) => { setPendingAgentQuery(q); setAgentOpen(true); }}
              onOpenGroupInfo={() => setGroupInfoFor(thread.peerId)}
            />
          </ErrorBoundary>
        </motion.div>
      ) : (
        <EmptyRight onCompose={() => setCompose(true)} />
      )}
    </AnimatePresence>
  );

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: bp === "sm" ? "1fr"
        : dest === "diary" ? "64px 1fr"
        : "64px 320px 1fr",
      height: "var(--app-h)",
      // On a phone with a chat open the conversation goes full-bleed —
      // no card gutter — which is what every messenger does; safe-area
      // insets stay. Everywhere else keeps the 12px frame.
      ...(bp === "sm" && !!thread ? {
        padding: "var(--safe-top) var(--safe-right) calc(var(--tabbar-h) + var(--safe-bottom)) var(--safe-left)",
        gap: 0,
      } : {
        paddingTop: "calc(12px + var(--safe-top))",
        paddingBottom: "calc(12px + var(--tabbar-h) + var(--safe-bottom))",
        paddingLeft: "calc(12px + var(--safe-left))",
        paddingRight: "calc(12px + var(--safe-right))",
        gap: 12,
      }),
      position: "relative",
    }}>
      {bp !== "sm" && <NavRail dest={dest} onSelect={setDest} unread={{ diary: diaryUnread }} />}

      {dest === "diary" ? (
        <Diary refreshKey={refresh} />
      ) : (
      <>
      {showSidebar && (
        <Glass raised style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{
            padding: "14px 16px 6px", display: "flex", alignItems: "center", gap: 10,
          }}>
            <Brand />
            <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              <Button variant="icon" title="Contacts" onClick={() => setContactsOpen(true)}><Icon.contacts /></Button>
              <Button variant="icon" title="Settings" onClick={() => setSettings(true)}><Icon.settings /></Button>
            </div>
          </div>
          <div style={{ padding: "6px 16px 0" }}>
            <button
              type="button"
              onClick={() => setAgentOpen(true)}
              aria-label="Open Aegent — ask or search anything"
              style={{
                all: "unset", cursor: "pointer",
                display: "flex", alignItems: "center", gap: 10,
                width: "100%", minHeight: 44, padding: "10px 14px", borderRadius: 14,
                background: "linear-gradient(135deg, rgba(138,125,255,0.22), rgba(110,231,255,0.18))",
                border: "1px solid var(--glass-border-hi)",
                boxShadow: "0 6px 18px rgba(138,125,255,0.22)",
                color: "var(--text)", fontSize: 14,
              }}
            >
              <span style={{
                width: 24, height: 24, borderRadius: 8,
                background: "linear-gradient(135deg, var(--violet), var(--aqua))",
                display: "grid", placeItems: "center", color: "#10132a",
              }}>
                <Icon.agent />
              </span>
              <span style={{ flex: 1, color: "var(--text-dim)" }}>Ask or search Aegent…</span>
              <span style={{ fontSize: 11, color: "var(--text-mute)" }}>/agent</span>
            </button>
          </div>
          <div style={{ padding: "6px 16px 0", display: "flex", alignItems: "center", gap: 10 }}>
            <Avatar name={me?.displayName ?? "?"} size="sm" />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{me?.displayName}</div>
              <div className="small">@{me?.handle}</div>
            </div>
          </div>
          {rep && rep.phase !== "synced" && rep.phase !== "idle" && (
            <div style={{
              margin: "8px 16px 0", padding: "7px 10px", borderRadius: 10,
              fontSize: 12, display: "flex", alignItems: "center", gap: 8,
              background: rep.phase === "offline"
                ? "rgba(255,120,120,0.10)" : "rgba(138,125,255,0.14)",
              border: "1px solid var(--glass-border-hi)",
              color: "var(--text-dim)",
            }}>
              <span style={{
                width: 7, height: 7, borderRadius: 999, flexShrink: 0,
                background: rep.phase === "offline" ? "var(--danger)" : "var(--aqua)",
              }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {replicationSummary(rep)}
              </span>
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, marginTop: 4 }}>
            <ThreadList
              filter={dest === "groups" ? "group" : "all"}
              activeId={thread?.peerId ?? null}
              onSelect={setThread}
              onCompose={() => setCompose(true)}
              onOpenSearch={() => setSearch(true)}
              refreshKey={refresh}
            />
          </div>
        </Glass>
      )}

      {showChat && (bp === "sm"
        ? <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", position: "relative", height: "100%" }}>{chatPane}</div>
        : <Glass raised style={{ display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>{chatPane}</Glass>
      )}

      </>
      )}

      {barVisible && <TabBar dest={dest} onSelect={setDest} unread={{ diary: diaryUnread }} />}

      {/*
        Floating agent button. Rules for where it lives:
        - Hide when the agent panel is already open.
        - Hide on wide viewports where the sidebar's Agent icon in the
          header is already visible (would be redundant).
        - Hide when a chat is open on mobile — the chat composer's
          Send button sits in the bottom-right and the FAB would tap-
          overlap it. In that mode the agent is reachable from the
          back button + sidebar's agent icon.
        - When it does show, sit above the composer (~76 px) with safe-
          area applied so the Android nav bar doesn't clip it either.
      */}
      <AnimatePresence>
        {!agentOpen && bp === "sm" && !thread && dest !== "diary" && (
          <motion.button
            initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }}
            whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 340, damping: 24 }}
            onClick={() => setAgentOpen(true)}
            title="Open agent"
            aria-label="Open agent"
            style={{
              position: "fixed",
              right: "calc(18px + var(--safe-right))",
              // Above the composer bar so it never intercepts a Send tap.
              bottom: "calc(90px + var(--tabbar-h) + var(--safe-bottom))",
              zIndex: 400,
              width: 52, height: 52, borderRadius: 999, border: "none", cursor: "pointer",
              background: "linear-gradient(135deg, var(--violet), var(--aqua))",
              color: "#10132a",
              boxShadow: "0 12px 34px rgba(138,125,255,0.5)",
              display: "grid", placeItems: "center",
            }}
          >
            <Icon.agent />
          </motion.button>
        )}
      </AnimatePresence>

      <ComposeOverlay open={compose} onClose={() => setCompose(false)} onOpenThread={openThread} />
      <GlobalSearch open={search} onClose={() => setSearch(false)}
        onOpenThread={(pid, isG) => openThread(pid, isG)} />
      <Settings open={settings} onClose={() => setSettings(false)} onSignedOut={onSignedOut} />
      <AgentSheet
        open={agentOpen}
        onClose={() => { setAgentOpen(false); setPendingAgentQuery(null); }}
        onDidAct={() => setRefresh((k) => k + 1)}
        onOpenMessage={openMessage}
        initialQuery={pendingAgentQuery}
        onConsumeInitialQuery={() => setPendingAgentQuery(null)}
      />
      <ForwardSheet open={!!forwardMsg} onClose={() => setForwardMsg(null)} message={forwardMsg} />
      <ContactsSheet open={contactsOpen} onClose={() => setContactsOpen(false)}
        onOpenThread={(pid) => openThread(pid, false)} />
      <GroupInfo
        open={!!groupInfoFor} groupId={groupInfoFor}
        onClose={() => setGroupInfoFor(null)}
        onChanged={() => setRefresh((k) => k + 1)}
      />

      {tourOpen && <WelcomeTour onDone={() => setTourOpen(false)} />}
    </div>
  );
}

function EmptyRight({ onCompose }: { onCompose: () => void }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      style={{
        display: "grid", placeItems: "center", padding: 40, textAlign: "center",
        height: "100%", color: "var(--text-dim)",
      }}>
      <div>
        <div style={{
          width: 64, height: 64, margin: "0 auto 14px", borderRadius: 18,
          background: "linear-gradient(135deg, var(--violet), var(--aqua))",
          color: "#10132a", fontWeight: 800, display: "grid", placeItems: "center",
          fontSize: 26, boxShadow: "0 12px 30px rgba(138,125,255,0.4)",
        }}>Æ</div>
        <div style={{ color: "var(--text)", fontSize: 18, fontWeight: 600 }}>Pick a conversation</div>
        <div className="small" style={{ margin: "6px 0 14px" }}>
          Or start a new one. Every message here is encrypted end-to-end.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <Button variant="primary" onClick={onCompose}><Icon.plus /> New chat</Button>
          <Button onClick={async () => {
            const me = currentSession()?.user;
            const url = me ? siteUrl(`/#/i/${me.handle}`) : siteUrl("/");
            const how = await shareInvite({
              url,
              title: "Chat with me on Aegent",
              text: me
                ? `${me.displayName} invited you to chat privately on Aegent — end-to-end encrypted.`
                : "Chat privately on Aegent — end-to-end encrypted.",
            });
            if (how === "copied") toast("Link copied", "ok");
          }}>
            <Icon.link /> Share invite
          </Button>
        </div>
        <div className="small" style={{ marginTop: 20, opacity: 0.7 }}>
          Tip: <span className="kbd">Ctrl</span> + <span className="kbd">K</span> to search everything · <span className="kbd">Ctrl</span> + <span className="kbd">J</span> for the agent
        </div>
      </div>
    </motion.div>
  );
}

async function synthThread(peerId: string, isGroup: boolean): Promise<Thread> {
  if (isGroup) {
    const g = (await listGroups()).find((x) => x.id === peerId);
    return {
      peerId, isGroup: true,
      title: g?.name ?? "Group",
      subtitle: "New group — start the conversation",
      updatedAt: Date.now(),
      unread: 0,
      memberIds: g?.memberIds,
    };
  }
  const c = await getContact(peerId);
  return {
    peerId, isGroup: false,
    title: c?.displayName ?? "New chat",
    subtitle: "Say hello",
    updatedAt: Date.now(), unread: 0,
    online: c?.online,
  };
}

function useBreakpoint(): "sm" | "md" | "lg" {
  const [bp, setBp] = useState<"sm" | "md" | "lg">(() =>
    typeof window === "undefined" ? "lg" : window.innerWidth < 720 ? "sm" : window.innerWidth < 1080 ? "md" : "lg");
  useEffect(() => {
    const onResize = () => setBp(window.innerWidth < 720 ? "sm" : window.innerWidth < 1080 ? "md" : "lg");
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return bp;
}

// Consume so tree-shake doesn't drop it.
void upsertContact;
