import type { Actor, ContentRecord, EquipCategoryKey } from "../types";
import { RuleError } from "../types";
import { getDb } from "../data/store";
import { categoryOf } from "../config/categories";
import { EQUIP_CATEGORIES } from "../config/equipment";
import { getRecord, visibleRecords } from "./access";
import { can, requireCan } from "./permissions";
import { displayTitle, featuredFor, isComplete, ownersOf, riskOf, tasksOf, usesPipeline } from "./content";
import { allIncidents, getItem, hasGearAccess, inventoryReport, listManifests, manifestStatusView, manifestsForContent, isOverdue, type ReportRow } from "./equipment";
import { allDriveUsage, fleetTotals, getDrive, hasStorageAccess, isNearlyFull } from "./storage";
import { docsForRecord, getDoc, canViewDoc } from "./docs";
import { nameOf } from "./people";
import { teamOf } from "./team";
import { assignmentRisks, crewWorkload, fmtDays } from "./workload";
import { fmtDate, fmtDateTime, fmtSize, fmtShort, todayIso } from "./utils";

// A report is plain content: a title and some blocks. The same content becomes a PDF, a printed page
// or copied text, so the three never disagree.

export type Block =
  | { type: "heading"; text: string }
  | { type: "para"; text: string }
  | { type: "note"; text: string } // italic guidance
  | { type: "bullets"; items: string[] }
  | { type: "pairs"; pairs: [string, string][] }
  | { type: "table"; head: string[]; rows: string[][]; weights?: number[] }
  | { type: "check"; text: string; done: boolean };

export interface ReportDoc {
  title: string;
  subtitle: string;
  filename: string; // without extension
  landscape?: boolean;
  blocks: Block[];
}

export type ReportScope = "storage" | "drive" | "equipment" | "manifest" | "callsheet" | "project" | "pipeline" | "workload" | "document" | "audit";
export type Params = Record<string, string | boolean>;

export interface ReportField { key: string; label: string; kind: "select" | "checkbox"; options?: { value: string; label: string }[]; default: string | boolean }

export interface ReportKind {
  key: string;
  scope: ReportScope;
  label: string;
  description: string;
  fields?: ReportField[];
  build: (actor: Actor, p: Params) => ReportDoc;
}

const today = () => fmtDate(todayIso());
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const stamp = () => todayIso();
const doc = (title: string, subtitle: string, name: string, blocks: Block[], landscape = false): ReportDoc => ({ title, subtitle: `${subtitle}${subtitle ? ". " : ""}Printed ${today()}.`, filename: `${slug(name)}-${stamp()}`, blocks, landscape });

// ── Turning a document's text into blocks ────────────────────

/** Documents are written in a small markup: numbered sections, italic notes, bullets, checkboxes and tables. */
export function bodyToBlocks(body: string): Block[] {
  const out: Block[] = [];
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const check = /^- \[( |x|X)\] ?(.*)$/.exec(line);
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        if (!/^\|[\s|:-]+\|?$/.test(lines[i])) rows.push(lines[i].split("|").slice(1, lines[i].endsWith("|") ? -1 : undefined).map((c) => c.trim()));
        i++;
      }
      if (rows.length) out.push({ type: "table", head: rows[0], rows: rows.slice(1) });
      continue;
    }
    if (/^#{1,3} /.test(line)) out.push({ type: "heading", text: line.replace(/^#{1,3} /, "") });
    else if (/^\d+\.\s+\S/.test(line)) out.push({ type: "heading", text: line });
    else if (/^_.+_$/.test(line.trim())) out.push({ type: "note", text: line.trim().slice(1, -1) });
    else if (check) out.push({ type: "check", text: check[2], done: check[1] !== " " });
    else if (line.startsWith("- ")) out.push({ type: "bullets", items: [line.slice(2)] });
    else if (line.trim()) out.push({ type: "para", text: line.replace(/\*\*(.+?)\*\*/g, "$1") });
    i++;
  }
  // Join neighbouring bullets into one list.
  return out.reduce<Block[]>((acc, b) => {
    const prev = acc[acc.length - 1];
    if (b.type === "bullets" && prev?.type === "bullets") prev.items.push(...b.items);
    else acc.push(b);
    return acc;
  }, []);
}

// ── The reports ──────────────────────────────────────────────

const CATS: ReportField["options"] = [{ value: "all", label: "All categories" }, ...EQUIP_CATEGORIES.map((c) => ({ value: c.key, label: c.label }))];

export const REPORT_KINDS: ReportKind[] = [
  // Storage
  {
    key: "storage.fleet", scope: "storage", label: "All drives", description: "Every drive with what is on it, how full it is and how much is free.",
    build: () => {
      const t = fleetTotals();
      return doc("Storage report: all drives", "", "storage-all-drives", [
        { type: "pairs", pairs: [["Total capacity", fmtSize(t.capacity)], ["Used", fmtSize(t.used)], ["Free", fmtSize(t.capacity - t.used)]] },
        { type: "table", head: ["Drive", "Used", "Capacity", "Full", "Free", "Projects on it"], weights: [2, 1.2, 1.2, 0.8, 1.2, 4], rows: allDriveUsage().map((u) => [u.drive.name, fmtSize(u.usedGB), fmtSize(u.drive.capacityGB), `${u.pct.toFixed(0)}%`, fmtSize(u.freeGB), u.projects.map((p) => `${p.contentId ?? p.label} ${fmtSize(p.gb)}`).join(", ") || "None"]) },
      ], true);
    },
  },
  {
    key: "storage.byProject", scope: "storage", label: "By project", description: "Every project and where its files are, with the space each one takes.",
    build: () => {
      const rows = getDb().allocations.map((a) => ({ a, r: a.contentId ? getRecord(a.contentId) : undefined })).sort((x, y) => (x.a.contentId ?? x.a.label).localeCompare(y.a.contentId ?? y.a.label));
      const total = rows.reduce((n, x) => n + x.a.sizeGB, 0);
      return doc("Storage report: by project", `${rows.length} entries, ${fmtSize(total)} in total`, "storage-by-project", [
        { type: "table", head: ["Content ID", "Project", "Drive", "What is stored", "Size"], weights: [2.4, 3, 2, 2, 1], rows: rows.map(({ a, r }) => [a.contentId ?? "No project yet", r ? displayTitle(r) : a.contentId ? "" : a.label, getDrive(a.driveId)?.name ?? a.driveId, a.kind === "raw" ? "Raw footage" : a.kind === "project" ? "Project files" : a.kind === "delivered" ? "Delivered files" : "Other", fmtSize(a.sizeGB)]) },
      ]);
    },
  },
  {
    key: "storage.nearlyFull", scope: "storage", label: "Drives nearly full", description: "Only the drives past the warning level, and what is taking the space.",
    build: () => {
      const full = allDriveUsage().filter(isNearlyFull);
      return doc("Storage report: drives nearly full", `Warning level ${getDb().settings.storageWarningThreshold}%`, "storage-nearly-full", full.length ? full.flatMap((u): Block[] => [
        { type: "heading", text: `${u.drive.name}, ${u.pct.toFixed(0)}% full` },
        { type: "pairs", pairs: [["Used", fmtSize(u.usedGB)], ["Free", fmtSize(u.freeGB)]] },
        { type: "table", head: ["Content ID", "Project", "Size"], rows: u.projects.map((p) => [p.contentId ?? "No project yet", p.contentId && getRecord(p.contentId) ? displayTitle(getRecord(p.contentId)!) : p.label, fmtSize(p.gb)]) },
      ]) : [{ type: "para", text: "No drive is past the warning level." }]);
    },
  },
  {
    key: "drive.detail", scope: "drive", label: "This drive", description: "What is on the drive, project by project.",
    build: (_a, p) => {
      const d = getDrive(String(p.driveId));
      if (!d) throw new RuleError("Drive not found.");
      const u = allDriveUsage().find((x) => x.drive.id === d.id)!;
      return doc(`Drive report: ${d.name}`, `${fmtSize(u.usedGB)} of ${fmtSize(d.capacityGB)} used`, `drive-${d.name}`, [
        { type: "pairs", pairs: [["Capacity", fmtSize(d.capacityGB)], ["Used", `${fmtSize(u.usedGB)} (${u.pct.toFixed(1)}%)`], ["Free", fmtSize(u.freeGB)], ...(d.notes ? [["Notes", d.notes] as [string, string]] : [])] },
        { type: "table", head: ["Content ID", "Project", "What is stored", "Size"], weights: [2.6, 3.4, 2, 1], rows: [...getDb().allocations.filter((a) => a.driveId === d.id).sort((a, b) => b.sizeGB - a.sizeGB).map((a) => [a.contentId ?? "No project yet", a.contentId && getRecord(a.contentId) ? displayTitle(getRecord(a.contentId)!) : a.contentId ? "" : a.label, a.kind === "raw" ? "Raw footage" : a.kind === "project" ? "Project files" : a.kind === "delivered" ? "Delivered files" : "Other", fmtSize(a.sizeGB)]), ...(d.otherUsedGB ? [["", "Other files", "Not tied to a project", fmtSize(d.otherUsedGB)]] : [])] },
      ]);
    },
  },
  // Equipment
  {
    key: "equipment.inventory", scope: "equipment", label: "Equipment list by category", description: "Every item with asset code, serial number, condition and status. Choose which extra columns to include.",
    fields: [
      { key: "category", label: "Category", kind: "select", options: CATS, default: "all" },
      { key: "includeOut", label: "Include retired and lost items", kind: "checkbox", default: false },
      { key: "colVendor", label: "Column: Vendor", kind: "checkbox", default: false },
      { key: "colPurchased", label: "Column: Purchase date", kind: "checkbox", default: false },
      { key: "colCost", label: "Column: Cost", kind: "checkbox", default: false },
      { key: "colPackaging", label: "Column: Packaging & accessories", kind: "checkbox", default: false },
    ],
    build: (_a, p) => {
      const groups = inventoryReport(String(p.category ?? "all") as EquipCategoryKey | "all", !!p.includeOut);
      const units = groups.reduce((n, g) => n + g.units, 0);
      const extra: { head: string; weight: number; cell: (r: ReportRow) => string }[] = [
        ...(p.colVendor ? [{ head: "Vendor", weight: 1.6, cell: (r: ReportRow) => r.vendor }] : []),
        ...(p.colPurchased ? [{ head: "Purchased", weight: 1.2, cell: (r: ReportRow) => r.purchased }] : []),
        ...(p.colCost ? [{ head: "Cost", weight: 1, cell: (r: ReportRow) => r.cost ? r.cost.toLocaleString() : "" }] : []),
        ...(p.colPackaging ? [{ head: "Packaging & accessories", weight: 2.6, cell: (r: ReportRow) => [r.packaging, r.accessories].filter(Boolean).join("; ") }] : []),
      ];
      const head = ["Asset code", "Item", "Serial", "Qty", "Free", "Condition", "Status", ...extra.map((c) => c.head)];
      const weights = [3, 3.4, 2, 0.7, 0.7, 1.2, 1.4, ...extra.map((c) => c.weight)];
      return doc("Dawn of Faith equipment list", `${p.category && p.category !== "all" ? EQUIP_CATEGORIES.find((c) => c.key === p.category)?.label : "All categories"}, ${units} unit${units === 1 ? "" : "s"}`, "equipment-list", groups.flatMap((g): Block[] => [
        { type: "heading", text: `${g.label} (${g.units})` },
        { type: "table", head, weights, rows: g.rows.map((r) => [r.id, `${r.name}${r.detail ? `, ${r.detail}` : ""}`, r.serial || "Batch", String(r.qty), String(r.free), r.condition, r.status, ...extra.map((c) => c.cell(r))]) },
      ]), true);
    },
  },
  {
    key: "equipment.out", scope: "equipment", label: "Gear checked out now", description: "Every checkout list that is out, who has it and when it is due back.",
    build: (actor) => {
      const out = listManifests(actor).filter((m) => m.status === "checked-out");
      return doc("Gear checked out", `${out.length} list${out.length === 1 ? "" : "s"} out`, "gear-checked-out", [
        { type: "table", head: ["List", "Project", "Person responsible", "Out from", "Due back", "Items", "Status"], weights: [1.6, 3, 2.2, 1.4, 1.4, 3, 1.2], rows: out.map((m) => [m.id, m.contentId, nameOf(m.responsiblePersonId), fmtShort(m.date), m.expectedReturn ? fmtShort(m.expectedReturn) : "", m.lines.map((l) => `${getItem(l.equipmentId)?.name ?? l.equipmentId}${l.quantity > 1 ? ` x${l.quantity}` : ""}`).join(", "), isOverdue(m) ? "Overdue" : "Out"]) },
      ], true);
    },
  },
  {
    key: "equipment.attention", scope: "equipment", label: "Items needing attention", description: "Gear in repair, retired or lost.",
    build: () => {
      const items = getDb().equipment.filter((i) => i.baseStatus !== "active").sort((a, b) => a.id.localeCompare(b.id));
      return doc("Equipment needing attention", `${items.length} item${items.length === 1 ? "" : "s"}`, "equipment-attention", [
        { type: "table", head: ["Asset code", "Item", "Status", "Condition"], weights: [3, 4, 2, 1.4], rows: items.map((i) => [i.id, i.name, i.baseStatus === "in-repair" ? "In repair" : i.baseStatus === "lost" ? "Lost" : "Retired", i.condition]) },
      ]);
    },
  },
  {
    key: "equipment.damage", scope: "equipment", label: "Damage and loss log", description: "Every reported incident, with who had the gear and on which project.",
    build: () => doc("Damage and loss log", `${allIncidents().length} incident${allIncidents().length === 1 ? "" : "s"}`, "damage-log", [
      { type: "table", head: ["Date", "Item", "What happened", "Who had it", "Project"], weights: [1.4, 3, 4, 2, 2], rows: allIncidents().map((i) => [fmtDate(i.at), `${getItem(i.equipmentId)?.name ?? i.equipmentId} (${i.equipmentId})`, `${i.type === "loss" ? "Lost" : "Damaged"}${i.quantity > 1 ? ` x${i.quantity}` : ""}: ${i.description}`, nameOf(i.personId), i.contentId]) },
    ], true),
  },
  {
    key: "manifest.list", scope: "manifest", label: "Checkout list", description: "The list as it stands, grouped by category, with make/model, accessories and notes for each item.",
    build: (_a, p) => {
      const m = getDb().manifests.find((x) => x.id === p.manifestId);
      if (!m) throw new RuleError("Checkout list not found.");
      const rec = getRecord(m.contentId);
      const catLabel = (key: string | undefined) => EQUIP_CATEGORIES.find((c) => c.key === key)?.label ?? "Other";
      const groups = new Map<string, typeof m.lines>();
      for (const l of [...m.lines].sort((a, b) => catLabel(getItem(a.equipmentId)?.category).localeCompare(catLabel(getItem(b.equipmentId)?.category)))) {
        const label = catLabel(getItem(l.equipmentId)?.category);
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label)!.push(l);
      }
      const head = ["Asset code", "Item", "Make/model", "Qty", "Condition out", "Photos", "Accessories", "Info", ...(m.status === "returned" ? ["Came back"] : [])];
      const weights = [1.6, 2.2, 1.8, 0.6, 1.4, 0.8, 1.8, 2, ...(m.status === "returned" ? [2] : [])];
      return doc(`Checkout list ${m.id}`, `${rec ? displayTitle(rec) : m.contentId}, ${manifestStatusView(m).label}`, `checkout-${m.id}`, [
        { type: "pairs", pairs: [["Content ID", m.contentId], ["Person responsible", nameOf(m.responsiblePersonId)], [m.destination === "outside" ? "Out from" : "Shoot date", fmtDate(m.date)], ...(m.expectedReturn ? [["Expected back", fmtDate(m.expectedReturn)] as [string, string]] : []), ...(m.checkedOutAt ? [["Left the studio", fmtDateTime(m.checkedOutAt)] as [string, string]] : []), ...(m.returnedAt ? [["Checked in", fmtDateTime(m.returnedAt)] as [string, string]] : [])] },
        ...[...groups.entries()].flatMap(([label, lines]): Block[] => [
          { type: "heading", text: label },
          {
            type: "table", head, weights,
            rows: lines.map((l) => {
              const item = getItem(l.equipmentId);
              const row = [
                l.equipmentId,
                item?.name ?? l.equipmentId,
                [item?.make, item?.model].filter(Boolean).join(" ") || "—",
                String(l.quantity),
                l.conditionOut,
                l.photosOut.length ? `${l.photosOut.length} attached` : "None",
                item?.accessories || "None listed",
                item?.info || "",
              ];
              if (m.status === "returned") row.push(`${l.returnedGood ? `${l.returnedGood} fine` : ""}${l.damaged ? ` ${l.damaged} damaged` : ""}${l.lost ? ` ${l.lost} lost` : ""}${l.conditionIn ? `, ${l.conditionIn}` : ""}`.trim());
              return row;
            }),
          },
        ]),
        { type: "para", text: "Released by: ______________________________   Date: ______________" },
        { type: "para", text: "Received by: ______________________________   Date: ______________" },
      ], true);
    },
  },
  // Call sheets
  {
    key: "callsheet.pdf", scope: "callsheet", label: "This call sheet", description: "Shoot details, who is on it, the gear list and the run of show, ready to print or send.",
    build: (actor, p) => {
      const cs = getDb().callSheets.find((c) => c.id === p.callSheetId);
      if (!cs) throw new RuleError("Call sheet not found.");
      const root = getRecord(cs.contentId);
      const blocks: Block[] = [
        { type: "pairs", pairs: [["Date", fmtDate(cs.date)], ["Call time", cs.callTime || "Not set"], ["Location", cs.location || "Not set"], ["Format", cs.format || "Not set"], ["Status", cs.status === "final" ? "Final" : "Draft"], ["Project", root ? displayTitle(root) : cs.contentId]] },
      ];
      if (cs.notes) blocks.push({ type: "heading", text: "Notes" }, { type: "para", text: cs.notes });
      const days = cs.linkedEpisodeIds.map((eid) => getRecord(eid)).filter((r): r is ContentRecord => !!r);
      if (days.length) blocks.push({ type: "heading", text: root?.category === "live" ? "Days on this sheet" : "Episodes on this sheet" }, { type: "bullets", items: days.map((r) => r.category === "live" ? `${root?.title ?? ""}, ${r.title}` : r.title) });
      if (cs.crewPersonIds.length) blocks.push({ type: "heading", text: "Crew" }, { type: "bullets", items: cs.crewPersonIds.map((pid) => nameOf(pid)) });
      if (cs.equipmentIds.length) blocks.push({ type: "heading", text: "Gear" }, { type: "bullets", items: cs.equipmentIds.map((id) => { const it = getItem(id); return it ? `${it.name}${it.serialNumber ? `, serial ${it.serialNumber}` : ""}` : id; }) });
      if (cs.runOfShow.length) blocks.push({ type: "heading", text: "Run of show" }, { type: "table", head: ["Time", "Item", "Duration", "Owner"], weights: [1.2, 4, 1.4, 2.4], rows: cs.runOfShow.map((r) => [r.time, r.title, `${r.durationMin} min`, r.ownerPersonId ? nameOf(r.ownerPersonId) : ""]) });
      return doc(cs.title, cs.id, `callsheet-${cs.id}`, blocks);
    },
  },
  // Project
  {
    key: "project.summary", scope: "project", label: "Project report", description: "Details, who does what, hosts and guests, links, documents, gear list IDs and storage in one report.",
    build: (actor, p) => {
      const r = getRecord(String(p.contentId));
      if (!r) throw new RuleError("Project not found.");
      const cfg = categoryOf(r.category);
      const leaf = usesPipeline(r);
      const f = featuredFor(r);
      const blocks: Block[] = [
        { type: "pairs", pairs: [["Content ID", r.contentId], ["Category", cfg.singular], ...(leaf ? [["Stage", `${r.pipelineStage}${isComplete(r) ? " (complete)" : ""}`] as [string, string]] : []), ...(r.scheduledDate ? [[cfg.key === "live" ? "Show date" : "Shoot date", fmtDate(r.scheduledDate)] as [string, string]] : []), ...(r.showStart ? [["Show runs", `${fmtDate(r.showStart)}${r.showEnd && r.showEnd !== r.showStart ? ` to ${fmtDate(r.showEnd)}` : ""}`] as [string, string]] : []), ["Publish date", fmtDate(r.deadline)]] },
      ];
      if (r.notes) blocks.push({ type: "para", text: r.notes });
      const people = [...f.inherited.map((x) => x.person), ...f.own.filter((x) => x.kind === "host")];
      if (people.length || f.own.some((x) => x.kind === "guest")) {
        blocks.push({ type: "heading", text: "Hosts and guests" }, { type: "table", head: ["", "Name", "Note"], rows: [...people.map((x) => ["Host", x.name, x.note]), ...f.own.filter((x) => x.kind === "guest").map((x) => ["Guest", x.name, x.note])] });
      }
      const stageRows = (leaf ? cfg.stages.map((s) => s.name) : ["Project"]).map((s) => [s, ownersOf(r, s).map((o) => `${nameOf(o.personId)}${o.roles.length ? ` (${o.roles.join(", ")})` : ""}`).join("; ") || "No one", leaf ? fmtDate(r.stageDeadlines[s]) : ""]);
      blocks.push({ type: "heading", text: "Who does what, and when" }, { type: "table", head: ["Stage", "People and roles", "Due"], weights: [1.6, 5, 1.6], rows: stageRows });
      const tasks = leaf ? tasksOf(r) : [];
      if (tasks.length) blocks.push({ type: "heading", text: "Checklists" }, ...tasks.map((t): Block => ({ type: "check", text: `${t.stage}: ${t.label}${t.assigneePersonId ? `, ${nameOf(t.assigneePersonId)}` : ""}${t.dueDate ? `, due ${fmtShort(t.dueDate)}` : ""}`, done: t.done })));
      const team = teamOf(r);
      if (team.length) blocks.push({ type: "heading", text: "On the project" }, { type: "bullets", items: team.map((t) => `${t.person.name}${t.roles.length ? `: ${t.roles.join(", ")}` : ""}`) });
      if (r.links.length) blocks.push({ type: "heading", text: "Links" }, { type: "table", head: ["Type", "Stage", "Link or note"], weights: [1.2, 1.6, 6], rows: r.links.map((l) => [l.kind === "final" ? "Final" : l.kind === "review" ? "Review" : l.kind === "analysis" ? "Analysis" : "Reference", l.stage, [l.url, l.note].filter(Boolean).join("  ")]) });
      const docs = docsForRecord(actor, r);
      if (docs.length) blocks.push({ type: "heading", text: "Documents" }, { type: "table", head: ["Document", "ID", "Version"], weights: [5, 2, 1], rows: docs.map((d) => [d.title, d.id, `v${d.version}`]) });
      if (hasGearAccess(actor)) {
        const lists = manifestsForContent(r.contentId);
        if (lists.length) blocks.push({ type: "heading", text: "Gear checkout lists" }, { type: "bullets", items: lists.map((m) => `${m.id}, ${manifestStatusView(m).label}, ${fmtShort(m.date)}`) }, { type: "note", text: "Print each list from the Equipment module to attach it to this report." });
      }
      if (hasStorageAccess(actor)) {
        const allocs = getDb().allocations.filter((a) => a.contentId !== null && (a.contentId === r.contentId || a.contentId.startsWith(`${r.contentId}-`)));
        if (allocs.length) blocks.push({ type: "heading", text: "Storage" }, { type: "table", head: ["Content ID", "Drive", "What is stored", "Size"], weights: [3, 2, 2, 1], rows: allocs.map((a) => [a.contentId ?? "", getDrive(a.driveId)?.name ?? a.driveId, a.kind, fmtSize(a.sizeGB)]) });
      }
      return doc(`Project report: ${displayTitle(r)}`, r.contentId, `project-${r.contentId}`, blocks);
    },
  },
  // Pipeline
  {
    key: "pipeline.status", scope: "pipeline", label: "Pipeline status", description: "Every item in production with its stage, owners, deadline and whether it is on track.",
    fields: [{ key: "which", label: "Show", kind: "select", options: [{ value: "open", label: "In production" }, { value: "done", label: "Completed" }, { value: "all", label: "Everything" }], default: "open" }],
    build: (actor, p) => {
      const rows = visibleRecords(actor).filter(usesPipeline).filter((r) => (p.which === "done" ? isComplete(r) : p.which === "all" ? true : !isComplete(r))).sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"));
      return doc("Content pipeline status", `${rows.length} item${rows.length === 1 ? "" : "s"}`, "pipeline-status", [
        { type: "table", head: ["Content ID", "Title", "Stage", "Responsible", "Publish date", "State"], weights: [2.8, 3.2, 1.8, 2.2, 1.6, 1.4], rows: rows.map((r) => [r.contentId, displayTitle(r), r.pipelineStage ?? "", nameOf(r.assigneePersonId), fmtShort(r.deadline), isComplete(r) ? "Complete" : riskOf(r) === "overdue" ? "Overdue" : riskOf(r) === "at-risk" ? "At risk" : "On track"]) },
      ], true);
    },
  },
  // Workload
  {
    key: "workload.crew", scope: "workload", label: "Crew workload", description: "Who is over capacity in the coming weeks, and the work that will not fit.",
    fields: [{ key: "weeks", label: "Look ahead", kind: "select", options: [{ value: "2", label: "Two weeks" }, { value: "4", label: "Four weeks" }], default: "2" }],
    build: (actor, p) => {
      const rows = crewWorkload(actor, todayIso(), Number(p.weeks ?? 2) * 7);
      const blocks: Block[] = [{ type: "table", head: ["Person", "Busiest day", "Days over capacity", "Days with room"], weights: [3, 1.6, 4, 1.6], rows: rows.map(({ person, workload: w }) => [person.name, `${Math.round(w.peak * 100)}%`, w.overDays.map(fmtShort).join(", ") || "None", String(w.freeDays)]) }];
      for (const { person } of rows) {
        const risks = assignmentRisks(person.personId);
        if (risks.length) blocks.push({ type: "heading", text: person.name }, { type: "bullets", items: risks.map((r) => r.reason) });
      }
      blocks.push({ type: "note", text: `Load is a share of one person's working day. A series cut needs at least ${fmtDays(2)} for someone with nothing else on.` });
      return doc("Crew workload", `Next ${p.weeks ?? 2} weeks`, "crew-workload", blocks);
    },
  },
  // Document
  {
    key: "doc.pdf", scope: "document", label: "This document", description: "The document as it stands now.",
    build: (actor, p) => {
      const d = getDoc(String(p.docId));
      if (!d || !canViewDoc(actor, d)) throw new RuleError("Document not found.");
      const rec = getRecord(d.contentId);
      return { title: d.title, subtitle: `Content ID ${d.contentId}${rec ? `, ${displayTitle(rec)}` : ""}. Document ${d.id}, version ${d.version}. Last edited ${fmtDateTime(d.updatedAt)} by ${nameOf(d.updatedBy)}.`, filename: `${slug(d.title)}-${d.id}`, blocks: bodyToBlocks(d.body) };
    },
  },
  // Back end
  {
    key: "audit.log", scope: "audit", label: "Activity log", description: "The most recent changes, who made them and when.",
    build: (actor) => {
      requireCan(actor, "backend.audit", "see the activity log");
      const rows = [...getDb().audit].reverse().slice(0, 300);
      return doc("Activity log", `Latest ${rows.length} changes`, "activity-log", [{ type: "table", head: ["When", "Who", "What"], weights: [2.4, 2.4, 6], rows: rows.map((a) => [fmtDateTime(a.at), nameOf(a.byPersonId), `${a.action} ${a.entity} ${a.entityId}${a.detail ? `, ${a.detail}` : ""}`]) }], true);
    },
  },
];

export const reportsFor = (scope: ReportScope): ReportKind[] => REPORT_KINDS.filter((k) => k.scope === scope);

/** Builds a report, refusing anyone who may not produce reports. */
export function buildReport(actor: Actor, key: string, params: Params = {}): ReportDoc {
  requireCan(actor, "reports.export", "produce reports");
  const kind = REPORT_KINDS.find((k) => k.key === key);
  if (!kind) throw new RuleError("That report does not exist.");
  const merged: Params = { ...Object.fromEntries((kind.fields ?? []).map((f) => [f.key, f.default])), ...params };
  return kind.build(actor, merged);
}

export const canExport = (actor: Actor): boolean => can(actor, "reports.export");

// ── Plain text, for copying ──────────────────────────────────

export function reportToText(r: ReportDoc): string {
  const out: string[] = [r.title, r.subtitle, ""];
  for (const b of r.blocks) {
    if (b.type === "heading") out.push("", b.text.toUpperCase());
    else if (b.type === "para") out.push(b.text);
    else if (b.type === "note") out.push(`(${b.text})`);
    else if (b.type === "bullets") out.push(...b.items.map((i) => `  - ${i}`));
    else if (b.type === "check") out.push(`  [${b.done ? "x" : " "}] ${b.text}`);
    else if (b.type === "pairs") out.push(...b.pairs.map(([k, v]) => `${k}: ${v}`));
    else out.push(b.head.join(" | "), ...b.rows.map((row) => row.join(" | ")));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
