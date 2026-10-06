import { useState } from "react";
import type { CallSheet, ContentRecord } from "../types";
import { useApp } from "../ui/AppContext";
import { getDb, useDb } from "../data/store";
import { canComment, canWrite, getRecord, visibleCallSheets, visibleRecords } from "../services/access";
import {
  attachCallSheet,
  bookPlannedGear,
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
import { fmtDate, relativeDays } from "../services/utils";
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
  type ContactRow,
} from "./production/SheetSections";
import { RunSheetPanel } from "./workflow/SessionPage";
import { usePrintCallSheet } from "./documents/printCallSheet";
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
  const sheets = visibleCallSheets(actor).sort((a, b) => a.date.localeCompare(b.date));
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
      <section className="glass panel">
        {sheets.length === 0 ? (
          <Empty>No call sheets yet. Use the call sheet button on a pipeline record, or create one here.</Empty>
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
  const [date, setDate] = useState("");
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
          <button className="btn primary" onClick={save}>
            Duplicate
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="New shoot date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} autoFocus />
        </Field>
        <p className="muted">
          Crew, location, format and gear carry over. Episodes are matched again for the new date, and gear already booked that day is
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
  const cs = getCallSheet(id);
  const root = cs ? getRecord(cs.contentId) : undefined;

  if (!cs || !root)
    return (
      <div className="page">
        <Empty>This call sheet does not exist or is not part of a project you are attached to.</Empty>
      </div>
    );

  const write = canWrite(actor, root);

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
        {write &&
          (cs.status === "draft" ? (
            <button
              className="btn primary"
              onClick={() => attempt(() => finalizeCallSheet(actor, cs.id, cs.version), "Call sheet finalized")}
            >
              Finalize
            </button>
          ) : (
            <button className="btn" onClick={() => attempt(() => reopenCallSheet(actor, cs.id), "Reopened as draft")}>
              Reopen
            </button>
          ))}
        {write && (
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
  const editable = write && cs.status === "draft";
  const mm = getMismatches(cs);
  const drift = mm.moved.length + mm.unlinked.length > 0;
  const clashes = crewConflicts(cs);
  const db = getDb();
  const comments = getComments(cs.contentId, cs.id);
  // A sheet made for a recording session lists the episodes planned for it (the five-stage workflow).
  const session = db.recordingSessions.find((s) => s.callSheetId === cs.id);
  const sessionRows = session ? db.sessionLogEntries.filter((e) => e.sessionId === session.id) : [];
  const day = cs.instanceId ? getRecord(cs.instanceId) : undefined;
  const save = (patch: SheetPatch) => attempt(() => updateCallSheet(actor, cs.id, patch, cs.version));
  const roleHint = (pid: string) => roleOn(pid, root) || null;
  const props = { value: cs, editable, onChange: save };
  // Ticking the technical check and the rehearsal happens on the day, on a final sheet too.
  const tickProps = { value: cs, editable: write, onChange: save };

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
        {cs.status === "final" && write && (
          <p className="muted">
            This call sheet is final: its plan is locked until it is reopened. The technical check and rehearsal can still be ticked.
          </p>
        )}
      </section>

      <SectionNav />
      <ScheduleSection
        {...props}
        date={{ value: cs.date, onChange: (date) => save({ date }) }}
        derived={sheetTimes(session ? session.runSheet : cs.runOfShow)}
      />
      <CrewSection
        {...props}
        candidates={crewCandidates(cs.contentId, cs.crewPersonIds)}
        roleHint={roleHint}
        clashes={new Map(clashes.map((c) => [c.personId, `Also on ${c.otherSheet.title}`]))}
      />
      <TalentSection {...props} />
      <LocationSection {...props} />
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
      {session ? (
        <div id="sec-runOfShow" className="cs-section">
          <RunSheetPanel sessionId={session.id} editable={write && session.status !== "Closed" && !session.archivedAt} />
        </div>
      ) : (
        <RunOfShowSection {...props} required={runOfShowRequired(cs)} />
      )}
      <TechnicalCheckSection {...tickProps} editable={editable} onChange={save} canTick tickable={write} />
      <RehearsalSection {...tickProps} editable={editable} onChange={save} canTick tickable={write} />

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
              <b>{nameOf(c.byPersonId)}</b> <small>{new Date(c.at).toLocaleString()}</small>
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
