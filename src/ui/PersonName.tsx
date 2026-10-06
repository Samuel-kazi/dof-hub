import { getDb } from "../data/store";
import { useApp } from "./AppContext";

/**
 * A person's name that opens their contact card when clicked: phone, email and role. Used wherever crew are named,
 * so anyone on a sheet is a tap away from a call. Someone not in the directory shows as text.
 */
export function PersonName({ id, role, fallback = "No one" }: { id: string | null | undefined; role?: string; fallback?: string }) {
  const { showPerson } = useApp();
  if (!id) return <>{fallback}</>;
  if (id === "system") return <>DOF Hub</>;
  const p = getDb().people.find((x) => x.personId === id);
  if (!p) return <>{id}</>;
  return (
    <button
      type="button"
      className="person-link"
      title={`Contact ${p.name}`}
      onClick={(e) => {
        e.stopPropagation();
        showPerson(p.personId, role ? { role } : undefined);
      }}
    >
      {p.name}
    </button>
  );
}
