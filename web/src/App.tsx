// Top-level app. Owns three big states: onboarding, auth, signed-in.
// Handles the invite deep link (#/i/:handle) once you're signed in.

import { useEffect, useState } from "react";
// (AnimatePresence intentionally omitted here — see main.tsx and Auth.tsx
// notes on why mode="wait" transitions get tangled in dev.)
import { ToastHost, toast } from "./components/ui.js";
import { AdminDashboard } from "./pages/Admin.js";
import { AuthScreen } from "./pages/Auth.js";
import { Home } from "./pages/Home.js";
import { hasOnboarded, Onboarding } from "./pages/Onboarding.js";
import { api } from "./lib/api.js";
import { currentSession, tryRestoreSession } from "./lib/session.js";
import { initCrypto } from "./lib/crypto.js";
import { upsertContact, upsertGroup } from "./lib/store.js";
import { installDeepLinkHandlers } from "./lib/deeplinks.js";

export default function App() {
  const [ready, setReady] = useState(false);
  const [onboarded, setOnboarded] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [adminRoute, setAdminRoute] = useState<boolean>(() => location.hash === "#/admin");
  useEffect(() => {
    const sync = () => setAdminRoute(location.hash === "#/admin");
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    (async () => {
      await initCrypto();
      setOnboarded(hasOnboarded());
      // Silent session restore — if we have a valid JWT + persisted
      // crypto keys, jump straight into the app instead of showing
      // the auth screen.
      const restored = await tryRestoreSession();
      if (restored) setSignedIn(true);
      // Install deep-link handlers once per boot so cold-start URLs
      // and later intents both route through onChatDeepLink.
      installDeepLinkHandlers();
      setReady(true);
    })();
  }, []);

  // When we become signed in, honor any pending #/i/:handle deep link.
  useEffect(() => {
    if (!signedIn) return;
    const parseHash = async () => {
      // Group invite: #/g/<token>. The token is the authorisation, so
      // redeeming it is a server call — depending on the group it either
      // joins you or files a request for an admin.
      const g = /^#\/g\/(.+)$/.exec(location.hash);
      if (g) {
        const token = decodeURIComponent(g[1]);
        location.hash = "";
        try {
          const r = await api.groupRedeemInvite(token);
          if (r.state === "joined") {
            await upsertGroup({
              id: r.group.id, name: r.group.name, memberIds: r.group.memberIds ?? [],
              createdBy: "", createdAt: Date.now(), lastSeenAt: Date.now(),
            });
            toast(`Joined ${r.group.name}`, "ok");
          } else {
            toast(`Asked to join ${r.group.name} — an admin will decide`, "info");
          }
        } catch (e) {
          toast((e as Error).message, "warn");
        }
        return;
      }

      const m = /^#\/i\/(.+)$/.exec(location.hash);
      if (!m) return;
      const handle = decodeURIComponent(m[1]).replace(/^@/, "");
      try {
        const u = await api.byHandle(handle);
        await upsertContact({
          id: u.id, email: u.email, phone: u.phone ?? null,
          handle: u.handle, displayName: u.displayName,
          publicKey: u.publicKey, lastSeenAt: Date.now(), online: u.presence?.online,
        });
        toast(`Added @${handle}`, "ok");
        location.hash = "";
      } catch {
        toast(`No user @${handle}`, "warn");
        location.hash = "";
      }
    };
    parseHash();
    window.addEventListener("hashchange", parseHash);
    return () => window.removeEventListener("hashchange", parseHash);
  }, [signedIn]);

  if (!ready) return <Splash />;

  return (
    <div className="aegent-root">
      {!onboarded ? (
        <Onboarding onDone={() => setOnboarded(true)} />
      ) : (!signedIn && !currentSession()) ? (
        <AuthScreen onDone={() => setSignedIn(true)} />
      ) : adminRoute ? (
        <AdminDashboard onExit={() => { location.hash = ""; }} />
      ) : (
        <Home onSignedOut={() => setSignedIn(false)} />
      )}
      <ToastHost />
    </div>
  );
}

function Splash() {
  return (
    <div className="aegent-root" style={{ display: "grid", placeItems: "center", height: "var(--app-h)" }}>
      <div style={{
        width: 56, height: 56, borderRadius: 16,
        background: "linear-gradient(135deg, var(--violet), var(--aqua))",
        color: "#10132a", fontWeight: 900, fontSize: 24,
        display: "grid", placeItems: "center",
        boxShadow: "0 12px 30px rgba(138,125,255,0.4)",
        animation: "pulse 1.3s ease-in-out infinite",
      }}>Æ</div>
      <style>{`@keyframes pulse { 50% { transform: scale(1.06); filter: brightness(1.1); } }`}</style>
    </div>
  );
}
