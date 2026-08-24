import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { listContacts, upsertContact, type ContactRow } from "../lib/store.js";
import { currentSession, logout } from "../lib/session.js";

export function Sidebar({
  activePeerId,
  onSelect,
  refreshKey,
  onLoggedOut,
}: {
  activePeerId: string | null;
  onSelect: (c: ContactRow) => void;
  refreshKey: number;
  onLoggedOut: () => void;
}) {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ id: string; email: string; displayName: string; publicKey: string }>>([]);

  useEffect(() => {
    (async () => setContacts(await listContacts()))();
  }, [refreshKey]);

  useEffect(() => {
    let alive = true;
    if (!q.trim()) { setResults([]); return; }
    const t = window.setTimeout(async () => {
      try {
        const r = await api.search(q.trim());
        if (alive) setResults(r);
      } catch { /* ignore */ }
    }, 200);
    return () => { alive = false; window.clearTimeout(t); };
  }, [q]);

  async function addContact(u: { id: string; email: string; displayName: string; publicKey: string }) {
    const row: ContactRow = { ...u, lastSeenAt: Date.now() };
    await upsertContact(row);
    setContacts(await listContacts());
    onSelect(row);
    setQ(""); setResults([]);
  }

  const me = currentSession()?.user;

  return (
    <aside className="sidebar">
      <header>
        <div className="brand">Aegent</div>
        <div className="who">{me?.displayName}</div>
        <button className="icon-btn" onClick={() => { logout(); onLoggedOut(); }}>Sign out</button>
      </header>
      <div className="search">
        <input
          placeholder="Find someone by email or name"
          value={q} onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="contacts">
        {q && results.length > 0 && (
          <>
            <div className="small" style={{ padding: "8px 16px", color: "var(--text-dim)" }}>People</div>
            {results.map((u) => (
              <div key={u.id} className="contact-row" onClick={() => addContact(u)}>
                <div className="avatar">{u.displayName.slice(0, 1).toUpperCase()}</div>
                <div className="contact-meta">
                  <div className="name">{u.displayName}</div>
                  <div className="sub">{u.email}</div>
                </div>
              </div>
            ))}
            <div className="small" style={{ padding: "8px 16px", color: "var(--text-dim)" }}>Recent</div>
          </>
        )}
        {contacts.length === 0 && (
          <div className="small" style={{ padding: 16 }}>
            No chats yet. Search above to find someone.
          </div>
        )}
        {contacts.map((c) => (
          <div
            key={c.id}
            className={`contact-row ${activePeerId === c.id ? "active" : ""}`}
            onClick={() => onSelect(c)}
          >
            <div className="avatar">{c.displayName.slice(0, 1).toUpperCase()}</div>
            <div className="contact-meta">
              <div className="name">{c.displayName}</div>
              <div className="sub">{c.email}</div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
