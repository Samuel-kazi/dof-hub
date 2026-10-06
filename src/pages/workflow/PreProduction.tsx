import { useState } from "react";
import type { Actor } from "../../types";
import { PROJECT_ROLE_DEFS, REQUIRED_ROLES } from "../../config/workflow";
import { getDb } from "../../data/store";
import { isHop } from "../../services/access";
import { can } from "../../services/wrapped/permissions";
import { nameOf } from "../../services/wrapped/people";
import {
  assignRole,
  createSession,
  evaluateGate,
  removeRole,
  rowsOf,
  sendToPostProduction,
  sessionsOf,
  type Project,
} from "../../services/wrapped/workflow";
import { fmtDate } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { Empty, Field } from "../../ui/parts";
import { CrewSelect } from "../../ui/workflow/shared";
import { ConfigChecklist } from "./common";
import { DecisionPanel } from "./Development";
import { PersonName } from "../../ui/PersonName";
import { askIfScheduling, useReviewCheck } from "../../ui/ReviewCheck";

// Pre-production for the whole project: the producer assigns the roles, works through the project's checklist,
// and schedules the recording sessions. A DOF-made documentary also gets its second greenlight here.

const canManageTeam = (actor: Actor, p: Project) =>
  isHop(actor) || can(actor, "pipeline.assign") || p.workflow.showProducerId === actor.personId;

export function RolesPanel({ project, write }: { project: Project; write: boolean }) {
  const { actor, attempt } = useApp();
  const [guestCrew, setGuestCrew] = useState<string | null>(null);
  const [guestName, setGuestName] = useState("");
  const roles = getDb().projectRoles.filter((r) => r.contentId === project.contentId);
  const manage = write && canManageTeam(actor, project) && project.workflow.stage === "Pre-production";
  const hosts = roles.filter((r) => r.roleKey === "host_guest");
  const addHost = () => {
    if (attempt(() => assignRole(actor, project.contentId, "host_guest", guestCrew ? { crewId: guestCrew } : { guestName }), "Added")) {
      setGuestCrew(null);
      setGuestName("");
    }
  };
  return (
    <section className="glass panel" aria-label="Project roles">
      <h2>Project roles</h2>
      <p className="muted">
        Show producer:{" "}
        <b>
          <PersonName id={project.workflow.showProducerId} fallback="not named yet" role="Show producer" />
        </b>
        . The producer assigns these at Pre-production.{" "}
        {manage ? "" : "Only the producer, or someone who may assign other people's work, can change them."}
      </p>
      <div className="wf-fields">
        {PROJECT_ROLE_DEFS.filter((d) => d.exclusive).map((d) => {
          const held = roles.find((r) => r.roleKey === d.key);
          return (
            <Field key={d.key} label={`${d.label}${REQUIRED_ROLES.includes(d.key) ? " *" : ""}`}>
              <CrewSelect
                label={d.label}
                value={held?.crewId ?? null}
                disabled={!manage}
                onChange={(p) =>
                  p
                    ? attempt(() => assignRole(actor, project.contentId, d.key, { crewId: p }), `${d.label}: ${nameOf(p)}`)
                    : held && attempt(() => removeRole(actor, held.id), "Removed")
                }
              />
            </Field>
          );
        })}
      </div>
      <h3 style={{ marginTop: 14 }}>Hosts and guests *</h3>
      {hosts.length === 0 ? (
        <Empty>No host or guest yet. At least one is needed before recording.</Empty>
      ) : (
        <div className="list">
          {hosts.map((h) => (
            <div key={h.id} className="list-item">
              <div className="grow">
                <div className="title">{h.crewId ? <PersonName id={h.crewId} /> : h.guestName}</div>
                <span className="muted">{h.crewId ? "Crew" : "Outside the crew"}</span>
              </div>
              {manage && (
                <button className="btn small ghost" onClick={() => attempt(() => removeRole(actor, h.id), "Removed")}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {manage && (
        <div className="row" style={{ alignItems: "end", marginTop: 10 }}>
          <Field label="Someone on the crew">
            <CrewSelect
              label="Host or guest from the crew"
              value={guestCrew}
              onChange={(p) => {
                setGuestCrew(p);
                if (p) setGuestName("");
              }}
            />
          </Field>
          <Field label="Or someone outside it, by name">
            <input type="text" value={guestName} disabled={!!guestCrew} onChange={(e) => setGuestName(e.target.value)} />
          </Field>
          <div style={{ flex: "none" }}>
            <button className="btn primary" disabled={!guestCrew && !guestName.trim()} onClick={addHost}>
              Add host or guest
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function SessionsPanel({ project, write }: { project: Project; write: boolean }) {
  const { actor, attempt, go, confirm } = useApp();
  const [date, setDate] = useState("");
  const [venue, setVenue] = useState("");
  const sessions = sessionsOf(project.contentId);
  const live = sessions.filter((s) => !s.archivedAt);
  const isDoc = project.workflow.formType.startsWith("documentary");
  const sentToPost = getDb().records.some((r) => r.parentId === project.contentId && r.episode && !r.archived);
  const canSchedule = write && project.workflow.stage === "Pre-production" && !project.archived;
  const [reviewCheck, reviewModal] = useReviewCheck();
  const add = async () => {
    const ok = await askIfScheduling(reviewCheck, project.contentId, "new session", null, date || null);
    if (!ok) return;
    const s = attempt(() => createSession(actor, project.contentId, { scheduledDate: date || null, venue }), "Session scheduled");
    if (s) {
      ok.done(s.id);
      setDate("");
      setVenue("");
      go({ n: "session", id: s.id });
    }
  };
  return (
    <section className="glass panel" aria-label="Recording sessions">
      <h2>Recording sessions</h2>
      {reviewModal}
      {live.length === 0 ? (
        <Empty>
          {project.workflow.stage === "Development"
            ? "Sessions are scheduled once the project is greenlit and handed off."
            : "No sessions yet."}
        </Empty>
      ) : (
        <div className="wf-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Date</th>
                <th>Venue</th>
                <th>Stage</th>
                <th>{isDoc ? "Items" : "Episodes"}</th>
              </tr>
            </thead>
            <tbody>
              {live.map((s) => (
                <tr
                  key={s.id}
                  className="clickable"
                  onClick={() => go({ n: "session", id: s.id })}
                  onKeyDown={(e) => e.key === "Enter" && go({ n: "session", id: s.id })}
                  tabIndex={0}
                >
                  <td className="cid">{s.id}</td>
                  <td>{s.scheduledDate ? fmtDate(s.scheduledDate) : <span className="muted">No date yet</span>}</td>
                  <td>{s.venue || <span className="muted">Not set</span>}</td>
                  <td>
                    <span className={`badge ${s.status === "Closed" ? "ok" : "accent"}`}>
                      {s.status === "Planned" ? "Pre-production" : s.status === "Open" ? "Production" : "Closed"}
                    </span>
                  </td>
                  <td>{rowsOf(s.id).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sessions.length > live.length && (
        <p className="muted">
          {sessions.length - live.length} session{sessions.length - live.length === 1 ? "" : "s"} taken off the schedule:{" "}
          {sessions
            .filter((s) => s.archivedAt)
            .map((s) => `${s.id} (${s.archivedReason})`)
            .join(", ")}
        </p>
      )}
      {canSchedule && (
        <div className="row" style={{ alignItems: "end", marginTop: 10 }}>
          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Venue">
            <input type="text" value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="DOF Studio A" />
          </Field>
          <div style={{ flex: "none" }}>
            <button className="btn primary" onClick={() => void add()}>
              Schedule a session
            </button>
          </div>
        </div>
      )}
      {isDoc && write && !sentToPost && live.some((s) => s.status === "Closed") && (
        <div className="gate ready" style={{ marginTop: 12 }}>
          <span className="grow" style={{ flex: 1 }}>
            The film's episode is made when you send it to post production, with the notes from every closed session's log.
          </span>
          <button
            className="btn primary"
            onClick={async () => {
              if (
                await confirm({
                  title: "Send to post production?",
                  body: "This makes the film's episode (or one per planned part) from the closed sessions. It is done once.",
                  confirmLabel: "Send",
                })
              )
                attempt(() => sendToPostProduction(actor, project.contentId), "Sent to post production");
            }}
          >
            Send to post production
          </button>
        </div>
      )}
    </section>
  );
}

export function PreProductionTab({ project, write }: { project: Project; write: boolean }) {
  if (project.workflow.stage === "Development")
    return <Empty>Pre-production starts once the project is greenlit and handed off. Project home shows what is still needed.</Empty>;
  const ready = evaluateGate("Pre-production", "project", project.contentId);
  const isDofDoc = project.workflow.formType === "documentary_dof";
  return (
    <div className="stack">
      {isDofDoc && (
        <section className="glass panel" aria-label="Second greenlight">
          <h2>Second greenlight</h2>
          <DecisionPanel project={project} write={write} active />
        </section>
      )}
      <RolesPanel project={project} write={write} />
      <ConfigChecklist
        title="Pre-production for the whole project"
        listKey="preProject"
        ownerId={project.contentId}
        disabled={!write || project.archived}
        auto={{ roles_assigned: [!ready.missing.some((m) => m.startsWith("Role:")), "From the roles above"] }}
      />
      <section className="glass panel" aria-label="Ready for recording">
        <h2>The project's part of every session's gate</h2>
        {ready.passed ? (
          <p>The project is ready. Each session still needs its own gear, rehearsal and call sheet.</p>
        ) : (
          <ul className="wf-missing">
            {ready.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
      </section>
      <SessionsPanel project={project} write={write} />
    </div>
  );
}
