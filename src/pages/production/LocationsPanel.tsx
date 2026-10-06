import { useState } from "react";
import { useDb } from "../../data/store";
import {
  archiveLocation,
  canKeepLocations,
  createLocation,
  listLocations,
  sheetsUsing,
  updateLocation,
} from "../../services/wrapped/locations";
import { todayIso } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { Empty, Field } from "../../ui/parts";
import { SavedInput } from "../documents/toolkit";
import { SavedText } from "./SheetSections";

// The saved locations any call sheet can pick from: kept by the Head of Production and crew, seen by everyone who
// works on sheets. Archived ones are hidden from the pickers and can be brought back.

export function LocationsPanel() {
  const { actor, attempt } = useApp();
  useDb();
  const keep = canKeepLocations(actor);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const all = listLocations(true);
  const active = all.filter((l) => !l.archived);
  const list = showArchived ? all : active;
  const today = todayIso();
  const add = () => {
    if (attempt(() => createLocation(actor, { name, address }), "Location saved")) {
      setName("");
      setAddress("");
    }
  };
  return (
    <details className="glass panel" aria-label="Saved locations">
      <summary>
        <b>Saved locations</b> <span className="muted">({active.length})</span>
        <span className="muted"> · pick one on any call sheet's Location section</span>
      </summary>
      {list.length === 0 ? (
        <Empty>
          No saved locations yet.{keep ? " Add the places you film often here, or save one from a call sheet's Location section." : ""}
        </Empty>
      ) : (
        <ul className="loc-list">
          {list.map((l) => {
            const using = sheetsUsing(l.id, today);
            return (
              <li key={l.id} className={l.archived ? "archived" : ""}>
                <SavedInput
                  aria-label={`Name of ${l.name}`}
                  value={l.name}
                  disabled={!keep || l.archived}
                  maxLength={200}
                  onSave={(v) => v.trim() && v.trim() !== l.name && attempt(() => updateLocation(actor, l.id, { name: v }), "Saved")}
                />
                <SavedText
                  label={`Address of ${l.name}`}
                  value={l.address}
                  placeholder="Address"
                  disabled={!keep || l.archived}
                  rows={2}
                  onSave={(v) => attempt(() => updateLocation(actor, l.id, { address: v }), "Saved")}
                />
                <SavedText
                  label={`Notes on ${l.name}`}
                  value={l.notes}
                  placeholder="Parking, the gate, who has the key"
                  disabled={!keep || l.archived}
                  rows={2}
                  onSave={(v) => attempt(() => updateLocation(actor, l.id, { notes: v }), "Saved")}
                />
                <div className="stack" style={{ gap: 4 }}>
                  {using > 0 && (
                    <small className="muted">
                      On {using} coming sheet{using === 1 ? "" : "s"}
                    </small>
                  )}
                  {keep &&
                    (l.archived ? (
                      <button className="btn small" onClick={() => attempt(() => archiveLocation(actor, l.id, false), "Brought back")}>
                        Bring back
                      </button>
                    ) : (
                      <button
                        className="btn small ghost"
                        onClick={() => attempt(() => archiveLocation(actor, l.id, true), "Taken off the list. Sheets using it keep it.")}
                      >
                        Archive
                      </button>
                    ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {all.length > active.length && (
        <button className="btn small ghost" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived}>
          {showArchived ? "Hide archived" : `Show archived (${all.length - active.length})`}
        </button>
      )}
      {keep && (
        <div className="row cs-add">
          <Field label="New location">
            <input type="text" value={name} maxLength={200} placeholder="Church hall" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Address">
            <input type="text" value={address} placeholder="Street, area" onChange={(e) => setAddress(e.target.value)} />
          </Field>
          <div style={{ flex: "none" }}>
            <button className="btn" disabled={!name.trim()} onClick={add}>
              + Save location
            </button>
          </div>
        </div>
      )}
      <p className="muted" style={{ fontSize: ".84rem" }}>
        A sheet keeps its own copy of the place it picked, so changing a saved location here does not change sheets already made.
      </p>
    </details>
  );
}
