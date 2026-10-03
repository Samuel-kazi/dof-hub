import type { Actor, DevelopmentForm, GateOverride } from "../../types";
import { RuleError } from "../../types";
import { commit } from "../../data/store";
import { briefKeyOf, catalogTypeOf } from "../../config/documentCatalog";
import { logAudit } from "../audit";
import { textOf } from "../html";
import { canDecide, checkpoint, formOf, nowStamp, type Project } from "../workflow/common";
import { pagesOf, projectForWrite, projectOf } from "./common";
import { documentOf } from "./pages";
import { reviewsOf, reviewStateOf } from "./reviews";

// The short list of what must be true before a project leaves Development, once its documents are in use (the
// documents rework). Everything else is a nudge that never blocks (./nudges.ts).
//
//   Series and documentary   1. the logline and the core question written in the brief
//                            2. the theological review of the brief approved
//                            3. the greenlight decision recorded as Greenlight, and a show producer named
//   Devotion                 1. the guest's name and contact filled in
//                            2. at least five devotion pages, each with its topic (the title), scripture and script
//                            3. the theological review of the script approved
//
// The Head of Production, or someone given "Create projects", can pass a gate by hand with a short note: kept with the
// project and in the activity log. The greenlight decision itself is never passed by hand: recording it is the way.

export type HardGateKey = "idea" | "review" | "greenlight" | "guest" | "pages";

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

function reviewGate(projectId: string, docKey: string, what: string): Omit<HardGate, "override"> {
  const doc = documentOf(projectId, "Development", docKey);
  const state = doc ? reviewStateOf(doc.id) : "no reviewers";
  const rows = doc ? reviewsOf(doc.id) : [];
  // A project reviewed on the earlier screens, before its documents were turned on, keeps that review: both of its
  // checkpoints approved count, until reviewers are named on the document.
  const earlier = (["pitch", "outline_script"] as const).every((k) => checkpoint(projectId, k)?.status === "Approved");
  if (state === "no reviewers" && earlier)
    return {
      key: "review",
      label: `Theological review of the ${what} approved`,
      met: true,
      detail: "Approved on the earlier review checkpoints",
      overridable: true,
    };
  const detail =
    state === "approved"
      ? `Approved by ${rows.length === 1 ? "its reviewer" : `all ${rows.length} reviewers`}`
      : state === "no reviewers"
        ? "No reviewer named yet"
        : state === "changes_requested"
          ? "Changes requested"
          : `${rows.filter((r) => r.status === "approved").length} of ${rows.length} reviewers have approved`;
  return { key: "review", label: `Theological review of the ${what} approved`, met: state === "approved", detail, overridable: true };
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
      withOverride(reviewGate(projectId, "devotional_script", "script")),
    ];
  }
  const brief = form.sections.brief ?? {};
  const missingIdea = [!text(brief.logline) && "the logline", !text(brief.coreQuestion) && "the core question"].filter(Boolean);
  const decision = latestFirstDecision(form);
  const greenlit = decision?.outcome === "Greenlight";
  const producer = !!p.workflow.showProducerId;
  const first = form.greenlightStage ? "First greenlight" : "Greenlight";
  return [
    withOverride({
      key: "idea",
      label: "The logline and the core question written in the brief",
      met: missingIdea.length === 0,
      detail: missingIdea.length ? `Write ${missingIdea.join(" and ")} at the top of The idea` : "Both written",
      overridable: true,
    }),
    withOverride(reviewGate(projectId, briefKeyOf(p.workflow.formType), "brief")),
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
  if (!gate.overridable) throw new RuleError("The greenlight decision is recorded, not passed by hand.");
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
