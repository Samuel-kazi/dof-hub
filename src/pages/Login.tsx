import { useState } from "react";
import type { Actor } from "../types";
import { RuleError } from "../types";
import { login } from "../services/auth";
import { resetDemoData } from "../data/store";
import { Field } from "../ui/parts";
import { Logo } from "../ui/Logo";
import { IconMoon, IconSun } from "../ui/Icons";
import { useTheme } from "../ui/theme";
import { api, type SessionUser } from "../data/remote";

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

// ── Signing in to the server ─────────────────────────────────

function Frame({ children, onSubmit, title, note }: { children: React.ReactNode; onSubmit: (e: React.FormEvent) => void; title?: string; note?: string }) {
  const { theme, setPref } = useTheme();
  return (
    <div className="login-wrap">
      <div className="theme-toggle login-theme" role="group" aria-label="Colour mode">
        <button type="button" aria-pressed={theme === "light"} aria-label="Light mode" title="Light mode" onClick={() => setPref("light")}><IconSun /></button>
        <button type="button" aria-pressed={theme === "dark"} aria-label="Night mode" title="Night mode" onClick={() => setPref("dark")}><IconMoon /></button>
      </div>
      <form className="login glass" onSubmit={onSubmit}>
        <div className="brand"><Logo /><div><b>Dawn of Faith</b><span>Production Hub</span></div></div>
        {title && <h2 style={{ fontSize: "1.1rem", fontWeight: 500 }}>{title}</h2>}
        {note && <p className="muted" style={{ fontSize: ".88rem" }}>{note}</p>}
        <div className="stack">{children}</div>
      </form>
    </div>
  );
}

const message = (e: unknown): string => (e instanceof Error ? e.message : "Something went wrong. Try again.");

export function RemoteLogin({ onLogin }: { onLogin: (u: SessionUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try { onLogin((await api.post<{ user: SessionUser }>("/api/login", { username, password })).user); } catch (err) { setError(message(err)); setBusy(false); }
  };
  return (
    <Frame onSubmit={submit}>
      <Field label="Username"><input type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} /></Field>
      <Field label="Password"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
      {error && <div className="banner bad" role="alert">{error}</div>}
      <button className="btn primary" type="submit" disabled={busy || !username || !password} style={{ justifyContent: "center" }}>{busy ? "Signing in…" : "Sign in"}</button>
      <p className="muted" style={{ fontSize: ".82rem" }}>Forgotten your password? Ask the Head of Production for a new one.</p>
    </Frame>
  );
}

export function Setup({ onDone }: { onDone: (u: SessionUser) => void }) {
  const [f, setF] = useState({ token: "", name: "", username: "", password: "", again: "", samples: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string | boolean) => setF({ ...f, [k]: v });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.password !== f.again) { setError("The two passwords are not the same."); return; }
    setBusy(true); setError("");
    try { onDone((await api.post<{ user: SessionUser }>("/api/setup", { token: f.token, name: f.name, username: f.username, password: f.password, samples: f.samples })).user); } catch (err) { setError(message(err)); setBusy(false); }
  };
  return (
    <Frame onSubmit={submit} title="Set up the Production Hub" note="You are creating the Head of Production account, which can do everything. The setup code is the SETUP_TOKEN you added in Vercel.">
      <Field label="Setup code"><input type="password" value={f.token} onChange={(e) => set("token", e.target.value)} autoComplete="off" /></Field>
      <Field label="Your name"><input type="text" value={f.name} onChange={(e) => set("name", e.target.value)} autoComplete="name" /></Field>
      <Field label="Choose a username"><input type="text" value={f.username} onChange={(e) => set("username", e.target.value.toLowerCase())} autoComplete="username" autoCapitalize="none" spellCheck={false} /></Field>
      <Field label="Choose a password (at least 10 characters)"><input type="password" value={f.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" /></Field>
      <Field label="Type the password again"><input type="password" value={f.again} onChange={(e) => set("again", e.target.value)} autoComplete="new-password" /></Field>
      <label className="check"><input type="checkbox" checked={f.samples} onChange={(e) => set("samples", e.target.checked)} /> Start with sample projects, so I can look around</label>
      {error && <div className="banner bad" role="alert">{error}</div>}
      <button className="btn primary" type="submit" disabled={busy || !f.token || !f.name || !f.username || !f.password} style={{ justifyContent: "center" }}>{busy ? "Setting up…" : "Create the account"}</button>
    </Frame>
  );
}

/** Shown after signing in with a one-time password. Nothing else works until a new one is chosen. */
export function MustChange({ user, onDone }: { user: SessionUser; onDone: (u: SessionUser) => void }) {
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.next !== f.again) { setError("The two passwords are not the same."); return; }
    setBusy(true); setError("");
    try { await api.post("/api/account/password", { current: f.current, next: f.next }); onDone(user); } catch (err) { setError(message(err)); setBusy(false); }
  };
  return (
    <Frame onSubmit={submit} title={`Welcome, ${user.name.split(" ")[0]}`} note="You signed in with a one-time password. Choose your own now. Use at least 10 characters. A few words together work well.">
      <Field label="The one-time password"><input type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoComplete="current-password" /></Field>
      <Field label="Your new password"><input type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} autoComplete="new-password" /></Field>
      <Field label="Type it again"><input type="password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} autoComplete="new-password" /></Field>
      {error && <div className="banner bad" role="alert">{error}</div>}
      <button className="btn primary" type="submit" disabled={busy || !f.current || !f.next} style={{ justifyContent: "center" }}>{busy ? "Saving…" : "Save and continue"}</button>
    </Frame>
  );
}
