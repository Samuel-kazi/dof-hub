import * as alerts from "../src/services/alerts";
import * as callsheets from "../src/services/callsheets";
import * as checks from "../src/services/checks";
import * as content from "../src/services/content";
import * as docs from "../src/services/docs";
import * as documents from "../src/services/documents";
import * as equipment from "../src/services/equipment";
import * as kits from "../src/services/kits";
import * as lending from "../src/services/lending";
import * as live from "../src/services/live";
import * as locations from "../src/services/locations";
import * as people from "../src/services/people";
import * as permissions from "../src/services/permissions";
import * as production from "../src/services/production";
import * as reminders from "../src/services/reminders";
import * as settings from "../src/services/settings";
import * as storage from "../src/services/storage";
import * as team from "../src/services/team";
import * as workflow from "../src/services/workflow";
import { RPC_NAMES } from "../src/services/wrapped/names";
import { ACTIONS, type ActionSpec } from "./schemas";

const modules: Record<string, Record<string, unknown>> = {
  alerts,
  callsheets,
  checks,
  content,
  docs,
  documents,
  equipment,
  kits,
  lending,
  live,
  locations,
  people,
  permissions,
  production,
  reminders,
  settings,
  storage,
  team,
  workflow,
};

export interface Action {
  fn: (...args: unknown[]) => unknown;
  spec: ActionSpec;
}

/**
 * The only functions a signed-in person can ask the server to run: those listed in server/schemas.ts, each
 * with the shape of its arguments. A Map, so a name such as "constructor" or "__proto__" can never resolve.
 */
export const REGISTRY: ReadonlyMap<string, Action> = (() => {
  const out = new Map<string, Action>();
  for (const [name, spec] of Object.entries(ACTIONS)) {
    const [m, n] = name.split(".");
    const mod = Object.hasOwn(modules, m) ? modules[m] : undefined;
    const fn = mod && Object.hasOwn(mod, n) ? mod[n] : undefined;
    if (typeof fn !== "function") throw new Error(`server/schemas.ts lists ${name}, but src/services/${m}.ts does not export it.`);
    if (!RPC_NAMES[m]?.includes(n)) throw new Error(`server/schemas.ts lists ${name}, but it is not a generated wrapper. Run npm run gen.`);
    out.set(name, { fn: fn as Action["fn"], spec });
  }
  return out;
})();
