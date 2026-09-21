import { RuleError } from "../src/types";
import type { Authed } from "./accounts";
import { afterPeopleChange } from "./accounts";
import { HttpError } from "./errors";
import { REGISTRY } from "./registry";
import { mutateState } from "./state";
import type { Store } from "./stores";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Refuses input that tries to reach into how objects are built, and input nested absurdly deep. */
export function checkShape(value: unknown, depth = 0): void {
  if (depth > 12) throw new HttpError(400, "That request is too deeply nested.");
  if (Array.isArray(value)) { if (value.length > 5000) throw new HttpError(400, "That request has too many items."); value.forEach((v) => checkShape(v, depth + 1)); return; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) { if (FORBIDDEN_KEYS.has(k)) throw new HttpError(400, "That request is not allowed."); checkShape(v, depth + 1); }
  }
}

/**
 * Runs one change for a signed-in person. The person is taken from the session, never from the request,
 * so nobody can act as anyone else. The same rules that run in the browser run here, and here they are final.
 */
export async function runAction(store: Store, who: Authed, name: unknown, args: unknown): Promise<unknown> {
  const fn = typeof name === "string" ? REGISTRY[name] : undefined;
  if (!fn) throw new HttpError(400, "That action does not exist.");
  if (!Array.isArray(args)) throw new HttpError(400, "That request is not valid.");
  checkShape(args);
  const rest = args.slice(1);
  // Logins are made by the account endpoints. A person is added here without one.
  if (name === "people.createPerson") rest.length = Math.min(rest.length, 1);
  try {
    const { result } = await mutateState(store, () => fn(who.actor, ...rest));
    if (name === "people.deactivatePerson" && typeof rest[0] === "string") await afterPeopleChange(store, rest[0]);
    return result;
  } catch (e) {
    if (e instanceof RuleError) throw new HttpError(400, e.message, "rule");
    throw e;
  }
}
