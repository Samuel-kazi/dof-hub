import { useState } from "react";
import { createPortal } from "react-dom";
import type { Actor, RecordingSession } from "../../types";
import { roleName } from "../../config/workflow";
import { getDb } from "../../data/store";
import { getRecord, isHop, redactPerson } from "../../services/access";
import { fmtDate, todayIso } from "../../services/utils";
import { framesOf, rowsOfShotList, shotNumbers } from "../../services/wrapped/documents";
import { can } from "../../services/wrapped/permissions";
import { nameOf } from "../../services/wrapped/people";
import { devotionPlacements, planRolesOf, roleHolder, sessionName, sheetTimes, type Project } from "../../services/wrapped/workflow";
import { useApp } from "../../ui/AppContext";
import { imageSrc } from "./images";

// Printing a session's call sheet, or its run sheet alone, on paper or to PDF through the browser's own print: one
// clean page, black on white, headed with the project, the session's name, label and date. Anyone who can see the
// project can print it (downloading a report still needs "Export reports").

export interface CallSheetPrintJob {
  sessionId: string;
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

function RunSheetTable({ session }: { session: RecordingSession }) {
  const rows = [...session.runSheet].sort((a, b) => a.time.localeCompare(b.time));
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

export function PrintedCallSheet({ job }: { job: CallSheetPrintJob }) {
  const { actor } = useApp();
  const db = getDb();
  const s = db.recordingSessions.find((x) => x.id === job.sessionId);
  const project = s ? (getRecord(s.contentId) as Project | undefined) : undefined;
  if (!s || !project) return null;
  const cs = s.callSheetId ? db.callSheets.find((c) => c.id === s.callSheetId) : undefined;
  const when = [
    s.label,
    s.scheduledDate ? fmtDate(s.scheduledDate) : "No date yet",
    s.startTime && `${s.startTime}${s.endTime ? `–${s.endTime}` : ""}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const head = (
    <header className="rp-print-head">
      <h1>{project.title}</h1>
      <p className="report-sub">
        <b>{sessionName(s)}</b> · {when} · {job.only === "run" ? "Run sheet" : "Call sheet"} · printed {fmtDate(todayIso())}
      </p>
    </header>
  );
  if (job.only === "run")
    return (
      <article className="report-page rp-print" aria-label="Printed run sheet">
        {head}
        <RunSheetTable session={s} />
      </article>
    );
  const t = sheetTimes(s.runSheet);
  const devotions = devotionPlacements(project.contentId).filter((x) => x.sessionId === s.id);
  const frames = s.storyboardId ? framesOf(s.storyboardId) : [];
  const shots = s.shotListId ? rowsOfShotList(s.shotListId).filter((r) => r.rowType !== "setup") : [];
  const numbers = s.shotListId ? shotNumbers(s.shotListId) : new Map<string, number>();
  // Every role, in the plan's order, with who holds it and their phone where the viewer may see it; then the guest.
  const contacts = new Map(sheetContacts(project, actor).map((c) => [c.role, c]));
  const rows = [
    ...planRolesOf(project.contentId).map((r) => contacts.get(roleName(r)) ?? { role: roleName(r), name: "No one yet", phone: "" }),
    ...[...contacts.values()].filter((c) => !planRolesOf(project.contentId).some((r) => roleName(r) === c.role)),
  ];
  return (
    <article className="report-page rp-print" aria-label="Printed call sheet">
      {head}
      <table className="report-pairs">
        <tbody>
          <tr>
            <th>Venue</th>
            <td>{cs?.location || s.venue || "Not set"}</td>
          </tr>
          {cs?.format && (
            <tr>
              <th>Format</th>
              <td>{cs.format}</td>
            </tr>
          )}
          <tr>
            <th>Crew call</th>
            <td>{t.crewCall ?? "Not on the run sheet"}</td>
          </tr>
          <tr>
            <th>Talent arrival</th>
            <td>{t.talentArrival ?? "Not on the run sheet"}</td>
          </tr>
          <tr>
            <th>Start recording</th>
            <td>{t.startRecording ?? "Not on the run sheet"}</td>
          </tr>
          <tr>
            <th>Wrap</th>
            <td>{t.wrap ?? "Not on the run sheet"}</td>
          </tr>
        </tbody>
      </table>
      <h2>Roles and contacts</h2>
      <table className="report-table">
        <thead>
          <tr>
            <th>Role</th>
            <th>Name</th>
            <th>Phone</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={`${c.role}|${c.name}`}>
              <td>{c.role}</td>
              <td>{c.name}</td>
              <td>{c.phone}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
      <h2>Run sheet</h2>
      <RunSheetTable session={s} />
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
