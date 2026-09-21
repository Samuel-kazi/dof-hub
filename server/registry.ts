import * as callsheets from "../src/services/callsheets";
import * as content from "../src/services/content";
import * as docs from "../src/services/docs";
import * as equipment from "../src/services/equipment";
import * as people from "../src/services/people";
import * as permissions from "../src/services/permissions";
import * as reminders from "../src/services/reminders";
import * as settings from "../src/services/settings";
import * as storage from "../src/services/storage";
import * as team from "../src/services/team";
import { RPC_NAMES } from "../src/services/wrapped/names";

const modules: Record<string, Record<string, unknown>> = { callsheets, content, docs, equipment, people, permissions, reminders, settings, storage, team };

/** The only functions a signed-in person can ask the server to run, each taking the person first. */
export const REGISTRY: Record<string, (...args: unknown[]) => unknown> = {};
for (const [m, names] of Object.entries(RPC_NAMES)) for (const n of names) REGISTRY[`${m}.${n}`] = modules[m][n] as (...args: unknown[]) => unknown;
