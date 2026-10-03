import { useEffect, useState } from "react";
import type { Actor } from "./types";
import { AppProvider } from "./ui/AppContext";
import { Shell } from "./ui/Shell";
import { Login, MustChange, RemoteLogin, Setup, Unavailable } from "./pages/Login";
import { actorOf, hydrate, probe, signOut, startSync, syncEvents, type SessionInfo, type SessionUser } from "./data/remote";
import { startLocalDailyChecks } from "./data/localChecks";
import { enableDesktopMedia } from "./pages/documents/images";

type Boot = { kind: "loading" } | { kind: "local" } | { kind: "remote"; info: SessionInfo };

export default function App() {
  const [boot, setBoot] = useState<Boot>({ kind: "loading" });
  const [actor, setActor] = useState<Actor | null>(null);
  const [pending, setPending] = useState<SessionUser | null>(null); // signed in, but must choose a new password

  const enter = async (u: SessionUser) => {
    if (u.mustChange) {
      setPending(u);
      return;
    }
    await hydrate();
    startSync();
    setPending(null);
    setActor(actorOf(u));
  };

  useEffect(() => {
    syncEvents.onSignedOut = () => window.location.reload();
    void probe().then(async (info) => {
      if (!info) {
        // The desktop app on its own keeps pictures in a media folder on that computer.
        if ("__TAURI_INTERNALS__" in window) await enableDesktopMedia();
        setBoot({ kind: "local" });
        return;
      }
      setBoot({ kind: "remote", info });
      if (info.user && !info.unavailable) await enter(info.user);
    });
  }, []);

  // Signed in to a server, the server runs the daily checks. On its own, the app runs them.
  useEffect(() => (boot.kind === "local" ? startLocalDailyChecks() : undefined), [boot.kind]);

  if (boot.kind === "loading")
    return (
      <>
        <div className="dawn" />
        <div className="login-wrap">
          <p className="muted">Loading…</p>
        </div>
      </>
    );

  return (
    <>
      <div className="dawn" />
      {actor ? (
        <AppProvider actor={actor} onLogout={boot.kind === "remote" ? () => void signOut() : () => setActor(null)}>
          <Shell />
        </AppProvider>
      ) : boot.kind === "local" ? (
        <Login onLogin={setActor} />
      ) : boot.info.unavailable ? (
        <Unavailable message={boot.info.unavailable} />
      ) : pending ? (
        <MustChange user={pending} onDone={(u) => void enter({ ...u, mustChange: false })} />
      ) : boot.info.needsSetup ? (
        <Setup onDone={(u) => void enter(u)} />
      ) : (
        <RemoteLogin onLogin={(u) => void enter(u)} />
      )}
    </>
  );
}
