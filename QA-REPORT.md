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

Browser runs of the documents, all passing on the Phase 4 build: writing and saving in the demo 45 of 45 and hosted
21 of 21; gates and review in the demo 32 of 32 and hosted 12 of 12; Storyboard and Shot List in the demo 28 of 28
and hosted 6 of 6. Each run starts its own server and stops it afterwards; a server left running from an earlier run
had picked up file changes, and the page and the test then held two copies of the data (the cause of a false failure
in the save-conflict check, which passes).
