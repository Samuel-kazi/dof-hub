// Run with: npm test -- rework-foundations
// The rework's foundations (build prompt v2, phase 1): data version 21 and its dry-run report, the switches for each
// part, one view of production instances, lending, role kits, the Calendar's reminders and the bell, the email queue,
// the urgency report, and storyboard and shot list templates. No screens yet.
import assert from "node:assert/strict";
import type { Actor, Database } from "../src/types";
import { RuleError } from "../src/types";
import { enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { buildSeed } from "../src/data/seed";
import { integrityProblems } from "../src/data/constraints";
import { upgradeToV21 } from "../src/data/migrate";
import { describeRework, reworkReport } from "../src/data/reworkReport";
import { login } from "../src/services/auth";
import * as CS from "../src/services/wrapped/callsheets";
import * as D from "../src/services/wrapped/documents";
import * as E from "../src/services/wrapped/equipment";
import * as K from "../src/services/wrapped/kits";
import * as L from "../src/services/wrapped/lending";
import * as A from "../src/services/wrapped/alerts";
import * as S from "../src/services/wrapped/settings";
import * as W from "../src/services/wrapped/workflow";
import { featureOn } from "../src/services/settings";
import { instancesOf, instancesBetween } from "../src/services/productionInstances";
import { kitSuggestions, kitsForRole } from "../src/services/kits";
import { daysLate, overdueLoans } from "../src/services/lending";
import { fireReminders, nairobiInstant, notificationsFor } from "../src/services/alerts";
import { MAX_ATTEMPTS, queueEmail, quietUntil, recordSend, takeDue } from "../src/services/emailQueue";
import { urgencyReport } from "../src/services/urgency";
import { availabilityOn, displayStatus, getItem } from "../src/services/equipment-items";

let passed = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  setDb(buildWorkflowFixture());
  enableRollback();
  try {
    await fn();
    passed++;
    console.log("ok  ", name);
  } catch (e) {
    console.error("FAIL", name, "\n    ", (e as Error).stack?.split("\n").slice(0, 4).join("\n     "));
    process.exitCode = 1;
  }
};
const hop = (): Actor => login("hop@dof.demo", "demo");
const crew = (n: number): Actor => login(`crew${n}@dof.demo`, "demo");
const vol = (): Actor => login("volunteer1@dof.demo", "demo");
const throwsRule = (fn: () => unknown, match?: RegExp) =>
  assert.throws(fn, (e) => (e instanceof RuleError && (!match || match.test(e.message))) || assert.fail((e as Error).message));
const ok = () => assert.deepEqual(integrityProblems(getDb()), [], "the data keeps its own rules");
const WOW = "DOF-SER-001-S1";
const session = (n: number) => getDb().recordingSessions.find((s) => s.contentId === WOW && s.sessionNumber === n)!;
// Today, in the tests, is Saturday 26 September 2026, 09:00 in Nairobi.

// ── Data version 21 ──────────────────────────────────────────

await t("upgrading to version 21 adds the new lists, empty, marks boards as a project's own, and changes nothing else", () => {
  const db = buildSeed() as Database & Record<string, unknown>;
  for (const k of ["loans", "roleKits", "calendarReminders", "notifications", "emailQueue", "googleSyncLinks"]) delete db[k];
  delete db.settings.features;
  db.storyboards.push({
    id: "SB-aaaaaaaa",
    contentId: "DOF-SER-001",
    episodeId: null,
    name: "Old board",
    position: 0,
    copiedFrom: null,
    migrated: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  } as never);
  db.schemaVersion = 20;
  const before = JSON.stringify({ records: db.records, callSheets: db.callSheets, manifests: db.manifests, people: db.people });
  const up = upgradeToV21(structuredClone(db));
  assert.equal(up.schemaVersion, 21);
  for (const k of ["loans", "roleKits", "calendarReminders", "notifications", "emailQueue", "googleSyncLinks"] as const)
    assert.deepEqual(up[k], []);
  assert.equal(up.storyboards[0].isTemplate, false);
  assert.deepEqual(up.settings.features, {});
  assert.equal(JSON.stringify({ records: up.records, callSheets: up.callSheets, manifests: up.manifests, people: up.people }), before);
  assert.equal(JSON.stringify(upgradeToV21(structuredClone(up))), JSON.stringify(up), "running it again changes nothing");
  assert.deepEqual(integrityProblems(up), []);
});

await t("the dry-run report lists each General Use record with a proposal, and what is stored of reminders", () => {
  const db = buildSeed();
  const base = db.records.find((r) => r.contentId === "DOF-SER-001")!;
  db.records.push(
    { ...structuredClone(base), contentId: "DOF-GEN-001", title: "Lent to Grace Church", category: "general", parentId: null },
    { ...structuredClone(base), contentId: "DOF-GEN-002", title: "Old placeholder", category: "general", parentId: null },
  );
  db.manifests.push({ ...structuredClone(db.manifests[0]), id: "DOF-MF-900", contentId: "DOF-GEN-001", status: "checked-out" });
  db.people[1].notifyEmail = true;
  const r = reworkReport(db);
  const choosers = db.people.filter((p) => p.notifyEmail).length;
  assert.deepEqual(
    r.generalUse.map((g) => [g.contentId, g.checkouts, g.openCheckouts, g.proposal]),
    [
      ["DOF-GEN-001", 1, 1, "loan"],
      ["DOF-GEN-002", 0, 0, "archive"],
    ],
  );
  assert.equal(r.emailChoosers, choosers);
  const text = describeRework(r).join("\n");
  assert.match(text, /DOF-GEN-001 +Lent to Grace Church: 1 checkout \(1 still out or reserved\).*Proposed: loan/);
  assert.match(text, /Reminders: none are stored/);
  assert.match(text, /Fields not carried over: none/);
});

// ── Switches ─────────────────────────────────────────────────

await t("a part of the rework not built yet stays off whatever is stored; only the Head of Production switches parts", () => {
  assert.equal(featureOn("lending"), false);
  S.setFeature(hop(), "lending", true);
  assert.equal(getDb().settings.features?.lending, true);
  assert.equal(featureOn("lending"), false, "not built yet: off, whatever is stored");
  throwsRule(() => S.setFeature(crew(1), "lending", false), /Head of Production/);
});

// ── One view of production instances ────────────────────────

await t("recording sessions and show days are read the same way: date, label, times, place, status and call sheet", () => {
  const all = instancesOf(WOW);
  assert.equal(all.length, 6);
  const [r1, r2] = all;
  assert.deepEqual([r1.kind, r1.status, r1.callSheetId], ["session", "done", "DOF-CS-001"], "session 1 is closed");
  assert.deepEqual([r2.status, r2.callSheetId, r2.date], ["draft", null, "2026-09-26"]);
  const sheet = W.createSessionCallSheet(hop(), r2.id);
  CS.updateCallSheet(hop(), sheet.id, { location: "DOF Studio A", crewPersonIds: ["DOF-P-CRW-002"], crewLeadId: "DOF-P-CRW-002" });
  CS.finalizeCallSheet(hop(), sheet.id);
  assert.equal(instancesOf(WOW)[1].status, "published");
  W.archiveSession(hop(), session(3).id, "Moved to January");
  assert.equal(instancesOf(WOW)[2].status, "cancelled");
  const between = instancesBetween(hop(), "2026-09-19", "2026-10-03");
  assert.deepEqual(
    between.map((i) => i.id),
    [session(1).id, session(2).id, session(3).id],
  );
  assert.equal(instancesBetween(login("partner1@dof.demo", "demo"), "2026-09-01", "2026-12-31").length, 0, "only what one may see");
});

// ── Lending ──────────────────────────────────────────────────

await t("a lent item is unavailable to bookings until it is back, and the clash names the borrower and the return date", () => {
  const loan = L.createLoan(crew(2), {
    borrowerName: "Pastor Otieno",
    organisation: "Grace Church",
    borrowerPhone: "+254 700 111 222",
    dateOut: "2026-09-28",
    expectedReturn: "2026-10-02",
    lines: [{ equipmentId: "DOF-EQ-CAM-001", quantity: 1 }],
  });
  assert.match(loan.id, /^DOF-LOAN-\d{4}$/);
  const cam = getItem("DOF-EQ-CAM-001")!;
  const a = availabilityOn(cam, "2026-09-30", "2026-09-30");
  assert.equal(a.availableQty, 0);
  assert.match(a.reason, /Lent to Pastor Otieno \(DOF-LOAN-\d{4}\), due back/);
  assert.equal(availabilityOn(cam, "2026-10-03", "2026-10-03").availableQty, 1, "free once it is due back");
  // A booking for a production on a day it is lent is refused, with the return date.
  const cs = CS.createCallSheet(hop(), { contentId: "DOF-SER-001", date: "2026-09-30" });
  throwsRule(
    () => E.addGearToSheet(hop(), { id: cs.id, contentId: cs.contentId, date: cs.date }, [{ equipmentId: cam.id, quantity: 1 }]),
    /Lent to Pastor Otieno/,
  );
  // Lending something booked for a production is refused too.
  E.addGearToSheet(hop(), { id: cs.id, contentId: cs.contentId, date: cs.date }, [{ equipmentId: "DOF-EQ-CAM-002", quantity: 1 }]);
  throwsRule(
    () =>
      L.createLoan(crew(2), {
        borrowerName: "Youth",
        dateOut: "2026-09-30",
        expectedReturn: "2026-09-30",
        lines: [{ equipmentId: "DOF-EQ-CAM-002", quantity: 1 }],
      }),
    /not free for those dates/,
  );
  throwsRule(() =>
    L.createLoan(vol(), {
      borrowerName: "Me",
      dateOut: "2026-09-30",
      expectedReturn: "2026-09-30",
      lines: [{ equipmentId: "DOF-EQ-CAM-004", quantity: 1 }],
    }),
  );
  throwsRule(() => E.retireItem(hop(), cam.id, "retired", "old"), /lent out/);
  ok();
});

await t("items come back a few at a time; a late loan keeps holding them, is overdue, and closes when all are back", () => {
  const xlr = getDb().equipment.find((e) => e.trackingType === "aggregate" && e.baseStatus === "active" && e.quantityTotal >= 4)!;
  const loan = L.createLoan(crew(2), {
    borrowerName: "Kibera Fellowship",
    dateOut: "2026-09-20",
    expectedReturn: "2026-09-24", // two days ago
    lines: [
      { equipmentId: xlr.id, quantity: 4 },
      { equipmentId: "DOF-EQ-CAM-004", quantity: 1 },
    ],
  });
  assert.deepEqual(
    overdueLoans().map((l) => l.id),
    [loan.id],
  );
  assert.equal(daysLate(loan), 2);
  const held = availabilityOn(getItem("DOF-EQ-CAM-004")!, "2026-10-30", "2026-10-30");
  assert.equal(held.availableQty, 0, "late and still out: held until it is checked in");
  assert.match(held.reason, /overdue since/);
  assert.equal(displayStatus(getItem("DOF-EQ-CAM-004")!).label, "Loan overdue");
  L.returnLoanItems(crew(2), loan.id, [{ equipmentId: xlr.id, quantity: 3, condition: "Good" }]);
  assert.equal(L.getLoan(loan.id)!.status, "out");
  throwsRule(() => L.returnLoanItems(crew(2), loan.id, [{ equipmentId: xlr.id, quantity: 2, condition: "Good" }]), /Only 1/);
  L.returnLoanItems(crew(2), loan.id, [
    { equipmentId: xlr.id, quantity: 1, condition: "Fair" },
    { equipmentId: "DOF-EQ-CAM-004", quantity: 1, condition: "Fair", note: "Leg sticks" },
  ]);
  const back = L.getLoan(loan.id)!;
  assert.equal(back.status, "returned");
  assert.ok(back.returnedAt);
  assert.equal(getItem("DOF-EQ-CAM-004")!.condition, "Fair", "a serialized item takes the condition it came back in");
  assert.ok(
    getDb().equipmentHistory.some(
      (h) => h.equipmentId === "DOF-EQ-CAM-004" && h.kind === "loan-returned" && h.detail.includes("Leg sticks"),
    ),
  );
  assert.equal(overdueLoans().length, 0);
  ok();
});

await t("a loan can be kept longer only if its items are free for the extra days, and called off before anything comes back", () => {
  const loan = L.createLoan(crew(2), {
    borrowerName: "Choir",
    dateOut: "2026-10-01",
    expectedReturn: "2026-10-02",
    lines: [{ equipmentId: "DOF-EQ-AUD-001", quantity: 1 }],
  });
  const cs = CS.createCallSheet(hop(), { contentId: "DOF-SER-001", date: "2026-10-05" });
  E.addGearToSheet(hop(), { id: cs.id, contentId: cs.contentId, date: cs.date }, [{ equipmentId: "DOF-EQ-AUD-001", quantity: 1 }]);
  L.updateLoan(crew(2), loan.id, { expectedReturn: "2026-10-04" });
  throwsRule(() => L.updateLoan(crew(2), loan.id, { expectedReturn: "2026-10-06" }), /booked after/);
  throwsRule(() => L.cancelLoan(crew(2), loan.id, ""), /why/);
  L.cancelLoan(crew(2), loan.id, "The choir borrowed elsewhere");
  assert.equal(L.getLoan(loan.id)!.status, "cancelled");
  assert.equal(availabilityOn(getItem("DOF-EQ-AUD-001")!, "2026-10-01", "2026-10-01").availableQty, 1);
  ok();
});

// ── Role kits ────────────────────────────────────────────────

await t("a role kit is offered item by item to the matching roles on a call sheet, with what is not free marked", () => {
  const kit = K.createKit(crew(2), {
    role: "Camera operator",
    keywords: ["camera", "dop"],
    cameraModel: "FX3",
    items: [
      { equipmentId: "DOF-EQ-CAM-001", quantity: 1 },
      { equipmentId: "DOF-EQ-CAM-003", quantity: 1 },
      { equipmentId: "DOF-EQ-CAM-004", quantity: 1 },
    ],
  });
  throwsRule(() => K.createKit(vol(), { role: "Runner" }));
  assert.deepEqual(
    kitsForRole("Camera 1").map((k) => k.id),
    [kit.id],
  );
  assert.deepEqual(
    kitsForRole("DOP").map((k) => k.id),
    [kit.id],
  );
  assert.deepEqual(kitsForRole("Audio"), []);
  const cs = CS.createCallSheet(hop(), { contentId: "DOF-SER-001", date: "2026-10-08" });
  CS.updateCallSheet(hop(), cs.id, { crewPersonIds: ["DOF-P-CRW-002"], crewRoles: { "DOF-P-CRW-002": "Camera 1" } });
  // The lens is booked elsewhere that day; the body is already on this sheet.
  const other = CS.createCallSheet(hop(), { contentId: "DOF-SER-001", date: "2026-10-08" });
  E.addGearToSheet(hop(), { id: other.id, contentId: other.contentId, date: other.date }, [{ equipmentId: "DOF-EQ-CAM-003", quantity: 1 }]);
  E.addGearToSheet(hop(), { id: cs.id, contentId: cs.contentId, date: cs.date }, [{ equipmentId: "DOF-EQ-CAM-001", quantity: 1 }]);
  const [s] = kitSuggestions(CS.getCallSheet(cs.id)!);
  assert.deepEqual(s.roles, ["Camera 1"]);
  assert.deepEqual(
    s.items.map((x) => [x.item.id, x.free]),
    [
      ["DOF-EQ-CAM-003", false],
      ["DOF-EQ-CAM-004", true],
    ],
  );
  assert.match(s.items[0].reason, /Booked for/);
  assert.equal(E.manifestForSheet(cs.id)!.lines.length, 1, "nothing is booked by suggesting it");
  K.updateKit(crew(2), kit.id, { keywords: ["steadicam"] });
  assert.deepEqual(kitSuggestions(CS.getCallSheet(cs.id)!), []);
  K.deleteKit(crew(2), kit.id);
  assert.equal(getDb().roleKits.length, 0);
});

// ── Reminders and the bell ───────────────────────────────────

await t("a reminder on a session fires into each recipient's bell at its time, and follows the session when it moves", () => {
  const s3 = session(3); // 3 October
  const r = A.createReminder(crew(1), {
    targetType: "instance",
    targetId: s3.id,
    offsetMinutes: 1440,
    channels: ["app"],
    recipientIds: ["DOF-P-CRW-001", "DOF-P-CRW-002"],
  });
  assert.equal(r.fireAt, nairobiInstant("2026-10-02", "08:00"), "a day before, from 08:00 for a session with no start time");
  throwsRule(
    () => A.createReminder(crew(1), { targetType: "instance", targetId: s3.id, offsetMinutes: 60, channels: ["email"] }),
    /a day or more ahead/,
  );
  throwsRule(() => A.createReminder(vol(), { title: "x", date: "2026-10-01", recipientIds: ["DOF-P-CRW-001"] }), /yourself/);
  // The session moves to 10 October: the reminder moves with it.
  W.updateSession(hop(), s3.id, { scheduledDate: "2026-10-10" });
  const db = getDb();
  assert.equal(fireReminders(db, nairobiInstant("2026-10-02", "09:00")).inApp, 0, "not due any more on the old date");
  assert.equal(db.calendarReminders[0].fireAt, nairobiInstant("2026-10-09", "08:00"));
  assert.equal(fireReminders(db, nairobiInstant("2026-10-09", "08:01")).inApp, 2);
  assert.equal(fireReminders(db, nairobiInstant("2026-10-09", "09:00")).inApp, 0, "fires once");
  const [n] = notificationsFor("DOF-P-CRW-002");
  assert.match(n.body, /Oct 10, 2026/);
  assert.equal(n.link, `#/session/${s3.id}`);
  A.markNotificationsRead(crew(2), []);
  assert.ok(notificationsFor("DOF-P-CRW-002").every((x) => x.readAt));
  assert.ok(!notificationsFor("DOF-P-CRW-001")[0].readAt, "one's own only");
  ok();
});

await t("email reminders are queued by the morning run for everything due before the next one; a repeating one moves on", () => {
  const r = A.createReminder(hop(), {
    title: "Back up the drives",
    date: "2026-09-28",
    time: "18:00",
    offsetMinutes: 1440, // due 27 September at 18:00
    channels: ["app", "email"],
    repeat: "weekly",
  });
  const db = getDb();
  const morning = nairobiInstant("2026-09-27", "06:45");
  const until = new Date(Date.parse(morning) + 24 * 3_600_000).toISOString();
  const fired = fireReminders(db, morning, until);
  assert.equal(fired.inApp, 0, "the bell waits for the time itself");
  assert.equal(fired.emails.length, 1, "the email goes out in the morning run before it is due");
  assert.equal(fired.emails[0].to, db.people.find((p) => p.personId === "DOF-P-HOP-001")!.email);
  assert.match(fired.emails[0].subject, /Back up the drives/);
  assert.equal(fireReminders(db, morning, until).emails.length, 0, "never twice");
  assert.equal(fireReminders(db, nairobiInstant("2026-09-27", "18:05")).inApp, 1);
  const after = db.calendarReminders.find((x) => x.id === r.id)!;
  assert.equal(after.date, "2026-10-05", "both sent, so it moves to next week");
  assert.equal(after.fireAt, nairobiInstant("2026-10-04", "18:00"));
});

// ── The email queue ──────────────────────────────────────────

await t("the email queue sends each message once, retries a failure five times in all, and holds email in quiet hours", () => {
  const db = getDb();
  const now = "2026-09-26T04:00:00.000Z"; // 07:00 in Nairobi
  assert.equal(queueEmail(db, { personId: "DOF-P-CRW-001", to: "crew1@dof.demo", subject: "S", body: "B", key: "k1" }, now), true);
  assert.equal(
    queueEmail(db, { personId: "DOF-P-CRW-001", to: "crew1@dof.demo", subject: "S", body: "B", key: "k1" }, now),
    false,
    "same key: not twice",
  );
  assert.equal(queueEmail(db, { personId: null, to: "not an address", subject: "S", body: "B", key: "k2" }, now), false);
  const [m] = takeDue(db, now, 10);
  assert.equal(takeDue(db, now, 10).length, 0, "leased: a second request at the same moment takes nothing");
  recordSend(db, m.id, now, "Connection refused");
  assert.equal(db.emailQueue[0].status, "queued");
  assert.equal(db.emailQueue[0].nextTryAt, "2026-09-26T04:05:00.000Z", "tried again in five minutes");
  for (let i = 1; i < MAX_ATTEMPTS; i++) recordSend(db, m.id, now, "Connection refused");
  assert.equal(db.emailQueue[0].status, "failed");
  // Quiet hours, 22:00 to 07:30: an email at 07:00 waits until 07:30.
  db.people.find((p) => p.personId === "DOF-P-CRW-002")!.quietHours = { from: "22:00", to: "07:30" };
  queueEmail(db, { personId: "DOF-P-CRW-002", to: "crew2@dof.demo", subject: "S", body: "B", key: "k3" }, now);
  assert.equal(takeDue(db, now, 10).length, 0);
  assert.equal(db.emailQueue[1].nextTryAt, "2026-09-26T04:30:00.000Z");
  assert.equal(quietUntil({ from: "22:00", to: "07:30" }, "2026-09-26T09:00:00.000Z"), null, "12:00: not quiet");
  assert.equal(takeDue(db, "2026-09-26T04:30:00.000Z", 10).length, 1);
});

// ── The urgency report ───────────────────────────────────────

await t("each project gets a level and its reasons from plain rules; late loans are listed too", () => {
  // Session 2 records today with no call sheet, and the theological review is not done on the brief.
  let rows = urgencyReport(hop());
  const wow = rows.find((r) => r.id === WOW)!;
  assert.equal(wow.level, "Critical");
  assert.equal(wow.reasons[0], "Recording today (Session 2) with no published call sheet.");
  // An overdue episode of the season is Critical too; nothing is overdue at season level itself.
  const ep = getDb().records.find((r) => r.episode && r.parentId === WOW && r.episode.mdStage !== "Published")!;
  ep.stageDeadlines[ep.episode!.stage] = "2026-09-20";
  rows = urgencyReport(hop());
  assert.ok(rows.find((r) => r.id === WOW)!.reasons.some((x) => /episode overdue/.test(x)));
  // A late loan: High within a week, then Critical.
  L.createLoan(crew(2), {
    borrowerName: "Choir",
    dateOut: "2026-09-10",
    expectedReturn: "2026-09-22",
    lines: [{ equipmentId: "DOF-EQ-CAM-004", quantity: 1 }],
  });
  L.createLoan(crew(2), {
    borrowerName: "Youth",
    dateOut: "2026-09-01",
    expectedReturn: "2026-09-12",
    lines: [{ equipmentId: "DOF-EQ-AUD-003", quantity: 1 }],
  });
  rows = urgencyReport(hop());
  const loans = rows.filter((r) => r.kind === "loan");
  assert.deepEqual(
    loans.map((r) => [r.title, r.level]),
    [
      ["Youth", "Critical"],
      ["Choir", "High"],
    ],
  );
  assert.match(loans[1].reasons[0], /4 days late/);
  assert.ok(!urgencyReport(vol()).some((r) => r.kind === "loan"), "loans only for people who use the equipment");
  // Most urgent first.
  const order = ["Critical", "High", "Watch", "On track"];
  assert.deepEqual(
    rows.map((r) => order.indexOf(r.level)),
    [...rows.map((r) => order.indexOf(r.level))].sort((a, b) => a - b),
  );
});

await t("the urgency thresholds come from settings", () => {
  // Session 3 records in a week: outside the default 24 hours, inside a window of eight days.
  const s3 = /\(Session 3\) with no published call sheet/;
  assert.ok(
    !urgencyReport(hop())
      .find((r) => r.id === WOW)!
      .reasons.some((r) => s3.test(r)),
  );
  getDb().settings.urgency = { soonHours: 8 * 24 };
  assert.ok(
    urgencyReport(hop())
      .find((r) => r.id === WOW)!
      .reasons.some((r) => /^Recording in 7 days \(Session 3\)/.test(r)),
  );
});

// ── Templates ────────────────────────────────────────────────

await t("a storyboard saved as a template is copied into a project on use, and editing the copy never changes it", () => {
  const board = D.createStoryboard(hop(), WOW, { name: "Interview set" });
  D.addFrame(hop(), board.id, { description: "Wide of the set" });
  D.addFrame(hop(), board.id, { description: "Host close-up" });
  const tpl = D.saveStoryboardAsTemplate(crew(1), board.id, "Two-chair interview");
  assert.deepEqual([tpl.contentId, tpl.isTemplate, tpl.name], [null, true, "Two-chair interview"]);
  assert.equal(D.framesOf(tpl.id).length, 2);
  const copy = D.createStoryboard(hop(), "DOF-DEV-001", { name: "", copyFrom: tpl.id });
  D.updateFrame(hop(), D.framesOf(copy.id)[0].id, { description: "Changed in the project" });
  assert.equal(D.framesOf(tpl.id)[0].description, "Wide of the set", "the template is untouched");
  throwsRule(() => D.createStoryboard(vol(), null, { name: "Mine" }), /Head of Production and crew/);
  throwsRule(() => D.addFrame(vol(), tpl.id, {}), /Head of Production and crew/);
  throwsRule(() => D.createStoryboard(hop(), null, { name: "x", episodeId: "DOF-SER-001-S1-E01" }), /no episode/);
  const practice = D.createShotList(crew(1), null, { name: "Practice" });
  assert.deepEqual([practice.contentId, practice.isTemplate], [null, false]);
  D.addShotRow(crew(1), practice.id, "shot", { description: "Wide" });
  const listTpl = D.saveShotListAsTemplate(crew(1), practice.id, "Basic coverage");
  assert.equal(D.rowsOfShotList(listTpl.id).length, 1);
  assert.deepEqual(
    D.shotListsOf(null).map((l) => l.name),
    ["Practice", "Basic coverage"],
  );
  ok();
});

console.log(`\n${passed} passed`);
