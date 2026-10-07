import type { FormType, WorkflowStage } from "../types";

// What each project gets at each of the five stages, by its type: documents (pages of writing), tools (storyboards
// and shot lists) and forms (the structured screens that drive the calendar, reminders, call sheets, gear, storage,
// gates and overdue, unchanged). The stage names and their order are the workflow's own (src/config/workflow.ts).
// A document's starting pages are only a start: people add, rename, reorder and delete pages.

export type CatalogType = "series" | "documentary" | "devotion" | "music" | "live";
export type CatalogKind = "document" | "tool" | "form" | "review";
export type FormTile =
  | "plannedEpisodes"
  | "consent"
  | "acceptDecline"
  | "roles"
  | "sessions"
  | "callSheet"
  | "gear"
  | "sessionLog"
  | "storage"
  | "recordingDayView"
  | "episodeTracker"
  | "review"
  | "platformStatus"
  | "archive"
  | "showDays";

export interface CatalogPage {
  title: string;
  subtitle?: string;
  body?: string; // starting HTML
  // Structured fields shown above the body, kept on the development form so gates can read them reliably.
  fields?: { section: string; key: string; label: string }[];
  // A structured screen shown as this page instead of rich text (a session's run sheet or wrap checklist).
  form?: "runSheet" | "wrapChecklist";
  storage?: boolean; // the drive the footage is planned to go on is chosen above this page (a Recording Plan's Cards and storage)
}

export interface CatalogEntry {
  key: string;
  title: string;
  kind: CatalogKind;
  pages?: CatalogPage[];
  tool?: "storyboard" | "shotList";
  form?: FormTile;
  reviews?: string; // a review view: the key of the document it reviews
  per?: "session" | "episode"; // one of these documents for each session or episode, rather than one for the project
  pagePerEpisode?: boolean; // its pages are one per episode (a review thread)
  onlyIfMade?: boolean; // made only by the move from the old forms: its tile shows once it exists, and it is never made empty
  plan?: boolean; // a Recording Plan: its roles, devotions, sessions and call sheets show as fixed cards before its pages
}

const CRITERIA_LIST =
  "<ul><li><p><strong>Mission fit:</strong> </p></li><li><p><strong>Message soundness:</strong> </p></li><li><p><strong>Audience need:</strong> </p></li><li><p><strong>Feasibility:</strong> </p></li><li><p><strong>Resource cost:</strong> </p></li><li><p><strong>Team strength:</strong> </p></li></ul>";

const doc = (key: string, title: string, pages: (string | CatalogPage)[], extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  key,
  title,
  kind: "document",
  pages: pages.map((p) => (typeof p === "string" ? { title: p } : p)),
  ...extra,
});
const form = (key: string, title: string, tile: FormTile, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  key,
  title,
  kind: "form",
  form: tile,
  ...extra,
});
const tool = (key: string, title: string, which: "storyboard" | "shotList"): CatalogEntry => ({ key, title, kind: "tool", tool: which });
const review = (reviews: string): CatalogEntry => ({ key: "theological_review", title: "Theological Review", kind: "review", reviews });
// One page with four section cards (roles, the items to record, sessions, call sheets), then its own pages.
const recordingPlan = doc("recording_plan", "Recording Plan", [{ title: "Cards and storage", storage: true }, "Notes"], { plan: true });
/** A series' or documentary's planning tiles: the Recording Plan (roles, sessions and call sheets are in it). */
const planOrForms = (): CatalogEntry[] => [
  recordingPlan,
  tool("storyboard", "Storyboard", "storyboard"),
  tool("shot_list", "Shot List", "shotList"),
];

// The two brief fields the Development gate reads: written at the top of the brief's first page. A song's second field
// is its core message, an event's its purpose: the same field, in their own words.
const ideaFields = (second = "Core question or tension") => [
  { section: "brief", key: "logline", label: "Logline" },
  { section: "brief", key: "coreQuestion", label: second },
];
const IDEA_FIELDS = ideaFields();

const greenlight = doc("greenlight", "Greenlight", [{ title: "Decision", body: `<p>The six criteria:</p>${CRITERIA_LIST}` }]);

/**
 * What a project's old Development form held, for a project whose brief was started before the form was moved: kept
 * here, word for word, rather than written into pages someone had already begun (src/data/migrateDocuments.ts).
 */
export const EARLIER_FORM_KEY = "earlier_form";
const earlierForm = doc(EARLIER_FORM_KEY, "Earlier Development form", [], { onlyIfMade: true });

/** The Show Brief's pages, with the extra pages a testimonial or a sermon series keeps from its earlier form. */
function showBrief(formType: FormType): CatalogEntry {
  const pages: CatalogPage[] = [
    { title: "The idea", fields: IDEA_FIELDS },
    { title: "Scripture and source basis" },
    { title: "Shape" },
    { title: "Ask" },
  ];
  if (formType === "testimonial") pages.splice(3, 0, { title: "Sensitivity" });
  if (formType === "sermon") pages.splice(3, 0, { title: "Outline" });
  return doc("show_brief", "Show Brief", pages);
}

function documentaryBrief(formType: FormType): CatalogEntry {
  const pages: CatalogPage[] = [
    { title: "The idea", fields: IDEA_FIELDS },
    { title: "Subjects and locations" },
    { title: "Sources and fact-checking" },
    { title: "Ask" },
  ];
  if (formType === "documentary_pitched")
    pages.push({ title: "Proposer readiness" }, { title: "Support asked for" }, { title: "Ownership terms" });
  return doc("documentary_brief", "Documentary Brief", pages);
}

const marketing = (): CatalogEntry[] => [
  doc("release_plan", "Release Plan", ["Release message", "Platform plan", "Study resources"]),
  form("platform_status", "Platform Status", "platformStatus"),
  doc("learning_notes", "Learning Notes", ["Against the success measures"]),
  form("archive", "Archive", "archive"),
];

/** A music release, a single or an album: the series' workflow in its own words. Each song can have its own storyboard
 * and shot list, or share the release's. */
function musicCatalog(formType: FormType): Record<WorkflowStage, CatalogEntry[]> {
  const single = formType === "music_single";
  return {
    Development: [
      doc("music_brief", "Music Brief", [
        { title: "The idea", fields: ideaFields("Core message") },
        "Lyrics",
        "Scripture and source basis",
        "Sound and arrangement",
        "Ask",
      ]),
      review("music_brief"),
      greenlight,
      form("planned_episodes", single ? "The Song" : "Planned Songs", "plannedEpisodes"),
    ],
    "Pre-production": [
      doc("production_pack", "Production Pack", ["Arrangement and rehearsal", "Music video concept", "Set and wardrobe"]),
      ...planOrForms(),
      form("gear", "Gear", "gear"),
    ],
    Production: [
      doc(
        "recording_day_sheet",
        "Recording Day Sheet",
        [{ title: "Run sheet", form: "runSheet" }, "Session notes", { title: "Wrap checklist", form: "wrapChecklist" }],
        { per: "session" },
      ),
      form("session_log", "Session Log", "sessionLog"),
      form("storage", "Storage", "storage"),
    ],
    "Post production": [
      doc("edit_notes", "Mix and Edit Notes", ["Mix notes", "Mastering notes", "Video edit notes"]),
      form("episode_tracker", "Song Tracker", "episodeTracker"),
      doc("review_thread", "Review Thread", [], { pagePerEpisode: true }),
    ],
    "Marketing and distribution": marketing(),
  };
}

/** A live event: one day, several days, or a recurring show. Each day is a session with its own call sheet and run of
 * show; what was recorded on a day goes on as recordings. */
const liveCatalog: Record<WorkflowStage, CatalogEntry[]> = {
  Development: [
    doc("event_brief", "Event Brief", [
      { title: "The idea", fields: ideaFields("Purpose of the event") },
      "Theme and scripture",
      "Format and programme",
      "Speakers and performers",
      "Ask",
    ]),
    review("event_brief"),
    greenlight,
    form("show_days", "Show Days", "showDays"),
  ],
  // The Recording Plan holds the roles, the days and each day's call sheet and run of show.
  "Pre-production": [
    doc("production_pack", "Production Pack", ["Stage and set design", "Technical plan", "Rehearsal notes"]),
    ...planOrForms(),
    form("gear", "Gear", "gear"),
  ],
  Production: [
    doc(
      "show_day_sheet",
      "Show Day Sheet",
      [{ title: "Run of show", form: "runSheet" }, "Show notes", { title: "Strike and wrap checklist", form: "wrapChecklist" }],
      { per: "session" },
    ),
    form("session_log", "Show Log", "sessionLog"),
    form("storage", "Storage", "storage"),
  ],
  "Post production": [
    doc("edit_notes", "Edit Notes", ["Recording notes", "Clips to cut", "Graphics and music"]),
    form("episode_tracker", "Recording Tracker", "episodeTracker"),
    doc("review_thread", "Review Thread", [], { pagePerEpisode: true }),
  ],
  "Marketing and distribution": [
    doc("release_plan", "Release Plan", ["Clips and highlights", "Platform plan"]),
    form("platform_status", "Platform Status", "platformStatus"),
    doc("show_report", "Show Report", ["Attendance and reach", "What worked", "What to change"]),
    form("archive", "Archive", "archive"),
  ],
};

function seriesCatalog(formType: FormType): Record<WorkflowStage, CatalogEntry[]> {
  return {
    Development: [
      showBrief(formType),
      review("show_brief"),
      greenlight,
      form("planned_episodes", "Planned Episodes", "plannedEpisodes"),
      ...(formType === "testimonial" ? [form("consent", "Consent and Release", "consent")] : []),
      earlierForm,
    ],
    // The Recording Plan holds the roles, the episodes, the sessions they are recorded in and each session's call sheet.
    "Pre-production": [
      doc("production_pack", "Production Pack", ["Set design", "Rehearsal notes"]),
      ...planOrForms(),
      form("gear", "Gear", "gear"),
    ],
    Production: [
      doc(
        "recording_day_sheet",
        "Recording Day Sheet",
        [{ title: "Run sheet", form: "runSheet" }, "Daily notes", { title: "Wrap checklist", form: "wrapChecklist" }],
        {
          per: "session",
        },
      ),
      form("session_log", "Session Log", "sessionLog"),
      form("storage", "Storage", "storage"),
    ],
    "Post production": [
      doc("edit_notes", "Edit Notes", ["Notes to the editor", "Story and theology lock", "Graphics and music"]),
      form("episode_tracker", "Episode Tracker", "episodeTracker"),
      doc("review_thread", "Review Thread", [], { pagePerEpisode: true }),
    ],
    "Marketing and distribution": marketing(),
  };
}

function documentaryCatalog(formType: FormType): Record<WorkflowStage, CatalogEntry[]> {
  return {
    Development: [
      documentaryBrief(formType),
      review("documentary_brief"),
      greenlight,
      form("planned_episodes", "Planned Parts", "plannedEpisodes"),
      earlierForm,
    ],
    "Pre-production": [
      doc("treatment", "Treatment", ["Story structure", "Interview guide"]),
      ...planOrForms(),
      form("gear", "Gear", "gear"),
    ],
    Production: [
      doc(
        "shoot_day_sheet",
        "Shoot Day Sheet",
        [{ title: "Run sheet", form: "runSheet" }, "Interview notes", { title: "Wrap checklist", form: "wrapChecklist" }],
        {
          per: "session",
        },
      ),
      form("session_log", "Session Log", "sessionLog"),
      form("storage", "Storage", "storage"),
    ],
    "Post production": [
      doc("edit_notes", "Edit Notes", ["Assembly notes", "Narration", "Fact-check lock", "Graphics and music"]),
      form("cut_tracker", "Cut Tracker", "episodeTracker"),
      doc("review_thread", "Review Thread", [], { pagePerEpisode: true }),
    ],
    "Marketing and distribution": marketing(),
  };
}

/** Five devotion pages to start, each a title, its scripture and the script. More can be added. */
const DEVOTION_PAGES: CatalogPage[] = [1, 2, 3, 4, 5].map((n) => ({ title: `Devotion ${n}`, subtitle: "" }));

const devotionCatalog: Record<WorkflowStage, CatalogEntry[]> = {
  Development: [
    doc("devotional_script", "Devotional Script", DEVOTION_PAGES),
    review("devotional_script"),
    form("accept_decline", "Accept or Decline", "acceptDecline"),
    earlierForm,
  ],
  // The Recording Plan holds the roles, the devotions, the sessions they are recorded in and each session's call sheet;
  // a session's call sheet shows one storyboard and one shot list of the project's, chosen from these.
  "Pre-production": [recordingPlan, tool("storyboard", "Storyboard", "storyboard"), tool("shot_list", "Shot List", "shotList")],
  Production: [form("recording_day_view", "Recording Day View", "recordingDayView"), form("storage", "Storage", "storage")],
  "Post production": [doc("edit_notes", "Edit Notes", ["Notes to the editor"]), form("review", "Review", "review")],
  "Marketing and distribution": [
    doc("release_plan", "Release Plan", ["Release message", "Platform plan"]),
    doc("study_notes", "Study Notes", ["Study notes"]),
  ],
};

/**
 * What a Recording Plan's items are called for each kind of project, and where they come from (build prompt v2,
 * section 8: labels per type live in configuration, so they can change without code).
 */
export interface PlanLabels {
  one: string; // "episode"
  many: string; // "episodes"
  title: string; // "Episodes"
  source: string; // where the list is read from
  detail: string; // the second column: a devotion's scripture, an episode's question
}
export function planLabels(formType: FormType): PlanLabels {
  switch (catalogTypeOf(formType)) {
    case "devotion":
      return { one: "devotion", many: "devotions", title: "Devotions", source: "the Devotional Script", detail: "Scripture" };
    case "documentary":
      return { one: "part", many: "parts", title: "Parts", source: "the Planned Parts in Development", detail: "Question" };
    case "music":
      return {
        one: "song",
        many: "songs",
        title: "Songs",
        source: formType === "music_single" ? "The Song in Development" : "the Planned Songs in Development",
        detail: "Notes",
      };
    case "live":
      // A live event records what happens on its days: its recordings are named in each day's show log.
      return { one: "recording", many: "recordings", title: "Recordings", source: "each day's show log", detail: "Notes" };
    default:
      return { one: "episode", many: "episodes", title: "Episodes", source: "the Planned Episodes in Development", detail: "Question" };
  }
}

export function catalogTypeOf(formType: FormType): CatalogType {
  if (formType === "devotion") return "devotion";
  if (formType === "documentary_dof" || formType === "documentary_pitched") return "documentary";
  if (formType === "music_single" || formType === "music_album") return "music";
  if (formType === "live_event") return "live";
  return "series";
}

/** What a project of this form type has at this stage, in the order its tiles show. */
export function catalogFor(formType: FormType, stage: WorkflowStage): CatalogEntry[] {
  const type = catalogTypeOf(formType);
  const all =
    type === "devotion"
      ? devotionCatalog
      : type === "documentary"
        ? documentaryCatalog(formType)
        : type === "music"
          ? musicCatalog(formType)
          : type === "live"
            ? liveCatalog
            : seriesCatalog(formType);
  return all[stage];
}

export const catalogEntry = (formType: FormType, stage: WorkflowStage, key: string): CatalogEntry | undefined =>
  catalogFor(formType, stage).find((e) => e.key === key);

/** The document a project's Development writing lives in: the brief, or a devotion's script. */
export const briefKeyOf = (formType: FormType): string =>
  ({ devotion: "devotional_script", documentary: "documentary_brief", music: "music_brief", live: "event_brief", series: "show_brief" })[
    catalogTypeOf(formType)
  ];

/** Seed values for a shot list's dropdowns. Free text is allowed too. */
export const SHOT_SIZES = ["Wide", "Medium", "Close-up", "Extreme close-up"];
export const SHOT_TYPES = ["Eye level", "High angle", "Low angle", "Over the shoulder"];
export const SHOT_MOVEMENTS = ["Static", "Pan", "Tilt", "Dolly", "Gimbal", "Handheld"];
