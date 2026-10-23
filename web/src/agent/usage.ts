// What the agent actually read this turn.
//
// The agent's tools pull messages off the device and send them to the
// model to answer a question. This records which ones, so the UI can
// show the person — after the fact — exactly what left their phone.
// It is transparency, not a gate: the messages have already been used
// by the time a reply exists, and the honest thing is to say so plainly
// rather than hide it.

export type UsedMessage = { peer: string; when: string; snippet: string };

let used: Map<string, UsedMessage> = new Map();

export function resetAgentUsage(): void {
  used = new Map();
}

// Called from the retrieval layer as rows are surfaced. Deduped by id,
// so a message read by two tools in one turn counts once.
export function noteAgentUse(rows: Array<{ id: string; peerName?: string; when?: string; body?: string | null }>): void {
  for (const r of rows) {
    if (used.has(r.id)) continue;
    used.set(r.id, {
      peer: r.peerName ?? "a chat",
      when: r.when ?? "",
      snippet: (r.body ?? "").slice(0, 120),
    });
  }
}

export function agentUsageCount(): number { return used.size; }
export function agentUsageMessages(): UsedMessage[] { return [...used.values()]; }
