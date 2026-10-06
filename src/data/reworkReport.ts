import type { Database } from "../types";

// What the rework (build prompt v2) will need decided about the existing data, reported with every dry run of the
// upgrade (npm run db:upgrade) and kept out of the upgrade itself until decided:
// - General Use records: the category goes from the pipeline. Each record is listed with what is attached to it and a
//   proposal: one with gear checkouts becomes a loan (Equipment, Lending), anything else is archived. Their Content IDs
//   stay and keep resolving either way.
// - Reminders: none are stored today; each person's reminders are worked out from dates. What is stored (the log of
//   reminders sent, and each person's email and text choices) carries over as it is.
// - Fields not carried over by the upgrade, for a decision.

export interface GeneralUseLine {
  contentId: string;
  title: string;
  archived: boolean;
  checkouts: number; // gear checkout lists on it, any status
  openCheckouts: number; // of those, still reserved or out
  callSheets: number;
  documents: number;
  storage: number; // storage entries
  proposal: "loan" | "archive";
}

export interface ReworkReport {
  generalUse: GeneralUseLine[];
  remindersSent: number;
  emailChoosers: number;
  textChoosers: number;
  notCarried: string[];
}

export function reworkReport(db: Database): ReworkReport {
  const generalUse = db.records
    .filter((r) => r.category === "general")
    .map((r): GeneralUseLine => {
      const lists = db.manifests.filter((m) => m.contentId === r.contentId);
      return {
        contentId: r.contentId,
        title: r.title,
        archived: r.archived,
        checkouts: lists.length,
        openCheckouts: lists.filter((m) => m.status === "assigned" || m.status === "checked-out").length,
        callSheets: db.callSheets.filter((c) => c.contentId === r.contentId).length,
        documents: db.docs.filter((d) => d.contentId === r.contentId).length,
        storage: (db.allocations ?? []).filter((a) => a.contentId === r.contentId).length,
        proposal: lists.length ? "loan" : "archive",
      };
    })
    .sort((a, b) => a.contentId.localeCompare(b.contentId, undefined, { numeric: true }));
  return {
    generalUse,
    remindersSent: (db.outbox ?? []).length,
    emailChoosers: db.people.filter((p) => p.notifyEmail).length,
    textChoosers: db.people.filter((p) => p.notifySms).length,
    notCarried: [],
  };
}

/** The report as lines of text, for the dry run. */
export function describeRework(r: ReworkReport): string[] {
  const out = ["", "For the rework, to decide before its later parts:"];
  if (!r.generalUse.length) out.push("  General Use records: none.");
  else {
    out.push(`  General Use records: ${r.generalUse.length}. Proposed: with gear checkouts, a loan; otherwise archived. IDs stay.`);
    for (const g of r.generalUse)
      out.push(
        `    ${g.contentId.padEnd(16)} ${g.title}${g.archived ? " (archived)" : ""}: ${g.checkouts} checkout${g.checkouts === 1 ? "" : "s"}` +
          `${g.openCheckouts ? ` (${g.openCheckouts} still out or reserved)` : ""}, ${g.callSheets} call sheet${g.callSheets === 1 ? "" : "s"}, ` +
          `${g.documents} document${g.documents === 1 ? "" : "s"}, ${g.storage} storage entr${g.storage === 1 ? "y" : "ies"}. Proposed: ${g.proposal}.`,
      );
  }
  out.push(
    `  Reminders: none are stored; they are worked out from dates. Carried over as they are: ${r.remindersSent} sent ` +
      `reminder${r.remindersSent === 1 ? "" : "s"} in the log, ${r.emailChoosers} ${r.emailChoosers === 1 ? "person" : "people"} with email reminders on, ` +
      `${r.textChoosers} with text reminders on.`,
  );
  out.push(r.notCarried.length ? `  Not carried over: ${r.notCarried.join("; ")}.` : "  Fields not carried over: none.");
  return out;
}
