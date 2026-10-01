import { ConflictError, RuleError } from "../src/types";
import { expectIds } from "../src/data/ids";
import type { Authed } from "./accounts";
import { afterPeopleChange } from "./accounts";
import { HttpError } from "./errors";
import { REGISTRY } from "./registry";
import { extractFiles } from "./layout";
import { InvalidArgs, parseArgs } from "./schemas";
import { mutateState } from "./state";
import type { FileDoc, Store } from "./stores";

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
 * so nobody can act as anyone else. Only actions listed in server/schemas.ts exist, and their arguments
 * are checked against the schema there before the service runs. The same rules that run in the browser
 * run here, and here they are final.
 */
export async function runAction(store: Store, who: Authed, name: unknown, args: unknown, ids?: unknown): Promise<unknown> {
  const action = typeof name === "string" ? REGISTRY.get(name) : undefined;
  if (!action) throw new HttpError(400, "That action does not exist.");
  if (!Array.isArray(args)) throw new HttpError(400, "That request is not valid.");
  checkShape(args);
  // The IDs the browser gave anything new (src/data/ids.ts). A page from before this check sends none.
  if (ids !== undefined && !(Array.isArray(ids) && ids.length <= 2000 && ids.every((x) => typeof x === "string" && x.length <= 200))) throw new HttpError(400, "That request is not valid.");
  const expected = ids as string[] | undefined;
  // args[0] is the actor the browser used. It is ignored: the actor always comes from the session.
  const rest = args.slice(1);
  // Logins are made by the account endpoints. A person is added here without one.
  if (name === "people.createPerson") rest.length = Math.min(rest.length, 1);
  let parsed: unknown[];
  try {
    parsed = parseArgs(action.spec, rest);
  } catch (e) {
    if (e instanceof InvalidArgs) {
      console.warn(`Refused ${name}: ${e.message}`); // in the Vercel logs, to help whoever is debugging
      throw new HttpError(400, "That request is not valid.", "invalid");
    }
    throw e;
  }
  // Photos arrive as data: URLs. Each is stored as a file and the change keeps only a link to it, so photos
  // never weigh down the data that every page downloads.
  const files: FileDoc[] = [];
  parsed = extractFiles(parsed, files);
  for (const f of files) await store.files.insert(f); // false if the same photo is already stored
  try {
    const { result } = await mutateState(store, () => expectIds(expected, () => action.fn(who.actor, ...parsed)));
    if (name === "people.deactivatePerson" && typeof parsed[0] === "string") await afterPeopleChange(store, parsed[0]);
    return result;
  } catch (e) {
    if (e instanceof ConflictError) throw new HttpError(409, e.message, "conflict");
    if (e instanceof RuleError) throw new HttpError(400, e.message, "rule");
    throw e;
  }
}
