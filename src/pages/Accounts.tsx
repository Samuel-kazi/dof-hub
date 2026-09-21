import { useEffect, useState } from "react";
import type { Person } from "../types";
import { useApp } from "../ui/AppContext";
import { Modal } from "../ui/Modal";
import { Field } from "../ui/parts";
import { can } from "../services/permissions";
import { api, ApiError, isRemote } from "../data/remote";
import { fmtDateTime } from "../services/utils";

export const say = (e: unknown): string => (e instanceof Error ? e.message : "Something went wrong. Try again.");

/** A one-time password is shown once, here, and is not kept anywhere the Head of Production can look it up again. */
export function GivePassword({ title, username, password, onClose }: { title: string; username: string; password: string; onClose: () => void }) {
  const { toast } = useApp();
  return (
    <Modal title={title} onClose={onClose} actions={<><button className="btn" onClick={() => navigator.clipboard.writeText(`Username: ${username}\nOne-time password: ${password}`).then(() => toast("Copied", "success"))}>Copy</button><button className="btn primary" onClick={onClose}>Done</button></>}>
      <div className="stack">
        <dl className="kv"><dt>Username</dt><dd><b>{username}</b></dd><dt>One-time password</dt><dd><code style={{ fontSize: "1.1rem" }}>{password}</code></dd></dl>
        <p className="banner warn">Give this to the person now, in person or by a private message. It is shown only once. They will choose their own password when they first sign in.</p>
      </div>
    </Modal>
  );
}

/** Making, resetting and switching off someone's login. The password never passes through the app's own data. */
export function RemoteLoginPanel({ person }: { person: Person }) {
  const { actor, confirm, toast } = useApp();
  const manage = can(actor, "people.manage");
  const suggested = person.name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "").slice(0, 30);
  const [username, setUsername] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ title: string; username: string; password: string } | null>(null);
  const mine = actor.personId === person.personId;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast(say(e), "error"); } finally { setBusy(false); }
  };

  return (
    <section className="glass panel" aria-label="Login access">
      <h2>Login access</h2>
      {person.hasLogin ? (
        <div className="stack">
          <dl className="kv"><dt>Username</dt><dd>{person.username ?? "Hidden"}</dd><dt>Access level</dt><dd>{person.category}</dd><dt>State</dt><dd>{person.status !== "active" ? "Person is inactive" : person.loginOff ? "Login switched off" : "Can sign in"}</dd></dl>
          {mine && <p className="muted">Change your own password in Settings.</p>}
          {manage && !mine && person.category !== "HOP" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn small" disabled={busy} onClick={async () => { if (await confirm({ title: `Reset ${person.name.split(" ")[0]}'s password?`, body: "They are signed out on every device and need the new one-time password to get back in.", confirmLabel: "Reset" })) void run(async () => { const r = await api.post<{ username: string; temporaryPassword: string }>("/api/accounts/reset", { personId: person.personId }); setShown({ title: "New one-time password", username: r.username, password: r.temporaryPassword }); }); }}>Reset password</button>
              <button className="btn small" disabled={busy} onClick={() => void run(async () => { await api.post("/api/accounts/disable", { personId: person.personId, disabled: !person.loginOff }); toast(person.loginOff ? "Login switched on" : "Login switched off", "success"); })}>{person.loginOff ? "Switch login on" : "Switch login off"}</button>
              <button className="btn small ghost" disabled={busy} onClick={() => void run(async () => { await api.post("/api/accounts/signout", { personId: person.personId }); toast("Signed out everywhere", "success"); })}>Sign out everywhere</button>
            </div>
          )}
        </div>
      ) : (
        <div className="stack">
          <span className="muted">This person cannot sign in yet.</span>
          {manage && person.status === "active" && (
            <>
              <Field label="Username"><input type="text" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} autoCapitalize="none" spellCheck={false} /></Field>
              <div><button className="btn primary" disabled={busy || !username} onClick={() => void run(async () => { const r = await api.post<{ username: string; temporaryPassword: string }>("/api/accounts/create", { personId: person.personId, username }); setShown({ title: "Login created", username: r.username, password: r.temporaryPassword }); })}>Create login</button></div>
            </>
          )}
        </div>
      )}
      {shown && <GivePassword {...shown} onClose={() => setShown(null)} />}
    </section>
  );
}

/** Change your own password. */
export function PasswordSettings({ username }: { username: string }) {
  const { toast } = useApp();
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (f.next !== f.again) { toast("The two new passwords are not the same.", "error"); return; }
    setBusy(true);
    try { await api.post("/api/account/password", { current: f.current, next: f.next }); setF({ current: "", next: "", again: "" }); toast("Password changed. You are signed out on your other devices.", "success"); } catch (e) { toast(say(e), "error"); } finally { setBusy(false); }
  };
  return (
    <section className="glass panel" aria-label="Sign in">
      <h2>Sign in</h2>
      <p className="muted" style={{ margin: "6px 0 12px" }}>You sign in as <b>{username}</b>. Use at least 10 characters. A few words together make a good password.</p>
      <div className="row">
        <Field label="Current password"><input type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoComplete="current-password" /></Field>
        <Field label="New password"><input type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} autoComplete="new-password" /></Field>
        <Field label="Type it again"><input type="password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} autoComplete="new-password" /></Field>
      </div>
      <div style={{ marginTop: 12 }}><button className="btn primary" disabled={busy || !f.current || !f.next} onClick={submit}>Change password</button></div>
    </section>
  );
}

interface GoogleStatus { available: boolean; linked: boolean; email?: string; calendar?: boolean; gmail?: boolean; linkedAt?: string }

export function useGoogle(): [GoogleStatus | null, () => void] {
  const [g, setG] = useState<GoogleStatus | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => { if (!isRemote()) return; let live = true; api.get<{ google: GoogleStatus }>("/api/google/status").then((r) => live && setG(r.google)).catch(() => live && setG({ available: false, linked: false })); return () => { live = false; }; }, [n]);
  return [g, () => setN((x) => x + 1)];
}

/** Linking a Google account is optional, and the person chooses what it may be used for. */
export function ConnectedAccounts() {
  const { toast, confirm } = useApp();
  const [g, reload] = useGoogle();
  const [calendar, setCalendar] = useState(true);
  const [gmail, setGmail] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("google");
    if (!q) return;
    window.history.replaceState({}, "", window.location.pathname);
    if (q === "linked") toast("Google account linked", "success");
    else if (q === "denied") toast("You chose not to link Google. Nothing was changed.", "info");
    else toast("Google could not be linked. Try again.", "error");
  }, []);

  const go = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { toast(say(e), "error"); } finally { setBusy(false); } };
  if (!g) return null;

  return (
    <section className="glass panel" aria-label="Connected accounts">
      <h2>Connected accounts</h2>
      {!g.available ? (
        <p className="muted" style={{ marginTop: 8 }}>Linking a Google account is not switched on for this site yet. The Head of Production can turn it on. It is optional, and nothing in the app needs it.</p>
      ) : g.linked ? (
        <div className="stack" style={{ marginTop: 8 }}>
          <dl className="kv"><dt>Google account</dt><dd>{g.email}</dd><dt>Linked</dt><dd>{g.linkedAt ? fmtDateTime(g.linkedAt) : ""}</dd><dt>Allowed to</dt><dd>{[g.calendar && "add reminders to your calendar", g.gmail && "send reminder emails from your Gmail"].filter(Boolean).join(", ") || "Nothing yet"}</dd></dl>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {g.calendar && <button className="btn" disabled={busy} onClick={() => void go(async () => { const r = await api.post<{ added: number; already: number; failed: number }>("/api/google/calendar"); toast(r.failed ? `${r.added} added, ${r.failed} could not be added` : r.added ? `${r.added} reminder${r.added === 1 ? "" : "s"} added to your Google Calendar` : "Your calendar already has everything", r.failed ? "error" : "success"); })}>Add my reminders to Google Calendar</button>}
            <button className="btn ghost" disabled={busy} onClick={async () => { if (await confirm({ title: "Unlink your Google account?", body: "The app's access is cancelled at Google. Events already in your calendar stay there.", confirmLabel: "Unlink" })) void go(async () => { await api.post("/api/google/unlink"); reload(); toast("Google account unlinked", "success"); }); }}>Unlink</button>
          </div>
        </div>
      ) : (
        <div className="stack" style={{ marginTop: 8 }}>
          <p className="muted">Link your Google account only if you want to. Choose what it may be used for. You can unlink at any time.</p>
          <label className="check"><input type="checkbox" checked={calendar} onChange={(e) => setCalendar(e.target.checked)} /> Add my reminders to my Google Calendar</label>
          <label className="check"><input type="checkbox" checked={gmail} onChange={(e) => setGmail(e.target.checked)} /> Send reminder emails from my Gmail (for people who send reminders to the team)</label>
          <div><button className="btn primary" disabled={busy} onClick={() => void go(async () => { const r = await api.post<{ url: string }>("/api/google/link", { calendar, gmail }); window.location.href = r.url; })}>Link my Google account</button></div>
        </div>
      )}
    </section>
  );
}

export { ApiError };
