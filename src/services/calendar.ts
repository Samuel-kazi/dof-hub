import type { CategoryKey, Person } from "../types";
import type { Reminder } from "./reminders";
import { categoryOf } from "../config/categories";
import { dayNumber, fromDayNumber } from "./utils";

// A calendar file (.ics) opens in Google Calendar, Apple Calendar and Outlook. Each event carries an
// alert, so the person is reminded by their own calendar app, on their phone as well as their computer.

// The calendar page's own colour + sub-type marks (filled bar / outline / dot / hatched) don't have an
// equivalent in the .ics standard or Google's "create event" link: neither accepts an arbitrary hex
// colour, and Google's public link is limited to its 11 fixed event colours. This is the closest honest
// match for each category, plus a glyph in the title so the distinction still reads at a glance.
const GLYPH: Record<Reminder["kind"], string> = { stage: "▢", task: "▢", shoot: "●", gear: "▤" };
// Google Calendar's fixed colorId palette (1 Lavender .. 11 Tomato), picked for the closest hue to
// each category's colour.
const GOOGLE_COLOR_ID: Record<CategoryKey, string> = { series: "6", devotional: "2", live: "5", documentary: "1", music: "4" };

const compact = (iso: string): string => iso.replace(/-/g, "");
const escapeText = (s: string): string => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines longer than 75 bytes are folded onto the next line, as the standard asks. */
export function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length;
    if (curBytes + b > (out.length === 0 ? 75 : 74)) { out.push(cur); cur = ""; curBytes = 0; }
    cur += ch; curBytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const stampNow = (now: Date): string => `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}T${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}${String(now.getUTCSeconds()).padStart(2, "0")}Z`;

export function icsFor(person: Person, rems: Reminder[], leadHours: number, now: Date = new Date()): string {
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Dawn of Faith//Production Hub//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${escapeText(`Dawn of Faith: ${person.name}`)}`];
  for (const r of rems) {
    const title = `${GLYPH[r.kind]} ${r.title}`;
    lines.push("BEGIN:VEVENT", `UID:${r.key.replace(/[^A-Za-z0-9:_-]/g, "-")}@dawnoffaith.hub`, `DTSTAMP:${stampNow(now)}`);
    if (r.time) lines.push(`DTSTART:${compact(r.date)}T${r.time.replace(":", "")}00`, "DURATION:PT8H");
    else lines.push(`DTSTART;VALUE=DATE:${compact(r.date)}`, `DTEND;VALUE=DATE:${compact(fromDayNumber(dayNumber(r.date) + 1))}`);
    // CATEGORIES carries the category through for calendar apps that colour or group by it; the glyph
    // in the title is the part every calendar app will actually show.
    lines.push(`SUMMARY:${escapeText(title)}`, `DESCRIPTION:${escapeText(r.detail)}`, `CATEGORIES:${escapeText(categoryOf(r.category).label)}`, "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(r.title)}`, `TRIGGER:-PT${Math.max(1, Math.round(leadHours))}H`, "END:VALARM", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** A link that opens Google Calendar with this reminder filled in, ready to save. */
export function googleCalendarLink(r: Reminder): string {
  const start = compact(r.date);
  const dates = r.time ? `${start}T${r.time.replace(":", "")}00/${start}T${String(Math.min(23, Number(r.time.slice(0, 2)) + 8)).padStart(2, "0")}${r.time.slice(3)}00` : `${start}/${compact(fromDayNumber(dayNumber(r.date) + 1))}`;
  const q = new URLSearchParams({ action: "TEMPLATE", text: `${GLYPH[r.kind]} ${r.title}`, dates, details: `${r.detail}\n\nFrom the Dawn of Faith Production Hub.`, colorId: GOOGLE_COLOR_ID[r.category] });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}
