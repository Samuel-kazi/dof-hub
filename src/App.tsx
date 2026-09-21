import { useState } from "react";
import type { Actor } from "./types";
import { AppProvider } from "./ui/AppContext";
import { Shell } from "./ui/Shell";
import { Login } from "./pages/Login";

export default function App() {
  const [actor, setActor] = useState<Actor | null>(null);
  return (
    <>
      <div className="dawn" />
      {actor ? (
        <AppProvider actor={actor} onLogout={() => setActor(null)}>
          <Shell />
        </AppProvider>
      ) : (
        <Login onLogin={setActor} />
      )}
    </>
  );
}
