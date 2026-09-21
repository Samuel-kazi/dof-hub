import { useEffect, useRef, useState } from "react";
import { useApp, type Route } from "./AppContext";
import { didSaveFail, useDb } from "../data/store";
import { modulesFor } from "../services/permissions";
import { CATEGORIES } from "../config/categories";
import { MODULE_LABELS, ROLES, type ModuleKey } from "../config/roles";
import { getReminders } from "../services/content";
import { relativeDays } from "../services/utils";
import { IconBack, IconBell, IconCam, IconChevron, IconDoc, IconDrive, IconFilm, IconGear, IconHome, IconLogout, IconMenu, IconMoon, IconSheet, IconSun, IconUsers } from "./Icons";
import { Logo } from "./Logo";
import { useTheme } from "./theme";
import { Initials } from "./parts";
import { Dashboard } from "../pages/Dashboard";
import { Pipeline } from "../pages/Pipeline";
import { RecordPage } from "../pages/RecordPage";
import { CallSheets, CallSheetPage } from "../pages/CallSheets";
import { Crew, PersonPage } from "../pages/Crew";
import { Settings } from "../pages/Settings";
import { Equipment } from "../pages/Equipment";
import { EquipmentItemPage } from "../pages/EquipmentItem";
import { ManifestPage } from "../pages/Manifest";
import { Storage, DrivePage } from "../pages/Storage";
import { Documents, DocPage } from "../pages/Documents";
import { Access } from "../pages/Access";
import { Reminders } from "../pages/Reminders";
import { Soon } from "../pages/Soon";

const ICONS: Record<ModuleKey, () => JSX.Element> = {
  dashboard: IconHome,
  pipeline: IconFilm,
  callsheets: IconSheet,
  equipment: IconCam,
  storage: IconDrive,
  crew: IconUsers,
  documents: IconDoc,
  reminders: IconBell,
  settings: IconGear,
};
const BUILT: ModuleKey[] = ["dashboard", "pipeline", "callsheets", "equipment", "storage", "crew", "documents", "reminders", "settings"];

function moduleOfRoute(r: Route): ModuleKey {
  switch (r.n) {
    case "dashboard": return "dashboard";
    case "pipeline": case "record": return "pipeline";
    case "callsheets": case "callsheet": return "callsheets";
    case "crew": case "person": return "crew";
    case "equipment": case "item": case "manifest": return "equipment";
    case "storage": case "drive": return "storage";
    case "documents": case "doc": return "documents";
    case "reminders": return "reminders";
    case "access": return "settings";
    case "settings": return "settings";
    case "soon": return r.module;
  }
}

function routeFor(m: ModuleKey): Route {
  switch (m) {
    case "dashboard": return { n: "dashboard" };
    case "pipeline": return { n: "pipeline" };
    case "callsheets": return { n: "callsheets" };
    case "equipment": return { n: "equipment" };
    case "storage": return { n: "storage" };
    case "documents": return { n: "documents" };
    case "crew": return { n: "crew" };
    case "reminders": return { n: "reminders" };
    case "settings": return { n: "settings" };
    default: return { n: "soon", module: m };
  }
}

export function Shell() {
  const { actor, me, route, go, back, canBack, menu, toast, logout, notifications, clearNotifications } = useApp();
  const db = useDb();
  const dockKey = `dof-dock-${actor.personId}`;
  const [wide, setWide] = useState(() => {
    try { return localStorage.getItem(dockKey) === "wide"; } catch { return false; }
  });
  const { theme, setPref } = useTheme();
  const pipeKey = `dof-pipe-${actor.personId}`;
  const [pipeOpen, setPipeOpen] = useState(() => {
    try { return localStorage.getItem(pipeKey) !== "closed"; } catch { return true; }
  });
  const togglePipe = () => setPipeOpen((o) => { try { localStorage.setItem(pipeKey, o ? "closed" : "open"); } catch { /* ignore */ } return !o; });
  const contentRef = useRef<HTMLElement>(null);
  const role = ROLES[actor.role];
  const active = moduleOfRoute(route);
  const reminders = getReminders(actor);
  void db;

  const toggle = () => {
    setWide((w) => {
      try { localStorage.setItem(dockKey, w ? "icons" : "wide"); } catch { /* ignore */ }
      return !w;
    });
  };

  // A new page starts at the top.
  useEffect(() => { contentRef.current?.scrollTo?.(0, 0); }, [route]);

  // One heads-up on sign-in for stage deadlines inside the reminder window.
  useEffect(() => {
    const n = getReminders(actor).length;
    if (n) toast(`${n} stage deadline${n > 1 ? "s" : ""} need${n > 1 ? "" : "s"} your attention soon. Check the bell.`, "info");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openBell = (e: React.MouseEvent) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    menu(
      { clientX: r.right - 220, clientY: r.bottom + 6, preventDefault: () => {} },
      [
        ...notifications.slice(0, 5).map((n) => ({ label: `${n.title}: ${n.body}`, onClick: () => {} })),
        ...(notifications.length ? [{ label: "Clear notifications", onClick: clearNotifications }, { label: "", divider: true, onClick: () => {} }] : []),
        ...(reminders.length
          ? reminders.map((x) => ({ label: `${x.record.title}: ${x.stage} due ${relativeDays(x.dueDate)}`, onClick: () => go({ n: "record", id: x.record.contentId }) }))
          : [{ label: "No deadlines coming up for you", onClick: () => {}, disabled: true }]),
      ],
    );
  };

  return (
    <div className="app">
      <nav className={`dock ${wide ? "wide" : ""}`} aria-label="Main">
        <div className="dock-brand">
          <Logo />
          <div className="dock-brand-text">
            <b>Dawn of Faith</b>
            <span>Production Hub</span>
          </div>
        </div>
        {modulesFor(actor).map((m) => {
          const Icon = ICONS[m];
          const built = BUILT.includes(m);
          const label = MODULE_LABELS[m];
          return (
            <div key={m} style={wide ? undefined : { display: "contents" }}>
              <div className="dock-row" style={wide ? undefined : { display: "contents" }}>
                <button className={`dock-item ${active === m ? "active" : ""} ${m === "pipeline" && wide ? "has-chev" : ""}`} data-tip={label} aria-label={label} aria-current={active === m ? "page" : undefined} onClick={() => go(routeFor(m))}>
                  <Icon />
                  <span className="dock-label">{label}</span>
                  {!built && <span className="soon">Next</span>}
                </button>
                {m === "pipeline" && wide && (
                  <button className={`dock-chev ${pipeOpen ? "open" : ""}`} aria-expanded={pipeOpen} aria-label={pipeOpen ? "Hide the categories" : "Show the categories"} title={pipeOpen ? "Hide the categories" : "Show the categories"} onClick={togglePipe}><IconChevron /></button>
                )}
              </div>
              {m === "pipeline" && wide && pipeOpen && (
                <div className="dock-sub">
                  {CATEGORIES.map((c) => (
                    <button key={c.key} className={route.n === "pipeline" && route.category === c.key ? "active" : ""} onClick={() => go({ n: "pipeline", category: c.key })}>{c.label}</button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div className="dock-foot">Signed in as {role.label}</div>
      </nav>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn" onClick={back} disabled={!canBack} aria-label="Go back" title="Back"><IconBack /></button>
          <button className="icon-btn" onClick={toggle} aria-label={wide ? "Collapse menu" : "Expand menu"} title={wide ? "Collapse menu" : "Expand menu"}><IconMenu /></button>
          <div className="spacer" />
          <div className="theme-toggle" role="group" aria-label="Colour mode">
            <button aria-pressed={theme === "light"} aria-label="Light mode" title="Light mode" onClick={() => setPref("light")}><IconSun /></button>
            <button aria-pressed={theme === "dark"} aria-label="Night mode" title="Night mode" onClick={() => setPref("dark")}><IconMoon /></button>
          </div>
          <button className="icon-btn" onClick={openBell} aria-label="Deadline reminders" title="Deadline reminders">
            <IconBell />
            {reminders.length + notifications.length > 0 && <span className="dot">{reminders.length + notifications.length}</span>}
          </button>
          <div className="user-chip glass">
            <Initials name={me.name} />
            <div>
              {me.name}
              <small>{me.name === role.label ? me.personId : role.label}</small>
            </div>
          </div>
          <button className="icon-btn" onClick={logout} aria-label="Sign out" title="Sign out"><IconLogout /></button>
        </header>
        <main className="content" ref={contentRef}>
          {didSaveFail() && <div className="banner bad no-print" role="alert" style={{ marginBottom: 16 }}><span className="grow"><b>Changes are not being saved.</b> This device is out of storage for the app, usually because of photos. Remove some photos or use links instead. Recent changes will be lost if you close the app.</span></div>}
          {route.n === "dashboard" && <Dashboard />}
          {route.n === "pipeline" && <Pipeline category={route.category} />}
          {route.n === "record" && <RecordPage id={route.id} />}
          {route.n === "callsheets" && <CallSheets />}
          {route.n === "callsheet" && <CallSheetPage id={route.id} />}
          {route.n === "crew" && <Crew tab={route.tab} />}
          {route.n === "person" && <PersonPage id={route.id} />}
          {route.n === "settings" && <Settings />}
          {route.n === "equipment" && <Equipment tab={route.tab} />}
          {route.n === "item" && <EquipmentItemPage id={route.id} />}
          {route.n === "manifest" && <ManifestPage id={route.id} />}
          {route.n === "storage" && <Storage />}
          {route.n === "drive" && <DrivePage id={route.id} />}
          {route.n === "access" && <Access />}
          {route.n === "reminders" && <Reminders />}
          {route.n === "documents" && <Documents />}
          {route.n === "doc" && <DocPage id={route.id} />}
          {route.n === "soon" && <Soon module={route.module} />}
        </main>
      </div>
    </div>
  );
}
