import { useState } from "react";
import { api, isRemote } from "../data/remote";
import { useGoogle } from "./Accounts";
import { useApp } from "../ui/AppContext";
import { getDb, useDb } from "../data/store";
import { Empty } from "../ui/parts";
import { can } from "../services/wrapped/permissions";
import { redactPerson } from "../services/access";
import { alreadySent, dueSoon, lastSent, logSent, mailtoLink, messageFor, remindersFor, smsLink, type Reminder } from "../services/wrapped/reminders";
import { googleCalendarLink, icsFor } from "../services/calendar";
import { updateOwnProfile } from "../services/wrapped/people";
import { saveFile } from "../services/download";
import { fmtDateTime, fmtShort, relativeDays } from "../services/utils";
import { nameOf } from "../services/wrapped/people";

const KIND: Record<Reminder["kind"], string> = { stage: "Stage", task: "Checklist", shoot: "Shoot", gear: "Gear", stale: "Stalled" };

/** Opens a link the way a click would, so the mail or messages app takes over. */
function openLink(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function Reminders() {
  const { actor } = useApp();
  useDb();
  const canSend = can(actor, "reminders.sendOthers");
  const [tab, setTab] = useState<"mine" | "send">("mine");
  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Reminders and calendar</h1>
          <p className="sub">What is coming up, in your own calendar, by email or by text.</p>
        </div>
        {canSend && (
          <div className="seg" role="tablist">
            <button role="tab" aria-selected={tab === "mine"} className={tab === "mine" ? "on" : ""} onClick={() => setTab("mine")}>My reminders</button>
            <button role="tab" aria-selected={tab === "send"} className={tab === "send" ? "on" : ""} onClick={() => setTab("send")}>Send to the team</button>
          </div>
        )}
      </div>
      {tab === "mine" || !canSend ? <Mine /> : <Send />}
    </div>
  );
}

function Mine() {
  const { actor, me, go, attempt, notify, toast } = useApp();
  const lead = getDb().settings.stageReminderHours;
  const rems = remindersFor(actor.personId);
  const [g] = useGoogle();

  const download = async () => {
    try {
      const saved = await saveFile(`dawn-of-faith-${me.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.ics`, icsFor(me, rems, lead));
      if (!saved) return;
      logSent(actor, actor.personId, "calendar", "Calendar file", `${rems.length} events`, rems.map((r) => r.key));
      notify("Calendar downloaded", saved.how === "saved" ? `Saved to ${saved.where}. Open it to add ${rems.length} event${rems.length === 1 ? "" : "s"} to your calendar.` : `Saved as ${saved.where}. Look in your Downloads folder, then open it to add the events to your calendar.`);
    } catch { toast("The calendar file could not be made.", "error"); }
  };

  return (
    <>
      <section className="glass panel" aria-label="Coming up">
        <h2 style={{ marginBottom: 12 }}>Coming up for you</h2>
        {rems.length === 0 ? <Empty>Nothing is coming up in the next three weeks.</Empty> : (
          <table className="table">
            <thead><tr><th>When</th><th>What</th><th /></tr></thead>
            <tbody>
              {rems.map((r) => (
                <tr key={r.key} className="clickable" onClick={() => go({ n: "record", id: r.contentId })}>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtShort(r.date)}{r.time ? ` ${r.time}` : ""}<div className={r.overdue ? "badge bad" : "muted"} style={{ fontSize: ".8rem" }}>{r.overdue ? "Late" : relativeDays(r.date)}</div></td>
                  <td><span className="badge" style={{ marginRight: 8 }}>{KIND[r.kind]}</span>{r.title}<div className="muted" style={{ fontSize: ".84rem" }}>{r.detail}</div></td>
                  <td><a className="btn small ghost" href={googleCalendarLink(r)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Add to Google Calendar</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid-2">
        <section className="glass panel" aria-label="Calendar file">
          <h2>Put them in your calendar</h2>
          <p className="muted" style={{ margin: "8px 0 14px" }}>Download a calendar file with everything above. Open it to add the events to Google Calendar, Apple Calendar or Outlook. Each event has an alert {lead} hours before it, so your phone reminds you too.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {isRemote() && g?.calendar && <button className="btn primary" disabled={rems.length === 0} onClick={async () => { try { const r = await api.post<{ added: number; already: number; failed: number }>("/api/google-calendar"); toast(r.added ? `${r.added} added to your Google Calendar` : "Your Google Calendar already has everything", "success"); } catch (e) { toast(e instanceof Error ? e.message : "Could not add them.", "error"); } }}>Add to my Google Calendar</button>}
            <button className={`btn ${isRemote() && g?.calendar ? "" : "primary"}`} onClick={download} disabled={rems.length === 0}>Download my calendar (.ics)</button>
          </div>
          {isRemote() && g && !g.calendar && <p className="muted" style={{ marginTop: 10, fontSize: ".84rem" }}>{g.available ? "Want them added to Google Calendar automatically? Link your Google account in Settings. It is optional." : ""}</p>}
          <p className="muted" style={{ marginTop: 12, fontSize: ".84rem" }}>The file is a snapshot. When dates change, download a fresh one. A calendar that updates by itself needs a server, which comes with the database.</p>
        </section>

        <section className="glass panel" aria-label="How you are reminded">
          <h2>How you are reminded</h2>
          <div className="stack" style={{ marginTop: 10 }}>
            <label className="check"><input type="checkbox" checked disabled /> In the app, on the bell, {lead} hours before a deadline</label>
            <label className="check"><input type="checkbox" checked={!!me.notifyEmail} onChange={(e) => attempt(() => updateOwnProfile(actor, { notifyEmail: e.target.checked }), e.target.checked ? "You will get reminders by email" : "Email reminders are off")} /> By email to {me.email || "an address you have not added yet"}</label>
            <label className="check"><input type="checkbox" checked={!!me.notifySms} onChange={(e) => attempt(() => updateOwnProfile(actor, { notifySms: e.target.checked }), e.target.checked ? "You will get reminders by text" : "Text reminders are off")} /> By text to {me.phone || "a number you have not added yet"}</label>
            <p className="muted" style={{ fontSize: ".84rem" }}>Change your email or phone number in Settings. The Head of Production sends email and text reminders from the Send to the team tab.</p>
          </div>
        </section>
      </div>
    </>
  );
}

function Send() {
  const { actor, attempt, toast } = useApp();
  const [g] = useGoogle();
  const people = getDb().people.filter((p) => p.status === "active" && (p.category === "CRW" || p.category === "HOP"));
  const rows = people.map((p) => ({ person: redactPerson(actor, p), due: dueSoon(p.personId) })).sort((a, b) => b.due.length - a.due.length || a.person.name.localeCompare(b.person.name));
  const withDue = rows.filter((r) => r.due.length > 0);

  const send = (channel: "email" | "text", personId: string) => {
    const row = rows.find((r) => r.person.personId === personId)!;
    const msg = messageFor(row.person, row.due);
    const ok = attempt(() => logSent(actor, personId, channel, msg.subject, channel === "email" ? msg.email : msg.text, row.due.map((d) => d.key)));
    if (!ok) return;
    openLink(channel === "email" ? mailtoLink(row.person, msg) : smsLink(row.person, msg));
    toast(channel === "email" ? `Email to ${row.person.name} opened in your mail app. Press send there.` : `Text to ${row.person.name} opened in your messages app. Press send there.`, "info");
  };
  const copy = async (personId: string) => {
    const row = rows.find((r) => r.person.personId === personId)!;
    try { await navigator.clipboard.writeText(messageFor(row.person, row.due).email); toast("Message copied", "success"); } catch { toast("Could not copy the message.", "error"); }
  };

  return (
    <>
      <div className="banner"><span className="grow">This opens your own mail or messages app with the message ready to send, and keeps a record here. It does not send anything by itself. If you have linked Google with sending allowed (in Settings), Send with Gmail sends the email straight from your Gmail. Texting, and sending on a schedule, still need a text-message service.</span></div>
      <section className="glass panel" aria-label="Send reminders">
        <h2 style={{ marginBottom: 12 }}>Due within {getDb().settings.stageReminderHours} hours, or late</h2>
        {withDue.length === 0 ? <Empty>Nobody has anything due in that time.</Empty> : (
          <div className="stack" style={{ gap: 22 }}>
            {withDue.map(({ person, due }) => {
              const sent = alreadySent(person.personId, due);
              const last = lastSent(person.personId);
              const hidden = person.email === "Hidden";
              return (
                <div key={person.personId}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                    <b>{person.name}</b>
                    <span className={`badge ${person.notifyEmail ? "ok" : ""}`}>Email {person.notifyEmail ? "on" : "off"}</span>
                    <span className={`badge ${person.notifySms ? "ok" : ""}`}>Text {person.notifySms ? "on" : "off"}</span>
                    {!hidden && <span className="muted" style={{ fontSize: ".84rem" }}>{person.email}, {person.phone}</span>}
                    <span style={{ flex: 1 }} />
                    <button className="btn small" disabled={hidden || !person.email} onClick={() => send("email", person.personId)}>Email</button>
                    <button className="btn small" disabled={hidden || !person.phone} onClick={() => send("text", person.personId)}>Text</button>
                    {isRemote() && g?.gmail && <button className="btn small primary" disabled={hidden || !person.email} onClick={async () => { try { const r = await api.post<{ to: string; items: number }>("/api/google-email", { personId: person.personId }); toast(`Email sent to ${r.to} from your Gmail`, "success"); } catch (e) { toast(e instanceof Error ? e.message : "Could not send it.", "error"); } }}>Send with Gmail</button>}
                    <button className="btn small ghost" onClick={() => copy(person.personId)}>Copy message</button>
                  </div>
                  <div className="list">
                    {due.map((r) => (
                      <div key={r.key} className="list-item" style={{ cursor: "default" }}>
                        <span className={`badge ${r.overdue ? "bad" : ""}`}>{fmtShort(r.date)}{r.time ? ` ${r.time}` : ""}</span>
                        <div className="grow">{r.title}</div>
                        {sent.has(r.key) && <span className="badge ok">Already sent</span>}
                      </div>
                    ))}
                  </div>
                  {last && <p className="muted" style={{ fontSize: ".82rem", marginTop: 4 }}>Last {last.channel === "email" ? "emailed" : "texted"} {fmtDateTime(last.at)} by {nameOf(last.byPersonId)}.</p>}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
