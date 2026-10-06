# QA report: the five-stage workflow

Phase 6 of the workflow brief: its tests and acceptance (section 11), each item with the tests that cover it, and the
definition of done. Run on branch `claude/dazzling-noether-fz8hva`, 3 October 2026, after the sample data was moved
into the workflow (as approved). The documents rework has its own phases; its tests are listed at the end.

How to run everything: `npm run check`, `npm run lint`, `npm test`, `npm run build`. One file: `npm test -- <name>`.

## Definition of done

| Item | Result |
|---|---|
| Typecheck (app and server) | Passes |
| Lint | 0 errors; 2 warnings that were there before the workflow (`Accounts.tsx`, `AppContext.tsx`) |
| Tests | 41 of 41 files, all pass (after documents Phase 5) |
| The Whispers of Why fixture passes in tests | Yes: `workflow-services`, "Whispers of Why, Season 1, end to end" |
| The fixture passes by hand | Yes, clicked through in a real browser on the hosted site, to publishing and the share link: 30 of 30 checks (below) |
| Live Session and Music behave exactly as before | Yes: their own tests pass unchanged, and the sample's Live and Music records are identical before and after the move |
| Migration reconciliation: zero unexplained rows | Yes: 0 rows not accounted for, 0 for a decision by hand, on the sample data |
| No console errors in any flow | None, in every browser run below |

## Section 11, item by item

| Brief asks for a test of | Covered by (file: test) |
|---|---|
| ID generation, and permanence on rename | `workflow-services`: "codes come from the project's Content ID, and renaming changes no code"; "a devotion's days and a documentary's film are numbered under their own project"; "session codes, planned and episode numbers stay unique when the same project is used hard". `workflow-model`: "sessions, planned episodes and episodes are numbered from the project's own Content ID, at least two digits" |
| Each gate, passing and failing | `workflow-services`: "Development gate: lists everything missing, and passes once it is all there"; "Pre-production gate for a session"; "Production gate: the whole wrap checklist and a status on every row"; "Editing, Post production and Marketing gates"; "a testimonial cannot be greenlit until consent and release is complete"; "a DOF-made documentary records nothing until its second greenlight"; "dates after the publish date are warnings, never blockers". With the documents in use: `documents-gates` (the short gates, overrides, a devotion's Accept) |
| The split: the right episodes | `workflow-services`: "closing a session: Recorded and Pickup needed make episodes, Not recorded makes none and stays free" |
| The split: skips Not recorded | Same test |
| The split: idempotent on a second close | `workflow-services`: "closing twice never makes an episode twice" |
| The split: rolls back fully on failure | `workflow-services`: "a close that fails part way changes nothing at all". `workflow-model`: "a change that fails part way leaves the data exactly as it was" |
| Reopen rules | `workflow-services`: "reopening is allowed only while every episode from the session is untouched" |
| Unique constraints | `workflow-model`: "uniqueness: a planned episode number, an exclusive role, a log row per episode, an episode number, a share token". `workflow-server`: "a save that would break a uniqueness rule is refused, and nothing in it is saved". `workflow-services`: "one person per role"; "a planned episode goes in one session's log once" |
| URL validation (reject `javascript:`, `file:` and others) | `workflow-services`: "links: only http and https web links, everything else refused"; "an episode's links are checked when saved". `documents-editor`: links typed into the editor |
| Share token: unguessable | `workflow-http`: "share links: … no browser can choose a token". `workflow-services`: "share tokens are never made in the browser" (128 random bits, made by the server) |
| Share token: a revoked token fails | `workflow-http`: "revoking stops a link; making it again replaces it". `workflow-services`: "a share token resolves to its own episode only; revoked or unknown tokens resolve to nothing" |
| Share token: resolves only its own episode | `workflow-http`: "a share link is made by the server, opened by anyone, and reaches its own episode's file only" |
| Review-window auto-Hold | `workflow-services`: "a review window that passes with no decision moves the project to Hold, once, logged as the system". `workflow-http`: on the server's first request of the day, and the daily cron |
| Date handling around midnight in Africa/Nairobi | `workflow-services`: "around midnight in Nairobi, on a computer on UTC, today and the review window follow Nairobi". `workflow-model`: "the date is Nairobi's, around midnight, wherever the code runs"; "date arithmetic is by the calendar" |

### The end-to-end fixture: Whispers of Why, Season 1

30 planned episodes of 58 minutes, six sessions of five. `workflow-services`, "Whispers of Why, Season 1, end to end:
greenlight, roles, two sessions, review, publish, numbering" walks the brief's steps: create and greenlight; Operations
names a producer; the producer assigns roles; Pre-production for session 1; the session 1 log with one Pickup needed
(a dated note) and one Not recorded; close; four episodes with their notes; a review link on one; review; a share link
that reaches that episode only; publish; session 2, with numbering carrying on without gaps or duplicates.
`workflow-model` checks the fixture fresh from Development and after session 1. The walk through to publishing and
the share link was also clicked through in a browser against the hosted site (the 30-check run below); numbering into
session 2 is checked by the test.

## In a real browser

Built app, Chromium. "Hosted" is the real server and database code with data in memory; "demo" is the browser-only
app the desktop app runs. Every run checks there are no errors in the page.

| Run | What it covers | Result |
|---|---|---|
| Workflow screens (hosted) | The fixture walk by clicking: project, form, greenlight, roles, sessions, call sheet, gear, log, close, episodes, review, share link, publish; phone widths | 30 of 30 |
| Board, calendar, reminders, dashboard (hosted) | The five-stage board, overdue for episodes only, the calendar, the bell, reminders, search | 31 of 31 |
| Sample data and the move (hosted and demo) | A new site and a fresh demo start in the workflow; Settings has nothing to move; Live Shows and Music unchanged; the demo still moves the earlier examples, keeping a copy | 20 of 20 |
| Smoke (hosted) | Sign-in, photos, document history, a checklist item saved with its ID, compression, error recovery | 11 of 11 |
| Sharing in the demo | No server: the hosted file's link is copied and recorded | 6 of 6 |

## Changes made in this phase

- The sample data is moved, as approved (`src/data/sampleData.ts`): the demo, the desktop app and a new site with
  sample data start in the workflow. The earlier examples stay in `src/data/seed.ts`; the tests of the earlier
  pipeline start from them explicitly (`tests/support/earlier-examples.ts` for the server's), so they test what they
  always tested.
- The demo's data is read the first time it is needed, not while the app's files load; building the moved sample at
  load time met code that was still loading.
- Two browser checks were brought up to date with changes asked for since: sessions are never overdue (documents
  rework), and the sample series is on the new board.

## Not covered, or to do by hand

- The move against a real MongoDB copy (`hub_items_before_workflow`): it uses the same copy code as the version 15
  upgrade, which the storage tests in CI cover against MongoDB.
- The desktop app itself: the same code as the demo; its build is checked, not clicked through.
- The live site's own move: the Head of Production presses Move in Settings after reading the dry run.

## The documents rework so far

| Phase | Tests |
|---|---|
| 1. Data, services, the move | `documents` (15): the cleaner, pages, links, reviews, storyboards and shot lists, a devotion's episodes, every old field written or kept, safe to run twice, undone exactly |
| 2. The editor | `documents-editor` (12): what a paste keeps, the setting, the content dot, links and colours, the screens; plus browser runs of writing, saving, refusals, printing and both themes |
| 3. Gates and review | `documents-gates` (14): the short gates, passing by hand, the review and comments, Accept and Decline, the shared theme, Waiting on; plus browser runs, hosted and demo |
| 4. Storyboard and Shot List | `documents-tools` (4): where pictures may come from, both screens for writers and readers, shot numbering and times, starting from a copy; plus browser runs in the demo (28 checks) and on the hosted site (6) |
| 5. The later stages | `documents-stages` (5): a day sheet per session with the run sheet and wrap as the session's forms and its notes from the daily log, the forms' rules, the Review Thread's page per episode (added, never taken away, nothing made for a reader), each episode's review above its page; plus browser runs in the demo (24 checks) and on the hosted site (8) |
| 6. The old Development screens removed | Data version 17: the move runs for every workflow project not yet moved, a brief only opened is made again, a brief written in keeps the old form on an "Earlier Development form" (and a devotion's script gains no pages), undone exactly; the short gates everywhere, a testimonial's consent as a hard gate, episode reviewers from the brief; tests updated across `documents`, `documents-gates`, `documents-editor`, `workflow-services`, `workflow-model`, `workflow-server`, `workflow-views` and `workflow-screens`; plus a browser run of the upgrade in the demo (docs6) |
| 7. A devotion's Recording Plan | `recording-plan` (10): the six roles listed on Accept, renamed, added, removed and each needing someone from the crew (a series keeps its required roles); five devotions split three and two, moved by ticking, unticked as a note on the gate and never a block; a devotion recorded or on a started session stays, removing a planned session frees its devotions; a call sheet made once a session has a date and kept to it while a draft; recording rows following the ticks until the run sheet is changed by hand, "Rebuild from episodes", the times read from it; each session's storyboard and shot list from its own project; phones shown only where the privacy rules allow, printing for anyone who can see the project, the call sheet and the run sheet alone; the planned drive, a session's footage once recording starts, an episode's edit assets, "Use storage" required, a drive's removal clearing the plan; the calendar unchanged. `workflow-model`: data version 18 (call sheets into sessions with their checklists, nothing guessed, runs twice unchanged). `actions`: the ten new actions through the hosted server. Plus a browser run in the demo (docs7) |

Browser runs on the Phase 6 build, all passing: 316 checks across 15 scripts, among them the Recording Plan in the
demo (docs7, 30 checks: the plan's cards, roles, five devotions split and moved, the call sheet's times and recording
rows, boards chosen, + Row and Rebuild, printing both ways on a white page, the footage drive, a session's footage, an
episode's edit assets, a phone with no sideways scroll, and dark mode). Two scripts timed out on the first run while the
unit tests ran beside them (the sign-in form was not drawn in time); run alone, both pass.

Browser runs of the documents, all passing on the Phase 4 build: writing and saving in the demo 45 of 45 and hosted
21 of 21; gates and review in the demo 32 of 32 and hosted 12 of 12; Storyboard and Shot List in the demo 28 of 28
and hosted 6 of 6. Each run starts its own server and stops it afterwards; a server left running from an earlier run
had picked up file changes, and the page and the test then held two copies of the data (the cause of a false failure
in the save-conflict check, which passes).

## One production system (Phase 1: the production core)

| Area | Tests |
|---|---|
| Recurrence | `recurrence` (8): weekly on chosen days and every N weeks keeping its rhythm, ending on a date or after a number of times, dates left out (still counted) and added, monthly by date (a short month using its last day) and by the first to fourth or last weekday, rules that cannot work refused in plain words, the rule in a sentence |
| Productions | `production` (8): a one-time event's one day and call sheet, due around its own date; a multi-day event's days, Event Plan and a day added copying the day before (renumbered); a recurring show's 12 weeks of days made once and topped up later; a template change reaching only coming days still following it (ticks kept, edited and final days kept), crew attached to the show, put back on the template, a day's date moved by hand; a new schedule archiving untouched days, keeping edited ones, and bringing them back; template gear booked within two weeks, never double-booked, released when the template drops it; every section copied by Duplicate with nothing ticked; data version 19 |
| Screens | `production-screens` (5): the recurring show's panel, the board's fortnight, the template page, every call sheet's ten sections and the day's place on its template, an event's plan and day tabs, a one-time event, printing any sheet and its run sheet alone |
| Elsewhere | `actions`: the eight new actions and every call sheet section through the hosted server. `workflow`: any call sheet can have a run of show, a large production cannot be final without one. `workflow-model`, `workflow-server`, `storage`, `migrate`: data version 19. `recording-plan` and `workflow-screens`: the shared sections and the new Live Shows form |

In a real browser (prod1, demo, 20 checks; 336 checks across all 16 browser scripts, all passing): a recurring show from the New form, its 12 weeks of days, a template change
(crew with a role, talent, location) reaching them, a day edited by hand and passed by, then put back; ticking the
technical check not counting as an edit; printing; the board's fortnight; a multi-day event with its plan and a day
added; a one-time event; a phone with no sideways scroll; dark mode.

Not covered yet: DOF Music keeps its own pipeline (see the Phase 1 notes).

## One production system (Phase 2: call sheet improvements)

| Area | Tests |
|---|---|
| Call sheets | `callsheet-improvements` (11): a sheet duplicated a week on with every section, ticks and confirmations cleared, and gear booked elsewhere skipped, never double-booked; a session duplicated with its run sheet and call sheet but not its episodes; warnings for a missing call time, location, crew and lead, and unconfirmed crew within three days, none once the day has passed, and a sheet with warnings still made final; who may confirm for whom, a final sheet taking confirmations, the version unchanged and the day still following its template; each kind of change clearing only the confirmations it affects (role, talent call, crew call, place, taken off), each logged with who; a template change clearing them too; the change log for date, times, location, crew, roles, talent and run of show, only once shared or confirmed, newest first; saved locations kept by crew and the Head of Production, unique names, picked, unlinked by a hand edit, archived and brought back; gear suggested one per person, a body before a lens or tripod, skipping what is on the sheet or booked elsewhere; data version 20 |
| Screens | `production-screens` (6 with one new): the warnings summary and its lines, a confirm tick per person, names that open the contact card, the saved location picker, gear suggestions, "Will you be there?" for crew on the sheet, and the change log with a cleared confirmation |
| Elsewhere | `actions`: the five new actions through the hosted server. `workflow-server`: a partner is sent no saved locations but those on their sheets. `workflow-model`, `workflow-server`, `storage`, `migrate`: data version 20 |

In a real browser (prod2, demo, 22 checks; 358 checks across all 17 browser scripts, all passing): the warnings
summary and section lines; crew put on with roles; a saved location picked; gear suggested and added in one click;
a crew member's contact card; a confirmation recorded by the Head of Production and one by the crew member themself;
the sheet shared, reopened and changed, its confirmations cleared and the change log showing who changed what; a
sheet duplicated a week on; a saved location added and archived; a recording session duplicated two weeks on; a phone
with no sideways scroll; dark mode.

Not covered yet: alerts to crew when a shared sheet changes (in-app and email) come with Phase 4's alerts.

## The rework, build prompt v2 (Phase 1: foundations, no screens)

| Area | Tests |
|---|---|
| Foundations | `rework-foundations` (14): data version 21 adds the lists empty, marks boards as a project's own, changes nothing else, runs twice the same; the dry-run report lists each General Use record with its proposal, and what is stored of reminders; a part not built stays off whatever is stored, and only the Head of Production switches parts; sessions and show days read the same way, with their status; a lent item unavailable to bookings with the borrower and return date named, lending refused for booked gear and for volunteers, retiring refused while lent; partial returns, a late loan held until checked in, overdue, closed when all back, condition taken; keeping a loan longer only if free, calling it off; a role kit offered item by item with what is not free marked, nothing booked; a reminder on a session firing into each recipient's bell and following the session when it moves; email reminders a day or more ahead, queued by the morning run before they are due, never twice, repeating ones moving on; the email queue sending once, leasing, retrying five times, holding quiet hours; the urgency report's levels and reasons, late loans, most urgent first, thresholds from settings; storyboard and shot list templates copied into a project, never changed by the copy, kept by crew and the Head of Production |
| Server | `workflow-server`: the morning run emails a reminder once, through the queue, which is never sent to a browser, and the bell gets it at its time, one's own only; templates go to the team, not to partners. `actions`: the fourteen new actions through the hosted server |
| Elsewhere | `workflow-model`, `workflow-server`, `storage`, `migrate`: data version 21 |

Checked by hand against section 4 of the brief, the editor: the toolbar (undo, redo, block style, text size, bold,
italic, underline, strikethrough, colour, highlight, alignment, bullets, numbers, checklist, indent, outdent, link,
clear formatting), its shortcuts, saving 800 ms after the last keystroke with "Saving…" and "Saved @", "Save again" on
a failure with the words kept, the warning before leaving, and pastes cleaned, are all there. Not there yet, for
Phase 2: Ctrl or Cmd+S to save at once; Enter in a single-line field moving to the next, Esc putting the field back;
Ctrl+Enter saving a multi-line field; Enter at the end of a run sheet or shot list row adding a row below. (All in
Phase 2, below.)

## The rework, build prompt v2 (Phase 2: shell, call sheets open until Post production, keys)

| Area | Tests |
|---|---|
| Shell and search | `shell-keyboard` (13): the shell ships on, only the Head of Production switches it, and switching changes no data; a part not built stays off; General Use stays in the pipeline until lending replaces it; with the shell on no Settings in the side menu, a profile menu and a search button, and off, as before; search finds projects and episodes apart, the five-stage documents (only on projects the person may see), crew (for those who may see the People page, no contact details), loans (by borrower, organisation or number; never for volunteers), each with where it opens; the palette's commands, none for Equipment for a volunteer, and printing today's run sheet; a dialog's buttons in its own actions row |
| Call sheets | `shell-keyboard`: a published sheet stays editable and offers Back to draft; locked once its session closes, saying why and offering nothing; a show day's sheet locks at Post Production; a sheet linked to nothing never does. `callsheet-improvements`: changes refused on a locked sheet (fields, confirmations, gear on and off), allowed again when the session reopens. `rules`, `workflow`, `production`: a published sheet editable, its changes logged, put back on the template |
| In a browser (Phase 2) | `shell-keys` (37 checks): the side menu, the profile menu, Ctrl+, and Ctrl+K (typing, Enter, Esc, a command); the call sheets filters; Enter adding a row in a run of show, a session's run sheet and a shot list with the cursor in the new row; Enter moving on, Esc taking back, Ctrl+S saving; publishing refused by Enter and done by Ctrl+Enter; a deletion refused by Enter, cancelled by Esc; a closed session's sheet locked; the switch in Settings; a phone. `prod2`: Finalize asks first, Enter alone does not publish, a published sheet edited in place |

## The rework, build prompt v2 (Phase 3: the theological review as a reminder, not a gate)

| Area | Tests |
|---|---|
| Not a gate | `review-reminder` (11): a documentary's gates are its idea and the greenlight, recorded before the review; switched off, the review is a gate again and there is no reminder; a devotion accepted without it; a project and each episode show it not done until approved, with where it stands; the urgency report watches it until approved; scheduling a session and publishing its call sheet go ahead (a session's sheet answers to its season); going ahead keeps who, what, when and the note (trimmed to 300), newest first, an episode's on its project, in the activity log, never by someone who may not write; nothing to note once approved; a page changed after the approval says so, the others do not; the banner with the notes and "Open the review", gone once approved; the board card; the review decided after Development while not approved, then kept as it was |
| Gate mode | `documents-gates` runs with the switch off: the review as a gate, as before. `workflow-services`: the Development gate's short list without the review, the greenlight refused only for the idea |
| In a browser | `review` (17 checks): the banner and Open the review; the review decidable after Development; the board card; scheduling a session asks, Cancel stops it, Continue (with Enter) schedules it and keeps the note; publishing a call sheet asks instead of the usual confirmation, Enter alone does not publish, Publish anyway does and keeps the note; the notes listed under the banner; approving removes the banner; a page changed afterwards marked in the list and the editor; once approved, publishing asks only the usual confirmation |

## The rework, build prompt v2 (the rest, built together: data version 22)

| Area | Tests |
|---|---|
| Unit | `rework-build` (17): the Recording Plan for series and documentaries in their own words; Live and Music on the five stages with their checklists; version 22 moving a live record's stage, checks, deadlines, owners, checklist and documents and the workload estimates, running twice the same; the live gate (date and producer); daily repeat; the next 8 dates; this and future; cancelling a date and a day's label; the live run-of-show columns, bad values refused; General Use to loans, open lists released, running twice the same; Lending and Role kits on screen, the receipt, switched off; a role kit offered on a call sheet; Templates saved and used, the copy never changing the template; a recurring show on its dates only, a multi-day event one bar with its days; loans and reminders on the Calendar, its views; legacy approvals counted and a new review flagged; the card's tag a button. `server`: Google Calendar updates an event where it is and never adds one twice. Elsewhere: the tests that named the earlier live and music stages, the 12-week window and version 21, brought up to date |
| End to end | `full-flow` (43 checks, against the real server): a series made on screen; greenlit without the review, the banner and the card's tag; Done to Pre-production; the Recording Plan's roles, episodes, a session scheduled (asked, note kept), episodes ticked; its call sheet made and published (asked, Enter refused, Publish anyway), still editable; recording started, statuses, wrap, closed into episodes, the sheet locked; an episode through editing, both reviews, release plan, distribution, published before the review (asked, note kept; three notes on the project); the review approved after Development, the banner gone; a second episode published with only the usual confirmation; the Calendar's views, a reminder set, the urgency report, an old Reminders link; Live Shows on five stages; Lending and Role kits; Templates; no errors |
| Browser | The whole browser suite on this build, all passing: 458 checks across 20 scripts (documents in the demo and hosted, production, call sheets, the shell and keys, the review, the full walkthrough, the earlier phase walkthroughs, sharing). The earlier scripts were brought up to date where this work changed what they looked for: the review now off the gate and a review asked again after an earlier approval, the Recording Plan in place of the Roles and Sessions forms, Live and Music on five stages, the next 8 dates, data version 22, and old Reminders links opening the Calendar's Reminders. One hosted shot-list check missed under load in the full run and passed when run again |

