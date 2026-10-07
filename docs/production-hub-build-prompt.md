# Build prompt v4: Dawn of Faith TV Production Hub rework

This is the current version and replaces v3, v2 and the earlier "Documents Rework" prompt. v3 adds the Recording Log, Storage assigned in Production, Import existing project (section 7A) and the collapsible Checks panel (section 14A). It combines every approved change: documents instead of heavy forms, the shared Production system (recording sessions, call sheets, live shows), Storyboard and Shot List, Equipment lending, a Calendar that absorbs Reminders, and shell changes. Work inside the existing codebase and follow its real stack, naming and conventions. Do not rewrite the app.

## 0. Check the repository first, then stop and report

Work out which situation you are in.

* New session (you have no memory of this project): do the full read described below.
* Continuing an existing session on this codebase: do not repeat a full audit and do not trust your memory of earlier work; the repository is the source of truth. Compare this prompt with the current code section by section and reply with a gap list: for each section mark Done, Partly done, Not started, or Conflicts with this prompt, with file names as evidence. Build on what exists. Do not rewrite or duplicate finished work, and keep earlier decisions unless this prompt changes them.

Housekeeping in both cases: save this prompt in the repository (for example `docs/production-hub-build-prompt.md`) and re-read it at the start of each phase; work on a branch; make one commit per phase with a clear message so I can review and revert; run the existing tests before and after each phase.

Full read (new session): Before writing code, read: the stage components for Series, Documentary, Devotion, Live Show and DOF Music; the Documents, Calendar, Reminders, Equipment, Call Sheets and Crew modules; the schema and migrations; the service layer; auth and settings; the category/pipeline configuration; Content ID generation. Notes from earlier sessions disagree about the stack (a PySide6 desktop app versus a React/TypeScript web app); identify what the repository actually is and say so. Then reply with a short report: files you will change, tables you will add, how existing data will be migrated, any conflict with this brief, and the answers to the questions in section 20. Wait for my confirmation before Phase 1.

## 1. Non-negotiable rules

1. The five stages, their names and order never change: Development, Pre-production, Production, Post production, Marketing and distribution, for every content type. The stage tracker stays.
2. Content IDs stay permanent. Overdue is computed only at Episode or Devotion level, never at Series, Season or Project level. Project bars on the Calendar show planned dates only.
3. Board logic stays: a project appears in Development and Pre-production, a production instance (recording session or live show day) appears in Production, and each episode continues on its own in Post production and Marketing and distribution.
4. Narrative items become documents. Anything that drives Calendar, reminders, gear conflicts, storage or overdue stays a structured form with today's behaviour.
5. Never lose data. Every migration is reversible and idempotent, with a dry-run report. Fields that are not carried over must be listed for my decision. Keep old tables until I approve removal.
6. No manual "status" field on documents. A tile may show a small dot when its document has content (derived).
7. Partner login is on hold. Do not build it. Keep all data access going through the service layer so it can be added later.
8. Soft nudges never block. Hard gates are only those listed in section 14.

## 2. Shell and navigation changes

* Sidebar becomes: Dashboard; Content Pipeline (Series, Devotionals, Live Shows, Documentaries, DOF Music); Call Sheets; Calendar; Equipment; Storage & Media; Crew; Documents.
* Remove General Use from the Content Pipeline (filter chip, category, board column, creation menu). Do not delete existing General Use records or their Content IDs: convert them to loans (section 11) or archive them, and keep old IDs resolvable.
* Remove the Reminders module and its route; redirect old links to Calendar (section 12). Migrate every existing reminder into Calendar.
* Settings leaves the sidebar. It opens from the profile menu (click the avatar: Settings, Sign out). Remove the separate sign-out icon from the top bar. Ctrl+, (Cmd+, on Mac) opens Settings. Keep theme toggle and the bell.
* Call Sheets module stays as a read-only cross-project index of upcoming and past call sheets (filter by type, date, project), each row linking into the call sheet inside its project. It must not duplicate or edit call sheet data.
* Command palette: Ctrl+K (Cmd+K) searches projects, episodes and devotions, documents, call sheets, crew, equipment, loans, and offers commands (open Calendar, new loan, print today's run sheet). Results respect the current user's access.

## 3. Interaction model (StudioBinder style)

* Project Home: one coloured row per stage (label block on the left), icon tiles on the right. Tiles are documents, tools (Storyboard, Shot List, Recording or Broadcast Plan) or forms. Click to open, "← Project home" to return; stage tabs along the top of an open document jump between stages.
* Open document layout: left pane lists the documents of the current stage (forms tagged "form"); middle pane lists the pages inside the document as cards with "+ Add page"; right pane is the writing page: title, subtitle (scripture or note), rich body, "Saved @ time", and a Links box. Rename, reorder (drag) and delete pages.
* Keep existing glass-panel styling, terracotta accent, light and dark themes, keyboard accessibility, and aria labels on icon buttons.

## 4. Rich-text editor, saving and keyboard

* Use an established editor library (recommend TipTap/ProseMirror with StarterKit, Underline, TextStyle, Color, Highlight, TextAlign, Link, FontSize, TaskList). Do not use `document.execCommand`.
* Sticky toolbar: undo, redo; Normal and Heading 1 to 3; text size; bold, italic, underline, strikethrough; text colour; highlight; align left, centre, right; bullets, numbers, checklist; indent, outdent; link; clear formatting. Shortcuts: Ctrl/Cmd with B, I, U, Z, Shift+Z, K.
* Store sanitised HTML (allow-list sanitiser on save and load). Pasting from Google Docs or Word keeps bold, italic, headings, lists and links and strips the rest.
* Autosave 800 ms after the last keystroke: "Saving…" then "Saved @ hh:mm". Ctrl/Cmd+S forces a save. On failure show an error, keep the text on screen, retry, and warn before leaving with unsaved changes.
* Enter and Esc: in single-line fields Enter saves the field and moves to the next; at the end of a run sheet, rundown or shot list row, Enter adds a new row below; Esc reverts the field edit. In multi-line fields Enter adds a line and Ctrl+Enter saves. Dialogs: Enter confirms, Esc cancels; a required reason blocks Enter until filled.
* Deliberate actions: Approve, Greenlight, Accept or Decline, and publishing a call sheet or episode never fire on a casual Enter; they need a click or Ctrl+Enter and a confirm dialog.
* Print stylesheet for any document page.

## 5. Document catalogue per type

Starting pages are fixed; users can add, rename, reorder, delete.

Series: Development: Show Brief (The idea, Scripture and source basis, Shape, Ask; include a structured Episode list table: number, title, synopsis, planned scripture), Theological Review, Greenlight (Decision, with the six criteria as a list). Pre-production: Production Pack (Set design, Rehearsal notes), Recording Plan (section 8), Storyboard, Shot List, Roles and Gear folded into the Recording Plan. Production: Recording Day Sheet is the call sheet's run sheet (no duplicate) and Recording Log (form, section 7A; replaces Session Log, the Storage tile and the old link back to Pre-production). Post production: Edit Notes (Notes to the editor, Story and theology lock, Graphics and music), Episode Tracker (form), Review Thread. Marketing and distribution: Release Plan, Platform Status (form), Learning Notes, Archive (form).

Documentary: Documentary Brief (The idea, Subjects and locations, Sources and fact-checking, Ask), Theological Review, Greenlight; Treatment (Story structure, Interview guide), Recording Plan (items are interviews or scenes; sessions are shoot days), Storyboard, Shot List; Edit Notes (Assembly notes, Narration, Fact-check lock, Graphics and music), Cut Tracker (form), Review Thread; then as Series. Treat the page names as proposals and flag them for me.

Devotion: Development: Devotional Script (the script is the brief; starts with 5 pages "Devotion 1" to "Devotion 5": title, scripture in the subtitle, script text; add more freely), Theological Review, Accept or Decline. Pre-production: Recording Plan (section 8), Storyboard and Shot List (optional; one of each per set, not per devotion). Production: Recording Log (form, section 7A) and Recording Day View (the existing filtered batch view, form). Post production: Edit Notes, Review. Marketing and distribution: Release Plan, Study Notes. No Show Brief, no Greenlight criteria, no stress-test, story, team or budget forms.

Live Show: section 9. DOF Music: section 10.

## 6. Data model

Add tables adapted to the existing service layer:

* Documents: `project_documents(id, content_id, stage, doc_key, title, created_at, updated_at)`, `document_pages(id, document_id, position, title, subtitle, body_html, updated_at, updated_by)`, `document_links(id, document_id, url, label, added_by, added_at)` (reuse the Documents module's link handling; files stay in Google Drive or WhatsApp as links), `review_comments(id, page_id, author_id, body, resolved, created_at)`, `document_reviews(id, document_id, reviewer_id, status[pending|approved|changes_requested], note, decided_at)`. A page edited after approval sets `edited_after_approval`.
* Storyboards and shot lists: `storyboards(id, content_id nullable, name, position, is_template)`, `storyboard_frames(...image_path, description, sound_effects, video_link)`, `shot_lists(id, content_id nullable, name, position, is_template)`, `shot_list_rows(id, shot_list_id, position, row_type[shot|setup|banner], image_path, description, shot_size, shot_type, movement, est_time)`. Images are stored in the local media folder (path only), resized to a 1280 px long edge.
* Production system (section 7): `productions`, `production_templates`, `production_instances`, `call_sheets`, `call_sheet_roles`, `call_sheet_items` (episodes or devotions assigned), `run_of_show_rows`, `tech_check_items`, `rehearsal_entries`, `call_sheet_confirmations`, `call_sheet_changes`, `locations`, `role_kits`.
* Lending: `loans`, `loan_items`.
* Recording Log and storage: `recording_logs(id, instance_id, recorded_on, location, label, attendees, issues, notes)`, `recording_log_items(id, log_id, item_ref, take_mark[good|pickup|re_record], duration, notes)`, `storage_assignments(id, instance_id, drive_id, role[primary|backup], folder_path, offloaded_at, offloaded_by, backed_up_at, backed_up_by)` referencing the existing Storage & Media records (do not duplicate them), and project flags `imported`, `imported_at`, `reviewed_before_system`. Migrate existing Session Log entries and Storage links into these.
* Calendar: `calendar_items` (or reuse existing date fields via a unified query; prefer a view over copying), `reminders(id, target_type, target_id, offset_rule, channels, recipient_ids, fire_at, fired_at)`, `google_sync_links(user_id, item_type, item_id, google_event_id)`.
* Migration of the old Development stage: map each old Brief field into the Show Brief pages as a bold label line plus the old value ("The idea": working title, logline, target audience, format and duration, core question; "Scripture and source basis": scripture and sources, claims to verify, permissions; "Shape": show type, what it must not become, contributors, synopsis, planned episodes, team notes; "Ask": resource ask, budget fields, distribution plan, success measures, learning questions). Stress-test and Research text append under their own headings. The six criteria and notes populate the Greenlight list. The decision, decision date and review notes stay structured on the project. Pitch and Outline checkpoints become `document_reviews` rows. Entry fields, show producer and Content ID stay as the header strip and project fields. Existing Call Sheets, run sheets and recording sessions migrate into production instances and call sheets with no detail lost.

## 7. The Production system (one structure, three creation modes)

Do not build separate systems. Build one Production system with a call sheet as the operational center, and three creation modes.

```
PROJECT (Content ID) → PRODUCTION (container) → PRODUCTION INSTANCE (a day or session) → CALL SHEET → RUN OF SHOW
```

* Single: one instance (a one-time event, a one-night livestream).
* Multiple: several instances created by hand under one production (Multi-Day Event: Day 1, Day 2, and so on; also the recording sessions of a Devotion, Series or Documentary).
* Recurring: a show template (standard crew, equipment, workflow, run of show, call sheet defaults) plus a recurrence rule (daily, weekly on chosen days and time, until a date or count). The app automatically generates future instances in a rolling window (default the next 8 occurrences; configurable) when the app starts and daily. Every generated instance is independently editable and marks which fields differ from the template. Editing offers "this occurrence only" or "this and future occurrences" (updates the template). Support skip and cancel for one date. Store the time zone explicitly (Africa/Nairobi default).
* Instances appear in Production on their date; on completion the recording becomes the episode that continues through Post production and Marketing and distribution. Development happens once on the project (and the template), not per occurrence. Confirm in Phase 0 how the existing board handles this and adapt.
* Each instance has a label (Morning, Afternoon, Evening, Late night, Full day, or a custom name), date, start and end time, location, and status (draft, published, done, cancelled).

### The call sheet (one per instance)

Sections: Schedule; Crew and roles; Talent; Location; Equipment; Logistics; Contacts; Run of Show; Technical Check; Rehearsal, plus the episodes or devotions recorded in this session, plus the chosen storyboard and shot list (two pickers, shown read-only as board name, frame thumbnails, and shot rows; editing stays in the Storyboard and Shot List pages). Carry over every field of today's Call Sheet exactly (audit the current form; do not invent fields). Show Technical Check and Rehearsal always for Live Shows and optionally elsewhere.

* Generated, not retyped: roles from the Recording or Broadcast Plan, episodes from the plan's session assignment, defaults from the template.
* Run of Show rows: time, activity, who, duration, plus (Live) camera, audio, graphics, status, and actual start and end. Seeded from the template plus one "Record: <title>" row per assigned episode; "+ Row", drag to reorder, "Rebuild from episodes" (confirm).
* Equipment suggestions: `role_kits` map a role (and optionally a camera model) to a default kit (for example Camera operator with FX6: FX6, CFexpress cards, batteries, tripod, monitor, SDI cable). The call sheet shows suggestions the user accepts item by item; accepting reserves via the existing Equipment availability and conflict checks. Kits are editable defaults, never forced.
* Confirmed ticks per crew member and talent; click a crew name to reveal contact details; saved locations to pick from; duplicate a previous call sheet or instance; soft warnings for missing information (no location, no crew call, devotions not assigned to a session, role unassigned); a change log ("Crew call changed 08:00 to 09:00", by whom, when) shown on the sheet.
* Printing: anyone who can open the project can print. Buttons "Print call sheet" and "Print run sheet only". Print stylesheet: no sidebar, top bar, toolbars or buttons; black on white; the run sheet alone prints as one clean page headed with project, session, label and date. Save as PDF through the print dialog. Printing is read-only.

## 7A. Recording Log, Storage in Production, and importing existing projects

Recording Log is a form in the Production stage, one per production instance (session). It replaces the old link that sent users back to Pre-production, and it absorbs the Session Log and the Storage tile. It records what actually happened, not the plan. Sections: (1) session details (date, place, label, who attended); (2) what was recorded: one row per episode, devotion, interview or song, with a take mark (Good, Pickup needed, Re-record), duration and notes; (3) issues and pickups; (4) storage and backup. For planned projects it is pre-filled from the call sheet's session. For imported projects it starts blank. It must work with no Recording Plan and no call sheet.

Storage is assigned in Production, not Pre-production. Remove the storage step from Pre-production for every type. The call sheet shows the assigned drive read-only once set. In the Recording Log, storage works like this:

1. Choose a drive from the existing Storage & Media drives (show free space and online or offline).
2. The app lists the projects already linked to that drive with their folder paths and pre-selects the best match (Content ID, then name). One click confirms.
3. Starting from the project: if it has exactly one storage link, pre-select it; if several, ask; if none, prompt to assign one.
4. A project not yet on the drive: "+ Add to this drive" creates the storage record with a generated folder name (configurable pattern, default `<Content ID> / <date>_<session label>`) and links it.
5. A second assignment as backup drive. Assignment is per session; the project page shows all of them.
6. Tick Offloaded and Backed up, recording who and when. Soft warnings only: no drive, no backup, low free space, drive offline. The picker reads the existing Storage & Media records; do not create parallel storage data. Create folders or copy files only if the app really has access to the drives; otherwise record the destination and let the crew copy. Report which applies in Phase 0.

Import existing project (projects recorded before the system): entry points are Storage & Media ("Import as project" on a folder not yet linked) and the pipeline's Add menu. Flow: choose drive; list folders not linked to any project (and, optionally, already linked ones); select one; choose type; choose starting stage (Production or Post production); create the project with a Content ID, link the storage, set `imported`; open the Recording Log (Production) or a minimal imported record with the item list (Post production). Rules for imported projects: skipped stages show "Recorded before the system" and are never errors; no warnings for a missing plan, call sheet or Greenlight; offer "Reviewed before the system" to clear the theological review banner; past dates stay out of reminders, overdue checks, the urgency report and Google sync, and appear on the Calendar as history.

Moving to Post production: the only hard requirement is at least one recorded item in the log. Moving creates one episode in the Episode or Cut Tracker per recorded item (devotions stay flat) and carries pickups and issues into Edit Notes. Missing storage or backup is a soft warning. The editor must be able to see where the footage is.

## 8. Recording Plan (Devotion, Series, Documentary) and Broadcast Plan (Live)

One page with four sections as cards in the middle pane. It is the "multiple" creation mode of section 7.

1. Project roles: production roles (seed: Director, Camera, Audio, Lighting, Floor manager, Editor; add, rename, remove), each picked from Crew.
2. Item list: read-only list of what needs recording, brought up from Development: Devotion list (from the Devotional Script pages), Episode list (Series, from the Show Brief episode table), Interviews and scenes (Documentary), Rundown segments (Live, section 9), Songs (DOF Music). Show "x of y assigned" and mark unassigned items "Needs a session". The source stays the Development document; do not copy the text.
3. Sessions: add any number of sessions (name, label, date, time range). Under each, a checklist of all items; ticking assigns it to that session; an item belongs to exactly one session; ticking elsewhere moves it. Removing a session unassigns its items.
4. Call sheets: tabs per session, as in section 7. Labels per type live in category configuration (item name, session name, run sheet name) so they can be changed without code.

## 9. Live Shows

Stage mapping: Idea and Show Planning → Development; Pre-production, Technical Prep and Rehearsal → Pre-production; Live Show → Production; Post-show editing and clips → Post production; Archive and report → Marketing and distribution.

* Development: Show Plan (objective, venue and logistics, expected audience, streaming platform, production type, duration; show date and producer in the header), Greenlight, Theological Review (optional, with reminder).
* Pre-production: Broadcast Plan (section 8 with a Rundown as the item list: segments with time, duration, camera, audio, graphics), Tech Check, Rehearsal Log, optional Storyboard and Shot List as the camera plan. Creative notes (script, graphics, lower thirds, videos, promos) and logistics (venue, transport, accommodation, catering, power, internet) are pages inside the Show Plan.
* Tech Check: one list (cameras, lenses, tripods, switcher, audio console, wireless mics, comms, lighting, graphics, playback, internet, streaming encoder, recording, backup recording), each with assignee, state (Not checked, OK, Issue), linked equipment item from inventory, test result and notes. Duplicate from the previous show. Issues are soft warnings.
* Rehearsal Log: steps (setup, line check, camera check, audio, lighting, graphics, full rehearsal, final sign-off) with time checked, person, notes. Not a gate.
* Production: Live Day: the printable rundown, an actual start and end time log with issue notes, Storage. Phase 9b (last, optional): a Live Control view with a clock, current, next and up-next segments advanced by hand, and status lights for cameras, audio, stream, graphics, recording, comms and internet set by hand.
* Post production: the recording and backup arrive as the first items; Edit Notes, clip tracker (Episode Tracker), Review Thread.
* Marketing and distribution: Release Plan, Platform Status, Archive, Production Report (document with lessons learned). Equipment not returned after the show is flagged by checkout.
* Creation asks for mode: Recurring Show (for example Friday Vespers), One-Time Event, or Multi-Day Event (section 7).

## 10. DOF Music

Build the same skeleton (item list is songs or tracks, sessions are recording sessions, call sheets, Storyboard and Shot List optional) with all labels and sections in category configuration. I will tweak DOF Music and Live Show details later, so keep them configuration-driven, not hard-coded.

## 11. Equipment: Lending (replaces General Use)

* New Lending tab in Equipment. A loan has its own number (for example DOF-LOAN-0001), no Content ID. Fields: borrower name, phone, organisation, items (with quantity), date out, expected return, condition at checkout and at return, notes, lent by. Check-in supports partial returns.
* A lent item shows as unavailable in booking and in the conflict check. Booking an item that is lent out warns with the return date.
* Overdue loans appear in the Calendar and the urgency report; reminders fire before the return date.
* Printable loan receipt with a signature line.
* Convert or archive existing General Use records (report for my decision).
* Checkout of equipment for productions keeps working as today; show items not returned after an instance on the call sheet and in the urgency report.

## 12. Calendar (absorbs Reminders)

* Views: Timeline, Month, Week, Day, Agenda. Large and uncluttered: full page width, filters in a collapsible strip, generous row height.
* Timeline: projects as continuous bars from start date to due date, in lanes, coloured by stage or urgency; expand a bar to show episodes, sessions and call sheets as dated markers. Click opens the item.
* Items on the Calendar: project start and due, production instances and call sheets, episode due dates, review dates, loan returns, standalone reminders.
* Reminders attach to any dated item (rules: at the time, 1 hour, 1 day, 1 week, custom) or stand alone ("+ Reminder"). Channels per reminder: in-app (bell and badge) and email. Email needs a sending mechanism: find what exists; if none, add configurable SMTP in Settings with a queue and retry, and report this to me. Quiet hours and per-user preferences in Settings.
* Google Calendar sync: optional, per user, off by default. OAuth, one-way push to a dedicated "DOF Production Hub" calendar. Sync only items with dates: production instances and call sheets, due dates, loan returns. Date-only items become all-day events. Updates and cancellations propagate. Never import Google events into the pipeline. Two-way is a later phase.
* Urgency report (printable, filterable by type, sortable): each project gets a level (Critical, High, Watch, On track) and a plain-language reason. Use transparent rules, not AI. Seed rules: Critical: an episode overdue; a session or live show within 24 hours with no published call sheet or unassigned items; Critical or High: a lent item overdue, a gear conflict on an upcoming date; High: due within 48 hours; no producer named after Greenlight; Watch: theological review not done; items not assigned to a session; call sheet details missing; no recording date within 14 days of a due date. Example reason text: "Recording in 3 days. 2 of 5 devotions not assigned to a session. Theological review not done." Rules and thresholds live in configuration.
* Migrate existing reminders and keep their repeat settings.

## 13. Documents module: templates

* Documents gets a Templates area. Storyboard and Shot List can be created there with no Content ID, or saved as a template from any project board or shot list ("Save as template").
* "Use template" in a project creates a copy; editing the copy never changes the template.
* Optional standalone (no project) storyboards and shot lists for practice and events.

## 14. Gates, review and handoff

Hard gates only:

* Series and Documentary: logline and core question written; Greenlight recorded as Greenlight and a show producer named.
* Devotion: guest name and contact filled in; at least 5 devotion pages each with title, scripture and script text.
* Live Show: show date set and producer named. The existing "Done: move to Pre-production" button stays and enables when these pass; the "Still needed" list shows only these. Theological review is not a gate. It remains a document with named reviewer, inline comments per page, one Approve for the whole document, and Request changes (reason required). While it is not approved: show a persistent "Theological review not done" banner on the project, Project Home and board card, and list it in the urgency report. When someone schedules a session, publishes a call sheet, or publishes an episode, ask "Theological review not completed. Continue?" with a short note; record the note; never block. A page edited after approval shows "edited after approval". Devotion acceptance: Accept or Decline. Decline needs a reason, closes and archives the project (never deletes). Accept creates one flat devotion per script page with its own Content ID, with title, scripture and script carried over and the script attached; all start at Pre-production. Share link: a read-only link for a guest or reviewer if the existing mechanism supports it; otherwise list it as a follow-up.

## 14A. Checks panel (collapsible)

The long lists of checks (Development "Still needed", Handoff, soft nudges, call sheet warnings, Recording Log warnings, Tech Check issues) take too much screen space. Replace them with one reusable Checks panel:

* Collapsed by default to a slim bar under the stage tracker: "Checks: 2 required, 4 suggestions", or "All clear" in green. The bar is the only thing that takes space.
* Clicking opens a dropdown (anchored popover on wide windows, inline expand on narrow ones) with two groups: Required to move on (the hard gates in section 14) and Suggestions (soft nudges, including "Theological review not done"). Each item has a label, a short reason, and a Go to link that jumps to the exact document, page or field. Suggestions can be dismissed with an optional note. Done items collapse into "Completed (n)".
* It opens automatically when the user presses the move-to-next-stage button while required checks are unmet; otherwise it stays closed. Remember open or closed per project.
* Manual handoff items (outline locked, owner and resource commitment confirmed, show producer named) appear as checkable rows inside the panel, with a note field in the expanded row. Derived checks are read-only.
* Maximum height with internal scroll. It must never push page content down by more than the one bar.
* Keyboard and accessibility: `aria-expanded`, Esc closes, arrow keys move between items, counts announced.
* One evaluator and one component serve every stage and type; call sheet and Recording Log headers show a small count chip that opens the same panel. Rules live in configuration, reusing the hard-gate evaluator.

## 15. Storyboard page

Left pane lists boards with frame counts and "+ New storyboard"; main area has "Select all" and a responsive grid (3 columns when wide). Frame card: header "Sc. # · Frame N", a 16:9 image area (click, drag-and-drop, replace, remove), then Description, Sound effects and Video link fields. "+ Frame"; drag to reorder; a menu per frame (Duplicate, Move, Delete); multi-select for bulk delete and move; editable board name; autosave; optional link to an episode.

## 16. Shot List page

Left pane lists shot lists with shot counts and "+ New shot list"; main area is a table: Image, Shot (auto-numbered, counting only shot rows), Description, Shot size, Shot type, Movement, Est. time, row checkbox and menu. Footer: + Shot, + Setup (full-width row for lighting, lens or camera notes), + Banner (full-width divider). Dropdowns with free-text fallback; seeds: size (Wide, Medium, Close-up, Extreme close-up), type (Eye level, High angle, Low angle, Over the shoulder), movement (Static, Pan, Tilt, Dolly, Gimbal, Handheld). Drag to reorder; est. time total at the bottom. Call sheets read lists; they never edit them.

## 17. Forms that stay forms

Recording Log (replaces Session Log and Storage), Episode Tracker and Cut Tracker (stage dates, assignees from the Crew dropdown, review link and share link per episode, the parallel Sound Mix exemption), Platform Status, Archive, Recording Day View, Equipment inventory and checkout, Crew. The Calendar remains a derived query: do not change how dates are produced.

## 18. Delivery plan (stop for my review after each phase; each phase behind a feature flag)

0. Audit report (section 0).
1. Schema, services and migrations with dry-run reports; no UI change.
2. Shell: sidebar, profile-menu Settings, command palette.
3. Editor shell, rich-text editor, autosave and keyboard behaviour; Devotion documents first.
4. Production system core: Recording Plan, call sheets, run of show, print, soft warnings, confirmations, change log, duplicate, locations; Devotion first, then Series and Documentary. Then the Recording Log, Storage assigned in Production, and Import existing project (section 7A), including migration of Session Log and Storage.
5. Series and Documentary catalogues, Greenlight, hard gates, theological reminder, handoff, and the collapsible Checks panel (section 14A) applied to every stage.
6. Storyboard, Shot List and Documents templates.
7. Equipment: Lending, role kits and suggestions.
8. Calendar: views, timeline, reminders, alerts, email, urgency report, Google Calendar one-way sync; then remove the Reminders module after approval.
9. Live Shows: three creation modes, recurrence and template, Broadcast Plan, Tech Check, Rehearsal Log, Live Day; DOF Music skeleton. 9b: Live Control.
10. Remove the old Development UI and the General Use category after approval.

## 19. Acceptance checklist

* An existing Series project keeps all former Development data in the Show Brief; stage names unchanged.
* Devotion: write 5 devotions, assign them across 2 sessions (3 and 2); both call sheets show the right episodes, roles, run sheet, chosen storyboard and shot list. Moving an item updates both. Unassigned items are flagged.
* Recurring Show: create a weekly show from a template; future instances generate automatically; edit one occurrence without changing others; edit "this and future" and see the template and later instances change; skip a date.
* One-Time and Multi-Day events create 1 and N instances, each with its own call sheet and run of show.
* Print call sheet and print run sheet only produce clean pages for any user who can view the project.
* Greenlight works without theological review; the banner shows; the ask-and-note appears when scheduling or publishing and never blocks.
* Lending: lend an item, see it unavailable in booking, return it, see an overdue loan appear on the Calendar and the urgency report.
* Calendar: project bars span start to due; reminders arrive in-app and by email; Google sync pushes a session and updates it when the date changes; the urgency report gives a level and reason per project; overdue still comes from episode level.
* Existing reminders and General Use records are migrated or archived with nothing lost.
* Formatting survives save, reload, print and a paste from Google Docs. Typing is never lost on a failed save.
* Light and dark themes legible; icon buttons labelled; full keyboard navigation; Ctrl+K and Ctrl+, work.
* Recording Log: for a planned session it is pre-filled from the call sheet; for an imported project it works with no plan or call sheet. Moving to Post production creates one tracker episode per recorded item and carries pickups into Edit Notes.
* Storage in Production: choose a drive, see its linked projects with the right one pre-selected, confirm; add a new project to the drive; assign a backup; tick Offloaded and Backed up. The Pre-production stage has no storage step. No duplicate storage records appear in Storage & Media.
* Import existing project: import a folder from a drive, start at Production and at Post production; skipped stages are not errors; no theological review banner when marked reviewed before the system; past dates create no reminders or Google events.
* Checks panel: collapsed by default with correct counts; opens when moving a stage with unmet required checks; Go to links land on the right field; the Development screen no longer shows a long checklist; it works the same in every stage and type.
* TypeScript or equivalent compiles with no new errors; existing tests pass. Add tests for migrations, hard-gate evaluation, recurrence generation, assignment rules, and urgency rules.

## 20. Ask me, do not assume

The real stack and email capability; whether Storage & Media holds real folder and file data or manual records, and whether the app can read or create folders on the drives; today's Call Sheet fields and run sheet template; the Documentary page names; whether episode-specific storyboards are wanted; recurrence window size and what happens to past instances when a template changes; how the board handles recurring instances; Google OAuth setup details; DOF Music and Live Show specifics; how to treat old tables after migration.
