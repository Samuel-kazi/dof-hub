// Run with: npm test -- workflow-screens
// Phase 3 of the five-stage workflow: every new screen renders for every kind of person, on the Whispers of Why
// fixture, and shows what it should. Clicking through them in a real browser is in the phase report.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import type { JSX } from "react";
import { AppProvider } from "../src/ui/AppContext";
import { RecordPage } from "../src/pages/RecordPage";
import { CallSheetPage } from "../src/pages/CallSheets";
import { NewRecordModal } from "../src/pages/RecordForms";
import { SessionPage } from "../src/pages/workflow/SessionPage";
import { DecisionPanel } from "../src/pages/workflow/Development";
import { FormPane } from "../src/pages/documents/FormPanes";
import { catalogEntry } from "../src/config/documentCatalog";
import { PreProductionTab, SessionsPanel } from "../src/pages/workflow/PreProduction";
import { EpisodeTracker } from "../src/pages/workflow/EpisodeTracker";
import { decodeRoute, encodeRoute } from "../src/ui/routeLink";
import { getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { login } from "../src/services/auth";
import type { Project } from "../src/services/workflow";

let passed = 0;
const t = (name: string, fn: () => void) => {
  setDb(buildWorkflowFixture());
  try {
    fn();
    passed++;
    console.log("ok  ", name);
  } catch (e) {
    console.error("FAIL", name, "\n    ", (e as Error).stack?.split("\n").slice(0, 3).join("\n     "));
    process.exitCode = 1;
  }
};

const ROLES = {
  hop: "hop@dof.demo",
  producer: "crew4@dof.demo",
  crew: "crew2@dof.demo",
  vol: "volunteer1@dof.demo",
  partner: "partner1@dof.demo",
};
const html = (who: string, el: JSX.Element): string =>
  renderToString(
    <AppProvider actor={login(who, "demo")} onLogout={() => {}}>
      {el}
    </AppProvider>,
  )
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const WOW = "DOF-SER-001-S1";
const project = (id = WOW) => getDb().records.find((r) => r.contentId === id) as Project;

t("every workflow screen renders for every kind of person", () => {
  for (const [role, who] of Object.entries(ROLES)) {
    for (const id of ["DOF-SER-001", WOW, `${WOW}-E01`, `${WOW}-E03`, "DOF-DEV-001", "DOF-DOC-001"])
      assert.ok(html(who, <RecordPage id={id} />).length, `${role} ${id}`);
    for (const id of [`${WOW}-R01`, `${WOW}-R02`, "NOPE-R01"]) assert.ok(html(who, <SessionPage id={id} />).length, `${role} ${id}`);
    assert.ok(html(who, <CallSheetPage id="DOF-CS-001" />).length);
  }
});

t("the project page shows the derived stage and summary, and someone not on it gets an empty state", () => {
  const page = html(ROLES.hop, <RecordPage id={WOW} />);
  assert.match(page, /Production: 1 of 6 sessions closed\. Post: 4 episodes\./);
  assert.match(page, /Pre-production/);
  assert.match(page, /Series: Podcast/);
  assert.match(page, /Ruth Jepkorir/, "the producer");
  assert.match(html(ROLES.vol, <RecordPage id={WOW} />), /does not exist or is not part of a project/);
});

t("Development is the project's documents: the header strip, the short gate, its tiles, and the planned episodes", () => {
  setDb(buildWorkflowFixture({ through: "development" }));
  const page = html(ROLES.hop, <RecordPage id={WOW} />);
  for (const text of [
    "Project details",
    "Leave Development",
    'aria-label="Show Brief',
    'aria-label="Theological Review (review)',
    'aria-label="Greenlight',
    'aria-label="Planned Episodes (form)',
    "Done: move to Pre-production",
  ])
    assert.ok(page.includes(text), text);
  assert.ok(!page.includes("Still needed:") && !page.includes("Mission fit"), "not the earlier long form");
  // The Done button stays pressable: while the gate is not met it opens the Checks panel, under the stage tracker.
  assert.match(page, /<button class="btn primary">Done: move to Pre-production/);
  assert.match(page, /Checks: \d+ required/);
  assert.match(page, /still needed: see Checks, under the stage tracker/);
  const planned = html(
    ROLES.hop,
    <FormPane project={project()} entry={catalogEntry("podcast", "Development", "planned_episodes")!} write />,
  );
  assert.match(planned, /Planned episodes.*\(30\)/s, "the 30 planned episodes are listed");
  const decision = html(ROLES.hop, <DecisionPanel project={project()} write active />);
  for (const text of ["Review window", "Record decision"]) assert.ok(decision.includes(text), text);
});

t("a devotion's guest is in its Project details and on Accept or Decline; a pitched documentary's decision offers Advice only", () => {
  const dev = html(ROLES.hop, <RecordPage id="DOF-DEV-001" />);
  for (const text of ["Guest", "Accept or decline", 'aria-label="Devotional Script']) assert.ok(dev.includes(text), text);
  const accept = html(
    ROLES.hop,
    <FormPane project={project("DOF-DEV-001")} entry={catalogEntry("devotion", "Development", "accept_decline")!} write />,
  );
  assert.ok(accept.includes("Guest") && accept.includes("Decline"), "the guest and the decision");
  const db = getDb();
  db.developmentForms.find((f) => f.contentId === "DOF-DOC-001")!.formType = "documentary_pitched";
  project("DOF-DOC-001").workflow.formType = "documentary_pitched";
  assert.ok(html(ROLES.hop, <DecisionPanel project={project("DOF-DOC-001")} write active />).includes("Advice only"));
});

t("Pre-production: roles from the crew list, hosts and guests, the checklist, and the sessions", () => {
  const page = html(ROLES.producer, <PreProductionTab project={project()} write />);
  for (const text of [
    "Project roles",
    "Director",
    "DOP",
    "Audio engineer",
    "Camera operator (B-roll)",
    "Continuity",
    "Editor",
    "Hosts and guests",
    "Pastor James Mwangi",
    "Pre-production for the whole project",
    "Recording sessions",
    "Schedule a session",
  ])
    assert.ok(page.includes(text), text);
  assert.match(page, /<option value="DOF-P-CRW-001" selected="">Wanjiru Kamau<\/option>/, "the director is chosen from the crew list");
  assert.ok(!/<option[^>]*>Joseph Kiptoo/.test(page), "volunteers are not on the crew list");
  const sessions = html(ROLES.hop, <SessionsPanel project={project()} write />);
  assert.equal((sessions.match(/DOF-SER-001-S1-R0\d/g) ?? []).length, 6);
});

t("the session page: the recording day, the run sheet, the log with its statuses and notes, wrap, and reopening", () => {
  const closed = html(ROLES.hop, <SessionPage id={`${WOW}-R01`} />);
  for (const text of [
    "Recording day",
    "Episodes and guests",
    "Crew and contacts",
    "Run sheet",
    "Recording Log",
    "Who attended",
    "Take mark",
    "Issues and pickups",
    "Storage and backup",
    "Notes for post production",
    "Pickup booked for",
    "Wrap",
    "Daily log",
    "Reopen session",
  ])
    assert.ok(closed.includes(text), text);
  assert.match(closed, /<option value="Pickup needed" selected="">/);
  const planned = html(ROLES.hop, <SessionPage id={`${WOW}-R02`} />);
  for (const text of [
    "Call sheet and gear",
    "Make the call sheet",
    "Camera tests and rehearsal",
    "Ready to record",
    "Start recording: move to Production",
    "Rebuild from the template",
    "Add an episode",
  ])
    assert.ok(planned.includes(text), text);
  assert.ok(!planned.includes("Reopen session"));
  assert.match(html(ROLES.hop, <SessionPage id="NOPE-R01" />), /does not exist/);
});

t("the episode tracker and the episode page: stages, reviews, links and share links", () => {
  const tracker = html(ROLES.hop, <EpisodeTracker project={project()} />);
  for (const text of [
    "Episode tracker",
    "Source session",
    "Rough cut reviewed",
    "Final reviewed",
    "Review link",
    "Share link",
    "Post: Not started",
  ])
    assert.ok(tracker.includes(text), text);
  assert.equal((tracker.match(/DOF-SER-001-S1-E0\d/g) ?? []).length, 4);
  const e01 = html(ROLES.hop, <RecordPage id={`${WOW}-E01`} />);
  for (const text of [
    "Production notes",
    "Clean take",
    "Post production",
    "Editor",
    "Review link",
    "Final file link",
    "Start editing",
    "Theological review",
    "Rough cut",
    "Share links",
    "From DOF-SER-001-S1-R01",
  ])
    assert.ok(e01.includes(text), text);
  const e03 = html(ROLES.hop, <RecordPage id={`${WOW}-E03`} />);
  assert.ok(e03.includes("Attach a hosted file link first."), "an episode with no hosted file cannot be shared");
});

t("the Add form makes workflow projects: a series asks its kind, a documentary who makes it, a workflow series adds seasons", () => {
  const series = html(ROLES.hop, <NewRecordModal category="series" onClose={() => {}} onCreated={() => {}} />);
  assert.ok(series.includes("Kind of series") && series.includes("Podcast") && series.includes("Testimonial") && series.includes("Sermon"));
  assert.ok(!series.includes("Show starts"), "the earlier pipeline's fields are gone");
  const doc = html(ROLES.hop, <NewRecordModal category="documentary" onClose={() => {}} onCreated={() => {}} />);
  assert.ok(doc.includes("Documentary: DOF-made") && doc.includes("Documentary: Pitched by others"));
  const season = html(
    ROLES.hop,
    <NewRecordModal parent={getDb().records.find((r) => r.contentId === "DOF-SER-001")!} onClose={() => {}} onCreated={() => {}} />,
  );
  assert.ok(season.includes("Season title (optional)"));
  const live = html(ROLES.hop, <NewRecordModal category="live" onClose={() => {}} onCreated={() => {}} />);
  for (const text of ["How does it run?", "Recurring show", "One-time event", "Multi-day event", "Date of the event"])
    assert.ok(live.includes(text), `a live show is made as a production: ${text}`);
});

t("the call sheet made for a session lists that session's episodes", () => {
  const page = html(ROLES.hop, <CallSheetPage id="DOF-CS-001" />);
  assert.ok(page.includes("Recording session DOF-SER-001-S1-R01") && page.includes("Open the session"));
  assert.ok(page.includes("DOF-SER-001-S1-P05"));
});

t("sessions have their own address", () => {
  assert.equal(encodeRoute({ n: "session", id: `${WOW}-R01` }), `/session/${WOW}-R01`);
  assert.deepEqual(decodeRoute(`/session/${WOW}-R01`), { n: "session", id: `${WOW}-R01` });
});

console.log(`\n${passed} passed`);
