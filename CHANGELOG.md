# Changelog

What changed in each version, newest first. How to deploy is in GO-LIVE.md.

## Unreleased: documents for each stage (the documents rework)

Being built in phases. The five stages, their names and order, the stage tracker, Content IDs and every form that
drives the calendar, reminders, call sheets, gear, storage or overdue stay as they are.

**Phase 1: the data, the services and the move** (data version 16; no new screens yet)
- New lists: project documents, their pages, links, theological reviews and review comments, storyboards with
  their frames, and shot lists with their rows. All start empty. Which documents, tools and forms each kind of
  project has at each stage is set in one place, `src/config/documentCatalog.ts`. A document is made from it the
  first time it is opened, with its starting pages; people add, rename, reorder and delete pages. A deleted page is
  kept, archived, and can be restored.
- Page writing is stored as HTML cleaned to the editor's allow-list (DOMPurify) on every save, in the browser and on
  the server alike: no scripts, no event handlers, links to http, https and mailto only. A page save carries the
  version it started from; one made from an older version is refused, and the writer's words stay on screen.
- Theological Review: named reviewers from the crew list, each with one decision on the whole document (Approve, or
  Request changes with the reason); comments beside a page that can be resolved and stay. The show producer or the
  Head of Production names the reviewers, and a reviewer joins the project so they can read it and decide. The same
  now holds for the workflow's review checkpoints: before, a reviewer who was not on the project could not decide.
- Storyboards and shot lists, per project or per episode. A new one can start as a copy of an existing one from any
  project the person can see, so frames and shots can be reused.
- Devotions: the Devotional Script has one page per devotion (title, scripture, script). In Pre-production its pages
  become the devotion's list of episodes, each given its Content ID there and then; the episode is made under that
  ID when its recording session closes.
- Sessions are never overdue. Overdue is worked out for episodes only (and a devotion's episodes); the session
  badges, reminders and dashboard counts for late sessions are gone.
- The move: every field of the old Development forms is written onto a page of the new documents (the six criteria
  onto Greenlight, a devotion's message-review notes as a review comment, the camera plan into a shot list), or kept
  on the form: the header strip, consent and release, and the fields a gate or a later stage reads (the logline,
  the core question, a sermon's delivery). A field the mapping does not know goes onto "Also from the old form", so nothing is lost; the report counts fields
  not accounted for, which is always zero. The old forms are left exactly as they were. It runs as part of "Move
  existing projects" (Settings, or `npm run migrate:workflow`), with the same dry run, copy first and all-or-nothing
  save; running it again changes nothing. `npm run migrate:workflow -- --undo-documents` undoes it, keeping any
  document or shot list written in since unless `--force` is given. How: GO-LIVE.md.
- Upgrading saved data keeps a copy first: `hub_items_before_v16` and `hub_meta_before_v16` in MongoDB, and
  `dof-hub-db-before-v16` in the desktop app and demo.

## Unreleased: the five-stage workflow for series, devotions and documentaries

Being built in phases. Live Shows and Music work exactly as before. Series, devotionals and documentaries made
before the workflow keep their earlier stages until the existing data is moved over, which is a later, separate step.

**Phase 1: the data** (data version 15)
- New lists for the workflow: development forms, planned episodes, project roles, workflow checklists, recording
  sessions, session logs, theological review checkpoints and share links. Every record gains three empty fields:
  series type, project workflow and episode. All of it starts empty. Existing projects are not moved into the
  workflow; that is a later, separate step with a dry run.
- The workflow's stages, form types, roles and checklists are set in one place, `src/config/workflow.ts`.
- Sessions, planned episodes and episodes are numbered from the project's Content ID: `DOF-SER-001-S1-R01`,
  `-P01`, `-E01`. Codes never change on rename.
- The data keeps its own rules. Uniqueness (one episode per number per project, one person per role, one log row
  per episode per session, one use of each share token, and others) is enforced by MongoDB itself with unique
  indexes, and by the in-memory store the same way. Every save also checks that nothing points at something that
  does not exist. A change that breaks a rule is refused whole.
- Changes are all or nothing in the browser and desktop app too: if one fails part way, nothing of it remains.
- Dates are Nairobi dates wherever the code runs. Before, stage deadlines made between midnight and 03:00 landed a
  day early, and the server (on UTC) thought it was still yesterday until 03:00.
- Upgrading saved data keeps a copy first: `hub_items_before_v15` and `hub_meta_before_v15` in MongoDB, and
  `dof-hub-db-before-v15` in the desktop app and demo. `npm run db:upgrade` shows what the upgrade will do without
  writing anything; add `-- --apply` to do it.
- Sample data for the workflow, including the "Whispers of Why" season used by the tests: `src/data/seedWorkflow.ts`.

**Phase 2: the services and rules**
- Every step of the workflow as a service (`src/services/workflow/`): creating a project, its development form
  (checked field by field against `src/config/devForms.ts`), the greenlight, naming the producer, roles, checklists,
  review checkpoints, recording sessions with their run sheet, call sheet and log, closing a session, reopening it,
  a documentary's Send to post production, and each episode through Post production and Marketing and distribution.
- One gate decides whether anything moves on: `evaluateGate(stage, level, id)` returns what is missing; every Done
  action calls it. Dates after the publish date are warnings only.
- Closing a session makes an episode for every row Recorded or Pickup needed, numbered on from the project's last
  episode, with the row's notes; Not recorded rows make nothing. It is all or nothing, and closing twice never makes
  an episode twice. A session can be reopened only while its episodes are untouched.
- A review window that passes with no decision moves the project to Hold, logged as the system: on the server the
  first time anyone opens the site each day and from a daily cron, in the desktop app when it opens and hourly.
- Share links: on the hosted site, `/share/<token>` leads to one episode's hosted file and nothing else. The token
  is 128 random bits made by the server. Links can be revoked and made again. The desktop app copies the file's own
  hosted link instead.
- Links people paste are web links only: http and https. `javascript:`, `file:`, `data:` and the rest are refused.
- Who decides what, without new company roles: greenlight decisions, the Head of Production or anyone given
  "Create projects"; naming the producer, anyone given "Assign other people's work"; roles, the producer too;
  review checkpoints, the reviewers named on them.
- The earlier pipeline's actions refuse workflow records. A live recording split into a workflow season becomes its
  next episode. A new Devotional no longer gets a producer hard-coded into the app.

**Phase 3: the screens**
- Adding a series, devotion or documentary now starts it in the workflow: a series asks its kind (podcast,
  testimonial, sermon) and starts with Season 1; a documentary asks whether DOF makes it or it was pitched. A
  workflow series adds later seasons the same way. Live Shows and Music add as before.
- A project's page shows where it stands (worked out from its sessions and episodes) and has four tabs:
  - Development: the form drawn section by section from `src/config/devForms.ts`, each with what is still missing;
    the planned episodes; the six criteria; the pitch and outline review checkpoints with their reviewers; the
    review window and the decision (Decline and Advice only ask for a reason and a confirmation); the show producer;
    the handoff checklist; and the gate with its Done button.
  - Pre-production: the roles, each chosen from the crew list (hosts and guests may also be outside it), the
    project's checklist, a DOF-made documentary's second greenlight, and the sessions.
  - Sessions, and Episodes: the episode tracker, with each episode's stage, reviews, review link and share link.
- A session's page: the recording day (date, venue, episodes, guests, crew and contacts), the call sheet made from
  the Call Sheet module and its gear, the rehearsal checklist, the run sheet, the session log (episode, guest,
  status, notes for post production), the wrap checklist, the daily log, and Start recording, Close session and
  send to post production, and Reopen, each behind its gate and a confirmation.
- An episode's page: production notes, the editor, review and final file links (web links only, refused on screen
  as you type), the rough cut and final reviews (sending back asks for a reason), the post checklist, the release
  plan, distribution, publishing, learning notes against the brief's success measures, and share links: made,
  copied, revoked and made again on the hosted site; the hosted file's own link copied in the desktop app.
- Shared pieces: one Crew dropdown, a checklist with notes, a gate panel listing what is missing, and links that
  open in the person's own browser with no access back to the app (the desktop app uses Tauri's opener plugin).
- A call sheet made for a session lists the session's episodes and guests.
- On a phone, the top bar no longer pushes every page sideways.

**Phase 4: the board, calendar, reminders and dashboard**
- One list of the workflow's work, at the level each stage works at (`src/services/workItems.ts`), read by every view
  below so they agree: a project in Development and Pre-production, a recording session in Production, an episode in
  Post production and Marketing and distribution. Nothing is stored for it.
- The board for Series, Devotionals and Documentaries has the five stages, with those cards. A project stays in
  Pre-production while it has sessions to come or planned episodes still to schedule; a documentary whose sessions
  are all closed waits in Production to be sent to post production. Each card says who moves it on, its date, and
  what its next Done button still needs (or which review it waits for); the Done buttons stay on the pages, behind
  their gates. Published episodes and closed projects are shown on request. Items made before the workflow keep
  their own board underneath until the data is moved over. Live Shows, Music and General Use keep their boards.
- Overdue is worked out for sessions (date passed, not closed) and episodes (the stage's deadline passed, not
  published) only, never for a project. A project's card shows how many of its planned sessions are overdue.
- The calendar adds each recording session's day (a new marker) and the projects' and episodes' stage deadlines, in
  the category's colour, all worked out from the data. An episode no longer adds its session's day a second time.
- Reminders, the bell and the reminder emails and calendar files add: a session's day to its producer (unless they
  are on its call sheet, which already reminds them), a session not closed after its day, an episode's stage
  deadline to its editor in Post production and its producer in Marketing and distribution, a project's stage
  deadline to its owner until that day, and a waiting review to each reviewer named on it. The 24-hour lead time
  applies to all of them.
- The dashboard counts workflow projects in production, its late sessions and episodes, what is waiting on you
  (including reviews), sessions and episodes in Nearest deadlines, and sessions this week with no call sheet yet.
- Search finds recording sessions; the pipeline status report lists the workflow's work; crew workload counts a
  session's day before its call sheet exists, editing up to the Post production deadline, and release work up to the
  Marketing and distribution deadline. The per-episode estimates can be changed in Settings.
- A workflow series' page and the tree no longer show an empty "0 of 0 complete" progress.

**Phase 5: moving existing projects** (no change until the Head of Production moves them)
- Series, devotionals and documentaries made before the workflow can be moved into it, from Settings (the Head of
  Production only) or with `npm run migrate:workflow`. A dry run comes first: every record with its before and
  after, those left for a decision by hand and why, each part's row count before and after, and what to do
  afterwards. Moving keeps a copy of all the data first and is all or nothing; running it again changes nothing.
  How, and how to go back: GO-LIVE.md.
- The rules agreed in Phase 0: a series' season becomes the project; episodes not recorded yet become planned
  episodes; those at Recording go on an open session on their shoot date, with their call sheet; Ingest and
  Editorial become Post production, Review becomes Rough cut review, Delivered becomes Marketing and distribution.
  A devotional at Creation or Guest is in Development, at Prep/Scripting in Pre-production; a closed one is
  archived with its reason; a recorded one is left as it is, for a decision by hand. A documentary's film becomes
  episode E01 from Ingest on. Projects past Development count the gates they passed as met.
- Content IDs never change. An episode not recorded yet keeps its Content ID: its planned episode holds the ID,
  and the record becomes the episode when a session that recorded it closes.
- The hosted site now sends the workflow's archived records to those who may see them (a closed project, and an
  episode waiting to be recorded), so the board's Closed column and a closed project's page work there as in the
  desktop app. Other archived records are still not sent.
- An archived record can no longer be changed by the earlier pipeline's buttons; its page says why it is archived.
- A project with episodes and no sessions (one that was moved across) shows the stage its episodes are in.

## v20: security and reliability fixes from the October 2026 code review

Everything here is behind the scenes: screens look and work as before, with a few clearer messages.

**Security**
- The server now checks every change against a list of what each action may receive (`server/schemas.ts`). Anything else is refused or dropped, so nobody can change a field a screen does not offer, such as a project's stage, or call a function no screen uses.
- "Add and change people" and "Change system settings" can no longer be used to become Head of Production or to give yourself more access. Someone managing people can only manage logins for people with no more access than their own, and nobody but the Head of Production can touch the Head of Production's login or details.
- Wrong-password limits now hold when guesses arrive all at once, and a stranger can no longer lock the Head of Production out: the lock is on the username and address together.
- Contact details a person may not see are no longer sent as the word "Hidden", which an edit could save back over the real details.
- Gear added to a call sheet is booked against that sheet's real project and date.

**Reliability**
- The live site never turns into the demo when the server is slow or down; it says it cannot reach its data.
- New items get the same ID on screen and on the server. Archived projects no longer make the next project's number differ, and if two people create something at the same moment, the second is asked to do it again instead of being saved under a different ID.
- Data is stored one record per document, so no part can outgrow MongoDB's 16 MB limit, and saves only write what changed. People saving at the same moment all get saved.
- Photos are stored as files instead of inside the data. The download each person gets carries the newest 500 activity log entries and the newest 5 revisions of each document with their text; older revisions load when the history is opened.
- A page that fails shows a message instead of blanking the app.

**For whoever looks after the code**
- `npm test` runs every test file, with the clock fixed, and reports them all. New: security, actions, storage, and storage against a real MongoDB (in CI).
- `npm run lint` (ESLint) and `npm run format` (Prettier) are part of CI.
- The desktop build works again: `npm run tauri build`.
- See GO-LIVE.md, "Updating a site that is already live", before deploying this to a live site.


## v19: move equipment between categories, split condition by unit, share a link, and record storage ahead of a project

**1. Move an item to a different category.** Editing an item (single unit or batch) now lets you change its category, for example moving something from Camera into Studio & Set. Its asset code never changes, so its checkout history stays intact — only the category it is grouped and filtered under changes.

**2. A real "Copy link" button.** Every screen has a real, working address now, shown in the little link icon in the top bar. Click it to copy a link straight to whatever you're looking at — a project, a checkout list, an equipment item, a drive, anything. Send it to someone and, if they have access, opening it takes them straight there after they sign in. Before this update the app never changed its address at all, so there was nothing a right-click or "copy link" could actually capture — that's now fixed.

**3. Split a batch's condition by unit.** A batch of equipment (cables, and anything else added as "batch of identical items") can now have some units in one condition and others in another — for example 10 Good cables and 2 Fair ones — instead of one condition standing in for the whole batch. Open the item and use **Split condition by unit…** to set the counts directly, or just check equipment back in with a different condition than it went out in and the split updates on its own. The equipment list and reports still show one condition per item, now automatically the worst one present, so a batch with anything faulty in it is easy to spot at a glance.

**4. Record storage ahead of a project.** On the Storage and media module, assigning space to a drive now offers **No project yet** as well as **Tie to a project**. Use it for footage or files that exist before the production is set up in this system yet — it gets its own entry and its own id, counts toward the drive and the company-wide totals immediately, and needs only a short label (for example "Youth Camp 2025 raw footage") instead of a Content ID. Once the project is ready to be worked on, open the drive page and use **Attach to a project** to tie it to a real Content ID for the first time — its process can then continue from Recording. This is separate from General Use (v15): a General Use project is a real, if placeholder, project; this has no project at all until you attach one.


## v18: confirmed and tested — the checkout list and its printed report already show everything asked for

Checking a checkout list, on screen or printed, already shows equipment ID, item name, make/model, quantity, condition out, photos, accessories, and additional info for every line, grouped under a heading per equipment category (Camera, Audio, Cabling & Connectivity, and so on). This existed in the code already but had no test coverage and one broken test (a missing import, unrelated to the feature itself) — both fixed, and five new tests lock the behaviour in going forward, including a rendered PDF check.

If your checkout lists still look plain after installing this, it is almost certainly the browser cache from before — see the earlier note about hard-refreshing or checking in a private window.


## v17: fixed "Add at least one serial number" when adding a single item with no serial

Real bug, caught live: leaving both Serial number and Label blank on a single-item add silently dropped that row before it ever reached the server, so the form submitted nothing and showed a confusing "Add at least one serial number" error — for a field that had just been made optional. A blank row is now only dropped when there's more than one row (an unfilled extra row you added by mistake); a single blank row is always kept, since one item with no serial is exactly what "optional" is supposed to allow.


## v16: equipment updates — optional serial numbers, a fuller checkout picker, grouped by category

- **Serial number is no longer required** when adding equipment, one at a time or in a batch, or when editing an existing item. Leave it blank for gear that doesn't carry a serial. Duplicate-checking still runs whenever one is actually entered.
- **Checking out equipment now shows more**: condition is shown on every serialized item, and a **Details** toggle expands to show accessories, notes, and a photo when there is one. Make, model, and the equipment ID were already shown.
- **The picker is grouped by category** — Camera, Audio, Lighting, and so on each get their own heading, instead of one long flat list.


## v15: equipment, storage, call sheets and documents no longer need a real project up front

A new **General Use** project type: create one with its own ID when gear, storage, a call sheet, or a document needs somewhere to live before you know (or before it matters) which real production it belongs to — gear lent out for something that was never going to become a tracked production, for instance. It never shows up on the Calendar, in reminders, in anyone's workload, or with a risk badge, since there's no production to track.

**Attach existing** buttons on a project's Storage and Documents panels, and an **Attach to a different project** action on call sheets, move something from a General Use placeholder onto the real project once you know it (or move it between two real projects). Equipment checkouts already had this. A call sheet's gear now moves with it automatically when the call sheet itself is reattached.


## v14: fixed the blank-page crash

The site going blank was a real crash, not a build problem: the Devotional stage rename shipped without a data migration, so any Devotional saved under its old stage names (Idea, Scripting, Editorial, Delivered) had a stage name that matched nothing in the current pipeline. Workload's crew-schedule calculation, running on every Dashboard load, tried to read the previous stage's name off that and crashed — and with nothing catching it, React unmounted the whole page.

Two fixes: the crash itself can no longer happen anywhere a stage name goes unmatched (checked and hardened every place that indexes into a stage list), and there's now a proper migration that renames any old Devotional record to its current stage names on load, rather than just working around a record stuck with the wrong name forever.

If you already applied the one-line patch to `workload.ts` yourself, this update replaces it with the same fix plus the real one underneath it.


## v13: the Devotional pipeline is wired in

Kanban and Calendar now show the new Devotional flow (Creation → Guest → Prep/Scripting → Recording → Editing → Review → Published):

- **Guest** shows a reviewer-name field and an Approve button, plus a "Guest is non-compliant" action that requires a reason and closes the project. The ordinary advance button is turned off here on purpose — those two are the only ways forward.
- **Closed** projects vanish from the Pipeline board and the Calendar by default. A **Closed (N)** filter next to the category chips brings them back into view, each showing its reason.
- **Editing** shows the ready-for-review checkbox; **Review** shows Approve (only once that checkbox is ticked) and Send back, which requires a reason and resets the checkbox.
- No deadlines, overdue badges, staleness, or reminders anywhere in this pipeline, as asked — checked through the Dashboard, the reminders bell, the Calendar's deadline bars, and workload scheduling, not just the obvious places.


## v12: fixed a live show cluttering the calendar with a bar for every day

A live show with several days was showing a separate stage bar for each of its days ("Medical Missionary Movement, Day 2: Prep", "Day 3: Prep"...), stacking into a wall of near-duplicate bars. Now, same as the Dashboard, a multi-day live show shows as one bar with just the show's name — its days no longer add bars of their own. A show with only one day is unaffected.


## v11: Gantt-style bars on the Calendar

Multi-day items now draw as horizontal bars across the days they cover, instead of a dot on every day. Single-day items — a shoot day, a published call sheet, a gear booking — stay as small dots, exactly as before.

- **Production windows:** a live show running more than one day shows as one bar across its whole run, with its title readable right on the bar.
- **Stages in progress:** whatever stage an item is in now shows as a bar from when it entered that stage to its deadline, so you can see how long something has actually been sitting there, not just when it's due. A stage that hasn't started yet still shows as a plain dot on its deadline, since there's no start to draw a bar from.
- **Overlapping bars stack** into separate lanes automatically, so two things happening at once never collide.
- A bar that runs into the next week shows a small `‹`/`›` instead of a rounded end, so it reads as "still going".
- Bar label color (light or dark text) is chosen automatically per category color, so it stays readable whichever of the five category colors it is, in both light and dark mode.


## v10: CI, a self-checking codegen step, the equipment file split, and stage staleness

- **Continuous integration**: every push and pull request now runs automatically on GitHub (`.github/workflows/ci.yml`) — install, type-check, confirm the generated server-replay code is current, then the full test suite. A failing step blocks the run (and blocks merging, if branch protection is turned on for the repo).
- **`npm run gen:check`**: catches a service function that was added or renamed without running `npm run gen` afterwards, before it reaches GitHub. Run it yourself any time with `npm run gen:check`.
- **`src/services/equipment.ts`** is now three files under the hood (`equipment-items.ts`, `equipment-manifests.ts`, `equipment-reports.ts`), with `equipment.ts` kept as a plain pass-through so nothing elsewhere in the app needed to change. Behaviour is identical — this was purely a file-organisation change, checked against the original file's full export list to confirm nothing moved or went missing.
- **Stalled work is now flagged on its own**, separately from missed deadlines: a project that has sat in one stage for a long time — 2.5× longer than that stage normally takes — now shows a **Stalled** badge on the Pipeline board and on its own page, and nudges whoever is responsible for it with a reminder that says "no update in X days" rather than "due", since the cause is different. This catches stalls even when nobody set a deadline in the first place. Advancing or sending back a stage resets the clock. A longer effort estimate (Settings) raises the bar before something counts as stalled.

### To set up branch protection (optional, on GitHub)
Repo Settings → Branches → add a rule for `main` → **Require status checks to pass before merging** → select the `test` check once it has run at least once.


## v9: merged with the Calendar and personalisation work

This brings your `main` branch's Calendar module and personalisation (workspace accent colour, font pairing, per-person font size, density and profile photo) together with everything built in this update batch (the live-show workflow rebuild, equipment units, branding, dashboard and report changes). Nothing from either side was dropped.

One thing worth knowing: both sets of changes had separately used "version 9" for a database migration, for two different things. This update keeps your appearance migration at version 9 and moves the live-show migration to version 10, layered on top, so real saved data upgrades correctly either way.


## v8: the live-show workflow rebuilt

- **New stages**: a live day now goes Prep → Build → Rehearse → Show → Wrap → Review → Post Production, in place of the old Idea/Scripting/Streaming/Review/Post Production. Existing saved data upgrades automatically; nothing needs doing by hand.
- **Strike plan**: on the show itself (not each day), set whether the rig is struck down every day or built once and struck only on the last day, and list what comes down nightly versus what stays up until the end. Each day's Wrap checklist is built from this automatically.
- **Post-production fork**: each day's Post Production stage now asks whether anything was recorded. If yes, split the recording into a Music track or a Series episode before the day can be marked done — it starts already past the stages that assume there's no footage yet. If no, the day can be marked done straight away.


## v7: dashboard, call sheets, equipment reports

- **Production metric**: a live show with several days now counts as one production on the Dashboard, not one per day.
- **Call sheets**: each call sheet has its own **Download…** button (on the sheet itself, and on the list's right-click menu), producing a PDF with shoot details, crew, gear and run of show. This no longer goes through Documents.
- **Equipment reports**: downloading the equipment list now offers optional columns — Vendor, Purchase date, Cost, and Packaging & accessories — so you can include only what you need.


## Several identical units at once (v6)

Adding equipment now supports several units of the same model in one go — for example three Sony FX6 bodies with different serial numbers. Pick **One or more units**, type the shared details once, then list a serial number for each (type them one by one, or paste a list, one per line). Units that share a make and model group together in the inventory list and on each other's page, so opening one FX6 shows the other two. **Add another** on a group, or **Add another unit** on a single item's page, adds more later with the shared details already filled in.
