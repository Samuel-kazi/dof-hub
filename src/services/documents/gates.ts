import type { Actor, DevelopmentForm, GateOverride } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { fmtDate } from "../utils";
import { catalogTypeOf } from "../../config/documentCatalog";
import { logAudit } from "../audit";
import { textOf } from "../html";
import { canDecide, formOf, nowStamp, type Project } from "../workflow/common";
import { pagesOf, projectForWrite, projectOf } from "./common";
import { documentOf } from "./pages";
import { reviewIsGate, theologyStatus } from "./theology";
import { formProblems } from "../workflow/forms";

// The short list of what must be true before a project leaves Development (the documents rework). Everything else is
// a nudge that never blocks (./nudges.ts).
//
//   Series and documentary   1. the logline and the core question written in the brief
//                            2. the theological review of the brief approved (only while the review is a gate)
//                            3. the greenlight decision recorded as Greenlight, and a show producer named
//   Live show                1. a show date set (a day on its Show Days)
//                            2. a show producer named
//                            (its Greenlight stays a document, and its theological review is a reminder: v4, section 9)
//   Devotion                 1. the guest's name and contact filled in
//                            2. at least five devotion pages, each with its topic (the title), scripture and script
//                            3. the theological review of the script approved (only while the review is a gate)
//
// With "Theological review as a reminder, not a gate" switched on (build prompt v2), the review is not a gate: see
// ./theology.ts for the banner and the question asked before going ahead.
//
// The Head of Production, or someone given "Create projects", can pass a gate by hand with a short note: kept with the
// project and in the activity log. The greenlight decision itself is never passed by hand: recording it is the way.

export type HardGateKey = "idea" | "review" | "greenlight" | "guest" | "pages" | "consent" | "date" | "producer";

export interface HardGate {
  key: HardGateKey;
  label: string;
  met: boolean;
  detail: string; // what is missing, or what was found
  overridable: boolean;
  override: GateOverride | null;
}

/** The number of devotion pages a devotion needs before it can be accepted. */
export const DEVOTION_PAGES_NEEDED = 5;
const NOTE_MAX = 300;

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const latestFirstDecision = (form: DevelopmentForm) => [...form.decisions].reverse().find((d) => d.stage === 1);

function reviewGate(projectId: string, what: string): Omit<HardGate, "override"> {
  const t = theologyStatus(projectId, false);
  return { key: "review", label: `Theological review of the ${what} approved`, met: t.done, detail: t.detail, overridable: true };
}

/** A devotion page that counts: a title, the scripture (its subtitle) and the script. */
export const devotionPageReady = (p: { title: string; subtitle: string; bodyHtml: string }): boolean =>
  p.title.trim() !== "" && p.subtitle.trim() !== "" && textOf(p.bodyHtml) !== "";

/** The hard gates of a project's Development, each met or not, with any passed by hand. */
export function hardGates(projectId: string): HardGate[] {
  const p = projectOf(projectId);
  const form = formOf(projectId);
  const overrides = form.overrides ?? [];
  const withOverride = (g: Omit<HardGate, "override">): HardGate => ({
    ...g,
    override: g.overridable && !g.met ? (overrides.find((o) => o.key === g.key) ?? null) : null,
  });
  if (catalogTypeOf(p.workflow.formType) === "devotion") {
    const guest = form.sections.guest ?? {};
    const lacking = [!text(guest.name) && "name", !text(guest.contact) && "contact"].filter(Boolean);
    const script = documentOf(projectId, "Development", "devotional_script");
    const ready = script ? pagesOf(script.id).filter(devotionPageReady).length : 0;
    return [
      withOverride({
        key: "guest",
        label: "The guest's name and contact filled in",
        met: lacking.length === 0,
        detail: lacking.length ? `The guest's ${lacking.join(" and ")} ${lacking.length === 2 ? "are" : "is"} missing` : String(guest.name),
        overridable: true,
      }),
      withOverride({
        key: "pages",
        label: `At least ${DEVOTION_PAGES_NEEDED} devotion pages, each with its topic, scripture and script`,
        met: ready >= DEVOTION_PAGES_NEEDED,
        detail: `${ready} of ${DEVOTION_PAGES_NEEDED} ready`,
        overridable: true,
      }),
      // With the review a reminder rather than a gate, it is not on this list (./theology.ts).
      ...(reviewIsGate() ? [withOverride(reviewGate(projectId, "script"))] : []),
    ];
  }
  const kind = catalogTypeOf(p.workflow.formType);
  if (kind === "live") {
    const dates = getDb()
      .recordingSessions.filter((x) => x.contentId === projectId && !x.archivedAt && x.scheduledDate)
      .map((x) => x.scheduledDate!)
      .sort();
    const producer = getDb().people.find((x) => x.personId === p.workflow.showProducerId);
    return [
      withOverride({
        key: "date",
        label: "Show date set",
        met: dates.length > 0,
        detail: dates.length
          ? `First show ${fmtDate(dates[0])}${dates.length > 1 ? `, ${dates.length} days` : ""}`
          : "No show date yet: set it in Show Days",
        overridable: false,
      }),
      withOverride({
        key: "producer",
        label: "Show producer named",
        met: !!producer,
        detail: producer ? producer.name : "No show producer named yet",
        overridable: false,
      }),
    ];
  }
  const brief = form.sections.brief ?? {};
  // The brief's second line in each kind's own words: a song's core message.
  const second = kind === "music" ? "core message" : "core question";
  const missingIdea = [!text(brief.logline) && "the logline", !text(brief.coreQuestion) && `the ${second}`].filter(Boolean);
  const decision = latestFirstDecision(form);
  const greenlit = decision?.outcome === "Greenlight";
  const producer = !!p.workflow.showProducerId;
  const first = form.greenlightStage ? "First greenlight" : "Greenlight";
  return [
    withOverride({
      key: "idea",
      label: `The logline and the ${second} written in the brief`,
      met: missingIdea.length === 0,
      detail: missingIdea.length ? `Write ${missingIdea.join(" and ")} at the top of The idea` : "Both written",
      overridable: true,
    }),
    ...(reviewIsGate() ? [withOverride(reviewGate(projectId, "brief"))] : []),
    // A testimonial records someone telling their own story: it is not greenlit without their consent and release.
    ...(p.workflow.formType === "testimonial" ? [withOverride(consentGate(projectId))] : []),
    withOverride({
      key: "greenlight",
      label: `${first} decision recorded as Greenlight, and a show producer named`,
      met: greenlit && producer,
      detail:
        [greenlit ? "" : decision ? `The decision is ${decision.outcome}` : "No decision yet", producer ? "" : "No show producer named yet"]
          .filter(Boolean)
          .join("; ") || "Greenlit, with a show producer",
      overridable: false,
    }),
  ];
}

/** A testimonial's Consent and Release form: complete, with the person's agreement. It cannot be passed by hand. */
function consentGate(projectId: string): Omit<HardGate, "override"> {
  const lacking = formProblems(projectId, 1)
    .filter((m) => m.startsWith("Consent and release: "))
    .map((m) => m.slice("Consent and release: ".length));
  return {
    key: "consent",
    label: "Consent and release complete, with the person's agreement",
    met: lacking.length === 0,
    detail: lacking.length ? lacking.join("; ") : "Complete",
    overridable: false,
  };
}

/** True when every hard gate is met or passed by hand. `except` leaves some out (the decision, before it is made). */
export const hardGatesPass = (projectId: string, except: HardGateKey[] = []): boolean =>
  hardGates(projectId).every((g) => except.includes(g.key) || g.met || g.override);

/** What is still needed, in words: the unmet hard gates not passed by hand. */
export const hardGatesMissing = (projectId: string, except: HardGateKey[] = []): string[] =>
  hardGates(projectId)
    .filter((g) => !except.includes(g.key) && !g.met && !g.override)
    .map((g) => `${g.label} (${g.detail})`);

/**
 * Passes a hard gate by hand, with a short note of why; or, with no note, takes that back. The Head of Production, or
 * someone given "Create projects", during Development. The greenlight decision cannot be passed by hand.
 */
export function setGateOverride(actor: Actor, projectId: string, key: HardGateKey, note: string | null): Project {
  const p = projectForWrite(actor, projectId);
  if (!canDecide(actor)) throw new RuleError('Only the Head of Production, or someone given "Create projects", can pass a gate by hand.');
  if (p.workflow.stage !== "Development") throw new RuleError("The project has already left Development.");
  const gate = hardGates(projectId).find((g) => g.key === key);
  if (!gate) throw new RuleError("That is not one of this project's gates.");
  if (!gate.overridable)
    throw new RuleError(
      gate.key === "consent"
        ? "Consent and release is given by the person, not passed by hand."
        : "The greenlight decision is recorded, not passed by hand.",
    );
  const form = formOf(projectId);
  const rest = (form.overrides ?? []).filter((o) => o.key !== key);
  if (note === null) {
    form.overrides = rest;
    logAudit(actor, "gate-override", "record", projectId, `Taken back: ${gate.label}`);
  } else {
    const why = note.trim().slice(0, NOTE_MAX);
    if (!why) throw new RuleError("Write a short note of why this gate is passed by hand. It is kept with the project.");
    if (gate.met) throw new RuleError("This gate is already met.");
    form.overrides = [...rest, { key, note: why, byPersonId: actor.personId, at: nowStamp() }];
    logAudit(actor, "gate-override", "record", projectId, `Passed by hand: ${gate.label}. ${why}`);
  }
  form.updatedAt = nowStamp();
  commit();
  return p;
}
