import type { Actor } from "../types";
import { RuleError } from "../types";
import { getDb } from "../data/store";

// MOCK AUTH for the click-through phase. Real auth (bcrypt) arrives with the backend.
export function login(email: string, password: string): Actor {
  const db = getDb();
  const u = db.users.find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
  if (!u || u.password !== password) throw new RuleError("Email or password is incorrect.");
  const p = db.people.find((x) => x.personId === u.personId);
  if (!u.active || !p || p.status !== "active") throw new RuleError("This login has been deactivated. Ask the Head of Production.");
  return { personId: u.personId, role: u.role };
}
