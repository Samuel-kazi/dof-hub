// Run with: npx tsx tests/gear.test.ts
import assert from "node:assert/strict";
import { getDb, resetDemoData } from "../src/data/store";
import { RuleError } from "../src/types";
import { login } from "../src/services/auth";
import { isoDay } from "../src/data/seed";
import * as E from "../src/services/equipment";
import * as S from "../src/services/storage";
import * as CS from "../src/services/callsheets";
import * as C from "../src/services/content";

let passed = 0;
const t = (name: string, fn: () => void) => {
  resetDemoData();
  try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", (e as Error).message); process.exitCode = 1; }
};
const throwsRule = (fn: () => unknown, match?: RegExp) => assert.throws(fn, (e) => e instanceof RuleError && (!match || match.test(e.message)));

const hop = () => login("hop@dof.demo", "demo");
const crew1 = () => login("crew1@dof.demo", "demo"); // Series, Devotional, Music
const crew2 = () => login("crew2@dof.demo", "demo"); // Series, Documentary. Responsible for the overdue list.
const vol = () => login("volunteer1@dof.demo", "demo");
const ptr = () => login("partner1@dof.demo", "demo");

const cameraInput = (over: Partial<E.ItemInput> = {}): E.ItemInput => ({ trackingType: "serialized", name: "Test camera", make: "M", model: "X", category: "camera", serialNumber: "SN-NEW-1", unitCost: 100, vendor: "", condition: "Good", packaging: "", accessories: "", info: "", ...over });
const item = (id: string) => E.getItem(id)!;

// ── Items and codes ──
t("serialized asset codes continue the category sequence", () => assert.equal(E.createItem(hop(), cameraInput()).id, "DOF-EQ-CAM-005"));
t("serialized items need a unique serial number", () => {
  throwsRule(() => E.createItem(hop(), cameraInput({ serialNumber: "" })), /serial/i);
  throwsRule(() => E.createItem(hop(), cameraInput({ serialNumber: "s-fx3-0412" })), /already registered/);
});
t("new batches get the next batch code within their family", () => {
  const b = E.createItem(crew1(), { ...cameraInput(), trackingType: "aggregate", category: "cabling", name: "XLR cable 10 m", itemFamily: "XLR-10M", quantity: 5, serialNumber: undefined });
  assert.equal(b.id, "DOF-EQ-CAB-XLR10M-B03");
  const c = E.createItem(crew1(), { ...cameraInput(), trackingType: "aggregate", category: "cabling", name: "SDI cable", itemFamily: "SDI-5M", quantity: 2, serialNumber: undefined });
  assert.equal(c.id, "DOF-EQ-CAB-SDI5M-B01");
});
t("batches need a family and a whole quantity", () => {
  throwsRule(() => E.createItem(hop(), { ...cameraInput(), trackingType: "aggregate", category: "cabling", itemFamily: "", quantity: 3 }), /family/);
  throwsRule(() => E.createItem(hop(), { ...cameraInput(), trackingType: "aggregate", category: "cabling", itemFamily: "X", quantity: 0 }), /Quantity/);
});
t("volunteers and partners cannot touch equipment", () => {
  throwsRule(() => E.createItem(vol(), cameraInput()), /crew/i);
  throwsRule(() => E.listManifests(ptr()), /crew/i);
});
t("every new item starts with a history entry", () => {
  const i = E.createItem(hop(), cameraInput());
  assert.equal(E.itemHistory(i.id)[0].kind, "created");
});

// ── Availability and conflicts ──
t("gear in repair or retired cannot be assigned", () => {
  throwsRule(() => E.createManifest(hop(), { contentId: "DOF-SER-001", date: isoDay(5), destination: "studio", status: "assigned", lines: [{ equipmentId: "DOF-EQ-LGT-002", quantity: 1 }] }), /in repair/);
  throwsRule(() => E.createManifest(hop(), { contentId: "DOF-SER-001", date: isoDay(5), destination: "studio", status: "assigned", lines: [{ equipmentId: "DOF-EQ-AUD-004", quantity: 1 }] }), /retired/);
});
t("an item booked for a date cannot be booked again that date, but can on another", () => {
  const mk = (date: string) => E.createManifest(hop(), { contentId: "DOF-SER-001", date, destination: "studio", status: "assigned", lines: [{ equipmentId: "DOF-EQ-CAM-001", quantity: 1 }] });
  throwsRule(() => mk(isoDay(2)), /not free/);
  assert.ok(mk(isoDay(4)));
});
t("outside checkouts block every day in their range", () => {
  E.createManifest(hop(), { contentId: "DOF-SER-001", date: isoDay(10), expectedReturn: isoDay(14), destination: "outside", status: "assigned", lines: [{ equipmentId: "DOF-EQ-AUD-002", quantity: 1 }] });
  const a = E.availabilityOn(item("DOF-EQ-AUD-002"), isoDay(12), isoDay(12));
  assert.equal(a.availableQty, 0); assert.match(a.reason, /DOF-SER-001/);
  assert.equal(E.availabilityOn(item("DOF-EQ-AUD-002"), isoDay(15), isoDay(15)).availableQty, 1);
});
t("a late checkout still occupies its gear until it is checked in", () => {
  assert.equal(E.availabilityOn(item("DOF-EQ-CAM-002"), isoDay(0), isoDay(0)).availableQty, 0);
  assert.equal(E.displayStatus(item("DOF-EQ-CAM-002")).label, "Overdue");
});
t("batch quantities are checked per batch and drawn oldest first", () => {
  throwsRule(() => E.createManifest(hop(), { contentId: "DOF-SER-001", date: isoDay(2), destination: "studio", status: "assigned", lines: [{ equipmentId: "DOF-EQ-CAB-XLR10M-B01", quantity: 9 }] }), /Only 8/);
  const lines = E.allocateFifo("XLR-10M", 10, isoDay(2), isoDay(2));
  assert.deepEqual(lines, [{ equipmentId: "DOF-EQ-CAB-XLR10M-B01", quantity: 8 }, { equipmentId: "DOF-EQ-CAB-XLR10M-B02", quantity: 2 }]);
  throwsRule(() => E.allocateFifo("XLR-10M", 17, isoDay(2), isoDay(2)), /Only 16/);
});
t("crew can only build lists for projects they are attached to", () => {
  throwsRule(() => E.createManifest(crew2(), { contentId: "DOF-LIVE-001", date: isoDay(6), destination: "studio", status: "assigned", lines: [{ equipmentId: "DOF-EQ-AUD-002", quantity: 1 }] }), /not attached/);
});
t("checking out now records who, when and where", () => {
  const m = E.createManifest(crew2(), { contentId: "DOF-DOC-001", date: isoDay(0), destination: "outside", status: "checked-out", lines: [{ equipmentId: "DOF-EQ-AUD-002", quantity: 1 }] });
  assert.equal(m.status, "checked-out"); assert.equal(m.responsiblePersonId, "DOF-P-CRW-002");
  assert.equal(m.expectedReturn, isoDay(getDb().settings.checkoutReturnDays));
  assert.equal(E.displayStatus(item("DOF-EQ-AUD-002")).label, "Checked out");
});

// ── Going out and check-in ──
t("assigned gear can be marked as gone out, with photos stored on the event", () => {
  const m = E.markGoneOut(crew2(), "DOF-MF-001", { expectedReturn: isoDay(4), photos: { "DOF-EQ-CAM-001": [{ url: "data:image/jpeg;base64,AAAA", caption: "" }] } });
  assert.equal(m.status, "checked-out"); assert.equal(m.destination, "outside");
  assert.equal(m.lines.find((l) => l.equipmentId === "DOF-EQ-CAM-001")!.photosOut.length, 1);
  assert.ok(m.lines[0].photosOut.length + m.lines[1].photosOut.length >= 1);
});
t("gear sent to repair after being assigned cannot go out", () => {
  E.startRepair(crew2(), "DOF-EQ-AUD-001", "Dead battery");
  throwsRule(() => E.markGoneOut(crew2(), "DOF-MF-001"), /in repair/);
});
t("a clean check-in frees the gear and logs it", () => {
  const m = E.checkIn(crew2(), "DOF-MF-002", [
    { equipmentId: "DOF-EQ-CAM-002", returnedGood: 1, damaged: 0, lost: 0, conditionIn: "Good" },
    { equipmentId: "DOF-EQ-CAM-004", returnedGood: 1, damaged: 0, lost: 0, conditionIn: "Good" },
    { equipmentId: "DOF-EQ-AUD-003", returnedGood: 1, damaged: 0, lost: 0, conditionIn: "Good" },
  ]);
  assert.equal(m.status, "returned");
  assert.equal(E.overdueManifests().length, 0);
  assert.equal(E.displayStatus(item("DOF-EQ-CAM-002")).label, "Available");
  assert.equal(E.itemHistory("DOF-EQ-CAM-002")[0].kind, "checked-in");
});
t("a drop in condition is logged as damage even when nobody ticked damaged", () => {
  const ret = (desc?: string) => E.checkIn(crew2(), "DOF-MF-002", [
    { equipmentId: "DOF-EQ-CAM-002", returnedGood: 1, damaged: 0, lost: 0, conditionIn: "Fair", description: desc },
    { equipmentId: "DOF-EQ-CAM-004", returnedGood: 1, damaged: 0, lost: 0, conditionIn: "Good" },
    { equipmentId: "DOF-EQ-AUD-003", returnedGood: 1, damaged: 0, lost: 0, conditionIn: "Good" },
  ]);
  throwsRule(() => ret(), /Describe what happened/);
  ret("Sand in the mount");
  const inc = E.itemIncidents("DOF-EQ-CAM-002");
  assert.equal(inc.length, 1); assert.equal(inc[0].personId, "DOF-P-CRW-002"); assert.equal(inc[0].contentId, "DOF-DOC-001");
  assert.equal(item("DOF-EQ-CAM-002").condition, "Fair");
});
t("check-in is all or nothing", () => {
  throwsRule(() => E.checkIn(crew2(), "DOF-MF-002", [
    { equipmentId: "DOF-EQ-CAM-002", returnedGood: 1, damaged: 0, lost: 0, conditionIn: "Poor", description: "Dropped" },
    { equipmentId: "DOF-EQ-CAM-004", returnedGood: 0, damaged: 0, lost: 0 }, // does not add up
    { equipmentId: "DOF-EQ-AUD-003", returnedGood: 1, damaged: 0, lost: 0, conditionIn: "Good" },
  ]), /add up/);
  assert.equal(E.getManifest("DOF-MF-002")!.status, "checked-out");
  assert.equal(item("DOF-EQ-CAM-002").condition, "Good");
  assert.equal(E.itemIncidents("DOF-EQ-CAM-002").length, 0);
});
t("a lost serialized item is taken out of service", () => {
  E.checkIn(crew2(), "DOF-MF-002", [
    { equipmentId: "DOF-EQ-CAM-002", returnedGood: 0, damaged: 0, lost: 1, description: "Left at the roadside" },
    { equipmentId: "DOF-EQ-CAM-004", returnedGood: 1, damaged: 0, lost: 0, conditionIn: "Good" },
    { equipmentId: "DOF-EQ-AUD-003", returnedGood: 1, damaged: 0, lost: 0, conditionIn: "Good" },
  ]);
  assert.equal(item("DOF-EQ-CAM-002").baseStatus, "lost");
  assert.equal(E.itemIncidents("DOF-EQ-CAM-002")[0].type, "loss");
});
t("damage can send the item straight to repair", () => {
  E.checkIn(crew2(), "DOF-MF-002", [
    { equipmentId: "DOF-EQ-CAM-002", returnedGood: 0, damaged: 1, lost: 0, conditionIn: "Poor", description: "Cracked screen", sendToRepair: true },
    { equipmentId: "DOF-EQ-CAM-004", returnedGood: 1, damaged: 0, lost: 0, conditionIn: "Good" },
    { equipmentId: "DOF-EQ-AUD-003", returnedGood: 1, damaged: 0, lost: 0, conditionIn: "Good" },
  ]);
  assert.equal(item("DOF-EQ-CAM-002").baseStatus, "in-repair");
});
t("batch check-in removes damaged and lost units from that batch and logs them", () => {
  const m = E.createManifest(crew2(), { contentId: "DOF-DOC-001", date: isoDay(0), destination: "outside", status: "checked-out", lines: [{ equipmentId: "DOF-EQ-CAB-XLR10M-B02", quantity: 6 }] });
  throwsRule(() => E.checkIn(crew2(), m.id, [{ equipmentId: "DOF-EQ-CAB-XLR10M-B02", returnedGood: 3, damaged: 2, lost: 0 }]), /add up|Describe/);
  E.checkIn(crew2(), m.id, [{ equipmentId: "DOF-EQ-CAB-XLR10M-B02", returnedGood: 3, damaged: 2, lost: 1, description: "Crushed by a case" }]);
  const b = item("DOF-EQ-CAB-XLR10M-B02");
  assert.equal(b.quantityTotal, 5); assert.equal(b.quantityDamaged, 2); assert.equal(b.quantityLost, 1);
  assert.equal(E.itemIncidents(b.id).length, 2);
  assert.equal(item("DOF-EQ-CAB-XLR10M-B01").quantityTotal, 12, "other batches are untouched");
});
t("assigned gear can be released without ever leaving", () => {
  E.releaseManifest(crew2(), "DOF-MF-001");
  assert.equal(E.displayStatus(item("DOF-EQ-CAM-001")).label, "Available");
  assert.deepEqual(getDb().callSheets[0].equipmentIds, []);
});

// ── Repair, retire, delete ──
t("repair cycle records history and blocks assignment in between", () => {
  E.startRepair(crew1(), "DOF-EQ-AUD-002", "Loose pan handle");
  throwsRule(() => E.startRepair(crew1(), "DOF-EQ-AUD-002", "again"), /in service/);
  E.finishRepair(crew1(), "DOF-EQ-AUD-002", "Good", "Tightened");
  assert.equal(item("DOF-EQ-AUD-002").baseStatus, "active");
  assert.deepEqual(E.itemHistory("DOF-EQ-AUD-002").slice(0, 2).map((h) => h.kind), ["repair-end", "repair-start"]);
});
t("checked-out gear cannot be sent to repair", () => throwsRule(() => E.startRepair(crew2(), "DOF-EQ-CAM-002", "x"), /checked out/));
t("only the Head of Production retires; not while on a list", () => {
  throwsRule(() => E.retireItem(crew1(), "DOF-EQ-AUD-002", "retired", ""), /Head of Production/);
  throwsRule(() => E.retireItem(hop(), "DOF-EQ-CAM-001", "retired", ""), /active checkout list/);
  E.retireItem(hop(), "DOF-EQ-AUD-002", "retired", "Obsolete");
  assert.equal(item("DOF-EQ-AUD-002").baseStatus, "retired");
});
t("items with history are retired, never deleted", () => {
  throwsRule(() => E.deleteItem(hop(), "DOF-EQ-CAM-003"), /history/);
  const fresh = E.createItem(hop(), cameraInput());
  E.deleteItem(hop(), fresh.id);
  assert.equal(E.getItem(fresh.id), undefined);
});
t("the lens keeps its scratch history", () => {
  assert.equal(E.itemIncidents("DOF-EQ-CAM-003").length, 2);
  assert.ok(E.itemHistory("DOF-EQ-CAM-003").filter((h) => h.kind === "incident").length === 2);
});

// ── Attachments ──
t("attachments accept small images and http links only", () => {
  E.addAttachment(crew1(), "DOF-EQ-CAM-001", "photo", { url: "data:image/jpeg;base64,AAAA" });
  E.addAttachment(crew1(), "DOF-EQ-CAM-001", "receipt", { url: "https://drive.google.com/x" });
  throwsRule(() => E.addAttachment(crew1(), "DOF-EQ-CAM-001", "photo", { url: "file:///etc/passwd" }), /http/);
  throwsRule(() => E.addAttachment(crew1(), "DOF-EQ-CAM-001", "photo", { url: "data:text/html;base64,AAAA" }), /images/);
  throwsRule(() => E.addAttachment(crew1(), "DOF-EQ-CAM-001", "photo", { url: "data:image/jpeg;base64," + "A".repeat(430_000) }), /too large/);
  assert.equal(item("DOF-EQ-CAM-001").photos.length, 1); assert.equal(item("DOF-EQ-CAM-001").receipts.length, 1);
});

// ── Call sheet gear ──
t("gear added on a call sheet becomes a linked checkout list", () => {
  const cs = CS.createCallSheet(crew2(), { contentId: "DOF-SER-001", date: isoDay(6) });
  const m = E.addGearToSheet(crew2(), { id: cs.id, contentId: cs.contentId, date: cs.date }, [{ equipmentId: "DOF-EQ-AUD-002", quantity: 1 }]);
  assert.equal(m.callSheetId, cs.id); assert.equal(m.status, "assigned");
  assert.deepEqual(CS.getCallSheet(cs.id)!.equipmentIds, ["DOF-EQ-AUD-002"]);
  E.addGearToSheet(crew2(), { id: cs.id, contentId: cs.contentId, date: cs.date }, [{ equipmentId: "DOF-EQ-AUD-003", quantity: 1 }]);
  assert.equal(E.manifestForSheet(cs.id)!.lines.length, 2);
});
t("adding a clashing item to a sheet adds nothing at all", () => {
  const cs = CS.createCallSheet(crew2(), { contentId: "DOF-SER-001", date: isoDay(2) }); // same day as the seeded sheet
  throwsRule(() => E.addGearToSheet(crew2(), { id: cs.id, contentId: cs.contentId, date: cs.date }, [{ equipmentId: "DOF-EQ-AUD-002", quantity: 1 }, { equipmentId: "DOF-EQ-CAM-001", quantity: 1 }]), /not free/);
  assert.equal(E.manifestForSheet(cs.id), undefined);
});
t("finalize is blocked while gear is in repair", () => {
  E.startRepair(crew2(), "DOF-EQ-AUD-001", "Dead battery");
  throwsRule(() => CS.finalizeCallSheet(crew2(), "DOF-CS-001"), /Gear needs attention/);
});
t("duplicate copies gear that is free and reports what it skipped", () => {
  E.createManifest(hop(), { contentId: "DOF-SER-001", date: isoDay(9), destination: "studio", status: "assigned", lines: [{ equipmentId: "DOF-EQ-CAM-001", quantity: 1 }] });
  const res = CS.duplicateCallSheet(crew2(), "DOF-CS-001", isoDay(9));
  assert.equal(res.gear.copied, 3); assert.equal(res.gear.skipped.length, 1); assert.match(res.gear.skipped[0], /Sony FX3/);
  assert.equal(E.manifestForSheet(res.sheet.id)!.lines.length, 3);
});
t("moving a call sheet moves its gear, or refuses when the gear is taken", () => {
  E.createManifest(hop(), { contentId: "DOF-SER-001", date: isoDay(7), destination: "studio", status: "assigned", lines: [{ equipmentId: "DOF-EQ-CAM-001", quantity: 1 }] });
  throwsRule(() => CS.updateCallSheet(crew2(), "DOF-CS-001", { date: isoDay(7) }), /not free/);
  assert.equal(CS.getCallSheet("DOF-CS-001")!.date, isoDay(2));
  CS.updateCallSheet(crew2(), "DOF-CS-001", { date: isoDay(8) });
  assert.equal(E.manifestForSheet("DOF-CS-001")!.date, isoDay(8));
});
t("deleting a call sheet releases its gear, unless the gear is out", () => {
  const cs = CS.createCallSheet(crew2(), { contentId: "DOF-SER-001", date: isoDay(6) });
  E.addGearToSheet(crew2(), { id: cs.id, contentId: cs.contentId, date: cs.date }, [{ equipmentId: "DOF-EQ-AUD-002", quantity: 1 }]);
  CS.deleteCallSheet(crew2(), cs.id);
  assert.equal(E.displayStatus(item("DOF-EQ-AUD-002")).label, "Available");
  E.markGoneOut(crew2(), "DOF-MF-001", { expectedReturn: isoDay(4) });
  throwsRule(() => CS.deleteCallSheet(crew2(), "DOF-CS-001"), /checked out/);
});
t("volunteers can see which gear is on a call sheet but not change it", () => {
  assert.equal(E.manifestForSheet("DOF-CS-001")!.lines.length, 4);
  throwsRule(() => E.addGearToSheet(vol(), { id: "DOF-CS-001", contentId: "DOF-SER-001", date: isoDay(2) }, [{ equipmentId: "DOF-EQ-AUD-002", quantity: 1 }]), /crew/i);
});

// ── Storage ──
t("fleet totals add up from projects and other files", () => {
  const f = S.fleetTotals();
  assert.equal(f.capacity, 7 * 4000 + 2000 + 1000);
  assert.equal(f.used, 120 + 200 + 1450 + 900 + 780 + 300 + 1200 + 640 + 210 + 2600 + 1000 + 90 + 320);
});
t("drives near the threshold are flagged", () => {
  const near = S.allDriveUsage().filter(S.isNearlyFull).map((u) => u.drive.name);
  assert.deepEqual(near, ["Extreme Pro"]);
});
t("allocations cannot exceed free space", () => {
  throwsRule(() => S.addAllocation(hop(), { driveId: "DRV-006", contentId: "DOF-SER-001", sizeGB: 500, kind: "raw" }), /only/);
  S.addAllocation(hop(), { driveId: "DRV-006", contentId: "DOF-SER-001", sizeGB: 300, kind: "raw" });
  assert.equal(S.driveUsage(S.getDrive("DRV-006")!).usedGB, 3900);
});
t("raw footage stays until everything under it is delivered", () => {
  const raw = getDb().allocations.find((a) => a.contentId === "DOF-DOC-001" && a.kind === "raw")!;
  throwsRule(() => S.removeAllocation(crew2(), raw.id), /Delivered/);
  const delivered = getDb().allocations.find((a) => a.kind === "delivered")!;
  S.removeAllocation(hop(), delivered.id);
  assert.ok(!getDb().allocations.some((a) => a.id === delivered.id));
});
t("crew can only record footage for their own projects", () => {
  throwsRule(() => S.addAllocation(crew2(), { driveId: "DRV-003", contentId: "DOF-LIVE-001", sizeGB: 10, kind: "raw" }), /not attached/);
  S.addAllocation(crew2(), { driveId: "DRV-003", contentId: "DOF-DOC-001", sizeGB: 10, kind: "raw" });
});
t("only the Head of Production adds, renames or removes drives", () => {
  throwsRule(() => S.createDrive(crew2(), { name: "New", capacityGB: 1000 }), /Head of Production/);
  throwsRule(() => S.updateDrive(crew2(), "DRV-001", { name: "Renamed" }), /Head of Production/);
  S.updateDrive(crew2(), "DRV-001", { otherUsedGB: 150 });
  throwsRule(() => S.deleteDrive(hop(), "DRV-001"), /Projects are still/);
  const d = S.createDrive(hop(), { name: "Spare", capacityGB: 2000 });
  S.deleteDrive(hop(), d.id);
  throwsRule(() => S.createDrive(hop(), { name: "taji", capacityGB: 1000 }), /already exists/);
});
t("volunteers and partners have no storage access", () => throwsRule(() => S.addAllocation(vol(), { driveId: "DRV-003", contentId: "DOF-SER-001", sizeGB: 1, kind: "raw" }), /crew/i));
t("changes record a snapshot for today", () => {
  S.addAllocation(hop(), { driveId: "DRV-004", contentId: "DOF-MUS-001", sizeGB: 100, kind: "project" });
  const last = getDb().snapshots[getDb().snapshots.length - 1];
  assert.equal(last.date, isoDay(0)); assert.equal(last.usedGB, S.fleetTotals().used);
});
t("the forecast projects growth and a fill date", () => {
  const f = S.forecast();
  assert.ok(f.slopeGBPerDay > 0); assert.ok(f.projected.length > 5); assert.ok(f.fillDate && f.fillDate > isoDay(0));
  assert.equal(f.thresholdGB, 31000 * 0.85);
});
t("project reports list what is on a drive", () => {
  const txt = S.driveReportText("DRV-006");
  assert.match(txt, /DOF-DOC-001/); assert.match(txt, /Whispers|Samburu/);
  assert.match(S.fleetReportText(), /Extreme Pro: 3\.60 TB of 4\.00 TB \(90%\)/);
});
t("a record shows storage from itself, its children and its show", () => {
  const ep = C.getChildren("DOF-SER-001-S1")[0];
  const ids = S.allocationsForRecord(ep).map((a) => a.contentId);
  assert.ok(ids.includes("DOF-SER-001-S1-E01") || ids.includes("DOF-SER-001"));
  assert.ok(S.allocationsForRecord(getDb().records.find((r) => r.contentId === "DOF-SER-001")!).length >= 3);
});

console.log(`\n${passed} passed`);

// ── Several identical units added at once (e.g. 3 Sony FX6 bodies) ──
const unitsInput = (over: Partial<E.UnitsInput> = {}): E.UnitsInput => ({
  name: "Sony FX6 camera body", make: "Sony", model: "FX6", category: "camera",
  unitCost: 6000, vendor: "B&H", condition: "Good", packaging: "", accessories: "", info: "",
  units: [{ serialNumber: "FX6-001" }, { serialNumber: "FX6-002", label: "B-cam" }, { serialNumber: "FX6-003" }],
  ...over,
});

t("adding several units at once creates one record per serial, with sequential asset codes", () => {
  const made = E.createSerializedUnits(hop(), unitsInput());
  assert.equal(made.length, 3);
  assert.deepEqual(made.map((m) => m.id), ["DOF-EQ-CAM-005", "DOF-EQ-CAM-006", "DOF-EQ-CAM-007"]);
  assert.deepEqual(made.map((m) => m.serialNumber), ["FX6-001", "FX6-002", "FX6-003"]);
  assert.equal(made[1].unitLabel, "B-cam");
  assert.equal(made[0].unitLabel, null);
  for (const m of made) { assert.equal(m.make, "Sony"); assert.equal(m.model, "FX6"); assert.equal(m.unitCost, 6000); assert.equal(m.trackingType, "serialized"); }
});

t("a repeated serial number within the same batch saves nothing", () => {
  const before = getDb().equipment.length;
  throwsRule(() => E.createSerializedUnits(hop(), unitsInput({ units: [{ serialNumber: "FX6-001" }, { serialNumber: "fx6-001" }] })), /entered twice/);
  assert.equal(getDb().equipment.length, before);
});

t("a serial that already exists elsewhere in the inventory saves nothing", () => {
  const before = getDb().equipment.length;
  throwsRule(() => E.createSerializedUnits(hop(), unitsInput({ units: [{ serialNumber: "FX6-100" }, { serialNumber: "S-FX3-0412" }] })), /already registered as DOF-EQ-CAM-001/);
  assert.equal(getDb().equipment.length, before);
});

t("a blank serial number saves nothing, and names which unit needs one", () => {
  const before = getDb().equipment.length;
  throwsRule(() => E.createSerializedUnits(hop(), unitsInput({ units: [{ serialNumber: "FX6-001" }, { serialNumber: "  " }] })), /Unit 2 needs a serial number/);
  assert.equal(getDb().equipment.length, before);
});

t("adding units in this way is only for equipment.use holders, same as adding one item", () => {
  const db = getDb();
  const outsider = { personId: "DOF-P-VOL-002", role: "VOL" as const };
  throwsRule(() => E.createSerializedUnits(outsider, unitsInput()), /managed by crew/);
  void db;
});

t("units of the same make and model group together; a lone unit does not", () => {
  E.createSerializedUnits(hop(), unitsInput());
  const groups = E.groupSerializedByModel(getDb().equipment);
  const fx6 = groups.find((g) => g.name === "Sony FX6");
  assert.ok(fx6 && fx6.items.length === 3);
  const fx3 = groups.find((g) => g.name === "Sony FX3"); // two FX3 bodies already in the demo data
  assert.ok(fx3 && fx3.items.length === 2);
  const lens = groups.find((g) => g.items.some((i) => i.id === "DOF-EQ-CAM-003")); // one-off lens: its own group of one
  assert.equal(lens?.items.length, 1);
});

t("blank make or model never groups items together", () => {
  E.updateItem(hop(), "DOF-EQ-CAM-004", { make: "", model: "" }); // the tripod, made blank
  assert.equal(E.modelKeyOf(item("DOF-EQ-CAM-004")), null);
});

t("a label can be added or cleared when editing a single unit", () => {
  const i = E.updateItem(hop(), "DOF-EQ-CAM-001", { unitLabel: "  Main cam  " });
  assert.equal(i.unitLabel, "Main cam");
  assert.equal(E.updateItem(hop(), "DOF-EQ-CAM-001", { unitLabel: "" }).unitLabel, null);
});

t("a label cannot be set on a batch item", () => throwsRule(() => E.updateItem(hop(), "DOF-EQ-CAB-XLR10M-B01", { unitLabel: "x" }), /Only single units/));
