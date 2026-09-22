import type { ReactNode } from "react";
import { useRef, useState } from "react";
import type { ContentRecord, Person } from "../types";
import { isComplete, riskOf } from "../services/wrapped/content";
import { fileToDataUrl } from "./Photos";

export function RiskBadge({ record }: { record: ContentRecord }) {
  const r = riskOf(record);
  if (r === "done") return <span className="badge ok">Complete</span>;
  if (r === "overdue") return <span className="badge bad">Overdue</span>;
  if (r === "at-risk") return <span className="badge warn">At risk</span>;
  return null;
}

export const StageBadge = ({ record }: { record: ContentRecord }) =>
  record.pipelineStage ? <span className={`badge ${isComplete(record) ? "ok" : "accent"}`}>{record.pipelineStage}</span> : null;

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
    </label>
  );
}

export function Initials({ name, size }: { name: string; size?: number }) {
  return <span className="avatar" style={size ? { width: size, height: size } : undefined}>{name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span>;
}

/** A person's profile photo, or colour initials (in the workspace accent) when they have not set one. */
export function Avatar({ person, size }: { person: Person; size?: number }) {
  if (person.photoUrl) return <img className="avatar avatar-photo" style={size ? { width: size, height: size } : undefined} src={person.photoUrl} alt="" />;
  return <Initials name={person.name} size={size} />;
}

/** Click or drag a photo onto the circle to set it; the initials fallback shows through until then. */
export function AvatarUpload({ person, onChange, onError }: { person: Person; onChange: (dataUrl: string) => void; onError: (msg: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const take = async (f: File | undefined) => {
    if (!f) return;
    try {
      onChange(await fileToDataUrl(f, 240, 0.7));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not use that photo.");
    }
  };

  return (
    <div
      className={`avatar-upload ${drag ? "drag" : ""}`}
      onClick={() => fileRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files?.[0]); }}
      role="button"
      tabIndex={0}
      aria-label="Change profile photo"
      onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
    >
      <Avatar person={person} />
      <div className="avatar-edit">Change photo</div>
      <input ref={fileRef} type="file" accept="image/*" onChange={(e) => { take(e.target.files?.[0]); e.target.value = ""; }} aria-label="Choose a profile photo" />
    </div>
  );
}
