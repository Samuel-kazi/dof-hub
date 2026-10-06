# Changelog

What changed in each version, newest first. How to deploy is in GO-LIVE.md.

## Unreleased: the rework (build prompt v2)

Phase 1, the foundations (no change on screen yet; each later part ships behind its own switch in Settings):

- Data version 21: lists for equipment loans, role kits, Calendar reminders, the bell's notifications, the email queue
  and Google calendar links, all empty; storyboards and shot lists can be templates, or belong to no project (kept in
  Documents); a switch for each part of the rework. General Use records are left as they are; the upgrade's dry run
  lists each with a proposal (with gear checkouts: a loan; otherwise archived) for a decision.
- One view of every production instance, a recording session or a show day: date, label, times, place, status (draft,
  published, done, cancelled) and call sheet. The Calendar, the urgency report and search will read from it.
- Lending: a loan (DOF-LOAN-0001) to a borrower, with phone, organisation, items, date out and expected return. A
  lent item is unavailable to bookings and the conflict check until its expected return, and once late until it is
  checked in; the clash names the borrower and the date. Items come back a few at a time; a serialized item takes the
  condition it came back in. A loan can be kept longer if its items are free, or called off before anything comes back.
- Role kits: a role's usual gear (for example a camera operator with an FX3), offered on a call sheet item by item to
  the matching roles, with what is not free that day marked. Nothing is booked until someone accepts an item.
- Reminders on anything with a date (a session or show day, a call sheet, an episode's or project's due date, a
  loan's return) or standing alone, at the time, an hour, a day or a week before, or any number of minutes. They
  follow their item when its date moves. A reminder standing alone can repeat daily, weekly or monthly.
- The bell keeps notifications for each person; email goes through the workspace's Google Workspace account
  (SMTP_USER and SMTP_PASS on the server), from a queue: each message once, five tries, held through a person's
  quiet hours. On Vercel's free plan email reminders must be a day or more ahead (see GO-LIVE.md).
- The urgency report's rules: each project gets Critical, High, Watch or On track and its reasons in plain words (an
  episode overdue; a session or show day within 24 hours with no published call sheet or items not assigned; a gear
  clash; due within 48 hours; no producer after the greenlight; theological review not done; items not assigned;
  call sheet details missing; no recording date within 14 days of a due date), and each late loan. The numbers are
  in settings.
- Storyboards and shot lists: "Save as template", templates and practice boards kept in Documents, and "Use template"
  copying one into a project; editing the copy never changes the template.
- The daily cron runs at 06:45 Nairobi time instead of 00:05.

Phase 2, the shell, call sheets open until Post production, and the keys (switch: "New menu, Settings in the profile
menu, Ctrl+K search", on):

- **Call sheets stay open to edit until their work reaches Post production**, published or not. Finalize asks first
  ("Publish …?") and needs a click or Ctrl+Enter; a published sheet keeps its change log, and a change still clears
  the confirmations it affects. "Reopen" is now "Back to draft". A sheet locks, and says why, once its recording
  session is closed, once its show day reaches Post Production, or once everything linked to it is past shooting; a
  sheet linked to nothing never locks. Reopening a session opens its sheet again. Locked sheets are marked in the list,
  and leave "My call sheets".
- The call sheets list filters by type (session, show day, other), by time (coming, past) and by project.
- **Settings moves to the profile menu** (click your name: Settings, Sign out). The side menu no longer lists it.
- **Ctrl+K (⌘K on a Mac)**, or the search button at the top: one box for projects, episodes and devotions apart,
  the five-stage documents, recording sessions, documents, call sheets, crew (for those who may see the People page;
  names and roles only), gear, loans and drives, each where the person may look, and a few commands (open the
  Calendar, Call Sheets, Equipment or Settings; print today's run sheet). Arrow keys move, Enter opens, Esc closes.
  In the document editor Ctrl+K still adds a link, as in most editors; the search button works there.
- **Ctrl+,** opens Settings. **Ctrl+S** saves the field being typed in, and says "Saved"; on a document page it
  saves the page.
- **In a field, Enter saves and moves to the next field; Esc takes back what was typed.** In a longer text, Ctrl+Enter
  saves. A page's title and subtitle move on with Enter.
- **Enter in a row's last field adds a row right below it**, the cursor in its first field: a call sheet's run of show
  (starting when the row ends), a session's run sheet (likewise) and a shot list.
- **Dialogs**: opening one moves the keys into it; Enter presses its main button, Esc closes it; closing it gives the
  cursor back. Deliberate actions (publish, approve, the greenlight, accept or decline) and every deletion or removal
  are never confirmed by Enter alone: a click, or Ctrl+Enter, and the dialog says so.
- Settings lists the parts of the rework with a switch each, for the Head of Production; parts still to come are
  marked "Coming". Switching one off goes back to how things were, changing no data.
- General Use stays in the Content Pipeline until lending (a later part) replaces it.

Phase 3, the theological review as a reminder, not a gate (switch: "Theological review as a reminder, not a gate",
on):

- **The review no longer holds anything up.** A series or documentary leaves Development on its logline and core
  question and the greenlight with a show producer; a devotion is accepted on its guest and its five pages. The
  greenlight can be recorded before the review. The other gates (a session's call sheet and gear, the wrap
  checklist, the review link, the distribution link) are unchanged.
- **While it is not approved, the project says so**: "Theological review not done", with where it stands (no reviewer
  yet, 1 of 2 approved, changes requested) and "Open the review", above Project Home and every document; on the
  project's board card; and in the urgency report (Watch).
- **Going ahead is asked about, never refused**: scheduling a session (giving it a date, adding one with a date,
  duplicating one), publishing a call sheet, and publishing an episode ask "Theological review not completed.
  Continue?" with a short note. Continuing keeps who, what, when and the note with the project (listed under the
  banner) and in the activity log; Cancel stops. Publishing stays deliberate: a click or Ctrl+Enter.
- The review can still be decided after the project leaves Development while it is not approved; once approved it is
  kept as it was.
- **A page changed after the approval says "Edited after approval"**, in the page list, in the editor and in the
  review.
- Switching it off brings the review back as a gate, as before. No data changes either way.

The rest of the rework, built together (data version 22):

- **The review, refined.** An approval from before the review documents counts: both earlier checkpoints approved,
  the review passed by hand while it was a gate (with its note), or a project moved across after Development. Naming
  reviewers after such an approval asks for a new review, and the banner and card say "New theological review
  requested". The review tag on a project's board card is a button: it opens where the review stands, each
  reviewer's decision and each time someone went ahead without it. Scheduling asks only when a session gets a date it
  did not have.
- **The Recording Plan for series and documentaries**, as devotions have it: Project roles (the usual six, each with
  someone from the crew), the episodes (or a documentary's parts) from Development, each on one session, the
  sessions with their ticks, and a call sheet per session. It replaces the Roles, Sessions and Call Sheet forms. The
  Pre-production gate is now the same for every kind: each role on the plan needs a person.
- **Live Shows and DOF Music on the five stages** (Development, Pre-production, Production, Post production,
  Marketing and distribution), with their checklists in configuration. The upgrade moves every record across: Prep,
  Build and Rehearse into Pre-production; Show and Wrap into Production; Review and Post Production into Post
  production; Music's Idea into Development, Recording into Production, audio post, video editing and review into Post
  production, Publish into Marketing and distribution. A live show leaves Development once its date is set and its
  producer named.
- **Recurring shows**: daily repeat; days made for the next 8 dates (changeable on the template); "Apply to this and
  future days" (the day's call sheet becomes the template from that day on); "Cancel this date" (kept, marked
  cancelled, left out of the schedule); a day's label (Morning, Afternoon, Evening, Late night, Full day). A live run
  of show has camera, audio, graphics, status (planned, live, done, cut) and actual start and end.
- **Equipment, Lending and Role kits.** New loan (borrower, phone, organisation, items, date out, expected back,
  required), check-in a few at a time with condition, keep longer, call off, a printed receipt with signature lines,
  overdue loans flagged. Role kits are edited there and offered on call sheets item by item. **General Use moves to
  Lending**: a record with gear lists becomes a loan holding the same items (its open lists released, with a note);
  the rest are archived; Content IDs keep working.
- **Documents, Templates**: storyboards and shot lists with no Content ID, as templates or kept for practice or an
  event; "Save as template" on a project's board or list; a project starts from one through "Start from".
- **The Calendar absorbs Reminders.** Month and Agenda views; a recurring show sits on each of its dates (Fridays
  only for Vespers), never a bar across months, and its days no longer stack bars; a multi-day event is one bar from
  its first day to its last, and clicking a day on it shows that day's crew call, place, crew and run of show with its
  call sheet. Loans due back and one's own reminders are on it. The Reminders view holds one's reminders ("+ Reminder",
  or "Remind me…" on a day's session, show day, call sheet, deadline or loan; in the bell and by email a day or more
  ahead; repeating) and the deadlines coming up (as the Reminders page had them, with sending to the team). The
  Urgency view is the urgency report, filterable, sortable and printable. Reminders leaves the side menu; old links
  open the Calendar on its Reminders view. The bell shows notifications, unread first, and marks them read.
- **Google Calendar**, for those who link it and allow the calendar: "Add to Google Calendar" now also sends the
  sessions and show days you are on the call sheet of (60 days ahead), and syncing again updates each event where it
  is (a session moved to another day moves in Google), never adding one twice.

## Unreleased: one production system, with the call sheet at its centre

Being built in phases. Phase 1, the production core:

- **A live show is a production, made one of three ways**, chosen when it is made (Pipeline, Live Shows, Add live
  show):
  - **Recurring show** (Friday Vespers, the weekly Sabbath service): a schedule (weekly on chosen days, or monthly by
    date or by "the first Friday", every so many weeks or months, from a first date, until a date, a number of times,
    or with no end, with dates left out and added) and a **Show Template** holding the standard crew, gear, workflow
    (level of production, who is responsible for each day), run of show and call sheet. A day and its call sheet are
    made for each date, 12 weeks ahead (1 to 26, set on the template), and topped up every day by the daily check.
  - **One-time event**: exactly one day and one call sheet.
  - **Multi-day event**: an **Event Plan** (overview, audience, venue, travel, accommodation, budget, notes) and a day
    and call sheet for each date, shown as tabs. A day added copies the call sheet of the day before it, with its gear
    where it is free; the days are numbered again in date order.
- One system, not three: every day is a record of its own (with its Content ID and the live pipeline, due around its
  own date), with exactly one call sheet, and the same copying makes a template's days, an event's new day, and a
  duplicated call sheet.
- **A template change reaches every coming day that still follows it.** A day whose call sheet someone changes by
  hand (any section, its date or its gear) keeps its own from then on, and says so; "Put back on the template" brings
  it back. Ticking the technical check or the rehearsal, confirming and commenting are not changes. A final call sheet
  is never changed by the template.
- A new schedule makes the days it now gives and takes off (archives, never deletes) coming days it no longer gives,
  unless they were changed by hand or work has started on them: those stay, marked "Off the schedule". A day comes
  back if its date returns.
- **Template gear** is booked on a day once the day is two weeks away, if it is free that day; anything already
  booked or lent out stays on the sheet's "Still to book" list, with "Book what is free now". Nothing is ever
  double-booked.
- **Every call sheet has the same ten sections**: Schedule (crew call, talent call, start, wrap), Crew (with each
  person's role and the crew lead), Talent, Location (with address and how to get in), Equipment, Logistics, Contacts,
  Run of Show, Technical Check and Rehearsal, with a bar to jump between them on a phone. Fields save as you leave
  them. The run of show is no longer only for large productions (a large one still needs it before it is final). A
  recording session's call sheet shows its run sheet as its Run of Show, and the times read from it where none are
  typed. The technical check and rehearsal can be ticked on a final sheet.
- Putting someone on a call sheet's crew attaches them to the project, so they can open it. Any active crew member can
  be chosen; volunteers attached to the project too; partners cannot be on the crew.
- "Print…" on any call sheet prints the whole sheet, or its run sheet alone, on one clean page.
- Duplicating a call sheet now copies every section (with the technical check unticked).
- The pipeline board shows a recurring show's days from a week ago to two weeks ahead, and any older one not finished.
- Data version 19: on first start, after keeping a copy, every call sheet gains the new sections, empty; each live
  show becomes a production (one day: a one-time event; otherwise a multi-day event with an empty Event Plan); each
  day is linked to the call sheet made for its date; and each coming day without one gets a draft call sheet. Nothing
  is moved or deleted.

Phase 2, call sheet improvements:

- **Duplicate to another date**, for a call sheet or a recording session, with "+1 day", "+1 week" and "+2 weeks"
  beside the date. A copy carries every section, with ticks and confirmations cleared, and the gear that is free on the
  new date (anything booked elsewhere or lent out is skipped and listed). A session's copy also takes its name, hours,
  venue, storyboard, shot list and run sheet, and a copy of its call sheet; its episodes or devotions stay on the
  original. "Duplicate…" is on the session's page and on each session in a devotion's Recording Plan.
- **Warnings, never blocks**: a sheet still to come lists what it is missing (no crew call time, no location, no crew,
  no crew lead) in a summary at the top and in the section concerned, and, from three days before the date, the crew
  who have not confirmed. The Call sheets list shows "N to check".
- **Confirmed ticks** for each person on the crew and each talent row. Crew tick their own (a crew member on the sheet
  sees "Will you be there?" with one button); anyone working on the project can record it for someone else. A
  confirmation records the call time, place and role it was given for: if any of the three changes, it is cleared, the
  change log says so, and the person is asked again. Confirming works on a final sheet and does not stop a day
  following its show's template.
- **Saved locations**: a list of places with their address and notes, on the Call sheets page. The Head of Production
  and crew add, edit and archive them (archived ones can be brought back). Any call sheet or show template picks one in
  its Location section, which fills in the place, address and notes; "Save as a saved location" adds a sheet's place to
  the list. A sheet keeps its own copy, so editing a saved location never rewrites sheets already made.
- **Click a name to reach them**: crew names on call sheets, sessions, the Recording Plan's call sheets, stage owners,
  the dashboard, equipment and checkout lists open a contact card with their role, phone (call or text) and email, as
  far as the viewer may see them. Volunteers' and partners' details stay private as before.
- **Change log**: once a sheet has been shared (first made final) or anyone has confirmed, every change to its date,
  call times, location, crew (added, removed, roles, lead), talent and run of show is logged with who made it and
  when, shown newest first under "Changes since it was shared or confirmed". The header shows when it was shared and
  how many changes are logged.
- **Gear suggestions** from the crew's roles (a camera for each camera operator, audio for the audio role, lights,
  the switcher, an editing machine), offered in the Equipment section with one click to add. Nothing is added on its
  own; gear already on the sheet, booked elsewhere or lent out that day is left out.
- Data version 20: on first start, after keeping a copy, every call sheet and show template gains a saved location
  (none), and every sheet its confirmations and change log (empty). A sheet already final counts as shared from then
  on. The list of saved locations starts empty. Nothing is moved or deleted.

## Unreleased: documents for each stage (the documents rework)

Being built in phases. The five stages, their names and order, the stage tracker, Content IDs and every form that
drives the calendar, reminders, call sheets, gear, storage or overdue stay as they are.

**Phase 6: a devotion's Recording Plan** (section 7A)
- A devotion's Pre-production is now the Recording Plan, plus a Storyboard and a Shot List (any number of each, for the
  whole project). The separate Devotions, Recording Session and Call Sheet tiles are gone: the plan holds them.
- The plan opens on four section cards before its pages (Cards and storage, Notes), each saying where it stands:
  - **Project roles**: Director, Camera, Audio, Lighting, Floor manager and Editor are listed when the devotion is
    accepted. Each is renamed by typing over its name, more are added, any is removed, and each takes someone from the
    crew. Before recording, every role needs a person; the devotion's guest is its host. Series and documentaries keep
    their required roles.
  - **Devotions**: read from the script as it stands (renaming a page renames its devotion at once), with "x of y
    assigned" and "Needs a session" for any not on one. "Bring the list up to date from the script" is still there.
  - **Recording sessions**: name, label (Morning, Afternoon, Evening, Late night, Full day), date, hours and venue, and a
    tick box for each devotion. A devotion is on one session: ticking it on another moves it there. Only sessions still
    being planned can gain or lose one; a devotion recorded, or on a session that has started, stays. Removing a
    session asks why, keeps it archived, and its devotions need a session again. A devotion with no session is a note
    on the gate, never a block.
  - **Call sheets**: a tab per session. A session's call sheet is made as soon as it has a date, and keeps to the
    session's date while it is a draft. Each shows the call sheet's own fields, crew, gear and comments; the crew call,
    talent arrival, start of recording and wrap, read from its run sheet; the role holders with their phones (where the
    privacy rules let the viewer see them) and the guest; the roles; the session's devotions in order; the run sheet,
    with who does each line, "+ Row", and "Rebuild from episodes" (it asks first); and the storyboard and shot list
    chosen for the session, shown read only with a way to each.
- A devotion session's run sheet starts from the template with no recording rows, and gains "Record: <topic>" for each
  devotion ticked, in order, until someone changes it by hand.
- **Printing**: "Print call sheet" and "Print run sheet only", for anyone who can see the project: one clean page,
  black on white, headed with the project, the session's name, label and date. Downloading a report still needs
  "Export reports".
- **Where the footage is kept**: above Cards and storage, the drive the devotion's footage goes on. In Production,
  Storage lists each session with its drive (the plan's, or another) and, once recording has started, the size of its
  footage in GB, kept as a raw entry on that drive. In Post production, each episode has its edit assets: the drive
  and the size in GB, changed as the edit grows. These are entries on the Storage screen, so the drives' free space,
  warnings and forecast include them. Drives are chosen by those who may use storage (crew and the Head of Production,
  unless changed); removing a drive clears any plan that chose it.
- The calendar is as before: it reads each session's date, and shows no label or hours.
- Data version 18: on first start, after keeping a copy, sessions gain their new fields, empty, and roles their order.
  A devotion in Pre-production whose call sheets have no session (made before the workflow or by hand) gets a planned
  session for each, on the sheet's date, with its location, run of show and the sheet itself, unchanged. No devotion
  is guessed onto it: each shows "Needs a session" until ticked.

**The old Development screens removed** (approved)
- Devotions, series and documentaries always open on their Project Home and documents. The "Documents (preview)"
  setting and each person's "Earlier screens" switch are gone, and so are the old Development tab, the six-criteria
  panel, the pitch and outline review cards and the long "Still needed" list. Nothing stored is deleted: the old forms
  and checkpoints are kept, untouched.
- Data version 17: on first start, after keeping a copy, every workflow project's Development form that has not been
  moved goes into its documents, so nothing written on the old screens is left out of sight. A brief that was only
  opened during the preview, with nothing written in it, is made again by the move. One someone wrote in is never
  written into: the old form is kept beside it on an "Earlier Development form" document (its tile shows only where it
  exists), which undoing the move removes exactly. The demo and the desktop app save the upgraded data at once. The same applies to a
  Greenlight document started by hand, whose page the move used to overwrite with the six criteria; and a devotion's
  script started by hand gains no extra pages, so no extra devotions at acceptance.
- Leaving Development is always the short list of hard gates. A testimonial also needs its consent and release with
  the person's agreement, as before; it can no longer be dismissed as a note, and it is never passed by hand.
- A DOF-made documentary's second greenlight needs its shot list; its shoot budget and interview sets are written in
  its documents.
- New projects no longer get pitch and outline checkpoints, which nothing would show. Projects reviewed on them keep
  that review. A new episode's reviewers start as the brief's reviewers (or, for an older project, its outline's).
- "Waiting on" and reminders for a project in Development come from its brief's review only.
- On a phone, a page's "Saved" line goes under its title instead of pushing the page sideways.

**Phase 5: the documents of Production, Post production, and Marketing and distribution**
- Recording Day Sheet (a documentary's Shoot Day Sheet), in Production: one for each recording session, chosen at the
  top (it opens on the session recording now, else the next one planned). Its run sheet and wrap checklist are the
  session's own forms, as before, shown as fixed cards beside the pages: a line added to the run sheet here is the
  session's, and still sets the call sheet's call time; a closed session's run sheet is as it was; the wrap opens
  once recording starts. The notes (Daily notes, or Interview notes) are pages like any other, and start with the
  daily log already written on the session. Once a session has its day sheet, the session's screen shows those notes
  as its daily log, so they are written in one place.
- Review Thread, in Post production: a page for each episode (or cut), added when the thread is opened after a session
  closes, and never taken away (an archived episode keeps its page; a page deleted by hand stays deleted and can be
  restored). Above each page, where that episode's review stands: its post-production step, editor, rough cut and
  final review with their notes, why it was sent back, its review link, and the way to the episode. Comments sit
  beside each page and can be resolved.
- Edit Notes, Release Plan, Learning Notes and a devotion's Study Notes are written like the other documents. The
  forms of these stages (Session Log, Storage, Episode or Cut Tracker, Platform Status, Archive, a devotion's Recording
  Day View and Review) keep their screens and behaviour.
- A day sheet's tile shows it has content when any session's sheet has some.

**Phase 4: the Storyboard and the Shot List** (behind the same setting)
- Storyboard, in Pre-production: the project's boards in a row above with their frame counts, and "+ New storyboard",
  which starts blank or as a copy of any board the person may see, in this project or another, pictures and all. A
  board can be for the whole project or one episode. Its frames sit in a grid (three across on a wide screen): "Sc. ·
  Frame N", a 16:9 picture (click or drop to add it, replace or remove it), description, sound effects and a video
  link (web links only). "+ Frame" adds one; frames are dragged into order; each has a ⋮ menu (Duplicate, move earlier
  or later, move to another storyboard, Delete); Select all, then delete or move several at once. The board's name is
  edited in place. Everything saves as it is typed.
- Shot List, in Pre-production: the lists in a row above with their shot counts, and "+ New shot list" (blank or a
  copy). A table: picture, shot number (shots only: setups and banners take none), description, shot size, type and
  movement (the usual ones offered, anything else typed), and estimated minutes, with a ⋮ menu and a checkbox per row.
  "+ Shot", "+ Setup" (a row across the table for lighting, lens or camera notes) and "+ Banner" (a section divider).
  Rows are dragged into order; Select all, then delete; the times add up at the foot.
- Pictures are shrunk to a 1280-pixel long edge before they are kept. On the hosted site the server files them and the
  frame keeps only the address. The desktop app now writes them to a media folder in its own data folder (one folder
  per project) and keeps only the path; it may write there and nowhere else. The browser demo keeps the shrunk picture.
- The camera plan from the old forms (moved in Phase 1) is there as a shot list.
- A project's "Waiting on" follows the document review once its documents are on: the reviewers still to decide, who
  are reminded, and then its owner (the Entry owner, or the producer) when changes are requested.
- Text inputs for web addresses now follow the theme (they were white in night mode).

**Phase 3: series and documentaries, the review, the greenlight and the short gates** (behind the same setting)
- Settings, Documents (preview), now has a switch for each kind: devotions, series and documentaries. A series or
  documentary then opens on its Project Home, with its own documents (Show Brief or Documentary Brief, Theological
  Review, Greenlight, Planned Episodes or Parts, and the later stages' documents and forms).
- The short gates out of Development, for a kind whose documents are on, replacing the long "Still needed" list:
  - Series and documentary: the logline and core question written (two fields at the top of The idea); the
    theological review of the brief approved; the greenlight decision recorded as Greenlight and a show producer named.
  - Devotion: the guest's name and contact; at least five devotion pages each with a title, scripture and script; the
    theological review of the script approved.
  - A project reviewed on the earlier screens keeps that review when its kind is turned on: both earlier checkpoints
    approved count, until reviewers are named on the document.
  - Everything else is a note that never blocks, and each can be dismissed (remembered in the person's browser).
  - The Head of Production, or someone given "Create projects", can pass a gate by hand with a short note, kept with
    the project and in the activity log, and can take it back. The greenlight decision itself is recorded, never
    passed by hand.
  - "Done: move to Pre-production" stays, enabled when the gates pass. A greenlight needs only the first two.
- Theological Review: the brief or script read-only, page by page, with a comment box beside each page. The show
  producer or the Head of Production names the reviewers; each named reviewer approves the whole document or requests
  changes with a reason; the Head of Production can decide for everyone. The reason shows on the document for its
  writers, who resolve comments and "Ask for review again". The review is kept as it was once the project leaves
  Development; comments can still be added.
- Greenlight: the six-criteria page, with the recorded decision, its date and notes and the show producer above it,
  as structured fields, and the gate below.
- Devotions: Accept or Decline. Accept records the decision, moves the devotion to Pre-production and lists its
  devotions from the script, each with its Content ID and its page, in one change. Decline needs a reason and closes
  and archives the devotion, never deleting it.
- Project Home shows the header strip (Project details: entry, a devotion's guest, a sermon's delivery) and, while in
  Development, the gate with its button.
- Testimonial and sermon briefs gain the logline and core question, optional on the earlier form so its gate is as it
  was.
- Devotions share one theme, set once in Project details; each devotion has its own topic, the title of its page
  (labelled Topic). The Devotional Script shows the shared theme, and the Devotions list shows each topic beside it.
  A change of theme reaches every devotion when the list is brought up to date.
- Form tiles open their screens as before: Planned Episodes, Consent and Release, Roles, Sessions, Call Sheet, Gear,
  Session Log, Storage, Episode Tracker, Platform Status and Archive.

**Phase 2: the document screens and the editor** (devotions first, behind a setting that starts off)
- Settings, Documents (preview): "Devotions show their documents". Off until someone with the system settings right
  turns it on. Series and documentaries cannot be turned on yet. Everyone can still switch a project back with
  "Earlier screens" (remembered in their own browser).
- Project Home: one coloured row per stage, the stage's name on the left and a tile for each document, tool or form.
  A tile shows a small dot when its document has something in it, worked out from its pages and links, never set by
  hand. The stage tracker stays at the top.
- A tile opens full width in three panes: the stage's documents on the left (forms tagged "form"), the document's pages
  as cards in the middle with "+ Add page", and the page on the right. Stage tabs along the top jump between stages,
  and "Project home" comes back. Pages can be reordered (drag, or the ⋮ menu), deleted and restored.
- The page: a plain title and subtitle (a devotion's scripture), a rich-text body (TipTap) with a sticky toolbar
  (undo, redo, block style, text size, bold, italic, underline, strikethrough, colour, highlight, alignment, bullet,
  numbered and check lists, indent, outdent, link, clear formatting) and the usual shortcuts (Ctrl or Cmd with B, I,
  U, Z, Shift+Z and K). The writing sits on paper, light in both themes, so colours read the same on screen and
  printed. A Links box for files kept in Google Docs, Drive or WhatsApp, opened in the person's own browser.
- Saving: 800 ms after the writer stops, "Saving…" then "Saved @ hh:mm". On the hosted site, "Saved" waits until the
  server has the save. A save that fails, or meets someone else's newer save, keeps the words on screen with Keep
  mine (or Save again), Copy my words, or Use theirs; until it is saved, a copy stays in the browser and is offered
  back next time. Leaving the page, the app screen or the browser tab with words not saved asks first.
- A paste from Google Docs, Word or the web keeps bold, italic, headings, lists and links and drops everything else.
  Every page is cleaned again when it is opened.
- Print page or Print document: the pages alone, without the app, each page on its own sheet.
- Forms keep their screens: the Accept or Decline tile shows the Development form as before (guest, review, decision
  and the move to Pre-production) until the next phase; Recording Session, Call Sheet, Recording Day View, Storage
  and Review open the same screens as before. Devotions (Pre-production) lists the devotions from the script, each with
  its Content ID; days already listed on the earlier form are taken over in order, never listed twice.
- The editor is downloaded only when a page is opened (about 130 KB), so the app's first load is not slower.

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

**Phase 6: the sample data moved, and the QA report** (as approved)
- The built-in sample data starts in the five-stage workflow: the demo, the desktop app and a new site set up with
  sample data begin with Whispers of Why, Morning Light and Samburu Stories already moved (by the same move a live site
  runs from Settings), their Development forms in their documents. Live Shows and Music are exactly as before.
  Settings, "Move existing projects", has nothing to move there. A live site's own data still moves only when its
  Head of Production presses Move.
- The demo's data is now read the first time it is needed rather than when the app's files load, so building the
  moved sample cannot meet code that is still loading.
- QA-REPORT.md: every item of the workflow brief's tests and acceptance, with the tests that cover it and the
  results.

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
