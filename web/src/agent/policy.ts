// What the agent is allowed to read.
//
// Until now `ACTIVE_THREAD` was a sentence in the system prompt asking
// the model to prefer the open chat, and every search tool took `peerId`
// as an OPTIONAL filter the model could simply omit. One casual question
// could therefore pull three hundred message bodies from every
// conversation on the device and send them off to be summarised. That is
// tolerable in a one-to-one app where everything already belongs to the
// person asking. It is not tolerable the moment a group's messages —
// other people's words — are in scope.
//
// So scope stops being advice and becomes enforcement, in two places,
// because one is not enough:
//
//   * at the dispatcher, which is where the model's chosen tool and
//     arguments arrive, and
//   * at the retrieval functions themselves, because the tools that take
//     a message id (`get_context_around`, `read_media`, and friends)
//     never consult `peerId` at all and would otherwise read straight
//     past a dispatcher check.
//
// What this is NOT: a defence against the person holding the device.
// The agent runs on their machine, over data they can already decrypt.
// A modified client ignores every line of this file. It protects other
// members of a group from a careless question, which is a real and
// common risk — not from a determined one, which this cannot address
// and should not claim to.

import type { OpenedMessage } from "../lib/store.js";

export type AgentScope =
  | { kind: "all" }                                  // 1:1 behaviour, unchanged
  | { kind: "peers"; peerIds: string[] };            // a specific, closed set

export type AgentPolicy = {
  scope: AgentScope;
  // Threads the agent must never read, whatever it is asked. Groups
  // whose `agentPolicy` is "off" land here.
  denied: Set<string>;
  // Hard ceiling on how much message text can leave the device in one
  // turn. Dosage control, not security.
  maxRows: number;
  maxBodyChars: number;
};

const OPEN: AgentPolicy = {
  scope: { kind: "all" },
  denied: new Set(),
  maxRows: 300,
  maxBodyChars: 4000,
};

let CURRENT: AgentPolicy = OPEN;

export function setAgentPolicy(p: AgentPolicy): void { CURRENT = p; }
export function resetAgentPolicy(): void { CURRENT = OPEN; }
export function agentPolicy(): AgentPolicy { return CURRENT; }

export class OutOfScopeError extends Error {
  constructor(peerId: string) {
    super(`out_of_scope: this conversation isn't available to the assistant (${peerId.slice(0, 8)})`);
  }
}

export function inScope(peerId: string): boolean {
  if (CURRENT.denied.has(peerId)) return false;
  if (CURRENT.scope.kind === "all") return true;
  return CURRENT.scope.peerIds.includes(peerId);
}

// For the id-addressed tools: refuse loudly rather than returning
// nothing, so the model reports a boundary instead of inventing one.
export function assertInScope(peerId: string): void {
  if (!inScope(peerId)) throw new OutOfScopeError(peerId);
}

// Every retrieval path funnels through this. Filtering the rows rather
// than trusting the model to pass the right filter is the whole point:
// the model is a participant here, not an enforcement boundary.
export function filterInScope(rows: OpenedMessage[]): OpenedMessage[] {
  if (CURRENT.scope.kind === "all" && CURRENT.denied.size === 0) return rows;
  return rows.filter((m) => inScope(m.peerId));
}

// Trim what actually leaves the device. Row counts were already capped
// per tool; bodies never were, so one `summarize_thread` could ship
// three hundred complete messages.
export function budget(rows: OpenedMessage[]): OpenedMessage[] {
  const capped = rows.slice(0, CURRENT.maxRows);
  if (!CURRENT.maxBodyChars) return capped;
  return capped.map((m) => {
    const body = m.editedBody ?? m.body;
    if (!body || body.length <= CURRENT.maxBodyChars) return m;
    return { ...m, body: `${body.slice(0, CURRENT.maxBodyChars)}… [truncated]`, editedBody: null };
  });
}
