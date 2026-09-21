# Dawn of Faith Production Hub

Desktop app for Dawn of Faith TV. React + TypeScript front end, wrapped by Tauri.
Phases 1 and 2 run on in-memory sample data (saved in the app's local storage). The database comes later.

## What works now

- Sign-in with four access levels: Head of Production, Crew, Volunteer, Partner
- Project scoping: crew, volunteers and partners only see projects they are attached to
- Dashboard: nearest deadlines (max five, overdue first), waiting on you, at risk, crew free today, shoots this week
- Content pipeline: five categories, each with its own stages; Show > Season > Episode hierarchy; board and tree views
- Stage gates: a stage cannot be finished until its required output is confirmed
- Call sheets: one per shoot, auto-linked to same-project episodes on the date, drift flags, duplicate, crew clash check, finalize/reopen
- People: Person IDs (DOF-P-CRW-004), login creation, promotion (ID never changes), deactivate, project history
- Menu button, back button on every page, right-click to edit or delete
- Audit log (Settings, Head of Production only)

### Phase 2: Equipment, Storage and gear on call sheets (crew and Head of Production only)

- Inventory: 11 categories, permanent asset codes (DOF-EQ-CAM-001). One row per unit for serialized gear; one row per purchase for batches of identical items (DOF-EQ-CAB-XLR10M-B01), grouped by item family
- Status: Available, Assigned (reserved in the studio), Checked out, Overdue, In repair, Retired, Lost. All derived from checkout lists, never typed in
- Checkout lists: every list is tied to a Content ID, a person responsible and dates. Reserve in the studio, then mark as gone out. Photos at checkout and check-in are timestamped and stored with the event. Printable
- Check-in: records returned, damaged and lost per item. A drop in condition is logged as damage. All lines are validated before any is applied
- Batches: drawn oldest first, or choose batches by hand. Damaged or lost units come off that batch and are logged against it
- Damage log and full history per item (repairs, retirements, who had it, on which project)
- Gear picker on call sheets: availability is shown at pick time and clashes are blocked. Moving a call sheet moves its gear or refuses. Duplicating copies free gear and reports what it skipped. A sheet cannot be finalized while its gear is in repair
- Storage and Media: drives with a Mac-style usage bar per project, nearly-full flags, per-drive and all-drive reports (copy or print), and a storage forecast on the dashboard
- Raw footage cannot be removed from a drive until everything under it is Delivered
- Saved Phase 1 data upgrades in place and keeps everything it had

### Workflow, documents and storage from the project page

- Every stage has an owner. The Head of Production assigns anyone; crew can take a stage nobody owns and hand it back. The owner of the current stage is the person responsible
- Stage checklists: editing has Story lock, Picture lock, Sound check and Color, each with its own person and date, and you can add more. A stage cannot be finished until every item is ticked. Music recording is tracked as Audio recording and Video recording
- Music now runs Idea, Pre-production, Recording, Audio post-production, Video editing, Review, Publish
- Links at any stage (review, reference, analysis notes) and a final link once an item reaches its publishing stage
- Documents module: briefs, scripts, shot lists, edit notes and a publishing analysis are attached automatically as an item reaches each stage. Anyone on the project reads them, crew edit them, and every save is kept with a version history, "what changed" view and restore
- Live sessions have a level of production (small, medium, large). Large productions get a run of show on the call sheet and cannot finalize without one
- Details on a project page are editable in place, and each project page has Media storage where you assign the project to a drive, record the space it has taken, change it later or move it to another drive
- Everyone can edit their own name and contact details in Settings

### Hosts, guests, teams, live days and printing

- Series and devotionals (and other categories except music) list hosts and guests. A show's hosts carry down to its episodes, guests are listed where they appear, and call sheets show who is on camera
- A series has a start and an end for the show. Shoot date and Publish date replace the old Scheduled and Final deadline labels
- Who does what, and when: every stage has a list of owners, each with the roles they do, chosen from a list or typed by hand. The first owner of the current stage is responsible. On a show, the same table holds the people who work across the whole project. Roles show beside a person's name on the project and on the call sheet crew list
- A live show is made of days. Give it a first and last day and each day is created as its own item, with its own pipeline, level of production, call sheet and run of show
- Post several links at once, each with a label
- The Gear section on a project holds only checkout list IDs. Lists can be printed from there, from the Equipment module, or attached by ID. The full equipment list prints by category

### Capacity and workload

- People > Workload shows every crew member's load for the next two or four weeks. Crew see their own. Hover a square to see what is in it
- Work is measured in person-days and spread over the working days before it is due. A shoot day or being away with gear takes the whole day. Over 100% means more than one person can do
- For a series, finishing a cut takes at least 2 days for someone with nothing else on. The other stage estimates are starting figures. Both, and the working days, can be changed in Settings
- Adding someone to a stage shows how many free days they have before it is due, and warns when the work will not fit
- The dashboard is simpler: four stat cards, the nearest deadlines, and short lists. The decorative charts were removed. The side menu's Content Pipeline categories can be hidden or shown

### Access, reports, documents and reminders

**Access and permissions.** The Head of Production is the administrator. Settings > Manage access shows what each role can do and lets you change it for a whole role or for one person. The defaults: crew see every project, ongoing and completed, and can jump in on any of them by adding themselves to a stage. They edit only projects they are on, and do not see who has a login. Volunteers and partners see only the projects they are attached to. Each permission is one line: see every project, jump in, edit any project, assign other people's work, create projects, use or manage equipment, use or manage drives, see the People page, see who has a login, see volunteer contact details, add and change people, see everyone's workload, produce reports, use reminders, send reminders to others, see the activity log, change system settings. Every change is written to the activity log.

**Reports.** Every Print, Copy or Report button opens a dialog to choose the kind of report, then PDF, Print or Copy as text. When it is done the app tells you with a message and an entry under the bell. Reports: storage (all drives, by project, nearly full), one drive, equipment (list by category, checked out now, needing attention, damage log), one checkout list, a project report, pipeline status, crew workload, one document, and the activity log.

**Documents.** New documents use numbered sections with an italic note under each one saying what to write, based on the document types in the master spec (content brief, script, shot list and run of show, editor's brief, technical spec, report, release, reference). There are no symbols to type. A document downloads as a PDF.

**Reminders and calendar.** The Reminders page lists what is coming up for you, with an Add to Google Calendar link for each and a calendar file (.ics) that carries an alert on every event. The Head of Production can open a prepared email or text for each person, and the app keeps a record of what was sent. It does not send anything by itself. Sending on a schedule needs a small server that can email and text, which comes with the database.

**Saving files in the desktop app.** In a browser, PDFs and calendar files download normally. The desktop app saves through a normal save dialog once Tauri's dialog and file plugins are installed (Tauri 2):

1. In `src-tauri`, run `cargo add tauri-plugin-dialog tauri-plugin-fs`.
2. In `src-tauri/src/lib.rs`, add `.plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_fs::init())` to the builder.
3. In `src-tauri/tauri.conf.json`, set `"app": { "withGlobalTauri": true }`.
4. In `src-tauri/capabilities/default.json`, add `"dialog:default"` and `"fs:allow-write-file"` to `permissions`.

Without them the app falls back to the web view's own download, which may not save inside the desktop shell.

### Look and feel

- Night mode and light mode: the moon and sun button at the top switches, Settings > Appearance also offers "Match my computer". The choice is remembered
- A floating rail of round icon buttons replaces the sidebar. The menu button widens it to show labels and the pipeline categories. The pipeline page also has category chips
- Dashboard: greeting and a search box (projects, call sheets, gear, drives, limited to what you may see), glance cards for production, gear, storage, delivery health and crew, and a storage gauge. Every chart is drawn from live data
- All colours live in one place at the top of `src/styles.css` as theme tokens

Documents shows a preview page for now.

## Demo sign-ins (password: demo)

| Role | Email |
| --- | --- |
| Head of Production | hop@dof.demo |
| Crew | crew1@dof.demo, crew2@dof.demo, crew3@dof.demo |
| Volunteer | volunteer1@dof.demo |
| Partner | partner1@dof.demo |

## Run it

```
npm install
npm run dev
```

Open http://localhost:1420 in a browser to try it. To run it as a desktop window, add Tauri (see below).

## Add the Tauri desktop shell

Needs Rust (https://rustup.rs). Then, in this folder:

```
npx tauri init
```

Answer the prompts:

- App name: Dawn of Faith Production Hub
- Window title: Dawn of Faith Production Hub
- Web assets location: ../dist
- Dev server URL: http://localhost:1420
- Frontend dev command: npm run dev
- Frontend build command: npm run build

Then `npm run tauri dev` opens the desktop window.

## Where things live

```
src/config/      Category stages, hierarchy labels and role rules (one source of truth)
src/services/    All business rules. Screens never touch data directly.
src/data/store   The ONLY file that knows where data lives. Swap this for the real database.
src/pages/       Screens
src/ui/          Shell, menus, modals
tests/           Rule tests and a render test for every page and role
```

Run `npm test` after `npm install` to check the rules.

Photos are shrunk and kept in the app's local storage for now, which holds roughly 5 MB. The app shows a warning if a save fails. The real database will hold photos properly; until then, links work as well as photos.

## Design rules built in

- Only the level that does production work has a pipeline (Episode, Track, or a flat project)
- Rollups are computed on demand, never stored
- Content IDs and Person IDs are permanent
- Removal archives instead of destroying
- Edits carry a version number so two people cannot silently overwrite each other
- Every change is written to the audit log
- Quantities, availability and drive usage are computed from checkouts and allocations, never stored
- Gear with history is retired, never deleted
