import type { ProjectMember } from "../types";
import { RuleError } from "../types";

// Suggested roles for a project team. People can also type their own.
export const PROJECT_ROLES = [
  "Producer",
  "Director",
  "Host",
  "Presenter",
  "Script writer",
  "Researcher",
  "Camera operator",
  "Audio engineer",
  "Lighting",
  "Switcher / vision mixer",
  "Technical director",
  "Graphics",
  "Floor manager",
  "Stage manager",
  "Editor",
  "Colorist",
  "Sound designer",
  "Recording engineer",
  "Musician",
  "Vocalist",
  "Social media",
  "Reviewer",
  "Floor crew",
];

export const rolesOf = (m: ProjectMember): string[] => m.roleOnProject.split(",").map((s) => s.trim()).filter(Boolean);

/** Trims, removes repeats, and checks each role. Roles are stored together as a comma-separated list. */
export function cleanRoles(roles: string[]): string[] {
  const out: string[] = [];
  for (const raw of roles) {
    const role = raw.trim().replace(/\s+/g, " ");
    if (!role) continue;
    if (role.includes(",")) throw new RuleError("Add one role at a time. Roles cannot contain commas.");
    if (role.length > 40) throw new RuleError(`"${role.slice(0, 20)}…" is too long for a role. Keep it under 40 characters.`);
    if (!out.some((x) => x.toLowerCase() === role.toLowerCase())) out.push(role);
  }
  return out;
}
