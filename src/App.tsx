import { useEffect, useState } from "react";
import type { Actor } from "./types";
import { AppProvider } from "./ui/AppContext";
import { Shell } from "./ui/Shell";
import { Login, MustChange, RemoteLogin, Setup, Unavailable } from "./pages/Login";
import { actorOf, hydrate, probe, signOut, startSync, syncEvents, type SessionInfo, type SessionUser } from "./data/remote";

type Boot = { kind: "loading" } | { kind: "local" } | { kind: "remote"; info: SessionInfo };

export default function App() {
  const [boot, setBoot] = useState<Boot>({ kind: "loading" });
  const [actor, setActor] = useState<Actor | null>(null);
  const [pending, setPending] = useState<SessionUser | null>(null); // signed in, but must choose a new password

  const enter = async (u: SessionUser) => {
    if (u.mustChange) { setPending(u); return; }
    await hydrate();
    startSync();
    setPending(null);
    setActor(actorOf(u));
  };

  useEffect(() => {
    syncEvents.onSignedOut = () => window.location.reload();
    void probe().then(async (info) => {
      if (!info) { setBoot({ kind: "local" }); return; }
      setBoot({ kind: "remote", info });
      if (info.user && !info.unavailable) await enter(info.user);
    });
  }, []);

  if (boot.kind === "loading") return <><div className="dawn" /><div className="login-wrap"><p className="muted">Loading…</p></div></>;

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
