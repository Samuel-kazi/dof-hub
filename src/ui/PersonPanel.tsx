import type { Actor } from "../types";
import { ROLES } from "../config/roles";
import { getDb } from "../data/store";
import { redactPerson } from "../services/access";
import { can } from "../services/wrapped/permissions";
import { Modal } from "./Modal";
import { Avatar } from "./parts";

// Someone's contact card, opened by clicking their name: how to reach them (phone and email, where the viewer may
// see them) and what they do. On a phone the number dials and the address opens a new email.

export interface PersonContext {
  role?: string; // what they do here, such as their role on a call sheet
}

export function PersonPanel({
  actor,
  personId,
  context,
  onClose,
  onOpenPage,
}: {
  actor: Actor;
  personId: string;
  context?: PersonContext;
  onClose: () => void;
  onOpenPage: (personId: string) => void;
}) {
  const p = getDb().people.find((x) => x.personId === personId);
  if (!p)
    return (
      <Modal title="Contact" onClose={onClose}>
        <p className="muted">This person is no longer in the directory.</p>
      </Modal>
    );
  const shown = redactPerson(actor, p);
  const phone = shown.phone.trim();
  const email = shown.email.trim();
  const directory = actor.role === "HOP" || can(actor, "people.directory");
  return (
    <Modal
      title={p.name}
      onClose={onClose}
      actions={
        <>
          {directory && (
            <button className="btn" onClick={() => onOpenPage(p.personId)}>
              Open their page
            </button>
          )}
          <button className="btn primary" onClick={onClose} autoFocus>
            Close
          </button>
        </>
      }
    >
      <div className="person-card">
        <Avatar person={shown} size={56} />
        <div className="grow">
          <div>{ROLES[p.category].label}</div>
          {context?.role && <div className="muted">{context.role}</div>}
          {p.status !== "active" && <span className="badge warn">No longer active</span>}
        </div>
      </div>
      {shown.contactHidden ? (
        <p className="muted">Their contact details are kept by the Head of Production.</p>
      ) : (
        <dl className="person-contact">
          <dt>Phone</dt>
          <dd>
            {phone ? (
              <>
                <a href={`tel:${phone.replace(/[^\d+]/g, "")}`}>{phone}</a>{" "}
                <a className="muted" href={`sms:${phone.replace(/[^\d+]/g, "")}`}>
                  Text
                </a>
              </>
            ) : (
              <span className="muted">Not given</span>
            )}
          </dd>
          <dt>Email</dt>
          <dd>{email ? <a href={`mailto:${email}`}>{email}</a> : <span className="muted">Not given</span>}</dd>
        </dl>
      )}
    </Modal>
  );
}
