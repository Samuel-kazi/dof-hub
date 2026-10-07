import { useEffect, useState } from "react";
import type { CallSheet, ContentRecord } from "../types";
import { useApp } from "../ui/AppContext";
import { getDb, useDb } from "../data/store";
import { canComment, canWrite, getRecord, visibleCallSheets, visibleRecords } from "../services/access";
import {
  attachCallSheet,
  bookPlannedGear,
  confirmOnSheet,
  createCallSheet,
  crewConflicts,
  deleteCallSheet,
  duplicateCallSheet,
  finalizeCallSheet,
  getCallSheet,
  getMismatches,
  reopenCallSheet,
  resolveMismatches,
  updateCallSheet,
  runOfShowRequired,
  type SheetPatch,
} from "../services/wrapped/callsheets";
import { addComment, featuredFor, getComments } from "../services/wrapped/content";
import { roleOn } from "../services/wrapped/team";
import { nameOf } from "../services/wrapped/people";
import { addDaysIso, dateInNairobi, fmtDate, fmtDateTime, relativeDays, todayIso } from "../services/utils";
import { sheetWarnings, gearSuggestions } from "../services/sheetAdvice";
import { pipelineCategories } from "../services/wrapped/settings";
import { changesOf, confirmationHolds } from "../services/sheetTracking";
import { canKeepLocations, createLocation, listLocations } from "../services/wrapped/locations";
import { PersonName } from "../ui/PersonName";
import { isSheetLocked, sheetLock } from "../services/sheetLock";
import { useReviewCheck } from "../ui/ReviewCheck";
import { featureOn } from "../services/wrapped/settings";
import { kitSuggestions } from "../services/wrapped/kits";
import { sheetOwnerId } from "../services/wrapped/documents";
import { DateShift } from "../ui/DateShift";
import { LocationsPanel } from "./production/LocationsPanel";
import { Modal } from "../ui/Modal";
import { Empty, Field } from "../ui/parts";
import { IconPlus } from "../ui/Icons";
import { GearPicker } from "../ui/GearPicker";
import { SavedInput } from "./documents/toolkit";
import { InstanceStrip } from "./production/InstanceStrip";
import {
  ContactsSection,
  CrewSection,
  LocationSection,
  LogisticsSection,
  PlannedGear,
  RehearsalSection,
  RunOfShowSection,
  SavedText,
  ScheduleSection,
  Section,
  SectionNav,
  TalentSection,
  TechnicalCheckSection,
  crewCandidates,
  crewContactRows,
  type ConfirmProps,
  type ContactRow,
} from "./production/SheetSections";
import { RunSheetPanel } from "./workflow/SessionPage";
import { takePrintRequest, usePrintCallSheet } from "./documents/printCallSheet";
import { sheetTimes } from "../services/wrapped/workflow";
import { ReportButton, ReportDialog } from "../ui/ReportDialog";
import {
  addGearToSheet,
  getItem,
  gearIssues,
  hasGearAccess,
  manifestForSheet,
  manifestStatusView,
  projectLabel,
  removeGearFromSheet,
} from "../services/wrapped/equipment";

export function CallSheets() {
  const { actor, go, menu, confirm, attempt } = useApp();
  useDb();
  const [creating, setCreating] = useState(false);
  const [duplicating, setDuplicating] = useState<CallSheet | null>(null);
  const [downloading, setDownloading] = useState<CallSheet | null>(null);
  const [attaching, setAttaching] = useState<CallSheet | null>(null);
  // Filters: the kind of production, upcoming or past, and the project.
  const [type, setType] = useState<string>("");
  const [when, setWhen] = useState<"all" | "upcoming" | "past">("all");
  const [project, setProject] = useState<string>("");
  const all = visibleCallSheets(actor).sort((a, b) => a.date.localeCompare(b.date));
  const today = todayIso();
  const categoryOfSheet = (cs: CallSheet) => getRecord(cs.contentId)?.category ?? "";
  const sheets = all.filter(
    (cs) =>
      (!type || categoryOfSheet(cs) === type) &&
      (when === "all" || (when === "upcoming" ? cs.date >= today : cs.date < today)) &&
      (!project || cs.contentId === project),
  );
  const sheetProjects = [...new Set(all.map((cs) => cs.contentId))]
    .map((id) => getRecord(id))
    .filter((r): r is ContentRecord => !!r)
    .sort((a, b) => a.title.localeCompare(b.title));
  const writableProjects = visibleRecords(actor).filter((r) => r.hierarchyLevel === 0 && canWrite(actor, r));

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Call sheets</h1>
          <p className="sub">Each sheet is linked to its project's episodes on the shoot date.</p>
        </div>
        {writableProjects.length > 0 && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            <IconPlus /> New call sheet
          </button>
        )}
      </div>
      {all.length > 0 && (
        <div className="row cs-filters" role="group" aria-label="Filter call sheets">
          <Field label="Type">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Every type</option>
              {pipelineCategories().map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="When">
            <select value={when} onChange={(e) => setWhen(e.target.value as typeof when)}>
              <option value="all">Upcoming and past</option>
              <option value="upcoming">Upcoming</option>
              <option value="past">Past</option>
            </select>
          </Field>
          <Field label="Project">
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">Every project</option>
              {sheetProjects.map((p) => (
                <option key={p.contentId} value={p.contentId}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      <section className="glass panel">
        {sheets.length === 0 ? (
          <Empty>
            {all.length
              ? "No call sheets match these filters."
              : "No call sheets yet. Use the call sheet button on a pipeline record, or create one here."}
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Call sheet</th>
                <th>Project</th>
                <th>Date</th>
                <th>Linked</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sheets.map((cs) => {
                const mm = getMismatches(cs);
                const drift = mm.moved.length + mm.unlinked.length > 0;
                const clash = crewConflicts(cs).length > 0;
                const toCheck = sheetWarnings(cs, today).length;
                const write = canWrite(actor, getRecord(cs.contentId)!);
                return (
                  <tr
                    key={cs.id}
                    className="clickable"
                    onClick={() => go({ n: "callsheet", id: cs.id })}
                    onContextMenu={(e) =>
                      menu(e, [
                        { label: "Open", onClick: () => go({ n: "callsheet", id: cs.id }) },
                        { label: "Download…", onClick: () => setDownloading(cs) },
                        { label: "Attach to a different project…", disabled: !write, onClick: () => setAttaching(cs) },
                        { label: "Duplicate for another date…", disabled: !write, onClick: () => setDuplicating(cs) },
                        { divider: true, label: "", onClick: () => {} },
                        {
                          label: "Delete",
                          danger: true,
                          disabled: !write,
                          onClick: async () => {
                            if (
                              await confirm({
                                title: `Delete ${cs.title}?`,
                                body: "This removes the call sheet. The episodes are not affected.",
                                confirmLabel: "Delete",
                                danger: true,
                              })
                            )
                              attempt(() => deleteCallSheet(actor, cs.id), "Deleted");
                          },
                        },
                      ])
                    }
                  >
                    <td>
                      <div>{cs.title}</div>
                      <span className="cid">{cs.id}</span>
                    </td>
                    <td>{getRecord(cs.contentId)?.title}</td>
                    <td>
                      {fmtDate(cs.date)}
                      <div className="muted" style={{ fontSize: ".82rem" }}>
                        {relativeDays(cs.date)}
                      </div>
                    </td>
                    <td>{cs.linkedEpisodeIds.length}</td>
                    <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <span className={`badge ${cs.status === "final" ? "ok" : ""}`}>{cs.status === "final" ? "Final" : "Draft"}</span>
                      {drift && <span className="badge warn">Dates changed</span>}
                      {clash && <span className="badge bad">Crew clash</span>}
                      {toCheck > 0 && <span className="badge warn">{toCheck} to check</span>}
                      {isSheetLocked(cs) && <span className="badge">Locked</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {sheets.length > 0 && (
          <p className="muted" style={{ marginTop: 10, fontSize: ".84rem" }}>
            Right-click a call sheet to duplicate or delete it.
          </p>
        )}
      </section>
      <LocationsPanel />
      {creating && (
        <NewSheetModal
          projects={writableProjects.map((p) => ({ id: p.contentId, title: p.title }))}
          onClose={() => setCreating(false)}
          onCreated={(cs) => {
            setCreating(false);
            go({ n: "callsheet", id: cs.id });
          }}
        />
      )}
      {duplicating && (
        <DuplicateModal
          sheet={duplicating}
          onClose={() => setDuplicating(null)}
          onCreated={(cs) => {
            setDuplicating(null);
            go({ n: "callsheet", id: cs.id });
          }}
        />
      )}
      {downloading && <ReportDialog scope="callsheet" params={{ callSheetId: downloading.id }} onClose={() => setDownloading(null)} />}
      {attaching && <AttachSheetModal sheet={attaching} onClose={() => setAttaching(null)} />}
    </div>
  );
}

function NewSheetModal({
  projects,
  onClose,
  onCreated,
}: {
  projects: { id: string; title: string }[];
  onClose: () => void;
  onCreated: (c: CallSheet) => void;
}) {
  const { actor, attempt } = useApp();
  const [project, setProject] = useState(projects[0]?.id ?? "");
  const [date, setDate] = useState("");
  const save = () => {
    const cs = attempt(() => createCallSheet(actor, { contentId: project, date }), "Call sheet created");
    if (cs) onCreated(cs);
  };
  return (
    <Modal
      title="New call sheet"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Create
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Project">
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Shoot date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} autoFocus />
        </Field>
        <p className="muted">
          Episodes and days in this project with a shoot date on that day are attached automatically. Other projects are never pulled in.
        </p>
      </div>
    </Modal>
  );
}

function DuplicateModal({ sheet, onClose, onCreated }: { sheet: CallSheet; onClose: () => void; onCreated: (c: CallSheet) => void }) {
  const { actor, attempt, toast } = useApp();
  const [date, setDate] = useState(() => addDaysIso(sheet.date, 7));
  const save = () => {
    const res = attempt(() => duplicateCallSheet(actor, sheet.id, date), "Call sheet duplicated");
    if (!res) return;
    if (res.gear.skipped.length)
      toast(`Copied ${res.gear.copied} gear item${res.gear.copied === 1 ? "" : "s"}. Skipped: ${res.gear.skipped.join(" ")}`, "info");
    onCreated(res.sheet);
  };
  return (
    <Modal
      title="Duplicate call sheet"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!date} onClick={save}>
            Duplicate
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="New shoot date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} autoFocus />
        </Field>
        <DateShift from={sheet.date} value={date} onChange={setDate} />
        <p className="muted">
          From {fmtDate(sheet.date)}. Every section carries over (crew, talent, location, schedule, run of show, logistics and the rest),
          with ticks and confirmations cleared. Episodes are matched again for the new date, and gear already booked or lent out that day is
          skipped.
        </p>
      </div>
    </Modal>
  );
}

/** Moves a call sheet, and any gear checked out under it, to a different project. */
function AttachSheetModal({ sheet, onClose }: { sheet: CallSheet; onClose: () => void }) {
  const { actor, attempt } = useApp();
  const options = visibleRecords(actor).filter((r) => r.hierarchyLevel === 0 && r.contentId !== sheet.contentId && canWrite(actor, r));
  const [id, setId] = useState(options[0]?.contentId ?? "");
  return (
    <Modal
      title="Attach to a different project"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!id}
            onClick={() => {
              if (attempt(() => attachCallSheet(actor, sheet.id, id, sheet.version), "Attached")) onClose();
            }}
          >
            Attach
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="muted">Currently under {projectLabel(actor, sheet.contentId)}. Any gear checked out on this sheet moves with it.</p>
        {options.length === 0 ? (
          <Empty>There is no other project you can write to.</Empty>
        ) : (
          <Field label="Project">
            <select value={id} onChange={(e) => setId(e.target.value)}>
              {options.map((r) => (
                <option key={r.contentId} value={r.contentId}>
                  {r.title}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

export function CallSheetPage({ id }: { id: string }) {
  const { actor, go, back, attempt, confirm, menu } = useApp();
  useDb();
  const [duplicating, setDuplicating] = useState(false);
  const [print, printNode] = usePrintCallSheet();
  const [reviewCheck, reviewModal] = useReviewCheck();
  const cs = getCallSheet(id);
  // "Print today's run sheet" from Ctrl+K: printed once, when the page opens.
  useEffect(() => {
    const job = takePrintRequest(id);
    if (job) print(job);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const root = cs ? getRecord(cs.contentId) : undefined;

  if (!cs || !root)
    return (
      <div className="page">
        <Empty>This call sheet does not exist or is not part of a project you are attached to.</Empty>
      </div>
    );

  const write = canWrite(actor, root);
  const lock = sheetLock(cs);
  const open = write && !lock.locked;

  return (
    <div className="page">
      <nav className="crumbs">
        <button onClick={() => go({ n: "callsheets" })}>Call sheets</button>
        <span aria-hidden> / </span>
        <span>{cs.title}</span>
      </nav>
      <div className="page-head">
        <div className="grow">
          <h1>{cs.title}</h1>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
            <span className="cid">{cs.id}</span>
            <span className={`badge ${cs.status === "final" ? "ok" : ""}`}>{cs.status === "final" ? "Final" : "Draft"}</span>
            {lock.locked && <span className="badge">Locked</span>}
            {cs.sharedAt && <span className="badge">Shared {fmtDate(dateInNairobi(new Date(cs.sharedAt)))}</span>}
            {cs.changeLog.length > 0 && (
              <a className="badge warn" href="#sec-changes">
                {cs.changeLog.length} change{cs.changeLog.length === 1 ? "" : "s"} logged
              </a>
            )}
            <button className="badge accent" style={{ cursor: "pointer" }} onClick={() => go({ n: "record", id: root.contentId })}>
              {root.title}
            </button>
          </div>
        </div>
        {write && (
          <button className="btn" onClick={() => setDuplicating(true)}>
            Duplicate
          </button>
        )}
        <button
          className="btn"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            menu({ clientX: r.left, clientY: r.bottom + 6, preventDefault: () => {} }, [
              { label: "Print call sheet", onClick: () => print({ sheetId: cs.id, only: "all" }) },
              { label: "Print run sheet only", onClick: () => print({ sheetId: cs.id, only: "run" }) },
            ]);
          }}
        >
          Print…
        </button>
        <ReportButton scope="callsheet" params={{ callSheetId: cs.id }} label="Download…" />
        {open &&
          (cs.status === "draft" ? (
            <button
              className="btn primary"
              onClick={async () => {
                // Publishing is deliberate: a click (or Ctrl+Enter) and a confirmation, never a stray Enter. Before the
                // theological review is done, the question about it is that confirmation.
                const ok = await reviewCheck({
                  contentId: sheetOwnerId(cs),
                  action: "publish-sheet",
                  targetId: cs.id,
                  confirmLabel: "Publish anyway",
                  deliberate: true,
                });
                if (!ok) return;
                if (
                  !ok.asked &&
                  !(await confirm({
                    title: `Publish ${cs.title}?`,
                    body: "The crew can rely on it from now on. It stays open to edit; every later change to its call time, place, crew, talent or schedule is logged, and clears the confirmations it affects.",
                    confirmLabel: "Publish",
                    deliberate: true,
                  }))
                )
                  return;
                if (attempt(() => finalizeCallSheet(actor, cs.id, cs.version), "Call sheet published")) ok.done();
              }}
            >
              Finalize
            </button>
          ) : (
            <button className="btn" onClick={() => attempt(() => reopenCallSheet(actor, cs.id), "Back to draft")}>
              Back to draft
            </button>
          ))}
        {open && (
          <button
            className="btn danger"
            onClick={async () => {
              if (
                await confirm({
                  title: `Delete ${cs.title}?`,
                  body: "This removes the call sheet. The episodes are not affected.",
                  confirmLabel: "Delete",
                  danger: true,
                })
              ) {
                if (attempt(() => deleteCallSheet(actor, cs.id), "Deleted")) back();
              }
            }}
          >
            Delete
          </button>
        )}
      </div>

      <CallSheetBody cs={cs} root={root} />
      {printNode}
      {reviewModal}
      {duplicating && (
        <DuplicateModal
          sheet={cs}
          onClose={() => setDuplicating(false)}
          onCreated={(n) => {
            setDuplicating(false);
            go({ n: "callsheet", id: n.id });
          }}
        />
      )}
    </div>
  );
}

/**
 * A call sheet's sections, the same for every call sheet: Schedule, Crew, Talent, Location, Equipment, Logistics,
 * Contacts, Run of Show, Technical Check and Rehearsal, after its warnings and its title, format and notes. Its page
 * shows them under its header; a devotion's Recording Plan shows them on a session's tab (`embedded`), where the
 * session and its devotions are listed by the plan itself, and adds its own parts (`children`) before the comments.
 * A recording session's run sheet is its Run of Show. Fields save when the person leaves them.
 */
export function CallSheetBody({
  cs,
  root,
  embedded = false,
  children,
  moreContacts,
}: {
  cs: CallSheet;
  root: ContentRecord;
  embedded?: boolean;
  children?: React.ReactNode;
  moreContacts?: ContactRow[];
}) {
  const { actor, go, attempt, toast } = useApp();
  const [comment, setComment] = useState("");
  const write = canWrite(actor, root);
  // Open to edit, published or not, until its production moves on to Post production (src/services/sheetLock.ts).
  const lock = sheetLock(cs);
  const editable = write && !lock.locked;
  const mm = getMismatches(cs);
  const drift = mm.moved.length + mm.unlinked.length > 0;
  const clashes = crewConflicts(cs);
  const db = getDb();
  const comments = getComments(cs.contentId, cs.id);
  // A sheet made for a recording session lists the episodes planned for it (the five-stage workflow).
  const session = db.recordingSessions.find((s) => s.callSheetId === cs.id);
  const sessionRows = session ? db.sessionLogEntries.filter((e) => e.sessionId === session.id) : [];
  const day = cs.instanceId ? getDb().recordingSessions.find((s) => s.id === cs.instanceId) : undefined;
  const save = (patch: SheetPatch) => attempt(() => updateCallSheet(actor, cs.id, patch, cs.version));
  const roleHint = (pid: string) => roleOn(pid, root) || null;
  const props = { value: cs, editable, onChange: save };
  // Ticking the technical check and the rehearsal happens on the day, on a final sheet too.
  const tickProps = { value: cs, editable, onChange: save };
  const warnings = sheetWarnings(cs, todayIso());
  const warnOf = (section: string) => warnings.filter((w) => w.section === section).map((w) => w.text);
  // Confirmations: crew tick their own; anyone working on the project records it for them, and for talent.
  const confirm: ConfirmProps = {
    of: (key) => {
      const c = cs.confirmations[key];
      if (!c || !confirmationHolds(cs, key)) return { confirmed: false, note: "" };
      const by = c.by === key ? "" : `, recorded by ${nameOf(c.by)}`;
      return { confirmed: true, note: `Confirmed ${fmtDateTime(c.at)}${by}` };
    },
    canTick: (key) => !lock.locked && (key === actor.personId || write),
    onTick: (key, yes) => attempt(() => confirmOnSheet(actor, cs.id, key, yes), yes ? "Confirmed" : "Confirmation taken off"),
  };
  const mine = cs.crewPersonIds.includes(actor.personId) && cs.date >= todayIso() && !lock.locked;
  const locations = listLocations();
  const keepPlaces = canKeepLocations(actor);
  const saveLocation = () => {
    const loc = attempt(() =>
      createLocation(actor, { name: cs.location.trim(), address: cs.locationAddress.trim(), notes: cs.locationNotes.trim() }),
    );
    if (loc && attempt(() => updateCallSheet(actor, cs.id, { locationId: loc.id }, cs.version))) toast(`${loc.name} saved`, "success");
  };

  return (
    <>
      {drift && (
        <div className="banner warn" role="alert">
          <div className="grow">
            <b>Episode dates no longer match this call sheet.</b>
            {mm.moved.length > 0 && (
              <div>
                Moved away from {fmtDate(cs.date)}: {mm.moved.map((r) => r.title).join(", ")}
              </div>
            )}
            {mm.unlinked.length > 0 && <div>Now scheduled for this date but not linked: {mm.unlinked.map((r) => r.title).join(", ")}</div>}
          </div>
          {write && (
            <button className="btn" onClick={() => attempt(() => resolveMismatches(actor, cs.id, cs.version), "Linked episodes updated")}>
              Re-link to {fmtDate(cs.date)}
            </button>
          )}
        </div>
      )}
      {clashes.length > 0 && (
        <div className="banner bad" role="alert">
          <div className="grow">
            <b>Crew double-booked.</b>{" "}
            {[...new Set(clashes.map((c) => `${nameOf(c.personId)} is also on ${c.otherSheet.title}`))].join("; ")}
          </div>
        </div>
      )}
      {day?.instance && <InstanceStrip day={day} write={write} />}
      {mine && (
        <div className={`banner ${confirm.of(actor.personId).confirmed ? "ok" : "accent"} no-print`} role="status">
          <div className="grow">
            {confirm.of(actor.personId).confirmed ? <b>You confirmed you will be there.</b> : <b>Will you be there?</b>} {fmtDate(cs.date)},
            crew call {cs.callTime || "not set yet"}
            {cs.location ? `, ${cs.location}` : ""}
            {cs.crewRoles[actor.personId] ? `, as ${cs.crewRoles[actor.personId]}` : ""}.
          </div>
          {confirm.of(actor.personId).confirmed ? (
            <button className="btn small ghost" onClick={() => confirm.onTick(actor.personId, false)}>
              I can no longer come
            </button>
          ) : (
            <button className="btn small primary" onClick={() => confirm.onTick(actor.personId, true)}>
              Confirm I will be there
            </button>
          )}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="banner warn no-print" role="status" aria-label="Call sheet warnings">
          <div className="grow">
            <b>
              {warnings.length} thing{warnings.length === 1 ? "" : "s"} to check before the day.
            </b>
            <ul className="cs-warn-list">
              {warnings.map((w) => (
                <li key={w.text}>
                  <a
                    href={`#sec-${w.section}`}
                    onClick={(e) => {
                      e.preventDefault();
                      document.getElementById(`sec-${w.section}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  >
                    {w.text}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {session && !embedded && (
        <section className="glass panel" aria-label="Recording session">
          <div className="wf-head">
            <h2>Recording session {session.id}</h2>
            <button className="btn small" onClick={() => go({ n: "session", id: session.id })}>
              Open the session
            </button>
          </div>
          {session.scheduledDate !== cs.date && (
            <div className="banner warn">
              The session is on {session.scheduledDate ? fmtDate(session.scheduledDate) : "no date yet"}, but this sheet is for{" "}
              {fmtDate(cs.date)}.
            </div>
          )}
          {sessionRows.length === 0 ? (
            <p className="muted">No episodes are planned for the session yet.</p>
          ) : (
            <ul>
              {sessionRows.map((r) => {
                const planned = db.plannedEpisodes.find((p) => p.id === r.plannedEpisodeId);
                return (
                  <li key={r.id}>
                    <span className="cid">{planned?.id ?? "Item"}</span> {planned?.workingTitle ?? r.itemLabel}
                    {r.guest ? `, with ${r.guest}` : ""}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="glass panel" aria-label="Call sheet">
        <div className="cs-grid wide">
          <Field label="Title">
            <SavedInput
              aria-label="Title"
              value={cs.title}
              disabled={!editable}
              maxLength={300}
              onSave={(v) => v.trim() && save({ title: v.trim() })}
            />
          </Field>
          <Field label="Format">
            <SavedInput
              aria-label="Format"
              value={cs.format}
              placeholder="Live stream, recorded, podcast"
              disabled={!editable}
              onSave={(v) => save({ format: v.trim() })}
            />
          </Field>
        </div>
        <Field label="Notes">
          <SavedText label="Notes" value={cs.notes} disabled={!editable} onSave={(v) => save({ notes: v.trim() })} />
        </Field>
        {lock.locked ? (
          <p className="muted">Locked: {lock.why} It is kept as the record of the day.</p>
        ) : (
          cs.status === "final" &&
          write && (
            <p className="muted">
              Published. It stays open to edit: changes to its call time, place, crew, talent or schedule are logged, and clear the
              confirmations they affect.
            </p>
          )
        )}
      </section>

      <SectionNav />
      <ScheduleSection
        {...props}
        date={{ value: cs.date, onChange: (date) => save({ date }) }}
        derived={sheetTimes(session ? session.runSheet : cs.runOfShow)}
        warn={warnOf("schedule")}
      />
      <CrewSection
        {...props}
        candidates={crewCandidates(cs.contentId, cs.crewPersonIds)}
        roleHint={roleHint}
        clashes={new Map(clashes.map((c) => [c.personId, `Also on ${c.otherSheet.title}`]))}
        confirm={confirm}
        warn={warnOf("crew")}
      />
      <TalentSection {...props} confirm={confirm} />
      <LocationSection {...props} saved={{ list: locations, onSave: keepPlaces ? saveLocation : undefined }} warn={warnOf("location")} />
      <Section id="equipment" title="Equipment">
        <GearPanel cs={cs} editable={editable} bare />
        {(cs.plannedGear.length > 0 || editable) && (
          <PlannedGear
            {...props}
            pickDate={cs.date}
            onBook={() => {
              const r = attempt(() => bookPlannedGear(actor, cs.id));
              if (r)
                toast(
                  r.skipped.length ? `${r.booked} booked. Not free that day: ${r.skipped.join(" ")}` : `${r.booked} booked`,
                  r.skipped.length ? "info" : "success",
                );
            }}
          />
        )}
      </Section>
      <LogisticsSection {...props} />
      <ContactsSection {...props} crewRows={crewContactRows(cs, actor, roleHint)} more={moreContacts} />
      {/* A recording session's run sheet is its own; a live day's running order is its call sheet's run of show. */}
      {session && root.category !== "live" ? (
        <div id="sec-runOfShow" className="cs-section">
          <RunSheetPanel sessionId={session.id} editable={write && session.status !== "Closed" && !session.archivedAt} />
        </div>
      ) : (
        <RunOfShowSection {...props} required={runOfShowRequired(cs)} live={root?.category === "live"} />
      )}
      <TechnicalCheckSection {...tickProps} editable={editable} onChange={save} canTick tickable={editable} />
      <RehearsalSection {...tickProps} editable={editable} onChange={save} canTick tickable={editable} />
      {(cs.sharedAt || cs.changeLog.length > 0) && <ChangeLog cs={cs} />}

      {!embedded && (
        <section className="glass panel" aria-label="Linked to this sheet">
          <h2>{root.category === "live" ? "Days on this sheet" : "Episodes on this sheet"}</h2>
          {cs.linkedEpisodeIds.length === 0 ? (
            <Empty>No episodes were scheduled for this date when the sheet was created.</Empty>
          ) : (
            <div className="list">
              {cs.linkedEpisodeIds.map((eid) => {
                const r = getRecord(eid);
                return r ? (
                  <div key={eid} className="list-item" onClick={() => go({ n: "record", id: eid })}>
                    <div className="grow">
                      <div className="title">{r.category === "live" ? `${root.title}, ${r.title}` : r.title}</div>
                      <span className="cid">{eid}</span>
                      {(() => {
                        const f = featuredFor(r);
                        const hosts = [...f.inherited.map((x) => x.person), ...f.own.filter((x) => x.kind === "host")];
                        const guests = f.own.filter((x) => x.kind === "guest");
                        return hosts.length + guests.length > 0 ? (
                          <div className="muted" style={{ fontSize: ".84rem" }}>
                            {hosts.length > 0 && `Host: ${hosts.map((h) => h.name).join(", ")}. `}
                            {guests.length > 0 && `Guest: ${guests.map((g) => g.name).join(", ")}.`}
                          </div>
                        ) : null;
                      })()}
                    </div>
                    {r.scheduledDate !== cs.date && <span className="badge warn">Now {fmtDate(r.scheduledDate)}</span>}
                  </div>
                ) : null;
              })}
            </div>
          )}
          <p className="muted" style={{ marginTop: 10, fontSize: ".84rem" }}>
            Linked when the sheet was created. Changing an episode's date later flags a mismatch instead of changing this list.
          </p>
        </section>
      )}

      {children}

      <section className="glass panel">
        <h2>Comments</h2>
        {comments.length === 0 ? (
          <Empty>No comments yet.</Empty>
        ) : (
          comments.map((c) => (
            <div key={c.id} className="comment">
              <b>
                <PersonName id={c.byPersonId} />
              </b>{" "}
              <small>{new Date(c.at).toLocaleString()}</small>
              <p>{c.text}</p>
            </div>
          ))
        )}
        {canComment(actor, root) ? (
          <div className="row" style={{ marginTop: 12, alignItems: "end" }}>
            <Field label="Add a comment">
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} />
            </Field>
            <div style={{ flex: "none", minWidth: 0 }}>
              <button
                className="btn primary"
                onClick={() => {
                  if (attempt(() => addComment(actor, cs.contentId, comment, cs.id), "Comment added")) setComment("");
                }}
              >
                Post comment
              </button>
            </div>
          </div>
        ) : (
          <p className="muted" style={{ marginTop: 10 }}>
            You can read comments on this project but not add them.
          </p>
        )}
      </section>
    </>
  );
}

/**
 * What changed on a sheet once it was shared or someone confirmed: call time, location, crew, talent and schedule,
 * with who changed it and when, newest first. Confirmations a change cleared are listed too.
 */
function ChangeLog({ cs }: { cs: CallSheet }) {
  const [all, setAll] = useState(false);
  const changes = changesOf(cs);
  const shown = all ? changes : changes.slice(0, 8);
  return (
    <section className="glass panel cs-section" id="sec-changes" aria-label="Changes">
      <div className="wf-head">
        <h2>Changes since it was shared or confirmed</h2>
        {changes.length > 0 && <span className="badge warn">{changes.length}</span>}
      </div>
      {changes.length === 0 ? (
        <Empty>
          {cs.sharedAt
            ? `Shared on ${fmtDateTime(cs.sharedAt)}. Nothing has changed since.`
            : "Nothing has changed since anyone confirmed."}
        </Empty>
      ) : (
        <ul className="cs-changes">
          {shown.map((c) => (
            <li key={c.id}>
              <div className="cs-change-what">
                <b>{c.what}</b>
                {c.what === "Confirmation cleared" ? (
                  <>
                    : {c.from}, {c.to}
                  </>
                ) : c.from && c.to ? (
                  <>
                    : <s>{c.from}</s> to {c.to}
                  </>
                ) : (
                  <>: {c.from || c.to}</>
                )}
              </div>
              <small className="muted">
                <PersonName id={c.by} />, {fmtDateTime(c.at)}
              </small>
            </li>
          ))}
        </ul>
      )}
      {changes.length > 8 && (
        <button className="btn small ghost" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? "Show the newest only" : `Show all ${changes.length} changes`}
        </button>
      )}
    </section>
  );
}

/**
 * The role kits that match the crew's roles (Equipment, Role kits), item by item: one click adds an item that is free
 * that day; one that is not says why. Only suggestions: nothing is booked until it is added.
 */
function KitSuggestions({ cs }: { cs: CallSheet }) {
  const { actor, attempt } = useApp();
  if (!featureOn("lending")) return null;
  const kits = kitSuggestions(cs);
  if (!kits.length) return null;
  return (
    <div className="cs-suggest" aria-label="Role kits">
      <h3>Role kits for this crew</h3>
      <ul>
        {kits.map((k) => (
          <li key={k.kit.id}>
            <div>
              <b>{k.kit.role}</b>
              {k.kit.cameraModel && <span className="muted"> with {k.kit.cameraModel}</span>}{" "}
              <span className="muted">for {k.roles.join(", ")}</span>
            </div>
            <div className="row cs-suggest-options">
              {k.items.map((o) =>
                o.free ? (
                  <button
                    key={o.item.id}
                    className="btn small"
                    title={o.item.id}
                    onClick={() =>
                      attempt(
                        () =>
                          addGearToSheet(actor, { id: cs.id, contentId: cs.contentId, date: cs.date }, [
                            { equipmentId: o.item.id, quantity: o.quantity },
                          ]),
                        `${o.item.name} added`,
                      )
                    }
                  >
                    + {o.item.name}
                    {o.quantity > 1 ? ` ×${o.quantity}` : ""}
                  </button>
                ) : (
                  <span key={o.item.id} className="badge warn" title={o.reason}>
                    {o.item.name}: not free ({o.reason})
                  </span>
                ),
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Gear the crew's roles usually need and the sheet does not have yet, free on its date: one click adds it. */
function GearSuggestions({ cs }: { cs: CallSheet }) {
  const { actor, attempt } = useApp();
  const list = gearSuggestions(cs);
  if (!list.length) return null;
  return (
    <div className="cs-suggest" aria-label="Suggested gear">
      <h3>Suggested for the crew's roles</h3>
      <ul>
        {list.map((s) => (
          <li key={s.category}>
            <div>
              <b>{s.label}</b>{" "}
              <span className="muted">
                for {s.roles.join(", ")}: {s.have} of {s.needed} on the sheet
              </span>
            </div>
            {s.options.length === 0 ? (
              <span className="muted">Nothing free on {fmtDate(cs.date)}.</span>
            ) : (
              <div className="row cs-suggest-options">
                {s.options.map((o) => (
                  <button
                    key={o.item.id}
                    className="btn small"
                    title={o.item.id}
                    onClick={() =>
                      attempt(
                        () =>
                          addGearToSheet(actor, { id: cs.id, contentId: cs.contentId, date: cs.date }, [
                            { equipmentId: o.item.id, quantity: 1 },
                          ]),
                        `${o.item.name} added`,
                      )
                    }
                  >
                    + {o.item.name}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="muted">Only suggestions: nothing is booked until you add it. Gear booked elsewhere or lent out that day is left out.</p>
    </div>
  );
}

/** The gear booked for the sheet's date. `bare`: inside the Equipment section, without a panel of its own. */
function GearPanel({ cs, editable, bare = false }: { cs: CallSheet; editable: boolean; bare?: boolean }) {
  const { actor, go, attempt } = useApp();
  const [picking, setPicking] = useState(false);
  const access = hasGearAccess(actor);
  const m = manifestForSheet(cs.id);
  const issues = gearIssues(cs.id);
  const view = m ? manifestStatusView(m) : null;
  const canEditGear = editable && access && (!m || m.status === "assigned");
  const Wrap = bare ? "div" : "section";

  return (
    <Wrap className={bare ? "cs-gear" : "glass panel"}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        {bare ? <h3 style={{ flex: 1 }}>Booked for {fmtDate(cs.date)}</h3> : <h2 style={{ flex: 1 }}>Gear</h2>}
        {view && <span className={`badge ${view.tone}`}>{view.label}</span>}
        {access && m && (
          <button className="btn small" onClick={() => go({ n: "manifest", id: m.id })}>
            Open checkout list
          </button>
        )}
        {canEditGear && (
          <button className="btn small primary" onClick={() => setPicking(true)}>
            <IconPlus /> Add gear
          </button>
        )}
      </div>
      {issues.length > 0 && (
        <div className="banner warn" role="alert" style={{ marginBottom: 12 }}>
          <div className="grow">
            <b>Gear needs attention.</b>
            {issues.map((t) => (
              <div key={t}>{t}</div>
            ))}
          </div>
        </div>
      )}
      {!m || m.lines.length === 0 ? (
        <Empty>{access ? "No gear assigned yet. Add gear to reserve it for this shoot." : "No gear listed."}</Empty>
      ) : (
        <div className="list">
          {m.lines.map((l) => {
            const item = getItem(l.equipmentId);
            return (
              <div
                key={l.equipmentId}
                className="list-item"
                style={{ cursor: access ? "pointer" : "default" }}
                onClick={() => access && go({ n: "item", id: l.equipmentId })}
              >
                <div className="grow">
                  <div className="title">
                    {item?.name ?? l.equipmentId}
                    {l.quantity > 1 ? ` x ${l.quantity}` : ""}
                  </div>
                  <span className="cid">{l.equipmentId}</span>
                </div>
                {canEditGear && (
                  <button
                    className="btn small ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      attempt(() => removeGearFromSheet(actor, cs.id, l.equipmentId), "Removed");
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {canEditGear && cs.date >= todayIso() && <KitSuggestions cs={cs} />}
      {canEditGear && cs.date >= todayIso() && <GearSuggestions cs={cs} />}
      {m && m.status === "assigned" && (
        <p className="muted" style={{ marginTop: 10, fontSize: ".84rem" }}>
          Reserved in the studio for {fmtDate(cs.date)}. When it leaves the building, mark it as gone out on the checkout list.
        </p>
      )}
      {picking && (
        <GearPicker
          from={cs.date}
          to={cs.date}
          excludeManifestId={m?.id}
          alreadyOn={m?.lines.map((l) => l.equipmentId) ?? []}
          onClose={() => setPicking(false)}
          onConfirm={(lines) => {
            if (attempt(() => addGearToSheet(actor, { id: cs.id, contentId: cs.contentId, date: cs.date }, lines), "Gear added"))
              setPicking(false);
          }}
        />
      )}
    </Wrap>
  );
}
