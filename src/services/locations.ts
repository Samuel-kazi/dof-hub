import type { Actor, SavedLocation } from "../types";
import { RuleError } from "../types";
import { commit, getDb, nextCounter } from "../data/store";
import { claimId } from "../data/ids";
import { logAudit } from "./audit";
import { pad, pickKeys } from "./utils";

// Saved locations: the studio, the church hall, a venue used before, with its address and notes (parking, the
// gate, who has the key). Any call sheet or show template can pick one, which fills in its location; the sheet
// keeps its own copy, so changing a saved location later never rewrites a sheet already made. The Head of
// Production and crew keep the list. A location is archived, never deleted, and can be brought back.

export const listLocations = (includeArchived = false): SavedLocation[] =>
  (getDb().locations ?? []).filter((l) => includeArchived || !l.archived).sort((a, b) => a.name.localeCompare(b.name));

export const getLocation = (id: string): SavedLocation | undefined => (getDb().locations ?? []).find((l) => l.id === id);

/** The Head of Production and crew keep the list of saved locations. */
export const canKeepLocations = (actor: Actor): boolean => actor.role === "HOP" || actor.role === "CRW";

export interface LocationInput {
  name?: string;
  address?: string;
  notes?: string;
}

const LOCATION_EDITABLE = ["name", "address", "notes"] as const;

function check(input: LocationInput, self?: SavedLocation): void {
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new RuleError("Give the location a name.");
    if (name.length > 200) throw new RuleError("Keep the location's name under 200 characters.");
    const same = (getDb().locations ?? []).find(
      (l) => !l.archived && l.id !== self?.id && l.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (same) throw new RuleError(`There is already a saved location called ${same.name}.`);
  }
  if (input.address !== undefined && input.address.length > 1000) throw new RuleError("Keep the address under 1,000 characters.");
  if (input.notes !== undefined && input.notes.length > 4000) throw new RuleError("Keep the notes under 4,000 characters.");
}

function keeper(actor: Actor): void {
  if (!canKeepLocations(actor)) throw new RuleError("Only the Head of Production and crew can change saved locations.");
}

export function createLocation(actor: Actor, input: LocationInput): SavedLocation {
  keeper(actor);
  const patch = pickKeys(input, LOCATION_EDITABLE);
  if (patch.name === undefined) throw new RuleError("Give the location a name.");
  check(patch);
  const at = new Date().toISOString();
  const loc: SavedLocation = {
    id: claimId(`DOF-LOC-${pad(nextCounter("location"))}`),
    name: patch.name.trim(),
    address: (patch.address ?? "").trim(),
    notes: (patch.notes ?? "").trim(),
    archived: false,
    createdAt: at,
    createdBy: actor.personId,
    updatedAt: at,
  };
  (getDb().locations ??= []).push(loc);
  logAudit(actor, "create", "location", loc.id, loc.name);
  commit();
  return loc;
}

export function updateLocation(actor: Actor, id: string, input: LocationInput): SavedLocation {
  keeper(actor);
  const loc = getLocation(id);
  if (!loc) throw new RuleError("That saved location no longer exists.");
  const patch = pickKeys(input, LOCATION_EDITABLE);
  check(patch, loc);
  if (patch.name !== undefined) loc.name = patch.name.trim();
  if (patch.address !== undefined) loc.address = patch.address.trim();
  if (patch.notes !== undefined) loc.notes = patch.notes.trim();
  loc.updatedAt = new Date().toISOString();
  logAudit(actor, "update", "location", id, Object.keys(patch).join(", "));
  commit();
  return loc;
}

/** Takes a location off the list (sheets that used it keep what they have), or brings it back. */
export function archiveLocation(actor: Actor, id: string, archived: boolean): SavedLocation {
  keeper(actor);
  const loc = getLocation(id);
  if (!loc) throw new RuleError("That saved location no longer exists.");
  if (!archived) check({ name: loc.name }, loc);
  loc.archived = archived;
  loc.updatedAt = new Date().toISOString();
  logAudit(actor, archived ? "archive" : "restore", "location", id, loc.name);
  commit();
  return loc;
}

/** How many call sheets still to come use a saved location. */
export function sheetsUsing(id: string, today: string): number {
  return getDb().callSheets.filter((c) => c.locationId === id && c.date >= today).length;
}
