import { createHash } from "node:crypto";
import type { Authed } from "./accounts";
import { decrypt, encrypt, randomToken, sha256 } from "./crypto";
import { HttpError } from "./errors";
import { loadDb, mutateState, withDb } from "./state";
import type { GoogleDoc, Store } from "./stores";
import { dueSoon, logSent, messageFor, remindersFor } from "../src/services/reminders";
import { can } from "../src/services/permissions";

// A person can choose to link a Google account. Nothing in the app needs it. When they do, they also
// choose what it may be used for: putting their reminders in their Google Calendar, and sending
// reminder emails from their Gmail. Tokens are encrypted, and unlinking revokes them at Google.

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const TIME_ZONE = "Africa/Nairobi";

const cfg = () => ({ id: process.env.GOOGLE_CLIENT_ID ?? "", secret: process.env.GOOGLE_CLIENT_SECRET ?? "" });
export const googleAvailable = (): boolean => !!(cfg().id && cfg().secret && process.env.TOKEN_ENCRYPTION_KEY);
const redirectUri = (origin: string): string => `${origin}/api/google-callback`;
const web = (): typeof fetch => globalThis.fetch;

export interface GoogleStatus { available: boolean; linked: boolean; email?: string; calendar?: boolean; gmail?: boolean; linkedAt?: string }

export async function status(store: Store, who: Authed): Promise<GoogleStatus> {
  const d = await store.google.get(who.user._id);
  return { available: googleAvailable(), linked: !!d, email: d?.email, calendar: d?.scopes.includes("calendar"), gmail: d?.scopes.includes("gmail"), linkedAt: d?.linkedAt };
}

/** Returns the address to send the person to, to say yes on Google's own page. */
export async function startLink(store: Store, who: Authed, origin: string, choose: { calendar: boolean; gmail: boolean }): Promise<string> {
  if (!googleAvailable()) throw new HttpError(503, "Google linking is not switched on yet.");
  const verifier = randomToken(32);
  const state = randomToken(24);
  const scopes = [...(choose.calendar ? ["calendar"] : []), ...(choose.gmail ? ["gmail"] : [])];
  await store.oauth.put({ _id: sha256(state), username: who.user._id, verifier, scopes, expiresAt: Date.now() + 10 * 60 * 1000 });
  const q = new URLSearchParams({
    client_id: cfg().id, redirect_uri: redirectUri(origin), response_type: "code", state,
    scope: ["openid", "email", ...(choose.calendar ? [CALENDAR_SCOPE] : []), ...(choose.gmail ? [GMAIL_SCOPE] : [])].join(" "),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    access_type: "offline", prompt: "consent",
  });
  return `${AUTH_URL}?${q.toString()}`;
}

/** Google sends the person back here with a code. It only counts if it is the same person who started. */
export async function finishLink(store: Store, who: Authed, origin: string, code: string, state: string): Promise<GoogleDoc> {
  const pending = await store.oauth.get(sha256(state));
  if (pending) await store.oauth.remove(pending._id); // one use only
  if (!pending || pending.expiresAt < Date.now() || pending.username !== who.user._id) throw new HttpError(400, "That link request has expired. Start again from Settings.");
  const res = await web()(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: cfg().id, client_secret: cfg().secret, redirect_uri: redirectUri(origin), grant_type: "authorization_code", code_verifier: pending.verifier }) });
  const tok = (await res.json()) as { id_token?: string; refresh_token?: string; error?: string };
  if (!res.ok || !tok.id_token) throw new HttpError(400, "Google did not accept that. Try linking again.");
  const claims = JSON.parse(Buffer.from(tok.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as { aud?: string; iss?: string; exp?: number; email?: string; email_verified?: boolean; sub?: string };
  if (claims.aud !== cfg().id || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss ?? "") || (claims.exp ?? 0) * 1000 < Date.now() || !claims.email || !claims.email_verified || !claims.sub) throw new HttpError(400, "Google's answer could not be checked. Try linking again.");
  if (!tok.refresh_token) throw new HttpError(400, "Google did not allow the app to stay linked. Remove the app at myaccount.google.com/permissions and try again.");
  const doc: GoogleDoc = { _id: who.user._id, email: claims.email, sub: claims.sub, scopes: pending.scopes, refresh: encrypt(tok.refresh_token), linkedAt: new Date().toISOString() };
  await store.google.put(doc);
  return doc;
}

export async function unlink(store: Store, who: Authed): Promise<void> {
  const d = await store.google.get(who.user._id);
  if (!d) return;
  try { await web()(`${REVOKE_URL}?token=${encodeURIComponent(decrypt(d.refresh))}`, { method: "POST" }); } catch { /* the link is removed here either way */ }
  await store.google.remove(who.user._id);
}

async function accessToken(store: Store, username: string, need: "calendar" | "gmail"): Promise<string> {
  const d = await store.google.get(username);
  if (!d) throw new HttpError(409, "Link your Google account first, in Settings.");
  if (!d.scopes.includes(need)) throw new HttpError(409, need === "calendar" ? "You did not allow Google Calendar. Link again and tick it." : "You did not allow sending email. Link again and tick it.");
  const res = await web()(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cfg().id, client_secret: cfg().secret, refresh_token: decrypt(d.refresh), grant_type: "refresh_token" }) });
  const tok = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !tok.access_token) {
    if (tok.error === "invalid_grant") { await store.google.remove(username); throw new HttpError(409, "Google says the link has ended. Link your account again."); }
    throw new HttpError(502, "Google could not be reached. Try again in a minute.");
  }
  return tok.access_token;
}

const addDay = (iso: string): string => new Date(Date.parse(`${iso}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);

/** Puts the person's coming reminders in their own Google Calendar. Adding twice does nothing extra. */
export async function addToCalendar(store: Store, who: Authed): Promise<{ added: number; already: number; failed: number }> {
  const token = await accessToken(store, who.user._id, "calendar");
  const loaded = await loadDb(store, ["records", "callSheets", "manifests", "settings", "people", "counters", "members"]);
  if (!loaded) throw new HttpError(503, "Not set up.");
  const { rems, lead } = withDb(loaded.db, () => ({ rems: remindersFor(who.person.personId), lead: loaded.db.settings.stageReminderHours }));
  const out = { added: 0, already: 0, failed: 0 };
  for (const r of rems) {
    const start = r.time ? { dateTime: `${r.date}T${r.time}:00`, timeZone: TIME_ZONE } : { date: r.date };
    const end = r.time ? { dateTime: `${r.date}T${String(Math.min(23, Number(r.time.slice(0, 2)) + 8)).padStart(2, "0")}:${r.time.slice(3)}:00`, timeZone: TIME_ZONE } : { date: addDay(r.date) };
    const res = await web()("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: createHash("sha1").update(r.key).digest("hex"), summary: r.title, description: `${r.detail}\n\nFrom the Dawn of Faith Production Hub.`, start, end, reminders: { useDefault: false, overrides: [{ method: "popup", minutes: Math.min(40320, lead * 60) }] } }),
    });
    if (res.ok) out.added++; else if (res.status === 409) out.already++; else out.failed++;
  }
  return out;
}

const encodeWord = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** Sends a reminder email from the signed-in person's own Gmail to the person it is for. */
export async function sendReminderEmail(store: Store, who: Authed, personId: string): Promise<{ to: string; items: number }> {
  const loaded = await loadDb(store);
  if (!loaded) throw new HttpError(503, "Not set up.");
  const mayOthers = withDb(loaded.db, () => can(who.actor, "reminders.sendOthers"));
  if (personId !== who.person.personId && !mayOthers) throw new HttpError(403, "Only the Head of Production, or someone given \"Send reminders to other people\", can email other people.");
  const target = loaded.db.people.find((p) => p.personId === personId);
  if (!target || target.status !== "active") throw new HttpError(404, "Choose an active person.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target.email)) throw new HttpError(400, `${target.name} has no email address on file.`);
  const rems = withDb(loaded.db, () => dueSoon(personId));
  if (!rems.length) throw new HttpError(400, `Nothing is due for ${target.name} in the next ${loaded.db.settings.stageReminderHours} hours.`);
  const msg = messageFor(target, rems);
  const token = await accessToken(store, who.user._id, "gmail");
  const raw = [`To: ${target.email}`, `Subject: ${encodeWord(msg.subject)}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(msg.email, "utf8").toString("base64")].join("\r\n");
  const res = await web()("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url") }) });
  if (!res.ok) throw new HttpError(502, "Google did not send the email. Try again in a minute.");
  await mutateState(store, () => logSent(who.actor, personId, "email", msg.subject, msg.email, rems.map((r) => r.key)));
  return { to: target.email, items: rems.length };
}
