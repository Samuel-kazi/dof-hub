import { useState } from "react";
import type { Person, RoleCode } from "../types";
import { useApp } from "../ui/AppContext";
import { getDb, useDb } from "../data/store";
import { ROLES } from "../config/roles";
import { redactPerson } from "../services/access";
import { can } from "../services/permissions";
import { assignToProject, createLoginForPerson, createPerson, deactivatePerson, getPerson, projectHistory, reactivatePerson, removeFromProject, updatePerson, updatePersonCategory } from "../services/people";
import { fmtShort } from "../services/utils";
import { Modal } from "../ui/Modal";
import { RolePicker } from "../ui/RolePicker";
import { Empty, Field } from "../ui/parts";
import { IconPlus } from "../ui/Icons";
import { WorkloadTab, PersonWorkload } from "./Workload";
import { rolesOnProject } from "../services/team";

type Tab = "crew" | "volunteers" | "partners" | "workload";
const TAB_ROLE: Record<Exclude<Tab, "workload">, RoleCode> = { crew: "CRW", volunteers: "VOL", partners: "PTR" };
const TAB_LABEL: Record<Tab, string> = { crew: "Active crew", volunteers: "Volunteers", partners: "Partners", workload: "Workload" };

export function Crew({ tab: initial }: { tab?: Tab }) {
  const { actor, go, menu, attempt, confirm } = useApp();
  useDb();
  const [tab, setTab] = useState<Tab>(initial ?? "crew");
  const [adding, setAdding] = useState(false);
  const hop = can(actor, "people.manage");
  const showLogin = can(actor, "people.loginStatus");
  const tabs: Tab[] = can(actor, "people.contacts") || hop ? ["crew", "volunteers", "partners", "workload"] : ["crew", "volunteers", "workload"];
  const rows = tab === "workload" ? [] : getDb().people.filter((p) => p.category === TAB_ROLE[tab]).sort((a, b) => a.personId.localeCompare(b.personId));

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>People</h1>
          <p className="sub">{hop ? "Add people, give logins, and attach them to projects." : "Crew and volunteers. Volunteer contact details stay private."}</p>
        </div>
        <div className="seg" role="tablist">
          {tabs.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{TAB_LABEL[t]}</button>)}
        </div>
        {hop && tab !== "workload" && <button className="btn primary" onClick={() => setAdding(true)}><IconPlus /> Add person</button>}
      </div>
      {tab === "workload" ? <WorkloadTab /> : (
      <section className="glass panel">
        {rows.length === 0 ? <Empty>No one in this list yet.</Empty> : (
          <table className="table">
            <thead><tr><th>Person ID</th><th>Name</th><th>Skills</th><th>Status</th>{showLogin && <th>Login</th>}</tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.personId}
                  className="clickable"
                  onClick={() => go({ n: "person", id: p.personId })}
                  onContextMenu={(e) =>
                    menu(e, [
                      { label: "Open profile", onClick: () => go({ n: "person", id: p.personId }) },
                      ...(hop
                        ? [
                            ...(p.category === "VOL" ? [{ label: "Promote to crew", onClick: () => attempt(() => updatePersonCategory(actor, p.personId, "CRW"), `${p.name} is now crew`) }] : []),
                            p.status === "active"
                              ? { label: "Deactivate", danger: true, onClick: async () => { if (await confirm({ title: `Deactivate ${p.name}?`, body: "They keep their history on past projects and call sheets, but can no longer sign in or be assigned.", confirmLabel: "Deactivate", danger: true })) attempt(() => deactivatePerson(actor, p.personId), "Deactivated"); } }
                              : { label: "Reactivate", onClick: () => attempt(() => reactivatePerson(actor, p.personId), "Reactivated") },
                          ]
                        : []),
                    ])
                  }
                >
                  <td><span className="cid">{p.personId}</span></td>
                  <td>{p.name}</td>
                  <td className="muted">{p.skills.join(", ") || "None listed"}</td>
                  <td><span className={`badge ${p.status === "active" ? "ok" : ""}`}>{p.status === "active" ? "Active" : "Inactive"}</span></td>
                  {showLogin && <td>{p.hasLogin ? <span className="badge accent">Has login</span> : <span className="muted">No login</span>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      )}
      {adding && tab !== "workload" && <AddPersonModal defaultCategory={TAB_ROLE[tab] as "CRW" | "VOL" | "PTR"} onClose={() => setAdding(false)} onCreated={(p) => { setAdding(false); go({ n: "person", id: p.personId }); }} />}
    </div>
  );
}

function AddPersonModal({ defaultCategory, onClose, onCreated }: { defaultCategory: "CRW" | "VOL" | "PTR"; onClose: () => void; onCreated: (p: Person) => void }) {
  const { actor, attempt } = useApp();
  const [category, setCategory] = useState<"CRW" | "VOL" | "PTR">(defaultCategory);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [skills, setSkills] = useState("");
  const [familiar, setFamiliar] = useState("");
  const [login, setLogin] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [password, setPassword] = useState("");
  const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  const save = () => {
    const p = attempt(
      () => createPerson(actor, { category, name, email, phone, skills: split(skills), equipmentFamiliarity: category === "CRW" ? split(familiar) : [] }, login ? { email: loginEmail || email, password } : undefined),
      "Person added",
    );
    if (p) onCreated(p);
  };

  return (
    <Modal title="Add a person" onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save person</button></>}>
      <div className="stack">
        <div className="seg" role="group" aria-label="Category">
          {(["CRW", "VOL", "PTR"] as const).map((c) => <button key={c} type="button" className={category === c ? "on" : ""} onClick={() => setCategory(c)}>{ROLES[c].label}</button>)}
        </div>
        <Field label="Full name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <div className="row">
          <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Phone"><input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        </div>
        <Field label="Skills (separate with commas)"><input type="text" value={skills} onChange={(e) => setSkills(e.target.value)} /></Field>
        {category === "CRW" && <Field label="Equipment they know (separate with commas)"><input type="text" value={familiar} onChange={(e) => setFamiliar(e.target.value)} /></Field>}
        <label className="check"><input type="checkbox" checked={login} onChange={(e) => setLogin(e.target.checked)} /> Create login access for this person</label>
        {login && (
          <div className="row">
            <Field label="Login email"><input type="email" value={loginEmail} placeholder={email} onChange={(e) => setLoginEmail(e.target.value)} /></Field>
            <Field label="Starting password"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          </div>
        )}
        <p className="muted">Their Person ID is generated when you save and never changes, even if their category does.</p>
      </div>
    </Modal>
  );
}

export function PersonPage({ id }: { id: string }) {
  const { actor, go, attempt, confirm, menu } = useApp();
  useDb();
  const [assigning, setAssigning] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const raw = getPerson(id);
  if (!raw) return <div className="page"><Empty>This person does not exist.</Empty></div>;
  const p = redactPerson(actor, raw);
  const hop = can(actor, "people.manage");
  const showLogin = can(actor, "people.loginStatus") || actor.personId === id;
  const history = projectHistory(id);
  const user = getDb().users.find((u) => u.personId === id);

  return (
    <div className="page">
      <nav className="crumbs"><button onClick={() => go({ n: "crew" })}>People</button><span aria-hidden> / </span><span>{p.name}</span></nav>
      <div className="page-head">
        <div className="grow">
          <h1>{p.name}</h1>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
            <span className="cid">{p.personId}</span>
            <span className="badge accent">{ROLES[p.category].label}</span>
            <span className={`badge ${p.status === "active" ? "ok" : ""}`}>{p.status === "active" ? "Active" : "Inactive"}</span>
          </div>
        </div>
        {hop && p.category === "VOL" && <button className="btn primary" onClick={() => attempt(() => updatePersonCategory(actor, id, "CRW"), `${p.name} is now crew. Their ID stays ${id}.`)}>Promote to crew</button>}
        {hop && p.category !== "HOP" && <button className="btn" onClick={() => setEditing(true)}>Edit</button>}
        {hop && p.category !== "HOP" && (p.status === "active" ? (
          <button className="btn danger" onClick={async () => { if (await confirm({ title: `Deactivate ${p.name}?`, body: "They keep their history on past projects and call sheets, but can no longer sign in or be assigned.", confirmLabel: "Deactivate", danger: true })) attempt(() => deactivatePerson(actor, id), "Deactivated"); }}>Deactivate</button>
        ) : (
          <button className="btn" onClick={() => attempt(() => reactivatePerson(actor, id), "Reactivated")}>Reactivate</button>
        ))}
      </div>

      <div className="grid-2">
        <section className="glass panel">
          <h2>Profile</h2>
          <dl className="kv">
            <dt>Email</dt><dd>{p.email || <span className="muted">None</span>}</dd>
            <dt>Phone</dt><dd>{p.phone || <span className="muted">None</span>}</dd>
            <dt>Skills</dt><dd>{p.skills.join(", ") || <span className="muted">None listed</span>}</dd>
            {p.category === "CRW" && (<><dt>Equipment they know</dt><dd>{p.equipmentFamiliarity.join(", ") || <span className="muted">None listed</span>}</dd></>)}
            <dt>Joined</dt><dd>{fmtShort(p.createdAt)}</dd>
          </dl>
          {p.email === "Hidden" && actor.personId !== p.personId && <p className="muted" style={{ marginTop: 10, fontSize: ".84rem" }}>Contact details are private to the Head of Production.</p>}
        </section>
        {showLogin && <section className="glass panel">
          <h2>Login access</h2>
          {user ? (
            <dl className="kv"><dt>Login email</dt><dd>{hop || actor.personId === id ? user.email : "Hidden"}</dd><dt>Access level</dt><dd>{ROLES[user.role].label}</dd><dt>State</dt><dd>{user.active ? "Can sign in" : "Deactivated"}</dd></dl>
          ) : (
            <div className="stack">
              <span className="muted">This person cannot sign in.</span>
              {hop && p.category !== "HOP" && <div><button className="btn" onClick={() => setLoginOpen(true)}>Create login</button></div>}
            </div>
          )}
        </section>}
      </div>

      <section className="glass panel">
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ flex: 1 }}>Projects</h2>
          {hop && p.category !== "HOP" && <button className="btn small" onClick={() => setAssigning(true)}><IconPlus /> Attach to project</button>}
        </div>
        {history.length === 0 ? <Empty>Not attached to any project yet.</Empty> : (
          <table className="table">
            <thead><tr><th>Project</th><th>Role on project</th><th>Can comment</th></tr></thead>
            <tbody>
              {history.map(({ member, record }) => (
                <tr key={member.projectContentId} className="clickable" onClick={() => go({ n: "record", id: record.contentId })}
                  onContextMenu={(e) => hop && menu(e, [{ label: "Remove from project", danger: true, onClick: async () => { if (await confirm({ title: `Remove ${p.name} from ${record.title}?`, body: "They lose access to this project immediately.", confirmLabel: "Remove", danger: true })) attempt(() => removeFromProject(actor, id, record.contentId), "Removed"); } }])}>
                  <td><div>{record.title}</div><span className="cid">{record.contentId}</span></td>
                  <td>{rolesOnProject(id, record).join(", ") || member.roleOnProject}</td>
                  <td>{member.canComment ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {hop && history.length > 0 && <p className="muted" style={{ marginTop: 10, fontSize: ".84rem" }}>Right-click a project to remove access.</p>}
      </section>

      <PersonWorkload personId={id} />

      {assigning && <AssignModal personId={id} onClose={() => setAssigning(false)} />}
      {loginOpen && <LoginModal person={raw} onClose={() => setLoginOpen(false)} />}
      {editing && <EditPersonModal person={raw} onClose={() => setEditing(false)} />}
    </div>
  );
}

function AssignModal({ personId, onClose }: { personId: string; onClose: () => void }) {
  const { actor, attempt } = useApp();
  const projects = getDb().records.filter((r) => r.hierarchyLevel === 0 && !r.archived);
  const [project, setProject] = useState(projects[0]?.contentId ?? "");
  const [roles, setRoles] = useState<string[]>([]);
  const [canComment, setCanComment] = useState(true);
  return (
    <Modal title="Attach to project" onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => { if (attempt(() => assignToProject(actor, personId, project, roles.join(", "), canComment), "Attached")) onClose(); }}>Attach</button></>}>
      <div className="stack">
        <Field label="Project"><select value={project} onChange={(e) => setProject(e.target.value)}>{projects.map((r) => <option key={r.contentId} value={r.contentId}>{r.title}</option>)}</select></Field>
        <div><div style={{ fontSize: ".86rem", color: "var(--ink-2)", marginBottom: 5 }}>Roles on this project</div><RolePicker value={roles} onChange={setRoles} /></div>
        <label className="check"><input type="checkbox" checked={canComment} onChange={(e) => setCanComment(e.target.checked)} /> Can comment on this project</label>
        <p className="muted">Attaching someone to a show also covers every season and episode under it.</p>
      </div>
    </Modal>
  );
}

function LoginModal({ person, onClose }: { person: Person; onClose: () => void }) {
  const { actor, attempt } = useApp();
  const [email, setEmail] = useState(person.email);
  const [password, setPassword] = useState("");
  return (
    <Modal title={`Create login for ${person.name}`} onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => { if (attempt(() => createLoginForPerson(actor, person.personId, email, password), "Login created")) onClose(); }}>Create login</button></>}>
      <div className="stack">
        <Field label="Login email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Starting password"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <p className="muted">Their access level follows their category: {ROLES[person.category].label}.</p>
      </div>
    </Modal>
  );
}

function EditPersonModal({ person, onClose }: { person: Person; onClose: () => void }) {
  const { actor, attempt } = useApp();
  const [name, setName] = useState(person.name);
  const [email, setEmail] = useState(person.email);
  const [phone, setPhone] = useState(person.phone);
  const [skills, setSkills] = useState(person.skills.join(", "));
  const [familiar, setFamiliar] = useState(person.equipmentFamiliarity.join(", "));
  const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  return (
    <Modal title={`Edit ${person.name}`} onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => { if (attempt(() => updatePerson(actor, person.personId, { name, email, phone, skills: split(skills), equipmentFamiliarity: split(familiar) }), "Saved")) onClose(); }}>Save changes</button></>}>
      <div className="stack">
        <Field label="Full name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="row">
          <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Phone"><input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        </div>
        <Field label="Skills"><input type="text" value={skills} onChange={(e) => setSkills(e.target.value)} /></Field>
        {person.category === "CRW" && <Field label="Equipment they know"><input type="text" value={familiar} onChange={(e) => setFamiliar(e.target.value)} /></Field>}
      </div>
    </Modal>
  );
}
