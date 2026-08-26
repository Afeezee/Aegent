// Main app shell — sidebar, chat, floating agent, and the four
// overlays (compose, search, settings, agent, forward).

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Avatar, Button, ErrorBoundary, Glass, Icon } from "../components/ui.js";
import { Chat } from "../components/Chat.js";
import { ThreadList } from "../components/ThreadList.js";
import { ComposeOverlay } from "../components/ComposeOverlay.js";
import { GlobalSearch } from "../components/GlobalSearch.js";
import { Settings } from "../components/Settings.js";
import { AgentSheet, pushAgentEvent } from "../components/Agent.js";
import { ForwardSheet } from "../components/ForwardSheet.js";
import { ContactsSheet } from "../components/Contacts.js";
import { Brand } from "./Onboarding.js";
import { api } from "../lib/api.js";
import {
  currentSession, ensureContact, ensureGroup, ingestEnvelope,
} from "../lib/session.js";
import { onMessage, onPresence, onRead } from "../lib/socket.js";
import {
  getContact, listGroups, listThreads, markRead, setContactPresence,
  takeDueScheduledBackups,
  upsertContact, upsertGroup, type OpenedMessage, type Thread,
} from "../lib/store.js";
import { backup_thread } from "../agent/tools.js";
import { toast } from "../components/ui.js";
import { siteUrl } from "../lib/api.js";
import { shareInvite } from "../lib/contacts-integration.js";

export function Home({ onSignedOut }: { onSignedOut: () => void }) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [compose, setCompose] = useState(false);
  const [search, setSearch] = useState(false);
  const [settings, setSettings] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [forwardMsg, setForwardMsg] = useState<OpenedMessage | null>(null);
  const [contactsOpen, setContactsOpen] = useState(false);

  const me = currentSession()?.user;

  // Initial sync: pull known groups + drain inbox.
  useEffect(() => {
    (async () => {
      try {
        const gs = await api.listGroups();
        for (const g of gs) {
          await upsertGroup({
            id: g.id, name: g.name, memberIds: g.memberIds,
            createdBy: g.created_by, createdAt: g.created_at, lastSeenAt: g.created_at,
          });
          for (const uid of g.memberIds) await ensureContact(uid);
        }
      } catch { /* ignore */ }
      try {
        const envs = await api.inbox();
        for (const e of envs) {
          try { await ingestEnvelope(e); } catch { /* ignore per-envelope */ }
        }
      } catch { /* ignore */ }
      setRefresh((k) => k + 1);
    })();
  }, []);

  // Live delivery.
  useEffect(() => {
    return onMessage(async (env) => {
      try {
        await ingestEnvelope(env);
        setRefresh((k) => k + 1);
        // Browser notification for new inbound if not focused.
        if (document.hidden && Notification?.permission === "granted") {
          new Notification("Aegent", { body: "New encrypted message" });
        }
      } catch { /* ignore */ }
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
    if (isGroup) await ensureGroup(peerId);
    else await ensureContact(peerId);
    const threads = await listThreads();
    const found = threads.find((t) => t.peerId === peerId) ?? await synthThread(peerId, isGroup);
    setThread(found);
  };

  const bp = useBreakpoint();
  const showSidebar = bp !== "sm" || !thread;
  const showChat = bp !== "sm" || !!thread;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: bp === "sm" ? "1fr" : "320px 1fr",
      height: "100vh",
      // Reserve space around the OS chrome (Android nav bar at the
      // bottom, notch at the top). On desktop / web these insets are 0
      // so nothing changes.
      paddingTop: "calc(12px + var(--safe-top))",
      paddingBottom: "calc(12px + var(--safe-bottom))",
      paddingLeft: "calc(12px + var(--safe-left))",
      paddingRight: "calc(12px + var(--safe-right))",
      gap: 12, position: "relative",
    }}>
      {showSidebar && (
        <Glass raised style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{
            padding: "14px 16px 6px", display: "flex", alignItems: "center", gap: 10,
          }}>
            <Brand />
            <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              <Button variant="icon" title="Contacts" onClick={() => setContactsOpen(true)}><Icon.contacts /></Button>
              <Button variant="icon" title="Agent (Ctrl+J)" onClick={() => setAgentOpen(true)}><Icon.agent /></Button>
              <Button variant="icon" title="Settings" onClick={() => setSettings(true)}><Icon.settings /></Button>
            </div>
          </div>
          <div style={{ padding: "6px 16px 0", display: "flex", alignItems: "center", gap: 10 }}>
            <Avatar name={me?.displayName ?? "?"} size="sm" />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{me?.displayName}</div>
              <div className="small">@{me?.handle}</div>
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, marginTop: 4 }}>
            <ThreadList
              activeId={thread?.peerId ?? null}
              onSelect={setThread}
              onCompose={() => setCompose(true)}
              onOpenSearch={() => setSearch(true)}
              refreshKey={refresh}
            />
          </div>
        </Glass>
      )}

      {showChat && (
        <Glass raised style={{ display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
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
                  />
                </ErrorBoundary>
              </motion.div>
            ) : (
              <EmptyRight onCompose={() => setCompose(true)} />
            )}
          </AnimatePresence>
        </Glass>
      )}

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
        {!agentOpen && bp === "sm" && !thread && (
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
              bottom: "calc(90px + var(--safe-bottom))",
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
      <AgentSheet open={agentOpen} onClose={() => setAgentOpen(false)} onDidAct={() => setRefresh((k) => k + 1)} />
      <ForwardSheet open={!!forwardMsg} onClose={() => setForwardMsg(null)} message={forwardMsg} />
      <ContactsSheet open={contactsOpen} onClose={() => setContactsOpen(false)}
        onOpenThread={(pid) => openThread(pid, false)} />
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
