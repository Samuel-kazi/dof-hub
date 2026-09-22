import { useState } from "react";
import { isRemote } from "../data/remote";
import { ConnectedAccounts, PasswordSettings } from "./Accounts";
import { ReportButton } from "../ui/ReportDialog";
import { useApp } from "../ui/AppContext";
import { getDb, resetDemoData, useDb } from "../data/store";
import { ROLES } from "../config/roles";
import { isHop } from "../services/access";
import { can, customisations } from "../services/wrapped/permissions";
import { changePassword, updateSettings } from "../services/wrapped/settings";
import { updateOwnProfile } from "../services/wrapped/people";
import { CATEGORIES } from "../config/categories";
import { DEFAULT_WORK_DAYS, effortFor, effortKey } from "../config/capacity";
import type { CategoryKey } from "../types";
import { nameOf } from "../services/wrapped/people";
import { useTheme } from "../ui/theme";
import { Field } from "../ui/parts";
import { Empty } from "../ui/parts";

export function Settings() {
  const { actor, me, attempt, confirm, go } = useApp();
  const custom = customisations();
  const db = useDb();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [hours, setHours] = useState(String(db.settings.stageReminderHours));
  const [days, setDays] = useState(String(db.settings.checkoutReturnDays));
  const [thr, setThr] = useState(String(db.settings.storageWarningThreshold));
  const hop = isHop(actor);
  const sys = can(actor, "backend.settings");
  const canAudit = can(actor, "backend.audit");
  const audit = [...getDb().audit].reverse().slice(0, 40);

  const { pref, setPref } = useTheme();
  const [workDays, setWorkDays] = useState<number[]>(db.settings.workDays ?? DEFAULT_WORK_DAYS);
  const [effort, setEffort] = useState<Record<string, string>>({});
  const effortValue = (cat: CategoryKey, stage: string): string => effort[effortKey(cat, stage)] ?? String(effortFor(cat, stage, db.settings.effortOverrides));
  const saveWorkload = () => {
    // Only the figures that differ from the built-in estimates are kept.
    const merged: Record<string, number> = { ...db.settings.effortOverrides };
    for (const [key, v] of Object.entries(effort)) {
      const [cat, ...rest] = key.split(":");
      const stage = rest.join(":");
      const n = Number(v);
      if (Number.isNaN(n)) continue;
      if (n === effortFor(cat as CategoryKey, stage)) delete merged[key];
      else merged[key] = n;
    }
    if (attempt(() => updateSettings(actor, { workDays, effortOverrides: merged }), "Saved")) setEffort({});
  };
  const [name, setName] = useState(me.name);
  const [email, setEmail] = useState(me.email);
  const [phone, setPhone] = useState(me.phone);
  return (
    <div className="page">
      <div><h1>Settings</h1><p className="sub">Your account{sys ? " and system defaults" : ""}.</p></div>

      <section className="glass panel">
        <h2>Appearance</h2>
        <div className="seg" role="group" aria-label="Theme">
          {([["dark", "Night"], ["light", "Light"], ["system", "Match my computer"]] as const).map(([k, label]) => <button key={k} className={pref === k ? "on" : ""} onClick={() => setPref(k)}>{label}</button>)}
        </div>
        <p className="muted" style={{ marginTop: 10 }}>The moon and sun button at the top switches quickly. Your choice is remembered on this computer.</p>
      </section>

      <section className="glass panel">
        <h2>Your account</h2>
        <div className="row" style={{ alignItems: "end" }}>
          <Field label="Your name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Email"><input type="text" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Phone"><input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <div style={{ flex: "none", minWidth: 0 }}><button className="btn primary" disabled={name === me.name && email === me.email && phone === me.phone} onClick={() => attempt(() => updateOwnProfile(actor, { name, email, phone }), "Profile saved")}>Save profile</button></div>
        </div>
        <dl className="kv" style={{ marginTop: 14 }}><dt>Person ID</dt><dd className="cid" style={{ fontSize: ".95rem" }}>{me.personId}</dd><dt>Access level</dt><dd>{ROLES[actor.role].label}<span className="muted" style={{ fontSize: ".84rem" }}> (set by the Head of Production)</span></dd></dl>
        <div className="row" style={{ marginTop: 16, alignItems: "end" }}>
          <Field label="Current password"><input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
          <Field label="New password"><input type="password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
          <div style={{ flex: "none", minWidth: 0 }}><button className="btn primary" onClick={() => { if (attempt(() => changePassword(actor, current, next), "Password changed")) { setCurrent(""); setNext(""); } }}>Change password</button></div>
        </div>
      </section>

      {isRemote() && <PasswordSettings username={me.username ?? ""} />}
      {isRemote() && <ConnectedAccounts />}
      <>
          {sys && <>
          <section className="glass panel">
            <h2>Reminders</h2>
            <div className="row" style={{ alignItems: "end" }}>
              <Field label="Remind people about a stage deadline this many hours ahead"><input type="text" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} /></Field>
              <div style={{ flex: "none", minWidth: 0 }}><button className="btn primary" onClick={() => attempt(() => updateSettings(actor, { stageReminderHours: Number(hours) }), "Saved")}>Save</button></div>
            </div>
          </section>

          <section className="glass panel">
            <h2>Equipment and storage</h2>
            <div className="row" style={{ alignItems: "end" }}>
              <Field label="Default days before checked-out gear is due back"><input type="text" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
              <Field label="Flag drives as nearly full at (percent)"><input type="text" inputMode="numeric" value={thr} onChange={(e) => setThr(e.target.value)} /></Field>
              <div style={{ flex: "none", minWidth: 0 }}><button className="btn primary" onClick={() => attempt(() => updateSettings(actor, { checkoutReturnDays: Number(days), storageWarningThreshold: Number(thr) }), "Saved")}>Save</button></div>
            </div>
          </section>

          <section className="glass panel" aria-label="Workload">
            <h2>Workload and capacity</h2>
            <p className="muted" style={{ marginBottom: 12 }}>How long each stage takes one person with nothing else on, in days. These feed the workload view, which shows who has too much on. Only the series editing figure (2 days) comes from the team. The others are starting estimates, so change them to match how you really work. Filming, recording and streaming stages are counted as shoot days.</p>
            <div className="chips" role="group" aria-label="Working days" style={{ marginBottom: 14 }}>
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => <button key={d} type="button" className={`chip ${workDays.includes(i) ? "on" : ""}`} onClick={() => setWorkDays(workDays.includes(i) ? workDays.filter((x) => x !== i) : [...workDays, i].sort())}>{d}</button>)}
            </div>
            <div className="effort-grid">
              {CATEGORIES.map((c) => (
                <div key={c.key}>
                  <h3 style={{ marginBottom: 6 }}>{c.label}</h3>
                  {c.stages.filter((st) => st.name !== c.footageStage).map((st) => (
                    <label key={st.name} className="effort-row">
                      <span>{st.name}</span>
                      <input type="number" min={0} max={30} step={0.25} value={effortValue(c.key, st.name)} onChange={(e) => setEffort({ ...effort, [effortKey(c.key, st.name)]: e.target.value })} aria-label={`${c.label} ${st.name} days`} />
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button className="btn primary" onClick={saveWorkload}>Save workload settings</button>
              <button className="btn ghost" onClick={() => { setEffort({}); attempt(() => updateSettings(actor, { effortOverrides: {}, workDays }), "Back to the built-in estimates"); }}>Use the built-in estimates</button>
            </div>
          </section>
          </>}

          {canAudit && <section className="glass panel">
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}><h2 style={{ flex: 1 }}>Recent changes</h2><ReportButton scope="audit" label="Report…" small /></div>
            {audit.length === 0 ? <Empty>Nothing has changed yet.</Empty> : (
              <table className="table">
                <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id}><td className="muted">{new Date(a.at).toLocaleString()}</td><td>{nameOf(a.byPersonId)}</td><td>{a.action} {a.entity} <span className="cid">{a.entityId}</span> <span className="muted">{a.detail}</span></td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>}

          {hop && <section className="glass panel" aria-label="Access">
            <h2>Access and permissions</h2>
            <p className="sub" style={{ marginBottom: 12 }}>Choose what crew, volunteers and partners can see and do, give one person more or less than their role, and decide who can see back end information.{custom.roles + custom.people > 0 ? ` ${custom.roles + custom.people} setting${custom.roles + custom.people === 1 ? "" : "s"} differ from the defaults.` : ""}</p>
            <button className="btn primary" onClick={() => go({ n: "access" })}>Manage access</button>
          </section>}

          {hop && !isRemote() && <section className="glass panel">
            <h2>Demo data</h2>
            <p className="sub" style={{ marginBottom: 12 }}>While the app is running on sample data, you can restore the starting set at any time.</p>
            <button className="btn danger" onClick={async () => { if (await confirm({ title: "Restore demo data?", body: "Everything you added or changed is replaced with the starting sample data.", confirmLabel: "Restore", danger: true })) resetDemoData(); }}>Restore demo data</button>
          </section>}
        </>
    </div>
  );
}
