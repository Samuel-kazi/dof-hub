// Run with: npm test -- recurrence
// The dates a recurring show's schedule gives: weekly on chosen days, every N weeks, monthly by date or by "the
// first Friday", ending on a date or after a number of times, with dates left out and added.
import assert from "node:assert/strict";
import type { RecurrenceRule } from "../src/types";
import { RuleError } from "../src/types";
import { checkRule, describeRule, occurrences, occurrencesBetween, weekdayOf, weeklyFrom } from "../src/services/recurrence";

let passed = 0;
const t = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log("ok  ", name);
  } catch (e) {
    console.error("FAIL", name, "\n    ", (e as Error).stack?.split("\n").slice(0, 4).join("\n     "));
    process.exitCode = 1;
  }
};
const rule = (over: Partial<RecurrenceRule>): RecurrenceRule => ({ ...weeklyFrom("2026-10-02"), ...over });
const throwsRule = (fn: () => unknown, match: RegExp) =>
  assert.throws(fn, (e) => (e instanceof RuleError && match.test(e.message)) || assert.fail((e as Error).message));

t("weekly: every Friday from the start date", () => {
  assert.equal(weekdayOf("2026-10-02"), 5, "2 October 2026 is a Friday");
  assert.deepEqual(occurrences(rule({}), "2026-10-31"), ["2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23", "2026-10-30"]);
});

t("weekly on two days, and every second week, keeping its rhythm from the start", () => {
  assert.deepEqual(occurrences(rule({ weekdays: [5, 6] }), "2026-10-11"), ["2026-10-02", "2026-10-03", "2026-10-09", "2026-10-10"]);
  // Starting on a Wednesday: that week's Friday counts, the Monday before the start does not.
  assert.deepEqual(occurrences(rule({ startDate: "2026-09-30", weekdays: [1, 5] }), "2026-10-06"), ["2026-10-02", "2026-10-05"]);
  assert.deepEqual(occurrences(rule({ interval: 2 }), "2026-11-15"), ["2026-10-02", "2026-10-16", "2026-10-30", "2026-11-13"]);
});

t("it ends on a date, or after a number of times", () => {
  assert.deepEqual(occurrences(rule({ until: "2026-10-16" }), "2027-01-01"), ["2026-10-02", "2026-10-09", "2026-10-16"]);
  assert.deepEqual(occurrences(rule({ count: 2 }), "2027-01-01"), ["2026-10-02", "2026-10-09"]);
  assert.deepEqual(occurrences(rule({ count: 3, weekdays: [5, 6] }), "2027-01-01"), ["2026-10-02", "2026-10-03", "2026-10-09"]);
});

t("dates left out are taken away (and still count), dates added are put in", () => {
  const r = rule({ count: 3, skipDates: ["2026-10-09"], extraDates: ["2026-10-14"] });
  assert.deepEqual(occurrences(r, "2027-01-01"), ["2026-10-02", "2026-10-14", "2026-10-16"]);
  assert.deepEqual(occurrencesBetween(r, "2026-10-10", "2026-12-31"), ["2026-10-14", "2026-10-16"]);
});

t("monthly by date, a short month using its last day", () => {
  const r = rule({ freq: "monthly", weekdays: [], monthDay: 31, startDate: "2027-01-31" });
  assert.deepEqual(occurrences(r, "2027-04-30"), ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
  const every3 = rule({ freq: "monthly", weekdays: [], monthDay: 15, interval: 3, startDate: "2026-10-20" });
  assert.deepEqual(occurrences(every3, "2027-08-01"), ["2027-01-15", "2027-04-15", "2027-07-15"], "the start month's 15th has passed");
});

t("monthly by the first, second, fourth or last day of the week", () => {
  const first = rule({ freq: "monthly", weekdays: [], nth: { week: 1, weekday: 5 }, startDate: "2026-10-01" });
  assert.deepEqual(occurrences(first, "2026-12-31"), ["2026-10-02", "2026-11-06", "2026-12-04"]);
  const last = rule({ freq: "monthly", weekdays: [], nth: { week: -1, weekday: 0 }, startDate: "2026-10-01" });
  assert.deepEqual(occurrences(last, "2026-12-31"), ["2026-10-25", "2026-11-29", "2026-12-27"]);
  const fourth = rule({ freq: "monthly", weekdays: [], nth: { week: 4, weekday: 6 }, startDate: "2026-10-01" });
  assert.deepEqual(occurrences(fourth, "2026-11-30"), ["2026-10-24", "2026-11-28"]);
});

t("a rule that cannot work is refused, in words a person can act on", () => {
  throwsRule(() => checkRule(rule({ weekdays: [] })), /day of the week/);
  throwsRule(() => checkRule(rule({ interval: 0 })), /every 1 to 12 weeks/);
  throwsRule(() => checkRule(rule({ until: "2026-09-01" })), /cannot end before it starts/);
  throwsRule(() => checkRule(rule({ until: "2026-12-01", count: 3 })), /not both/);
  throwsRule(() => checkRule(rule({ freq: "monthly", monthDay: 5, nth: { week: 1, weekday: 5 } })), /either a day of the month/);
  throwsRule(() => checkRule(rule({ startDate: "2026-02-30" })), /date the show starts/);
});

t("the rule in a sentence", () => {
  assert.equal(describeRule(rule({})), "Every Friday, from 2026-10-02");
  assert.equal(
    describeRule(rule({ weekdays: [5, 6], interval: 2, count: 6 })),
    "Every 2 weeks on Friday and Saturday, from 2026-10-02, 6 times",
  );
  assert.equal(
    describeRule(rule({ freq: "monthly", weekdays: [], nth: { week: -1, weekday: 0 }, until: "2027-06-01", skipDates: ["2026-12-27"] })),
    "On the last Sunday of every month, from 2026-10-02, until 2027-06-01 (1 date left out)",
  );
});

console.log(`\n${passed} passed`);
