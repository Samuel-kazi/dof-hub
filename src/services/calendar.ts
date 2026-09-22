import { useMemo, useState } from "react";
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
import type { CategoryKey, FontPairing, FontSizeToken } from "../types";
import { nameOf } from "../services/wrapped/people";
import { ACCENT_OPTIONS, DEFAULT_PERSON_APPEARANCE, FONT_OPTIONS, FONT_SIZE_OPTIONS, applyAppearance } from "../ui/theme";
import { Field, Initials } from "../ui/parts";
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
  const [workDays, setWorkDays] = useState<number[]>(db.settings.workDays ?? DEFAULT_WORK_DAYS);
  const [effort, setEffort] = useState<Record<string, string>>({});
  const workspaceAccent = db.settings.workspaceAppearance?.accentColor ?? "terracotta";
  const workspaceFont = db.settings.workspaceAppearance?.fontPairing ?? "modern";
  const personAppearance = { ...DEFAULT_PERSON_APPEARANCE, ...(me.appearance ?? {}) };
  const [accent, setAccent] = useState(workspaceAccent);
  const [fontPairing, setFontPairing] = useState<FontPairing>(workspaceFont);
  const [fontSize, setFontSize] = useState<FontSizeToken>(personAppearance.fontSize);
  const [density, setDensity] = useState(personAppearance.density);
  const [avatarUrl, setAvatarUrl] = useState(personAppearance.photoUrl ?? "");
  const [name, setName] = useState(me.name);
  const [email, setEmail] = useState(me.email);
  const [phone, setPhone] = useState(me.phone);

  applyAppearance(me, db.settings);

  const effortValue = (cat: CategoryKey, stage: string): string => effort[effortKey(cat, stage)] ?? String(effortFor(cat, stage, db.settings.effortOverrides));
  const saveWorkload = () => {
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

  const saveWorkspace = () => {
    if (!hop) return;
    attempt(() => updateSettings(actor, { workspaceAppearance: { accentColor: accent, fontPairing } }), "Workspace appearance saved");
  };

  const saveProfileAppearance = () => {
    attempt(() => updateOwnProfile(actor, { appearance: { fontSize, density, photoUrl: avatarUrl || null } }), "Profile appearance saved");
  };

  const onAvatarPick = (file?: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setAvatarUrl(String(reader.result ?? ""));
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="page">
      <div><h1>Settings</h1><p className="sub">Your account{sys ? " and system defaults" : ""}.</p></div>

      <section className="glass panel">
        <h2>Appearance</h2>
        <div className="stack" style={{ gap: 18 }}>
          <div>
            <p className="muted" style={{ marginBottom: 8 }}>Accent color</p>
            <div className="swatches" role="group" aria-label="Accent color">
              {Object.entries(ACCENT_OPTIONS).map(([key, value]) => (
                <button key={key} type="button" className={`swatch ${accent === key ? "on" : ""}`} style={{ background: `linear-gradient(135deg, ${value.value}, ${value.hi})` }} onClick={() => setAccent(key as typeof accent)} aria-label={value.label} title={value.label} />
              ))}
            </div>
          </div>
          <div>
            <p className="muted" style={{ marginBottom: 8 }}>Font pairing</p>
            <div className="font-grid">
              {Object.entries(FONT_OPTIONS).map(([key, value]) => (
                <button key={key} type="button" className={`font-choice ${fontPairing === key ? "on" : ""}`} style={{ fontFamily: value.family }} onClick={() => setFontPairing(key as FontPairing)}>
                  {value.label} Sample
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="field"><span>Font size</span><input type="range" min={0} max={3} step={1} value={Object.keys(FONT_SIZE_OPTIONS).indexOf(fontSize)} onChange={(e) => setFontSize(Object.keys(FONT_SIZE_OPTIONS)[Number(e.target.value)] as FontSizeToken)} /></label>
            <p className="type-sample" style={{ fontFamily: FONT_OPTIONS[fontPairing].family, fontSize: `${FONT_SIZE_OPTIONS[fontSize].px}px` }}>This is the sample text for your workspace.</p>
          </div>
          <div>
            <p className="muted" style={{ marginBottom: 8 }}>Density</p>
            <div className="seg" role="group" aria-label="Density">
              {(["comfortable", "compact"] as const).map((opt) => <button key={opt} className={density === opt ? "on" : ""} onClick={() => setDensity(opt)}>{opt === "comfortable" ? "Comfortable" : "Compact"}</button>)}
            </div>
          </div>
          {(sys || true) && <div className="row" style={{ justifyContent: "flex-end" }}>
            {sys && <button className="btn primary" onClick={saveWorkspace}>Save workspace appearance</button>}
            <button className="btn primary" onClick={saveProfileAppearance}>Save my preferences</button>
          </div>}
        </div>
      </section>

      <section className="glass panel">
        <h2>Your account</h2>
        <div className="row" style={{ alignItems: "end" }}>
          <div className="profile-upload">
            <label className="avatar-picker">
              <input type="file" accept="image/*" onChange={(e) => onAvatarPick(e.target.files?.[0])} />
              <Initials name={name || me.name} photoUrl={avatarUrl || me.appearance?.photoUrl} accent={accent} />
            </label>
          </div>
          <Field label="Your name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Email"><input type="text" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Phone"><input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <div style={{ flex: "none", minWidth: 0 }}><button className="btn primary" disabled={name === me.name && email === me.email && phone === me.phone} onClick={() => attempt(() => updateOwnProfile(actor, { name, email, phone }), "Profile saved")}>Save</button></div>
        </div>
        <dl className="kv" style={{ marginTop: 14 }}><dt>Person ID</dt><dd className="cid" style={{ fontSize: ".95rem" }}>{me.personId}</dd><dt>Access level</dt><dd>{ROLES[actor.role].label}<span className="muted">{actor.role === "HOP" ? " (Head of Production)" : ""}</span></dd></dl>
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
            <p className="muted" style={{ marginBottom: 12 }}>How long each stage takes one person with nothing else on, in days. These feed the workload view, which shows who has too much on. Once saved, the defaults remain but individual overrides are kept per category and stage.</p>
            <div className="chips" role="group" aria-label="Working days" style={{ marginBottom: 14 }}>
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => <button key={d} type="button" className={`chip ${workDays.includes(i) ? "on" : ""}`} onClick={() => setWorkDays((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i])}>{d}</button>)}
            </div>
            <div className="effort-grid">
              {CATEGORIES.map((c) => (
                <div key={c.key}>
                  <h3 style={{ marginBottom: 6 }}>{c.label}</h3>
                  {c.stages.filter((st) => st.name !== c.footageStage).map((st) => (
                    <label key={st.name} className="effort-row">
                      <span>{st.name}</span>
                      <input type="number" min={0} max={30} step={0.25} value={effortValue(c.key, st.name)} onChange={(e) => setEffort({ ...effort, [effortKey(c.key, st.name)]: e.target.value })} />
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
                  <tr key={a.id}><td className="muted">{new Date(a.at).toLocaleString()}</td><td>{nameOf(a.byPersonId)}</td><td>{a.action} {a.entity} <span className="cid">{a.entityId}</span> {a.detail}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>}
      </>
    </div>
  );
}
