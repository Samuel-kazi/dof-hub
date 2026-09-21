import { useState } from "react";
import type { RoleCode } from "../types";
import { useApp } from "../ui/AppContext";
import { useDb, getDb } from "../data/store";
import { ROLES } from "../config/roles";
import { CAPABILITIES, DEFAULT_GRANTS, type Capability } from "../config/permissions";
import { Empty, Field } from "../ui/parts";
import { isHop } from "../services/access";
import { customisations, effectiveGrants, grantFor, resetPermissions, setPersonGrant, setRoleGrant } from "../services/wrapped/permissions";

const EDITABLE_ROLES: RoleCode[] = ["CRW", "VOL", "PTR"];
const groups = [...new Set(CAPABILITIES.map((c) => c.group))];

/** The Head of Production decides what each kind of person, and each person, can see and do. */
export function Access() {
  const { actor, go, attempt, confirm } = useApp();
  useDb();
  const [tab, setTab] = useState<"role" | "person">("role");
  const people = getDb().people.filter((p) => p.category !== "HOP" && p.status === "active").sort((a, b) => a.name.localeCompare(b.name));
  const [who, setWho] = useState(people[0]?.personId ?? "");
  if (!isHop(actor)) return <div className="page"><Empty>Only the Head of Production can change who can do what.</Empty></div>;
  const custom = customisations();
  const person = people.find((p) => p.personId === who);

  const setRole = (role: RoleCode, cap: Capability, value: boolean) => attempt(() => setRoleGrant(actor, role, cap, value === DEFAULT_GRANTS[role].includes(cap) ? null : value));

  return (
    <div className="page">
      <nav className="crumbs"><button onClick={() => go({ n: "settings" })}>Settings</button><span aria-hidden> / </span><span>Access and permissions</span></nav>
      <div className="page-head">
        <div className="grow">
          <h1>Access and permissions</h1>
          <p className="sub">You always have full access. Everyone else has what their role gives them, plus anything you add or take away for a person. Every change is written to the activity log.</p>
        </div>
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={tab === "role"} className={tab === "role" ? "on" : ""} onClick={() => setTab("role")}>By role</button>
          <button role="tab" aria-selected={tab === "person"} className={tab === "person" ? "on" : ""} onClick={() => setTab("person")}>By person</button>
        </div>
        <button className="btn danger" disabled={custom.roles + custom.people === 0} onClick={async () => { if (await confirm({ title: "Go back to the defaults?", body: "Every change you made for a role or a person is removed.", confirmLabel: "Reset", danger: true })) attempt(() => resetPermissions(actor), "Back to the defaults"); }}>Reset to defaults</button>
      </div>

      {tab === "role" ? (
        <section className="glass panel">
          <p className="muted" style={{ marginBottom: 12 }}>These are the defaults for everyone in that role. A dot marks a setting you changed.</p>
          <table className="table">
            <thead><tr><th>What they can do</th><th>Head of Production</th>{EDITABLE_ROLES.map((r) => <th key={r}>{ROLES[r].label}</th>)}</tr></thead>
            <tbody>
              {groups.flatMap((g) => [
                <tr key={g}><td colSpan={2 + EDITABLE_ROLES.length} style={{ paddingTop: 20, fontWeight: 600 }}>{g}</td></tr>,
                ...CAPABILITIES.filter((c) => c.group === g).map((c) => (
                  <tr key={c.key}>
                    <td><div>{c.label}</div><div className="muted" style={{ fontSize: ".82rem", maxWidth: 520 }}>{c.hint}</div></td>
                    <td><input type="checkbox" checked disabled aria-label={`${c.label}, Head of Production, always`} /></td>
                    {EDITABLE_ROLES.map((r) => {
                      const cur = grantFor(r, null, c.key);
                      return (
                        <td key={r}>
                          <label className="check"><input type="checkbox" checked={cur.value} aria-label={`${c.label}, ${ROLES[r].label}`} onChange={(e) => setRole(r, c.key, e.target.checked)} />{cur.source === "role" && <span title="Changed from the default" style={{ color: "var(--accent-hi)" }}>●</span>}</label>
                        </td>
                      );
                    })}
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </section>
      ) : (
        <section className="glass panel">
          <div className="row" style={{ marginBottom: 14 }}>
            <Field label="Person">
              <select value={who} onChange={(e) => setWho(e.target.value)}>{people.map((p) => <option key={p.personId} value={p.personId}>{p.name}, {ROLES[p.category].label}</option>)}</select>
            </Field>
          </div>
          {!person ? <Empty>There is no one to choose.</Empty> : (
            <table className="table">
              <thead><tr><th>What they can do</th><th>{ROLES[person.category].label} default</th><th>For {person.name.split(" ")[0]}</th><th>Result</th></tr></thead>
              <tbody>
                {groups.flatMap((g) => [
                  <tr key={g}><td colSpan={4} style={{ paddingTop: 20, fontWeight: 600 }}>{g}</td></tr>,
                  ...CAPABILITIES.filter((c) => c.group === g).map((c) => {
                    const base = grantFor(person.category, null, c.key).value;
                    const eff = effectiveGrants(person.category, person.personId)[c.key];
                    const current = eff.source === "person" ? (eff.value ? "allow" : "deny") : "role";
                    return (
                      <tr key={c.key}>
                        <td><div>{c.label}</div><div className="muted" style={{ fontSize: ".82rem", maxWidth: 480 }}>{c.hint}</div></td>
                        <td>{base ? "Yes" : "No"}</td>
                        <td>
                          <select value={current} aria-label={`${c.label} for ${person.name}`} onChange={(e) => attempt(() => setPersonGrant(actor, person.personId, c.key, e.target.value === "role" ? null : e.target.value === "allow"))} style={{ width: 190 }}>
                            <option value="role">Use the role default</option>
                            <option value="allow">Allow</option>
                            <option value="deny">Do not allow</option>
                          </select>
                        </td>
                        <td><span className={`badge ${eff.value ? "ok" : ""}`}>{eff.value ? "Can" : "Cannot"}</span></td>
                      </tr>
                    );
                  }),
                ])}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
