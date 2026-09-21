import { useState } from "react";
import type { ContentRecord, Featured } from "../types";
import { useApp } from "../ui/AppContext";
import { Field } from "../ui/parts";
import { IconPlus } from "../ui/Icons";
import { canWrite } from "../services/access";
import { addFeatured, featuredFor, removeFeatured, updateFeatured } from "../services/wrapped/content";

/** Hosts and guests. Hosts of the show carry down to its episodes. Guests are listed where they appear. */
export function CastPanel({ rec }: { rec: ContentRecord }) {
  const { actor, attempt } = useApp();
  const write = canWrite(actor, rec);
  const { own, inherited } = featuredFor(rec);
  const [kind, setKind] = useState<Featured["kind"]>("guest");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const hosts = own.filter((f) => f.kind === "host");
  const guests = own.filter((f) => f.kind === "guest");
  const add = () => { if (attempt(() => addFeatured(actor, rec.contentId, { kind, name, note }), kind === "host" ? "Host added" : "Guest added")) { setName(""); setNote(""); } };

  const row = (f: Featured) => (
    <div key={f.id} className="list-item" style={{ cursor: "default" }}>
      <div className="grow">
        <div className="title">{f.name}</div>
        {write ? (
          <input type="text" defaultValue={f.note} placeholder="Title or organisation" aria-label={`Note for ${f.name}`} style={{ marginTop: 4, padding: "5px 10px", fontSize: ".86rem" }} onBlur={(e) => e.target.value !== f.note && attempt(() => updateFeatured(actor, rec.contentId, f.id, { note: e.target.value }))} />
        ) : f.note ? <div className="muted" style={{ fontSize: ".84rem" }}>{f.note}</div> : null}
      </div>
      {write && <button className="btn small ghost" onClick={() => attempt(() => removeFeatured(actor, rec.contentId, f.id), "Removed")}>Remove</button>}
    </div>
  );

  return (
    <section className="glass panel" aria-label="Hosts and guests">
      <h2 style={{ marginBottom: 12 }}>Hosts and guests</h2>
      <div className="grid-2" style={{ gap: 24 }}>
        <div>
          <h3 style={{ marginBottom: 6 }}>Hosts</h3>
          {inherited.map(({ person, from }) => (
            <div key={person.id} className="list-item" style={{ cursor: "default" }}>
              <div className="grow"><div className="title">{person.name}</div><div className="muted" style={{ fontSize: ".84rem" }}>Host of {from.title}{person.note ? `, ${person.note}` : ""}</div></div>
            </div>
          ))}
          {hosts.map(row)}
          {hosts.length + inherited.length === 0 && <p className="muted">No hosts listed.</p>}
        </div>
        <div>
          <h3 style={{ marginBottom: 6 }}>Guests</h3>
          {guests.map(row)}
          {guests.length === 0 && <p className="muted">No guests listed.</p>}
        </div>
      </div>
      {write && (
        <div className="task-add" style={{ marginTop: 14 }}>
          <div className="seg" role="group" aria-label="Host or guest">
            <button type="button" className={kind === "host" ? "on" : ""} onClick={() => setKind("host")}>Host</button>
            <button type="button" className={kind === "guest" ? "on" : ""} onClick={() => setKind("guest")}>Guest</button>
          </div>
          <Field label="Name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} /></Field>
          <Field label="Title or organisation (optional)"><input type="text" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} /></Field>
          <div style={{ flex: "none", minWidth: 0 }}><button className="btn primary" onClick={add}><IconPlus /> Add</button></div>
        </div>
      )}
    </section>
  );
}
