import type { Route } from "./AppContext";
import type { ModuleKey } from "../config/roles";
import type { CategoryKey } from "../types";
import { CATEGORIES } from "../config/categories";

const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key as string));
const MODULE_KEYS = new Set<ModuleKey>(["dashboard", "pipeline", "callsheets", "calendar", "equipment", "storage", "crew", "documents", "reminders", "settings"]);

// Turns a Route into a URL hash, and back, so a screen in the app has a real, shareable address.
// The app never talks to a server for routing (it is a single page, on Vercel or in Tauri), so a
// hash is the simplest thing that works the same in the browser and in the desktop app, needs no
// server configuration, and still lets someone right-click the address bar or the desktop app's
// window and copy a working link, or use their browser's own Back and Forward buttons.

const seg = (s: string): string => encodeURIComponent(s);
const unseg = (s: string): string => decodeURIComponent(s);

/** The path portion of the hash for this route, for example "/record/DOF-SER-001" or "/pipeline/music". */
export function encodeRoute(r: Route): string {
  switch (r.n) {
    case "dashboard": return "/";
    case "pipeline": return r.category ? `/pipeline/${seg(r.category)}` : "/pipeline";
    case "record": return `/record/${seg(r.id)}`;
    case "callsheets": return "/callsheets";
    case "callsheet": return `/callsheet/${seg(r.id)}`;
    case "crew": return r.tab ? `/crew/${seg(r.tab)}` : "/crew";
    case "person": return `/person/${seg(r.id)}`;
    case "soon": return `/soon/${seg(r.module)}`;
    case "equipment": return r.tab ? `/equipment/${seg(r.tab)}` : "/equipment";
    case "item": return `/item/${seg(r.id)}`;
    case "manifest": return `/manifest/${seg(r.id)}`;
    case "documents": return "/documents";
    case "doc": return `/doc/${seg(r.id)}`;
    case "storage": return "/storage";
    case "drive": return `/drive/${seg(r.id)}`;
    case "access": return "/access";
    case "reminders": return "/reminders";
    case "calendar": return "/calendar";
    case "settings": return "/settings";
  }
}

const CREW_TABS = new Set(["crew", "volunteers", "partners", "workload"]);
const EQUIPMENT_TABS = new Set(["inventory", "checkouts", "incidents"]);

/** The reverse of encodeRoute. Anything it does not recognise (a stale link, a typo) becomes the dashboard. */
export function decodeRoute(path: string): Route {
  const parts = path.split("/").filter(Boolean).map(unseg);
  const [head, arg] = parts;
  switch (head) {
    case undefined: return { n: "dashboard" };
    case "pipeline": return { n: "pipeline", ...(arg && CATEGORY_KEYS.has(arg) ? { category: arg as CategoryKey } : {}) };
    case "record": return arg ? { n: "record", id: arg } : { n: "dashboard" };
    case "callsheets": return { n: "callsheets" };
    case "callsheet": return arg ? { n: "callsheet", id: arg } : { n: "callsheets" };
    case "crew": return { n: "crew", ...(arg && CREW_TABS.has(arg) ? { tab: arg as "crew" | "volunteers" | "partners" | "workload" } : {}) };
    case "person": return arg ? { n: "person", id: arg } : { n: "dashboard" };
    case "soon": return arg && MODULE_KEYS.has(arg as ModuleKey) ? { n: "soon", module: arg as ModuleKey } : { n: "dashboard" };
    case "equipment": return { n: "equipment", ...(arg && EQUIPMENT_TABS.has(arg) ? { tab: arg as "inventory" | "checkouts" | "incidents" } : {}) };
    case "item": return arg ? { n: "item", id: arg } : { n: "equipment" };
    case "manifest": return arg ? { n: "manifest", id: arg } : { n: "equipment" };
    case "documents": return { n: "documents" };
    case "doc": return arg ? { n: "doc", id: arg } : { n: "documents" };
    case "storage": return { n: "storage" };
    case "drive": return arg ? { n: "drive", id: arg } : { n: "storage" };
    case "access": return { n: "access" };
    case "reminders": return { n: "reminders" };
    case "calendar": return { n: "calendar" };
    case "settings": return { n: "settings" };
    default: return { n: "dashboard" };
  }
}

/** Reads the route encoded in the current URL's hash, if any. */
export function routeFromLocation(): Route | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (!hash || hash === "#" || hash === "#/") return null;
  return decodeRoute(hash.slice(1));
}

/** A full, shareable URL to this route on this deployment. */
export function urlForRoute(r: Route): string {
  if (typeof window === "undefined") return encodeRoute(r);
  return `${window.location.origin}${window.location.pathname}${window.location.search}#${encodeRoute(r)}`;
}
