// Always-on replication.
//
// "Your messages are simply always there" is a promise about the
// product, not a button in a settings screen. Nothing in this module is
// user-initiated: it starts the moment a session opens and keeps the
// device, the relay, and every sibling device converged for as long as
// the app is alive.
//
// One cycle does four things, in this order:
//
//   1. flush the outbox        — anything composed while offline goes out
//   2. replicate own history   — any local message without a cloud copy
//                                gets a self-addressed ciphertext copy
//   3. drain the inbox         — anything the relay holds for us comes
//                                down (the ledger dedupes, retries what
//                                failed, and re-drains on divergence)
//   4. publish state           — so the UI can say what's true right now
//
// Cycles are triggered by: session open, a tick timer (faster while the
// app is in the foreground), coming back online, the tab/app becoming
// visible, and every socket reconnect. Failures back off instead of
// hammering a server that's down, and a cycle never overlaps itself.

import { onConnected } from "./socket.js";
import {
  availabilityReport, currentSession, flushOutbox, onDrainProgress, pullInbox,
  replicateUnpushed,
} from "./session.js";
import { messageCount } from "./store.js";

export type ReplicationPhase =
  | "idle"        // no session
  | "restoring"   // first sync on a device that has little or nothing yet
  | "syncing"     // a cycle is running
  | "synced"      // everything the relay holds is here
  | "catching-up" // reachable, but we know we're behind
  | "offline";    // the relay isn't reachable right now

export type ReplicationState = {
  phase: ReplicationPhase;
  // Envelope accounting — the honest measure of "do I have everything".
  serverTotal: number;      // -1 when the relay couldn't be reached
  localTotal: number;
  // Exact, from reconciliation by id: envelopes the relay holds that
  // this device has no record of. This — never a difference of totals —
  // is what "behind" means.
  missing: number;
  pending: number;          // envelopes parked for retry
  queuedOutbound: number;   // messages waiting to leave this device
  lastSyncAt: number | null;
  lastError: string | null;
};

const INITIAL: ReplicationState = {
  phase: "idle",
  serverTotal: -1,
  localTotal: 0,
  missing: 0,
  pending: 0,
  queuedOutbound: 0,
  lastSyncAt: null,
  lastError: null,
};

let state: ReplicationState = INITIAL;
const listeners = new Set<(s: ReplicationState) => void>();

export function replicationState(): ReplicationState { return state; }

export function onReplication(cb: (s: ReplicationState) => void): () => void {
  listeners.add(cb);
  cb(state);
  return () => { listeners.delete(cb); };
}

function publish(patch: Partial<ReplicationState>): void {
  state = { ...state, ...patch };
  for (const cb of listeners) {
    try { cb(state); } catch (e) { console.warn("[replication] listener threw", e); }
  }
}

// ---- scheduling ----

const TICK_FOREGROUND_MS = 20_000;
const TICK_BACKGROUND_MS = 90_000;
const BACKOFF_MAX_MS = 5 * 60_000;

let timer: number | null = null;
let unsubscribers: Array<() => void> = [];
let running = false;
let started = false;
let consecutiveFailures = 0;
// A cycle requested while one was already running; we run exactly one
// more afterwards rather than queueing a pile of them.
let rerunRequested = false;

function nextDelay(): number {
  if (consecutiveFailures > 0) {
    return Math.min(TICK_FOREGROUND_MS * 2 ** consecutiveFailures, BACKOFF_MAX_MS);
  }
  const hidden = typeof document !== "undefined" && document.hidden;
  return hidden ? TICK_BACKGROUND_MS : TICK_FOREGROUND_MS;
}

function rearm(): void {
  if (!started) return;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => { void cycle("tick"); }, nextDelay()) as unknown as number;
}

export function startReplication(): void {
  if (started) { void cycle("restart"); return; }
  started = true;
  consecutiveFailures = 0;

  unsubscribers.push(onConnected(() => { void cycle("socket-connect"); }));

  if (typeof window !== "undefined") {
    const onOnline = () => { consecutiveFailures = 0; void cycle("online"); };
    const onOffline = () => publish({ phase: "offline" });
    const onVisible = () => { if (!document.hidden) void cycle("visible"); };
    const onFocus = () => { void cycle("focus"); };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    unsubscribers.push(() => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    });
  }

  // Live progress out of the drain, so a first sync on a new device can
  // show real numbers instead of an empty chat list.
  unsubscribers.push(onDrainProgress(({ ingested, serverTotal }) => {
    publish({
      phase: state.phase === "restoring" ? "restoring" : "syncing",
      localTotal: Math.max(state.localTotal, ingested),
      ...(serverTotal >= 0 ? { serverTotal } : {}),
    });
  }));

  void cycle("session-open");
}

export function stopReplication(): void {
  started = false;
  if (timer !== null) { clearTimeout(timer); timer = null; }
  for (const u of unsubscribers) { try { u(); } catch { /* ignore */ } }
  unsubscribers = [];
  state = INITIAL;
  publish({});
}

// Ask for a cycle now (e.g. right after a send). Cheap and coalesced.
export function kickReplication(reason = "manual"): void { void cycle(reason); }

async function cycle(reason: string): Promise<void> {
  if (!started || !currentSession()) return;
  if (running) { rerunRequested = true; return; }
  running = true;
  try {
    // A device that holds nothing yet is *restoring*, which is a
    // different message to the user than a routine sync.
    const localMessages = await messageCount().catch(() => 0);
    publish({
      phase: localMessages === 0 ? "restoring" : "syncing",
      lastError: null,
    });

    // Each step is guarded on its own. These are independent jobs, and
    // letting a failing outbox flush (say, one unreachable recipient)
    // skip the drain is how a device ends up frozen at a number that
    // never moves while the status request behind that number keeps
    // succeeding.
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try { await fn(); }
      catch (e) { console.warn(`[replication] ${name} failed:`, (e as Error).message); }
    };
    await step("outbox flush", () => flushOutbox());
    await step("cloud copy", () => replicateUnpushed());
    await step("drain", () => pullInbox({ reason }));

    const report = await availabilityReport();
    const unreachable = report.serverTotal < 0;
    consecutiveFailures = unreachable ? consecutiveFailures + 1 : 0;
    publish({
      phase: unreachable ? "offline" : report.healthy ? "synced" : "catching-up",
      serverTotal: report.serverTotal,
      localTotal: report.localLedger,
      missing: report.missing,
      pending: report.pending,
      queuedOutbound: report.queuedOutbound,
      lastSyncAt: unreachable ? state.lastSyncAt : Date.now(),
      lastError: null,
    });
  } catch (e) {
    consecutiveFailures++;
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    publish({
      phase: offline ? "offline" : "catching-up",
      lastError: (e as Error).message,
    });
    console.warn(`[replication] cycle failed (${reason}):`, (e as Error).message);
  } finally {
    running = false;
    rearm();
    if (rerunRequested) { rerunRequested = false; void cycle("rerun"); }
  }
}

// ---- presentation helper ----
//
// One line the UI can show verbatim. Kept here so the sidebar strip and
// the Settings panel can never drift out of sync.
export function replicationSummary(s: ReplicationState): string {
  switch (s.phase) {
    case "idle":
      return "Not signed in";
    case "restoring":
      return s.serverTotal > 0
        ? `Restoring your messages… ${Math.min(s.localTotal, s.serverTotal)} of ${s.serverTotal}`
        : "Restoring your messages…";
    case "syncing":
      return "Syncing…";
    case "offline":
      return s.queuedOutbound > 0
        ? `Offline · ${s.queuedOutbound} waiting to send`
        : "Offline · will sync when you reconnect";
    case "catching-up": {
      if (s.missing > 0) return `Catching up · ${s.missing} to go`;
      if (s.pending > 0) {
        return `${s.pending} message${s.pending === 1 ? "" : "s"} couldn't be read yet`;
      }
      if (s.queuedOutbound > 0) return `${s.queuedOutbound} waiting to send`;
      return "Catching up…";
    }
    case "synced":
      return s.lastSyncAt
        ? `All messages backed up · ${relativeTime(s.lastSyncAt)}`
        : "All messages backed up";
  }
}

function relativeTime(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString();
}
