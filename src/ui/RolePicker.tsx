import { useId, useState } from "react";
import { knownRoles } from "../services/team";

/** One or more roles. Pick from the list or type your own, then press Enter or Add. */
export function RolePicker({ value, onChange, disabled }: { value: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const id = useId();
  const add = () => {
    const role = text.trim();
    if (role && !value.some((v) => v.toLowerCase() === role.toLowerCase())) onChange([...value, role]);
    setText("");
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      {value.length > 0 && (
        <div className="chips">
          {value.map((r) => (
            <span key={r} className="chip on" style={{ cursor: "default" }}>
              {r}
              {!disabled && <button type="button" aria-label={`Remove ${r}`} onClick={() => onChange(value.filter((x) => x !== r))} style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>}
            </span>
          ))}
        </div>
      )}
      {!disabled && (
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            list={id}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            onBlur={add}
            placeholder="Pick a role or type your own"
            aria-label="Role"
          />
          <datalist id={id}>{knownRoles().filter((r) => !value.some((v) => v.toLowerCase() === r.toLowerCase())).map((r) => <option key={r} value={r} />)}</datalist>
          <button type="button" className="btn" onClick={add}>Add role</button>
        </div>
      )}
    </div>
  );
}
