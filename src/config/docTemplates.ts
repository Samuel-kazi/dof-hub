// Starting points for documents. They follow the document types in the master spec: content brief,
// script, shot list, editor's brief, technical spec, report, release and reference.
//
// A document is text in a small format: numbered sections, an italic note under each one saying what
// belongs there, and the writer's answer below the note. There are no symbols to type. Lines starting
// with "- " are lists and "- [ ] " are checkboxes.

export interface TemplateSection {
  title: string;
  note: string; // shown in italics: what needs to go in this section
  start?: string; // text the section begins with, such as checkboxes
}

export interface DocTemplate {
  key: string;
  title: string;
  kind: string; // the document type in the spec
  purpose: string; // an italic line at the top saying what the whole document is for
  sections: TemplateSection[];
  body: string;
}

/** Lays sections out as numbered headings with their italic notes. `answers` fills sections by title. */
export function composeBody(purpose: string, sections: (TemplateSection & { answer?: string })[]): string {
  const parts = purpose ? [`_${purpose}_`, ""] : [];
  sections.forEach((s, i) => {
    parts.push(`${i + 1}. ${s.title}`);
    if (s.note) parts.push(`_${s.note}_`);
    const answer = s.answer ?? s.start ?? "";
    parts.push(answer, "");
  });
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

const t = (key: string, title: string, kind: string, purpose: string, sections: TemplateSection[]): DocTemplate => ({ key, title, kind, purpose, sections, body: composeBody(purpose, sections) });

export const DOC_TEMPLATES: DocTemplate[] = [
  t("concept", "Content brief", "Content brief", "A one-page brief that says who this is for, why we are making it and how it will reach people. Fill it in before scripting starts.", [
    { title: "Working title", note: "The name people will use for it. Short enough to say out loud." },
    { title: "Audience", note: "Who is this for? Describe the person watching, not a statistic." },
    { title: "Mission purpose", note: "Why are we making it? What should change, or be understood, because of it?" },
    { title: "Scripture or theme", note: "The passage or idea it rests on. Give the references." },
    { title: "Format and length", note: "Studio, field or live. How long is it, and is it one part or several?" },
    { title: "Distribution plan", note: "Where it is published, on what day, and who shares it." },
    { title: "What we need", note: "People, equipment, locations and money. Tick each one when it is sorted.", start: "- [ ] People\n- [ ] Equipment\n- [ ] Locations\n- [ ] Budget" },
    { title: "Risks and open questions", note: "Anything that could stop or delay this, and what is still undecided." },
  ]),
  t("script", "Script", "Script, treatment or outline", "The story-lock document. Once it is approved, the shoot is planned from it.", [
    { title: "Cold open", note: "The first thirty seconds. Give the viewer a reason to stay." },
    { title: "Segment 1", note: "What is said and shown. Note who speaks." },
    { title: "Segment 2", note: "The next part. Add more sections if the episode needs them." },
    { title: "Closing and call to action", note: "How it ends and what the viewer is asked to do." },
    { title: "Scripture references", note: "Every passage quoted, with the version used." },
    { title: "Notes for the presenter", note: "Pronunciations, timing and anything to avoid." },
    { title: "Approval", note: "Tick each one when it is done. The script is locked when all three are ticked.", start: "- [ ] Script read through\n- [ ] Theology checked\n- [ ] Script locked" },
  ]),
  t("shotlist", "Shot list and plan", "Shot list and run of show", "The plan for the shoot day: where, what, who and when.", [
    { title: "Locations and permissions", note: "Where you are shooting, and who has said yes.", start: "- [ ] Location confirmed\n- [ ] Permission obtained" },
    { title: "Shot list", note: "Each shot, in order, with a note on how to get it.", start: "| # | Shot | Notes |" },
    { title: "Equipment needed", note: "Cameras, lenses, audio and lights. Then reserve them on a call sheet." },
    { title: "Crew and roles", note: "Who is doing what on the day." },
    { title: "Schedule for the day", note: "Call time, set-up, each setup, lunch and wrap." },
    { title: "Backup plan", note: "What you will do if the weather, the location or a person falls through." },
  ]),
  t("research", "Research file", "Treatment or outline", "Everything the documentary is built on: the question, the people and the facts.", [
    { title: "The question we are answering", note: "One sentence. If it takes more, the film is not focused yet." },
    { title: "Sources and contacts", note: "Who we talk to, how to reach them, and what they can tell us." },
    { title: "Facts to verify", note: "Every claim that must be checked before it is used. Tick each one when confirmed.", start: "- [ ] First fact to check" },
    { title: "Interview questions", note: "The questions for each person, in the order you will ask them." },
    { title: "Rights and releases", note: "Who has signed a release, and any music, footage or images that need permission.", start: "- [ ] Interview releases signed" },
  ]),
  t("run-of-show", "Run of show plan", "Shot list and run of show", "The plan for a live session. The call sheet holds the final minute-by-minute run of show.", [
    { title: "Goal of the session", note: "What this service or event is for, and what a good one looks like." },
    { title: "Segments in order", note: "Each segment with a start time and length." },
    { title: "Who is on the platform", note: "Everyone speaking, leading or performing, and when." },
    { title: "Cues and transitions", note: "How the switcher, graphics and audio move from one segment to the next." },
    { title: "Technical checks", note: "Tick each one before going live.", start: "- [ ] Audio\n- [ ] Video\n- [ ] Stream key and backup" },
  ]),
  t("music-plan", "Session plan", "Shot list and run of show", "The plan for recording a song, both the sound and the video.", [
    { title: "Song and arrangement", note: "The song, the key and tempo, and the structure." },
    { title: "Audio recording plan", note: "Studio, engineer, microphones and what is recorded first.", start: "- [ ] Studio and engineer booked\n- [ ] Click and reference track ready" },
    { title: "Video recording plan", note: "Camera positions, lighting and how lyrics are shown.", start: "- [ ] Camera positions agreed\n- [ ] Lyrics on screen or cue cards" },
    { title: "Who is playing what", note: "Every musician and vocalist, and their part." },
    { title: "Schedule", note: "Arrival, set-up, takes and finish." },
  ]),
  t("edit-notes", "Editor's brief", "Editor's brief", "What the editor needs to know to finish this episode. It travels with the episode through editing and review.", [
    { title: "Story", note: "What the cut must say, and the moments that cannot be lost.", start: "- [ ] Story locked" },
    { title: "Picture", note: "Pacing, the B-roll to add, and anything to trim. Reviews happen on picture lock.", start: "- [ ] Picture locked" },
    { title: "Sound", note: "Dialogue clean-up, music and levels.", start: "- [ ] Sound checked" },
    { title: "Colour and look", note: "The look to match, and the LUT if there is one.", start: "- [ ] Colour graded" },
    { title: "Notes from review", note: "What reviewers asked for, who asked, and whether it is done." },
    { title: "Delivery specification", note: "Format, length, frame rate, file name and where it goes." },
  ]),
  t("analysis", "Publishing analysis", "Report", "Written after publishing. It records how the piece performed, so the next one is better.", [
    { title: "Where it was published", note: "Every platform and its link." },
    { title: "Headline numbers", note: "Views, watch time and average view duration, with the date you took them." },
    { title: "Audience retention", note: "Where viewers dropped off and what you think caused it." },
    { title: "Post-production notes", note: "What worked in the edit and what you would change." },
    { title: "Audience response", note: "Comments, messages and shares worth noting." },
    { title: "What to repeat and what to change", note: "The two or three lessons to carry into the next one." },
  ]),
  t("tech-spec", "Technical spec", "Technical spec", "The settings everyone works to, so footage and audio from different people match.", [
    { title: "Camera settings", note: "Resolution, frame rate, codec, white balance and picture profile." },
    { title: "Audio settings", note: "Sample rate, levels, microphones and monitoring." },
    { title: "LUT and colour reference", note: "The LUT name and version, and where to find it." },
    { title: "Delivery specification", note: "The final format, loudness target, file naming and destination." },
  ]),
  t("daily-report", "Daily production report", "Report", "Written at the end of each shoot day. It is the record of what was shot and where the files are.", [
    { title: "Date, location and crew", note: "Where you were and who was there." },
    { title: "What was shot", note: "Each setup or scene completed, and anything missed." },
    { title: "Ingest and backup", note: "Which drive the files are on, how much, and that a second copy exists.", start: "- [ ] Files copied\n- [ ] Second copy made\n- [ ] Copy checked" },
    { title: "Problems and fixes", note: "Anything that went wrong, and what was done about it." },
    { title: "Tomorrow", note: "What is planned next, and anything needed for it." },
  ]),
  t("release", "Guest release", "Contract or release form", "Records that a guest agreed to appear and how their words and image may be used. Keep the signed copy safe.", [
    { title: "Guest details", note: "Full name, organisation and how to reach them. Keep this private." },
    { title: "What they agree to", note: "Being filmed or recorded, and having it edited." },
    { title: "Where it may be used", note: "Which platforms, for how long, and any limits they asked for." },
    { title: "Signed", note: "Tick when the signed copy is filed, and note where.", start: "- [ ] Release signed\n- [ ] Signed copy filed" },
  ]),
  t("moodboard", "Reference and moodboard", "Reference", "Pictures and examples that show the look we want, so everyone aims at the same thing.", [
    { title: "Look and feel", note: "Describe the mood in a few plain words." },
    { title: "References", note: "Links to films, photos or clips that show it." },
    { title: "Colours and fonts", note: "The palette and type to use." },
    { title: "What to avoid", note: "Anything that would feel wrong for this piece." },
  ]),
];

export const templateOf = (key: string): DocTemplate | undefined => DOC_TEMPLATES.find((t) => t.key === key);

/** A template with some sections filled in, matched by title. Used for the sample documents. */
export function fillTemplate(key: string, answers: Record<string, string>): string {
  const tpl = templateOf(key)!;
  return composeBody(tpl.purpose, tpl.sections.map((s) => ({ ...s, answer: answers[s.title] ?? s.start ?? "" })));
}

// ── Reading a document as sections ───────────────────────────

export interface ParsedDoc { intro: string; sections: { title: string; note: string; answer: string }[] }

const HEADING = /^(\d+)\.\s+(\S.*)$/;

/** Splits a document into its intro and numbered sections. Returns null for text with no numbered sections. */
export function parseSections(body: string): ParsedDoc | null {
  const lines = body.split("\n");
  if (!lines.some((l) => HEADING.test(l))) return null;
  const intro: string[] = [];
  const sections: ParsedDoc["sections"] = [];
  let cur: { title: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = HEADING.exec(line);
    if (m) { if (cur) sections.push(finish(cur)); cur = { title: m[2].trim(), lines: [] }; }
    else if (cur) cur.lines.push(line);
    else intro.push(line);
  }
  if (cur) sections.push(finish(cur));
  return { intro: intro.join("\n").trim(), sections };
}

function finish(s: { title: string; lines: string[] }): ParsedDoc["sections"][number] {
  const lines = [...s.lines];
  let note = "";
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && /^_.+_$/.test(lines[first].trim())) { note = lines[first].trim().slice(1, -1); lines.splice(first, 1); }
  return { title: s.title, note, answer: lines.join("\n").replace(/^\n+|\s+$/g, "") };
}

/** Puts sections back together, numbering them in order. */
export function joinSections(p: ParsedDoc): string {
  return composeBody(p.intro.replace(/^_|_$/g, ""), p.sections.map((s) => ({ title: s.title, note: s.note, answer: s.answer })));
}
