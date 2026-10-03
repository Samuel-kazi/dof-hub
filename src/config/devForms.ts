import type { FormType } from "../types";

// The development form for each type, section by section. Saved values are checked against these definitions
// (src/services/workflow/forms.ts), and the screens are drawn from them, so a field is added in one place.
// Every form also ends with Greenlight (the six criteria and the decision) and Handoff (a checklist), which have
// their own data rather than fields here.

export type FieldType = "text" | "longtext" | "date" | "crew" | "select" | "multiselect" | "yesno" | "amount";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: readonly string[]; // select and multiselect
  hint?: string;
}

/** A section that also holds the project's planned episodes. */
export interface PlannedListDef {
  label: string; // "Planned episodes", "Five-day outline"
  min: number;
  max?: number;
  details: FieldDef[]; // fields each planned episode carries for this form type, beyond its title, question, guest and notes
}

export interface SectionDef {
  key: string;
  label: string;
  fields: FieldDef[];
  planned?: PlannedListDef;
}

const f = (key: string, label: string, type: FieldType = "text", extra: Partial<FieldDef> = {}): FieldDef => ({
  key,
  label,
  type,
  ...extra,
});
const req = (key: string, label: string, type: FieldType = "text", extra: Partial<FieldDef> = {}): FieldDef =>
  f(key, label, type, { ...extra, required: true });

export const INITIATED_BY = ["DOF", "Proposer", "Partner"] as const;
export const SUPPORT_MENU = ["Gear", "Crew", "Editing", "Color", "Sound", "Studio time", "Distribution", "Advice only"] as const;
export const READINESS = ["Ready", "Partly", "Not yet"] as const;
export const DELIVERY = ["In person", "Recorded"] as const;

// ── Shared sections ──────────────────────────────────────────

const entryFields = [
  req("initiatedBy", "Who initiated it", "select", { options: INITIATED_BY }),
  req("dateReceived", "Date received", "date"),
  req("ownerId", "Owner", "crew"),
  f("mandate", "Mandate or source note", "longtext"),
];

const coreBrief = (extra: FieldDef[] = []): SectionDef => ({
  key: "brief",
  label: "Brief",
  fields: [
    req("workingTitle", "Working title"),
    req("logline", "Logline", "longtext"),
    req("targetAudience", "Target audience"),
    req("formatDuration", "Format and duration"),
    f("showType", "Show type"),
    req("coreQuestion", "Core question or tension", "longtext"),
    req("scriptureBasis", "Scripture and source basis", "longtext"),
    f("mustNotBecome", "What it must not become", "longtext"),
    f("contributors", "Contributors, guests and locations", "longtext"),
    f("resourceAsk", "Resource ask", "longtext"),
    f("distributionPlan", "Distribution plan", "longtext"),
    req("successMeasures", "Success measures", "longtext", { hint: "Learning notes after release are written against these." }),
    f("learningQuestions", "Learning questions", "longtext"),
    ...extra,
  ],
});

const stressTest: SectionDef = {
  key: "stressTest",
  label: "Stress-test",
  fields: [
    req("twoSides", "The two sides of the core tension", "longtext"),
    f("discarded", "Ideas discarded, and why", "longtext"),
    req("revisedQuestion", "Revised core question", "longtext"),
  ],
};

const title = (n: string) => f("workingTitle", n);

// ── The forms ────────────────────────────────────────────────

export const DEV_FORMS: Record<FormType, SectionDef[]> = {
  podcast: [
    { key: "entry", label: "Entry", fields: entryFields },
    coreBrief(),
    {
      key: "research",
      label: "Research",
      fields: [
        f("experts", "Experts consulted, with what they confirmed and corrected", "longtext"),
        req("claimsToVerify", "Claims to verify", "longtext", { hint: "Write None if there are none." }),
        req("permissions", "Permissions needed for music, quotes and clips", "longtext", { hint: "Write None if there are none." }),
      ],
    },
    stressTest,
    {
      key: "story",
      label: "Story",
      fields: [req("synopsis", "Series synopsis", "longtext")],
      planned: { label: "Planned episodes", min: 1, details: [f("targetMinutes", "Target minutes")] },
    },
    {
      key: "team",
      label: "Team",
      fields: [
        req("host", "Host"),
        f("guests", "Guests", "longtext"),
        f("soundId", "Sound", "crew"),
        f("editorId", "Editor", "crew"),
        req("confirmations", "Each person's confirmation", "longtext"),
        f("proposerCovers", "What the proposer covers", "longtext"),
        f("dofSupplies", "What DOF supplies", "longtext"),
      ],
    },
    {
      key: "budget",
      label: "Budget",
      fields: [
        f("recordingSpace", "Recording space", "amount"),
        f("gear", "Gear", "amount"),
        f("editingHours", "Editing hours", "amount"),
        f("hostingDistribution", "Hosting and distribution", "amount"),
        f("musicLicensing", "Music licensing", "amount"),
        f("notes", "Notes", "longtext"),
      ],
    },
  ],

  testimonial: [
    { key: "entry", label: "Entry", fields: [...entryFields, req("howCameToDof", "How the person came to DOF", "longtext")] },
    {
      key: "brief",
      label: "Brief",
      fields: [
        req("person", "The person"),
        // Read by the documents' first gate; optional here, so the earlier form's gate is as it was.
        f("logline", "Logline", "longtext"),
        f("coreQuestion", "Core question or tension", "longtext"),
        req("storyCore", "The core of their story", "longtext"),
        req("audience", "Audience"),
        req("formatDuration", "Format and duration"),
        f("scriptureConnection", "Scripture or message connection", "longtext"),
        f("distribution", "Distribution", "longtext"),
        f("successMeasures", "Success measures", "longtext"),
      ],
    },
    {
      key: "research",
      label: "Research",
      fields: [req("factsToVerify", "Facts to verify", "longtext"), f("scriptureUsed", "Scripture used", "longtext")],
    },
    {
      key: "consent",
      label: "Consent and release",
      fields: [
        req("agreement", "They agree to be recorded and published", "yesno"),
        req("whereShared", "Where it may be shared", "longtext"),
        req("peopleNamed", "People named in the story", "longtext", { hint: "Write None if there are none." }),
        req("minors", "Minors involved", "yesno"),
        f("minorsConsent", "Consent for the minors", "longtext"),
        req("withdrawalTerms", "Terms if they want to withdraw before publication", "longtext"),
      ],
    },
    {
      key: "sensitivity",
      label: "Sensitivity check",
      fields: [
        req("privateDetails", "Private details about other people", "longtext", { hint: "Write None if there are none." }),
        f("timing", "Timing", "longtext"),
        f("askAgain", "Anything to ask the person again about", "longtext"),
      ],
    },
    {
      key: "story",
      label: "Story",
      fields: [
        req("keyBeats", "Key beats", "longtext"),
        req("interviewQuestions", "Interview questions", "longtext"),
        req("openingMinute", "Opening minute, as the sample", "longtext"),
      ],
      planned: { label: "Planned episodes", min: 1, details: [] },
    },
    {
      key: "team",
      label: "Team",
      fields: [req("interviewer", "Interviewer"), f("cameraId", "Camera", "crew"), f("soundId", "Sound", "crew")],
    },
  ],

  sermon: [
    { key: "entry", label: "Entry", fields: entryFields },
    {
      key: "brief",
      label: "Brief",
      fields: [
        req("speaker", "Speaker"),
        // Read by the documents' first gate; optional here, so the earlier form's gate is as it was.
        f("logline", "Logline", "longtext"),
        f("coreQuestion", "Core question or tension", "longtext"),
        req("seriesTheme", "Series theme"),
        req("mainScripture", "Main scripture"),
        req("audience", "Audience"),
        req("duration", "Duration"),
        req("delivery", "Delivery", "select", { options: DELIVERY, hint: "Decides which later stages apply." }),
        f("distribution", "Distribution", "longtext"),
        f("successMeasures", "Success measures", "longtext"),
      ],
    },
    {
      key: "research",
      label: "Research",
      fields: [req("scriptureCheck", "Scripture and source check", "longtext"), f("quotations", "Quotations and permissions", "longtext")],
    },
    {
      key: "outline",
      label: "Outline",
      fields: [
        title("Title"),
        req("mainText", "Main text"),
        req("keyPoints", "Key points", "longtext"),
        req("application", "Application", "longtext"),
        f("closing", "Closing", "longtext"),
        req("openingMinute", "Opening minute, as the sample", "longtext"),
      ],
      // The per-sermon check is kept on each planned sermon.
      planned: {
        label: "Sermons, with the per-sermon check",
        min: 1,
        details: [
          f("outlineReceived", "Outline received by the agreed date", "yesno"),
          f("scriptureConfirmed", "Scripture confirmed", "yesno"),
          f("slotBooked", "Recording slot booked", "yesno"),
        ],
      },
    },
    {
      key: "team",
      label: "Team",
      fields: [req("speakerConfirmed", "Speaker confirmed", "yesno"), f("cameraId", "Camera", "crew"), f("soundId", "Sound", "crew")],
    },
  ],

  documentary_dof: [
    { key: "entry", label: "Entry", fields: entryFields.map((x) => (x.key === "mandate" ? { ...x, required: true } : x)) },
    coreBrief([req("thesis", "Thesis statement", "longtext")]),
    {
      key: "research",
      label: "Research",
      fields: [
        req("researchPlan", "Deep research plan", "longtext"),
        f("sources", "Sources and archives", "longtext"),
        f("peopleToConsult", "People to consult", "longtext"),
        f("claimsToVerify", "Claims to verify", "longtext"),
        req("permissions", "Permissions and releases needed", "longtext", { hint: "Write None if there are none." }),
      ],
    },
    stressTest,
    {
      key: "story",
      label: "Story",
      fields: [
        req("treatment", "Treatment", "longtext"),
        req("actStructure", "Act structure", "longtext"),
        req("interviewSets", "Interview sets", "longtext"),
        req("oneMinuteSample", "One-minute sample", "longtext"),
      ],
      planned: { label: "Parts (only if it is planned in several parts)", min: 0, details: [] },
    },
    {
      key: "team",
      label: "Team",
      fields: [
        req("directorId", "Director", "crew"),
        f("cameraId", "Camera", "crew"),
        f("soundId", "Sound", "crew"),
        f("editorId", "Editor", "crew"),
        f("narrator", "Narrator"),
        f("confirmations", "Confirmations", "longtext"),
        req("intervieweesLocations", "Interviewees and locations confirmed", "longtext"),
      ],
    },
    {
      key: "budget",
      label: "Budget",
      fields: [
        f("locations", "Locations", "amount"),
        f("gear", "Gear", "amount"),
        f("travel", "Travel", "amount"),
        f("crewTime", "Crew time", "amount"),
        f("post", "Post", "amount"),
        f("licensing", "Licensing", "amount"),
        req("approaches", "For each demanding element: a practical, a simplified and an alternative approach", "longtext"),
      ],
    },
  ],

  documentary_pitched: [
    {
      key: "entry",
      label: "Entry",
      fields: [
        ...entryFields,
        req("proposerName", "Proposer's name"),
        req("proposerContact", "Proposer's contact"),
        req("howReceived", "How it was received"),
      ],
    },
    coreBrief(),
    {
      key: "readiness",
      label: "Proposer readiness",
      fields: [
        req("script", "Script or treatment", "select", { options: READINESS }),
        req("footage", "Footage", "select", { options: READINESS }),
        req("team", "Team", "select", { options: READINESS }),
        req("funding", "Funding", "select", { options: READINESS }),
        req("permissions", "Permissions", "select", { options: READINESS }),
        f("notes", "Notes", "longtext"),
      ],
    },
    {
      key: "research",
      label: "Research",
      fields: [
        req("claimsToVerify", "Claims to verify", "longtext"),
        f("sources", "Sources", "longtext"),
        f("permissions", "Permissions", "longtext"),
      ],
    },
    {
      key: "story",
      label: "Story",
      fields: [
        req("treatment", "Treatment", "longtext"),
        f("structure", "Structure", "longtext"),
        f("interviewSets", "Interview sets", "longtext"),
        req("oneMinuteSample", "One-minute sample", "longtext"),
      ],
      planned: { label: "Parts (only if it is planned in several parts)", min: 0, details: [] },
    },
    {
      key: "team",
      label: "Team",
      fields: [req("proposerTeam", "The proposer's team", "longtext"), f("confirmations", "Confirmations", "longtext")],
    },
    {
      key: "support",
      label: "Support menu",
      fields: [req("support", "What DOF is asked for", "multiselect", { options: SUPPORT_MENU })],
    },
    {
      key: "budget",
      label: "Budget",
      fields: [req("dofCommitment", "DOF's commitment", "longtext"), req("proposerProvides", "What the proposer provides", "longtext")],
    },
    {
      key: "ownership",
      label: "Ownership terms",
      fields: [
        req("owner", "Who owns the final film"),
        req("distributor", "Who distributes it"),
        req("creditBranding", "Credit and branding", "longtext"),
        req("editApproval", "Edit approval", "longtext"),
        req("messageAlignment", "Message alignment", "longtext"),
      ],
    },
  ],

  devotion: [
    {
      key: "entry",
      label: "Entry",
      fields: [
        ...entryFields,
        req("theme", "Theme"),
        req("slot", "Slot"),
        req("runStart", "Run starts", "date"),
        req("runEnd", "Run ends", "date"),
      ],
    },
    {
      key: "guest",
      label: "Guest",
      fields: [
        req("name", "Name"),
        req("contact", "Contact"),
        req("invitedById", "Who invited them", "crew"),
        req("invitedOn", "When they were invited", "date"),
        req("availableAllDays", "Availability confirmed for all five days", "yesno"),
        req("where", "In studio or remote", "select", { options: ["In studio", "Remote"] }),
      ],
    },
    {
      key: "outline",
      label: "Five-day outline",
      fields: [],
      planned: {
        label: "The five days",
        min: 5,
        max: 5,
        details: [
          req("scripture", "Scripture"),
          req("keyThought", "Key thought", "longtext"),
          req("application", "Application or closing", "longtext"),
        ],
      },
    },
    {
      key: "messageReview",
      label: "Message review",
      fields: [
        f("notes", "Notes from the team's review", "longtext", {
          hint: "A named reviewer approves the outline at the Outline checkpoint.",
        }),
      ],
    },
    {
      key: "recordingPlan",
      label: "Recording plan",
      fields: [req("slot", "Recording slot"), f("technicalNeeds", "Technical needs", "longtext"), f("backupDate", "Backup date", "date")],
    },
  ],
};

export const sectionsOf = (formType: FormType): SectionDef[] => DEV_FORMS[formType];
export const sectionOf = (formType: FormType, key: string): SectionDef | undefined => DEV_FORMS[formType].find((s) => s.key === key);
/** The section that holds a form type's planned episodes, if it has one. */
export const plannedSectionOf = (formType: FormType): SectionDef | undefined => DEV_FORMS[formType].find((s) => s.planned);
