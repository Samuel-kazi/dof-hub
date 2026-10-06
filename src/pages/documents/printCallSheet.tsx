import { useState } from "react";
import { createPortal } from "react-dom";
import type { Actor, CallSheet, RecordingSession, RunItem } from "../../types";
import { LOGISTICS_FIELDS } from "../../config/callSheet";
import { roleName } from "../../config/workflow";
import { getDb } from "../../data/store";
import { getRecord, isHop, redactPerson } from "../../services/access";
import { fmtDate, todayIso } from "../../services/utils";
import { framesOf, rowsOfShotList, shotNumbers } from "../../services/wrapped/documents";
import { getItem, manifestForSheet } from "../../services/wrapped/equipment";
import { can } from "../../services/wrapped/permissions";
import { nameOf } from "../../services/wrapped/people";
import { roleOn } from "../../services/wrapped/team";
import { devotionPlacements, planRolesOf, roleHolder, sessionName, sheetTimes, type Project } from "../../services/wrapped/workflow";
import { useApp } from "../../ui/AppContext";
import { crewContactRows, seesOutsideContacts } from "../production/SheetSections";
import { imageSrc } from "./images";

// Printing a call sheet, or its run sheet alone, on paper or to PDF through the browser's own print: one clean page,
// black on white, headed with the project, the day (or session's name and label) and the date. Every section of the
// sheet is printed, then, for a recording session, its devotions and its storyboard and shot list. Anyone who can see
// the project can print it (downloading a report still needs "Export reports").

export interface CallSheetPrintJob {
  sheetId?: string; // the call sheet, or
  sessionId?: string; // a recording session (its call sheet, if it has one, and its run sheet)
  only: "all" | "run";
}

/** Who to call: the role holders, with their phones where the viewer may see them, and the devotion's guest. */
export function sheetContacts(project: Project, viewer: Actor): { role: string; name: string; phone: string }[] {
  const db = getDb();
  const out = planRolesOf(project.contentId)
    .filter(roleHolder)
    .map((r) => {
      const person = r.crewId ? db.people.find((p) => p.personId === r.crewId) : undefined;
      const shown = person ? redactPerson(viewer, person) : undefined;
      return {
        role: roleName(r),
        name: person?.name ?? r.guestName,
        phone: !person ? "" : shown!.contactHidden ? "Private" : shown!.phone,
      };
    });
  const guest = db.developmentForms.find((f) => f.contentId === project.contentId)?.sections.guest;
  if (guest?.name) {
    const open = isHop(viewer) || can(viewer, "people.contacts") || (viewer.role !== "VOL" && viewer.role !== "PTR");
    out.push({ role: "Guest (host)", name: String(guest.name), phone: open ? String(guest.contact ?? "") : "Private" });
  }
  return out;
}

const endOf = (time: string, minutes: number): string => {
  const [h, m] = time.split(":").map(Number);
  const t = (h * 60 + m + minutes) % (24 * 60);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

function RunTable({ items }: { items: RunItem[] }) {
  const rows = [...items].sort((a, b) => a.time.localeCompare(b.time));
  if (!rows.length) return <p>The run sheet is empty.</p>;
  return (
    <table className="report-table">
      <thead>
        <tr>
          <th>Start</th>
          <th>End</th>
          <th>Activity</th>
          <th>Who</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{r.time}</td>
            <td>{endOf(r.time, r.durationMin)}</td>
            <td>{r.title}</td>
            <td>{r.ownerPersonId ? nameOf(r.ownerPersonId) : ""}</td>
            <td>{r.notes}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const Pairs = ({ rows }: { rows: [string, string][] }) => (
  <table className="report-pairs">
    <tbody>
      {rows.map(([k, v]) => (
        <tr key={k}>
          <th>{k}</th>
          <td style={{ whiteSpace: "pre-wrap" }}>{v}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

export function PrintedCallSheet({ job }: { job: CallSheetPrintJob }) {
  const { actor } = useApp();
  const db = getDb();
  let s: RecordingSession | undefined = job.sessionId ? db.recordingSessions.find((x) => x.id === job.sessionId) : undefined;
  const cs: CallSheet | undefined = job.sheetId
    ? db.callSheets.find((c) => c.id === job.sheetId)
    : s?.callSheetId
      ? db.callSheets.find((c) => c.id === s!.callSheetId)
      : undefined;
  if (!s && cs) s = db.recordingSessions.find((x) => x.callSheetId === cs.id);
  const contentId = cs?.contentId ?? s?.contentId;
  const project = contentId ? (getRecord(contentId) as Project | undefined) : undefined;
  if (!project || (!cs && !s)) return null;
  const day = cs?.instanceId ? getRecord(cs.instanceId) : undefined;
  const date = cs?.date ?? s?.scheduledDate ?? null;
  const from = s?.startTime ?? cs?.startTime ?? "";
  const to = s?.endTime ?? cs?.wrapTime ?? "";
  const name = s ? sessionName(s) : (day?.title ?? cs?.title ?? "");
  // A recurring show's day is called by its date: the date is not said twice.
  const dateText = date ? (name.includes(fmtDate(date)) ? null : fmtDate(date)) : "No date yet";
  const when = [s ? s.label : null, dateText, from && `${from}${to ? `–${to}` : ""}`].filter(Boolean).join(" · ");
  const run = s ? s.runSheet : (cs?.runOfShow ?? []);
  const head = (
    <header className="rp-print-head">
      <h1>{project.title}</h1>
      <p className="report-sub">
        <b>{name}</b> · {when} · {job.only === "run" ? "Run sheet" : "Call sheet"} · printed {fmtDate(todayIso())}
      </p>
    </header>
  );
  if (job.only === "run")
    return (
      <article className="report-page rp-print" aria-label="Printed run sheet">
        {head}
        <RunTable items={run} />
      </article>
    );
  const t = sheetTimes(run);
  const time = (typed: string | undefined, fromRun: string | null) => typed || fromRun || "Not set";
  const devotions = s ? devotionPlacements(project.contentId).filter((x) => x.sessionId === s!.id) : [];
  const frames = s?.storyboardId ? framesOf(s.storyboardId) : [];
  const shots = s?.shotListId ? rowsOfShotList(s.shotListId).filter((r) => r.rowType !== "setup") : [];
  const numbers = s?.shotListId ? shotNumbers(s.shotListId) : new Map<string, number>();
  const roleHint = (pid: string) => roleOn(pid, project) || null;
  const open = seesOutsideContacts(actor);
  // The crew on the sheet, then (for a recording session) the plan's role holders not on it and its guest.
  const crew = cs ? crewContactRows(cs, actor, roleHint) : [];
  const crewNames = new Set(crew.map((c) => c.name));
  const planRows = s ? sheetContacts(project, actor).filter((c) => !crewNames.has(c.name)) : [];
  const unfilled = s ? planRolesOf(project.contentId).filter((r) => !roleHolder(r)) : [];
  const gear = cs ? manifestForSheet(cs.id) : undefined;
  const logistics = cs
    ? LOGISTICS_FIELDS.filter((f) => cs.logistics[f.key]).map((f) => [f.label, cs.logistics[f.key]] as [string, string])
    : [];
  return (
    <article className="report-page rp-print" aria-label="Printed call sheet">
      {head}
      <h2>Schedule</h2>
      <Pairs
        rows={[
          ["Crew call", time(cs?.callTime, t.crewCall)],
          ["Talent call", time(cs?.talentCall, t.talentArrival)],
          ["Start", time(cs?.startTime, t.startRecording)],
          ["Wrap", time(cs?.wrapTime, t.wrap)],
        ]}
      />
      <h2>Crew</h2>
      {crew.length + planRows.length + unfilled.length === 0 ? (
        <p>No crew on the sheet yet.</p>
      ) : (
        <table className="report-table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Name</th>
              <th>Phone</th>
            </tr>
          </thead>
          <tbody>
            {[...crew, ...planRows].map((c, i) => (
              <tr key={`${c.name}|${i}`}>
                <td>{c.role}</td>
                <td>{c.name}</td>
                <td>{c.phone}</td>
              </tr>
            ))}
            {unfilled.map((r) => (
              <tr key={r.id}>
                <td>{roleName(r)}</td>
                <td>No one yet</td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cs && cs.talent.length > 0 && (
        <>
          <h2>Talent</h2>
          <table className="report-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Contact</th>
                <th>Call</th>
              </tr>
            </thead>
            <tbody>
              {cs.talent.map((x) => (
                <tr key={x.id}>
                  <td>{x.name}</td>
                  <td>{x.role}</td>
                  <td>{open ? x.contact : "Private"}</td>
                  <td>{x.callTime || cs.talentCall}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h2>Location</h2>
      <Pairs
        rows={[
          ["Location", cs?.location || s?.venue || "Not set"],
          ...(cs?.locationAddress ? [["Address", cs.locationAddress] as [string, string]] : []),
          ...(cs?.locationNotes ? [["Getting in", cs.locationNotes] as [string, string]] : []),
          ...(cs?.format ? [["Format", cs.format] as [string, string]] : []),
        ]}
      />
      {(gear?.lines.length || cs?.plannedGear.length) && (
        <>
          <h2>Equipment</h2>
          <ul>
            {(gear?.lines ?? []).map((l) => (
              <li key={l.equipmentId}>
                {getItem(l.equipmentId)?.name ?? l.equipmentId}
                {l.quantity > 1 ? ` x ${l.quantity}` : ""}
              </li>
            ))}
            {(cs?.plannedGear ?? []).map((g) => (
              <li key={`p-${g.equipmentId}`}>
                {getItem(g.equipmentId)?.name ?? g.equipmentId}
                {g.quantity > 1 ? ` x ${g.quantity}` : ""} (not booked yet)
              </li>
            ))}
          </ul>
        </>
      )}
      {logistics.length > 0 && (
        <>
          <h2>Logistics</h2>
          <Pairs rows={logistics} />
        </>
      )}
      {cs && cs.contacts.length > 0 && (
        <>
          <h2>Contacts</h2>
          <table className="report-table">
            <tbody>
              {cs.contacts.map((c) => (
                <tr key={c.id}>
                  <td>{c.role}</td>
                  <td>{c.name}</td>
                  <td>{open ? [c.phone, c.email].filter(Boolean).join(", ") : "Private"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {s && (
        <>
          <h2>Devotions, in order</h2>
          {devotions.length === 0 ? (
            <p>None ticked on this session yet.</p>
          ) : (
            <ol>
              {devotions.map((x) => (
                <li key={x.planned.id}>
                  {x.title}
                  {x.scripture ? ` (${x.scripture})` : ""}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      <h2>{s ? "Run sheet" : "Run of show"}</h2>
      <RunTable items={run} />
      {cs && cs.technicalCheck.length > 0 && (
        <>
          <h2>Technical check</h2>
          <ul className="rp-print-checks">
            {cs.technicalCheck.map((c) => (
              <li key={c.id}>
                {c.done ? "☑" : "☐"} {c.label}
                {c.note ? `: ${c.note}` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
      {cs && (cs.rehearsal.time || cs.rehearsal.notes) && (
        <>
          <h2>Rehearsal</h2>
          <Pairs
            rows={[
              ["Time", cs.rehearsal.time || "Not set"],
              ...(cs.rehearsal.notes ? [["What", cs.rehearsal.notes] as [string, string]] : []),
            ]}
          />
        </>
      )}
      {frames.length > 0 && (
        <>
          <h2>Storyboard</h2>
          <ol className="rp-print-frames">
            {frames.map((f) => {
              const src = imageSrc(f.imagePath);
              return (
                <li key={f.id}>
                  {src && <img src={src} alt="" />}
                  <span>
                    {f.scene && <b>{f.scene} </b>}
                    {f.description}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {shots.length > 0 && (
        <>
          <h2>Shot list</h2>
          <table className="report-table">
            <thead>
              <tr>
                <th>Shot</th>
                <th>Description</th>
                <th>Size</th>
                <th>Movement</th>
              </tr>
            </thead>
            <tbody>
              {shots.map((r) =>
                r.rowType === "banner" ? (
                  <tr key={r.id}>
                    <td colSpan={4}>
                      <b>{r.description}</b>
                    </td>
                  </tr>
                ) : (
                  <tr key={r.id}>
                    <td>{numbers.get(r.id)}</td>
                    <td>{r.description}</td>
                    <td>{r.shotSize}</td>
                    <td>{r.movement}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </>
      )}
      {cs?.notes && (
        <>
          <h2>Notes</h2>
          <p style={{ whiteSpace: "pre-wrap" }}>{cs.notes}</p>
        </>
      )}
    </article>
  );
}

/** A print button's helper: call print(job) to print it; render the returned node somewhere on the page. */
/**
 * A print asked for from somewhere else (the Ctrl+K "Print today's run sheet"): the call sheet's page picks it up once,
 * when it opens.
 */
let pending: CallSheetPrintJob | null = null;
export const requestPrint = (job: CallSheetPrintJob): void => {
  pending = job;
};
export function takePrintRequest(sheetId: string): CallSheetPrintJob | null {
  if (pending?.sheetId !== sheetId) return null;
  const job = pending;
  pending = null;
  return job;
}

export function usePrintCallSheet(): [(job: CallSheetPrintJob) => void, React.ReactNode] {
  const [job, setJob] = useState<CallSheetPrintJob | null>(null);
  const print = (next: CallSheetPrintJob) => {
    setJob(next);
    // Let the sheet draw, then open the print dialog.
    setTimeout(() => {
      document.body.classList.add("printing-report");
      const done = () => {
        document.body.classList.remove("printing-report");
        setJob(null);
        window.removeEventListener("afterprint", done);
      };
      window.addEventListener("afterprint", done);
      window.print();
    }, 150);
  };
  const node =
    job && typeof document !== "undefined"
      ? createPortal(
          <div id="print-root">
            <PrintedCallSheet job={job} />
          </div>,
          document.body,
        )
      : null;
  return [print, node];
}
