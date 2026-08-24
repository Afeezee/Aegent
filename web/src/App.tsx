// Top-level app. Owns three big states: onboarding, auth, signed-in.
// Handles the invite deep link (#/i/:handle) once you're signed in.

import { useEffect, useState } from "react";
// (AnimatePresence intentionally omitted here — see main.tsx and Auth.tsx
// notes on why mode="wait" transitions get tangled in dev.)
import { ToastHost, toast } from "./components/ui.js";
import { AuthScreen } from "./pages/Auth.js";
import { Home } from "./pages/Home.js";
import { hasOnboarded, Onboarding } from "./pages/Onboarding.js";
import { api } from "./lib/api.js";
import { currentSession } from "./lib/session.js";
import { initCrypto } from "./lib/crypto.js";
import { upsertContact } from "./lib/store.js";

export default function App() {
  const [ready, setReady] = useState(false);
  const [onboarded, setOnboarded] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    (async () => {
      await initCrypto();
      setOnboarded(hasOnboarded());
      setReady(true);
    })();
  }, []);

  // When we become signed in, honor any pending #/i/:handle deep link.
  useEffect(() => {
    if (!signedIn) return;
    const parseHash = async () => {
      const m = /^#\/i\/(.+)$/.exec(location.hash);
      if (!m) return;
      const handle = decodeURIComponent(m[1]).replace(/^@/, "");
      try {
        const u = await api.byHandle(handle);
        await upsertContact({
          id: u.id, email: u.email, handle: u.handle, displayName: u.displayName,
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
      ) : (
        <Home onSignedOut={() => setSignedIn(false)} />
      )}
      <ToastHost />
    </div>
  );
}

function Splash() {
  return (
    <div className="aegent-root" style={{ display: "grid", placeItems: "center", height: "100vh" }}>
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
