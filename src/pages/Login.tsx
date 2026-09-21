import { useState } from "react";
import type { Actor } from "../types";
import { RuleError } from "../types";
import { login } from "../services/auth";
import { resetDemoData } from "../data/store";
import { Field } from "../ui/parts";
import { Logo } from "../ui/Logo";
import { IconMoon, IconSun } from "../ui/Icons";
import { useTheme } from "../ui/theme";

const DEMO = [
  { label: "Head of Production", email: "hop@dof.demo" },
  { label: "Crew", email: "crew2@dof.demo" },
  { label: "Volunteer", email: "volunteer1@dof.demo" },
  { label: "Partner", email: "partner1@dof.demo" },
];

export function Login({ onLogin }: { onLogin: (a: Actor) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const { theme, setPref } = useTheme();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      onLogin(login(email, password));
    } catch (err) {
      setError(err instanceof RuleError ? err.message : "Could not sign in.");
    }
  };

  return (
    <div className="login-wrap">
      <div className="theme-toggle login-theme" role="group" aria-label="Colour mode">
        <button type="button" aria-pressed={theme === "light"} aria-label="Light mode" title="Light mode" onClick={() => setPref("light")}><IconSun /></button>
        <button type="button" aria-pressed={theme === "dark"} aria-label="Night mode" title="Night mode" onClick={() => setPref("dark")}><IconMoon /></button>
      </div>
      <form className="login glass" onSubmit={submit}>
        <div className="brand">
          <Logo />
          <div>
            <b>Dawn of Faith</b>
            <span>Production Hub</span>
          </div>
        </div>
        <div className="stack">
          <Field label="Email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" />
          </Field>
          <Field label="Password">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          {error && <div className="banner bad" role="alert">{error}</div>}
          <button className="btn primary" type="submit" style={{ justifyContent: "center" }}>Sign in</button>
        </div>
        <div className="demo-picks">
          <span className="muted" style={{ width: "100%", fontSize: ".82rem" }}>Demo sign-in (password: demo)</span>
          {DEMO.map((d) => (
            <button key={d.email} type="button" className="btn small" onClick={() => { setEmail(d.email); setPassword("demo"); setError(""); }}>
              {d.label}
            </button>
          ))}
          <button type="button" className="btn small ghost" onClick={() => { resetDemoData(); setError("Demo data restored."); }}>Restore demo data</button>
        </div>
      </form>
    </div>
  );
}
