import { createHash } from "node:crypto";
import type { Authed } from "./accounts";
import { decrypt, encrypt, randomToken, sha256 } from "./crypto";
import { HttpError } from "./errors";
import { loadDb, mutateState, withDb } from "./state";
import type { GoogleDoc, Store } from "./stores";
import { dueSoon, logSent, messageFor, remindersFor } from "../src/services/reminders";
import { can } from "../src/services/permissions";
import { instancesBetween } from "../src/services/productionInstances";

// A person can choose to link a Google account. Nothing in the app needs it. When they do, they also
// choose what it may be used for: putting their dates in a Google Calendar of their own, and sending
// reminder emails from their Gmail. Tokens are encrypted, and unlinking revokes them at Google.
//
// The calendar (build prompt v4, section 12) is a dedicated "DOF Production Hub" calendar that the app makes on the
// first sync, with the narrow calendar.app.created scope: the app can see and change only what it made, never the
// rest of the person's calendar. It is one way, from the hub to Google; updates and cancellations follow; nothing is
// ever read back into the pipeline. A link made before this (the calendar.events scope, on the main calendar) is
// linked again once.

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const CALENDAR_NAME = "DOF Production Hub";
/** 2: the dedicated calendar. 1 (or none): the person's main calendar, before data version 24. */
const CALENDAR_VERSION = 2;
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const DEFAULT_TIME_ZONE = "Africa/Nairobi";

const cfg = () => ({ id: process.env.GOOGLE_CLIENT_ID ?? "", secret: process.env.GOOGLE_CLIENT_SECRET ?? "" });
export const googleAvailable = (): boolean => !!(cfg().id && cfg().secret && process.env.TOKEN_ENCRYPTION_KEY);
const redirectUri = (origin: string): string => `${origin}/api/google-callback`;
const web = (): typeof fetch => globalThis.fetch;

export interface GoogleStatus {
  available: boolean;
  linked: boolean;
  email?: string;
  calendar?: boolean;
  gmail?: boolean;
  linkedAt?: string;
  relink?: boolean; // linked to the main calendar before the dedicated one: link again once
  calendarName?: string;
}

const needsRelink = (d: GoogleDoc): boolean => d.scopes.includes("calendar") && (d.calendarVersion ?? 1) < CALENDAR_VERSION;

export async function status(store: Store, who: Authed): Promise<GoogleStatus> {
  const d = await store.google.get(who.user._id);
  return {
    available: googleAvailable(),
    linked: !!d,
    email: d?.email,
    calendar: d?.scopes.includes("calendar"),
    gmail: d?.scopes.includes("gmail"),
    linkedAt: d?.linkedAt,
    ...(d && needsRelink(d) ? { relink: true } : {}),
    ...(d?.scopes.includes("calendar") ? { calendarName: CALENDAR_NAME } : {}),
  };
}

/** Returns the address to send the person to, to say yes on Google's own page. */
export async function startLink(store: Store, who: Authed, origin: string, choose: { calendar: boolean; gmail: boolean }): Promise<string> {
  if (!googleAvailable()) throw new HttpError(503, "Google linking is not switched on yet.");
  const verifier = randomToken(32);
  const state = randomToken(24);
  const scopes = [...(choose.calendar ? ["calendar"] : []), ...(choose.gmail ? ["gmail"] : [])];
  await store.oauth.put({ _id: sha256(state), username: who.user._id, verifier, scopes, expiresAt: Date.now() + 10 * 60 * 1000 });
  const q = new URLSearchParams({
    client_id: cfg().id,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    state,
    scope: ["openid", "email", ...(choose.calendar ? [CALENDAR_SCOPE] : []), ...(choose.gmail ? [GMAIL_SCOPE] : [])].join(" "),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${q.toString()}`;
}

/** Google sends the person back here with a code. It only counts if it is the same person who started. */
export async function finishLink(store: Store, who: Authed, origin: string, code: string, state: string): Promise<GoogleDoc> {
  const pending = await store.oauth.get(sha256(state));
  if (pending) await store.oauth.remove(pending._id); // one use only
  if (!pending || pending.expiresAt < Date.now() || pending.username !== who.user._id)
    throw new HttpError(400, "That link request has expired. Start again from Settings.");
  const res = await web()(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg().id,
      client_secret: cfg().secret,
      redirect_uri: redirectUri(origin),
      grant_type: "authorization_code",
      code_verifier: pending.verifier,
    }),
  });
  const tok = (await res.json()) as { id_token?: string; refresh_token?: string; error?: string };
  if (!res.ok || !tok.id_token) throw new HttpError(400, "Google did not accept that. Try linking again.");
  const claims = JSON.parse(Buffer.from(tok.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
    aud?: string;
    iss?: string;
    exp?: number;
    email?: string;
    email_verified?: boolean;
    sub?: string;
  };
  if (
    claims.aud !== cfg().id ||
    !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss ?? "") ||
    (claims.exp ?? 0) * 1000 < Date.now() ||
    !claims.email ||
    !claims.email_verified ||
    !claims.sub
  )
    throw new HttpError(400, "Google's answer could not be checked. Try linking again.");
  if (!tok.refresh_token)
    throw new HttpError(
      400,
      "Google did not allow the app to stay linked. Remove the app at myaccount.google.com/permissions and try again.",
    );
  const doc: GoogleDoc = {
    _id: who.user._id,
    email: claims.email,
    sub: claims.sub,
    scopes: pending.scopes,
    refresh: encrypt(tok.refresh_token),
    linkedAt: new Date().toISOString(),
    ...(pending.scopes.includes("calendar") ? { calendarVersion: CALENDAR_VERSION, calendarId: null, synced: [] } : {}),
  };
  await store.google.put(doc);
  return doc;
}

export async function unlink(store: Store, who: Authed): Promise<void> {
  const d = await store.google.get(who.user._id);
  if (!d) return;
  try {
    await web()(`${REVOKE_URL}?token=${encodeURIComponent(decrypt(d.refresh))}`, { method: "POST" });
  } catch {
    /* the link is removed here either way */
  }
  await store.google.remove(who.user._id);
}

async function accessToken(store: Store, username: string, need: "calendar" | "gmail"): Promise<string> {
  const d = await store.google.get(username);
  if (!d) throw new HttpError(409, "Link your Google account first, in Settings.");
  if (!d.scopes.includes(need))
    throw new HttpError(
      409,
      need === "calendar"
        ? "You did not allow Google Calendar. Link again and tick it."
        : "You did not allow sending email. Link again and tick it.",
    );
  const res = await web()(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg().id,
      client_secret: cfg().secret,
      refresh_token: decrypt(d.refresh),
      grant_type: "refresh_token",
    }),
  });
  const tok = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !tok.access_token) {
    if (tok.error === "invalid_grant") {
      await store.google.remove(username);
      throw new HttpError(409, "Google says the link has ended. Link your account again.");
    }
    throw new HttpError(502, "Google could not be reached. Try again in a minute.");
  }
  return tok.access_token;
}

const addDay = (iso: string): string => new Date(Date.parse(`${iso}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);

interface CalendarItem {
  key: string; // stable: the same item always has the same Google event
  title: string;
  detail: string;
  date: string;
  time: string;
  end: string; // HH:MM, or empty
  popupMinutes: number;
}

/**
 * Puts the person's dates in their own "DOF Production Hub" calendar at Google: their coming reminders and due dates,
 * the recording sessions and show days they are on the call sheet of (the next 60 days), and, for those who use the
 * equipment, loans due back. One way, from the hub to Google. Each item is always the same event, so syncing again
 * updates it (a session moved to another day moves in Google too) and never adds it twice; an item that is gone
 * (cancelled, or no longer theirs) is taken off. A date with no time is an all-day event. Opt-in: only for someone who
 * linked Google and allowed the calendar.
 */
export async function addToCalendar(
  store: Store,
  who: Authed,
): Promise<{ added: number; already: number; failed: number; removed: number; calendar: string }> {
  const doc = await store.google.get(who.user._id);
  if (doc && needsRelink(doc))
    throw new HttpError(
      409,
      `Your Google link is from before the app had its own calendar. Unlink, then link again once: your dates then go into a calendar of their own, "${CALENDAR_NAME}", and the app no longer touches the rest of your calendar.`,
    );
  const token = await accessToken(store, who.user._id, "calendar");
  const loaded = await loadDb(store, [
    "records",
    "callSheets",
    "manifests",
    "settings",
    "people",
    "counters",
    "members",
    "recordingSessions",
    "loans",
  ]);
  if (!loaded) throw new HttpError(503, "Not set up.");
  const zone = loaded.db.settings.timeZone || DEFAULT_TIME_ZONE;
  const items = withDb(loaded.db, (): CalendarItem[] => {
    const lead = loaded.db.settings.stageReminderHours;
    const out: CalendarItem[] = remindersFor(who.person.personId).map((r) => ({
      key: r.key,
      title: r.title,
      detail: r.detail,
      date: r.date,
      time: r.time ?? "",
      end: "",
      popupMinutes: Math.min(40320, lead * 60),
    }));
    const today = new Date().toISOString().slice(0, 10);
    const until = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    for (const i of instancesBetween(who.actor, today, until)) {
      const cs = i.callSheetId ? loaded.db.callSheets.find((c) => c.id === i.callSheetId) : undefined;
      if (!i.date || i.status === "cancelled" || !cs?.crewPersonIds.includes(who.person.personId)) continue;
      out.push({
        key: `instance:${i.id}`,
        title: `${i.projectTitle}: ${i.label}`,
        detail: [cs.callTime && `Crew call ${cs.callTime}`, i.location || cs.location, cs.crewRoles[who.person.personId]]
          .filter(Boolean)
          .join(". "),
        date: i.date,
        time: cs.callTime || i.start,
        end: i.end,
        popupMinutes: 1440,
      });
    }
    if (can(who.actor, "equipment.use"))
      for (const l of loaded.db.loans ?? []) {
        if (l.status !== "out" || l.expectedReturn < today) continue;
        out.push({
          key: `loan:${l.id}`,
          title: `Loan back: ${l.borrowerName}`,
          detail: `Loan ${l.id}${l.organisation ? `, ${l.organisation}` : ""}.`,
          date: l.expectedReturn,
          time: "",
          end: "",
          popupMinutes: 1440,
        });
      }
    return out;
  });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const linked = (await store.google.get(who.user._id))!;
  // The dedicated calendar: made on the first sync, and made again if the person deleted it at Google.
  const makeCalendar = async (): Promise<string> => {
    const res = await web()(`${CALENDAR_API}/calendars`, {
      method: "POST",
      headers,
      body: JSON.stringify({ summary: CALENDAR_NAME, description: "Dates from the Dawn of Faith Production Hub.", timeZone: zone }),
    });
    const made = (await res.json().catch(() => ({}))) as { id?: string };
    if (!res.ok || !made.id) throw new HttpError(502, "Google could not make the calendar. Try again in a minute.");
    linked.calendarId = made.id;
    linked.synced = [];
    await store.google.put(linked);
    return made.id;
  };
  let calendarId = linked.calendarId || (await makeCalendar());
  const eventsUrl = () => `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
  const out = { added: 0, already: 0, failed: 0, removed: 0, calendar: CALENDAR_NAME };
  const ids: string[] = [];
  for (const r of items) {
    const start = r.time ? { dateTime: `${r.date}T${r.time}:00`, timeZone: zone } : { date: r.date };
    const endTime =
      r.end && r.time && r.end > r.time
        ? r.end
        : r.time
          ? `${String(Math.min(23, Number(r.time.slice(0, 2)) + 8)).padStart(2, "0")}:${r.time.slice(3)}`
          : "";
    const end = r.time ? { dateTime: `${r.date}T${endTime}:00`, timeZone: zone } : { date: addDay(r.date) };
    const id = createHash("sha1").update(r.key).digest("hex");
    ids.push(id);
    const body = JSON.stringify({
      id,
      summary: r.title,
      description: `${r.detail}\n\nFrom the Dawn of Faith Production Hub.`,
      start,
      end,
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: r.popupMinutes }] },
    });
    // Update it where it is; if Google does not have it yet, add it. A calendar that is gone is made again.
    const put = await web()(`${eventsUrl()}/${id}`, { method: "PUT", headers, body });
    if (put.ok) {
      out.already++;
      continue;
    }
    let res = await web()(eventsUrl(), { method: "POST", headers, body });
    if (res.status === 404) {
      calendarId = await makeCalendar();
      res = await web()(eventsUrl(), { method: "POST", headers, body });
    }
    if (res.ok) out.added++;
    else if (res.status === 409) out.already++;
    else out.failed++;
  }
  // Cancellations: what was put there before and is no longer an item comes off.
  for (const gone of (linked.synced ?? []).filter((x) => !ids.includes(x))) {
    const res = await web()(`${eventsUrl()}/${gone}`, { method: "DELETE", headers });
    if (res.ok || res.status === 404 || res.status === 410) out.removed++;
    else ids.push(gone); // tried again next time
  }
  linked.synced = ids;
  await store.google.put(linked);
  return out;
}

const encodeWord = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** Sends a reminder email from the signed-in person's own Gmail to the person it is for. */
export async function sendReminderEmail(store: Store, who: Authed, personId: string): Promise<{ to: string; items: number }> {
  const loaded = await loadDb(store);
  if (!loaded) throw new HttpError(503, "Not set up.");
  const mayOthers = withDb(loaded.db, () => can(who.actor, "reminders.sendOthers"));
  if (personId !== who.person.personId && !mayOthers)
    throw new HttpError(403, 'Only the Head of Production, or someone given "Send reminders to other people", can email other people.');
  const target = loaded.db.people.find((p) => p.personId === personId);
  if (!target || target.status !== "active") throw new HttpError(404, "Choose an active person.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target.email)) throw new HttpError(400, `${target.name} has no email address on file.`);
  const rems = withDb(loaded.db, () => dueSoon(personId));
  if (!rems.length)
    throw new HttpError(400, `Nothing is due for ${target.name} in the next ${loaded.db.settings.stageReminderHours} hours.`);
  const msg = messageFor(target, rems);
  const token = await accessToken(store, who.user._id, "gmail");
  const raw = [
    `To: ${target.email}`,
    `Subject: ${encodeWord(msg.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(msg.email, "utf8").toString("base64"),
  ].join("\r\n");
  const res = await web()("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url") }),
  });
  if (!res.ok) throw new HttpError(502, "Google did not send the email. Try again in a minute.");
  await mutateState(store, () =>
    logSent(
      who.actor,
      personId,
      "email",
      msg.subject,
      msg.email,
      rems.map((r) => r.key),
    ),
  );
  return { to: target.email, items: rems.length };
}
