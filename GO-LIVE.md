# Going live: real sign-in on the hosted site

This turns the site on Vercel from the demo into the real thing. It uses the MongoDB you already connected.

## 1. Deploy from GitHub

The site is built by Vercel from this repository on GitHub. Every change goes in as a pull request, so it can
be read and tested before it reaches the live site (see CONTRIBUTING.md):

1. Changes are made on a branch and pushed to GitHub.
2. A pull request is opened. GitHub runs the checks (type-check, lint, format, every test, including the storage
   tests against a real MongoDB). Vercel builds a preview of the branch.
3. Once the checks pass and someone has read the change, it is merged into `main`. Vercel then builds and
   deploys the live site.

Before your first deploy, check on your own computer:

    npm ci
    npm test
    npm run build

`npm test` should end with "N of N test files passed".

## 2. Add two settings in Vercel

Project, Settings, Environment Variables. You already have `MONGODB_URI` and `MONGODB_DB`. Add:

| Name | Value |
|---|---|
| `SETUP_TOKEN` | A long secret you make up. Used once. Make one with `openssl rand -base64 24` |
| `TOKEN_ENCRYPTION_KEY` | Exactly this: `openssl rand -base64 32`. Only needed for Google. Never change it later, or linked Google accounts must be linked again |

Optional, for the five-stage workflow:

| Name | Value |
|---|---|
| `CRON_SECRET` | A long secret you make up (`openssl rand -base64 24`). Vercel uses it to run the daily check early each morning (06:45 Nairobi time, give or take the hour on the free plan): it moves projects whose review window passed with no decision to Hold, tops up recurring shows, and sends the day's reminder emails. Without it, the check still runs the first time anyone opens the site each day |
| `PUBLIC_BASE_URL` | Your site's address, for example `https://hub.dawnoffaith.tv`, if share links should use it rather than the address each person opened the site on |

Optional, for reminder emails (Google Workspace):

| Name | Value |
|---|---|
| `SMTP_USER` | The Workspace mailbox email is sent from, for example `hub@dawnoffaith.org`. A mailbox of its own is best |
| `SMTP_PASS` | An **app password** for that mailbox: sign in as it, Google Account, Security, turn on 2-Step Verification, then App passwords. Not the mailbox's normal password |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` | Leave unset for Google Workspace (`smtp.gmail.com`, `465`, and the mailbox itself as the sender) |

Without `SMTP_USER` and `SMTP_PASS` nothing is emailed and nothing is queued; reminders still reach the bell. The
password lives only in Vercel, never in the code. Google Workspace allows about 2,000 emails a day per mailbox.

Save them for Production, Preview and Development, then **Redeploy** (Deployments, the three dots, Redeploy).

## 3. Check the database

Open `https://YOUR-SITE.vercel.app/api/health`. You should see `"message":"Connected to MongoDB."`.

If it does not say that, it says what is wrong, in words. What each one means:

| It says | Do this |
|---|---|
| `MONGODB_URI is not set on the server` | Add it in Vercel (all three environments), then Redeploy. Adding a setting does nothing until you redeploy |
| refused the username or password | Atlas, Database Access: reset that user's password to letters and numbers only. Put it in `MONGODB_URI`, Redeploy |
| not a valid connection string | Copy the string again from Atlas (Connect, Drivers). It starts `mongodb+srv://`. Replace `<password>` with the real password. No quotes or spaces |
| address in `MONGODB_URI` was not found | Copy the string again from Atlas |
| could not reach MongoDB | Atlas, Network Access: allow `0.0.0.0/0`. Check the cluster is not paused. Wait a minute |
| not allowed to use this database | Atlas, Database Access: give the user "Read and write to any database" |

If the site shows **The site cannot reach its data** instead of a sign-in box, it is the same list. The site never shows demo data in its place.

## 4. Create the Head of Production

Open the site. It shows **Set up the Production Hub**. Enter the setup code, your name, a username and a password (10 or more characters). Choose blank or sample data (the sample projects start in the five-stage workflow). This can only be done once.

Afterwards, delete `SETUP_TOKEN` in Vercel. Setup is then switched off completely.

## 5. Add everyone else

People, **Add**, fill in the name and details. "Make a login for this person now" is ticked. Check the username (it is suggested from the name, and they sign in with it, not an email), then Save. The app shows a one-time password. Send it to them privately. They choose their own password when they first sign in.

To make a login for someone you added earlier: People, choose the person, **Login access**, pick a username, **Create login**.

Forgotten password: the same panel has **Reset password**. Someone leaves: **Switch login off** signs them out at once.

## 6. Google (optional, whenever you want)

Nothing needs this. Do it only if people want reminders in their Google Calendar or sent from their Gmail.

1. console.cloud.google.com: create a project.
2. APIs and Services, Library: enable **Google Calendar API** and **Gmail API**.
3. OAuth consent screen: type External, add the app name and your email.
4. Credentials, Create credentials, OAuth client ID, type **Web application**. Under Authorised redirect URIs add exactly:
   `https://YOUR-SITE.vercel.app/api/google-callback`
   (add your own domain the same way if you use one).
5. Copy the client ID and secret into Vercel as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Redeploy.

Then each person opens Settings, Connected accounts, ticks what they allow, and links their own account.

While the consent screen says "Testing", only people you add as test users can link, and Google ends their link after 7 days. For a small team, set publishing status to "In production". Google will show an "unverified app" notice at linking, which is expected for an internal tool.

## Updating a site that is already live

Version 20 (see CHANGELOG.md) stores the data in a new layout: one MongoDB document per record, person, item
and so on, in the collections `hub_meta` and `hub_items`, with photos in `files`. Your data is moved across
automatically.

- **What happens.** The first time the new version starts, one server copies everything from the old `state`
  collection into the new layout and moves photos out into `files`. This takes seconds for a typical amount of
  data. Anyone who opens the site during the move sees "The data is being moved to its new layout" and can try
  again a moment later. Nobody is signed out.
- **Your old data is kept.** The `state` collection is not changed or deleted. It is your backup.
- **Deploy at a quiet moment.** A change saved by the old version while the new one is starting would not be
  copied across. Pick a time when nobody is editing.
- **To check first (optional).** Copy your database in Atlas (or use a preview deployment pointed at a copy by
  setting `MONGODB_DB` for Preview only), and open the preview. Or run the storage tests against your own
  cluster, which uses a temporary database of its own and removes it afterwards:

      DOF_MONGO_URI="mongodb+srv://..." npm test -- storage-mongo

- **To go back.** In Vercel, Deployments, promote the previous deployment. It reads the `state` collection,
  which is as it was before the update, so anything saved after the update would be missing there.
- **Later.** Once you are happy, after a few weeks, the `state` collection can be deleted in Atlas.

### Data version 15 (the workflow's data, phase 1)

The first time a version with data version 15 starts, it adds the new workflow lists and three empty fields on
every record. Nothing that exists is changed in any other way, moved or removed.

- **A copy is kept first,** in the collections `hub_items_before_v15` and `hub_meta_before_v15`.
- **To see what it will do, first:**

      MONGODB_URI="mongodb+srv://..." npm run db:upgrade

  This is a dry run. It prints, for each part of the data, how many elements it has before and after, and writes
  nothing. `npm run db:upgrade -- --apply` does the upgrade (with the copy) from your computer instead of waiting
  for the server to do it.
- **To go back.** Older versions of the app cannot read version 15 data. Put the copy back first, then promote the
  previous deployment in Vercel. Anything saved after the update is lost. In `mongosh "<MONGODB_URI>"`:

      use dof
      db.hub_items.renameCollection("hub_items_after_v15")
      db.hub_meta.renameCollection("hub_meta_after_v15")
      db.hub_items_before_v15.renameCollection("hub_items")
      db.hub_meta_before_v15.renameCollection("hub_meta")

- **Check** `https://YOUR-SITE.vercel.app/api/health` after deploying: `uniqueIndexes` should be `true`. Anything
  else names a rule MongoDB could not enforce.

### Moving existing projects into the workflow (phase 5)

Series, devotionals and documentaries made before the five-stage workflow keep their earlier stages until they are
moved. Nothing moves by itself: the Head of Production does it, once, when ready.

- **See what it will do.** In the app: Settings, "Move existing projects to the new workflow". It lists every
  series, devotional and documentary record with what it is now and what it becomes, the ones left for a decision
  by hand and why, each part's row count before and after, and what to do in the app afterwards. Choose each
  series' type (podcast unless chosen) and whether each documentary was pitched by others (DOF-made unless chosen)
  there. From a computer instead, this prints the same report and writes nothing:

      MONGODB_URI="mongodb+srv://..." npm run migrate:workflow
      MONGODB_URI="mongodb+srv://..." npm run migrate:workflow -- --series DOF-SER-002=sermon --documentary DOF-DOC-003=pitched

- **Move them.** Press Move in Settings, or add `--apply` to the command. A copy of all the data is kept first, in
  `hub_items_before_workflow` and `hub_meta_before_workflow`, and the move is one all-or-nothing change. Content IDs
  never change. Running it again changes nothing. In the desktop app and the demo the same button keeps the copy on
  that computer, as `dof-hub-db-before-workflow`.
- **Old fields stay.** Each record keeps its earlier stage, checklist and devotional fields as they were. The
  earlier pipeline's buttons refuse records that have moved, so those fields are read-only. Deleting them is a
  later, separate step, once you are sure.
- **To go back.** Put the copy back, as for version 15 above. Anything saved after the move is lost:

      use dof
      db.hub_items.renameCollection("hub_items_after_workflow")
      db.hub_meta.renameCollection("hub_meta_after_workflow")
      db.hub_items_before_workflow.renameCollection("hub_items")
      db.hub_meta_before_workflow.renameCollection("hub_meta")

### Data version 16 and the Development forms into documents (documents rework, phase 1)

The first time a version with data version 16 starts, it adds the empty lists for documents, pages, reviews,
comments, storyboards and shot lists. It keeps a copy first, in `hub_items_before_v16` and `hub_meta_before_v16`;
`npm run db:upgrade` shows what it will do, and going back is as for version 15 above, with `v16` in the names.

- **The move.** "Move existing projects" (above) now also writes every project's old Development form into its new
  documents, in the same dry run and the same all-or-nothing save. Its report lists, for each project, the documents
  written and how many fields went onto pages, the fields kept on the form and why, and the fields not accounted
  for, which must be zero. The old forms are not changed or removed. A project whose brief was already started by
  hand keeps it as it is; its old form is kept beside it, on an "Earlier Development form" document. Running it again
  changes nothing.
- **To undo only the documents,** keeping the move into the workflow:

      MONGODB_URI="mongodb+srv://..." npm run migrate:workflow -- --undo-documents
      MONGODB_URI="mongodb+srv://..." npm run migrate:workflow -- --undo-documents --apply

  The first is a dry run. The second keeps a copy (`hub_items_before_undo_documents` and
  `hub_meta_before_undo_documents`) and removes exactly the documents, pages, reviews, comments and shot lists the
  move wrote. A document or shot list written in since the move is kept and listed; add `--force` to remove it too.

### Data version 17: the documents are how every project shows (the old Development screens are gone)

Devotions, series and documentaries now always open on their Project Home and documents. The "Documents (preview)"
setting and each person's "Earlier screens" switch are gone, and so is the old Development tab (the long form, the six
criteria, the pitch and outline review cards and the long "Still needed" list). A project leaves Development on the
short list of hard gates; a testimonial also needs its consent and release, with the person's agreement, which cannot
be passed by hand.

The first time a version with data version 17 starts, it keeps a copy (`hub_items_before_v17` and
`hub_meta_before_v17`), then moves the Development form of every project in the workflow that has not had it into its
documents, exactly as "Move existing projects" does, so nothing written on the old screens is left where no one can see
it. A project whose brief was started by hand while the documents were a preview keeps it as it was, with its old form
on an "Earlier Development form" document beside it. The old forms are not changed. `npm run db:upgrade` shows what it
will do; going back is as for version 15 above, with `v17` in the names, and the documents part alone can be undone
with `--undo-documents` (above); "Move existing projects" in Settings writes them again. Nothing has to be turned on.

Storyboard and shot list pictures: on the hosted site they are stored like equipment photos. In the desktop app they
are written to a `media` folder inside the app's own data folder on that computer (for example
`%APPDATA%\tv.dawnoffaith.productionhub\media` on Windows), one folder per project; back that folder up with the computer.
A picture kept on one desktop computer does not show anywhere else.

### Data version 18: a devotion's Recording Plan

A devotion's Pre-production is its Recording Plan: roles, devotions, sessions and a call sheet for each session, with
printing. Sessions gain a name, a label (Morning, Afternoon, Evening, Late night, Full day) and hours; drives can be
chosen for a devotion's footage, each session's footage size is entered once recording starts, and each episode's edit
assets in Post production. Those sizes are ordinary entries on the Storage screen.

The first time a version with data version 18 starts, it keeps a copy (`hub_items_before_v18` and
`hub_meta_before_v18`; in the demo and desktop app, `dof-hub-db-before-v18`), adds the new fields, empty, and gives a
devotion in Pre-production a planned session for each of its call sheets that has none (on the sheet's date, with its
location and run of show; the sheet itself is not changed). Those sessions are marked `fromCallSheet`, and an audit
entry ("migrate-call-sheets") lists them. No devotion is put on them: the plan shows each as "Needs a session" until
someone ticks it. Running it again changes nothing. `npm run db:upgrade` shows what it will do; going back is as for
version 15 above, with `v18` in the names. Nothing has to be turned on.

Who can do what: anyone who can see a devotion can print its call sheets and run sheets; downloading a report still
needs "Export reports". Choosing a drive needs "Use storage" (crew and the Head of Production have it unless changed),
since drives are only sent to people who have it. Roles are changed by the show producer, the Head of Production, or
someone given "Assign other people's work", as before.

### Data version 19: one production system

Live shows are productions: a recurring show (with its Show Template and schedule), a one-time event, or a multi-day
event (with its Event Plan). Every call sheet has the same ten sections.

The first time a version with data version 19 starts, it keeps a copy (`hub_items_before_v19` and
`hub_meta_before_v19`; in the demo and desktop app, `dof-hub-db-before-v19`), then:
- gives every call sheet the new sections, empty (what each already had is left as it was);
- makes each live show a production: a show with one day becomes a one-time event, any other a multi-day event with an
  empty Event Plan;
- links each day to the call sheet made for its date, and makes a draft call sheet for each coming day that has none.
  An audit entry ("migrate-productions") lists the sheets it made.
Nothing is moved or deleted, and running it again changes nothing. `npm run db:upgrade` shows what it will do; going
back is as for version 15 above, with `v19` in the names. The new list `showTemplates` is empty until a recurring show
is made.

**Recurring shows need the daily check.** The daily cron already in vercel.json (`/api/cron/daily`, set
`CRON_SECRET`) now also makes each recurring show's coming days and books the gear of days within two weeks. Without
it, the same check runs on the first request each day; the desktop app and demo run it on start and hourly. Gear
booked by the daily check is in the name of the sheet's crew lead, else the show's responsible person, else the Head of
Production.

### Data version 20: call sheet improvements

Call sheets gain confirmations, a change log once shared, saved locations, warnings and gear suggestions.

The first time a version with data version 20 starts, it keeps a copy (`hub_items_before_v20` and
`hub_meta_before_v20`; in the demo and desktop app, `dof-hub-db-before-v20`), then:
- gives every call sheet and show template a saved location, none (`locationId: null`); the place typed on each sheet is
  left as it was;
- gives every call sheet its confirmations and change log, empty; a sheet already final is marked shared at that
  moment, so changes to it are logged from then on;
- adds the list of saved locations (`locations`), empty.
Nothing is moved or deleted, and running it again changes nothing. `npm run db:upgrade` shows what it will do; going
back is as for version 15 above, with `v20` in the names. Nothing has to be turned on.

Who can do what: the Head of Production and crew keep the saved locations; everyone else picks from them, and a
partner is sent only those on the call sheets they can see. Crew confirm for themselves; anyone who can work on the
project can record a confirmation for someone else. A contact card shows only what the viewer was already allowed to
see (volunteers' and partners' details stay with the Head of Production unless "See volunteer and partner contact details" is given).

### Data version 21: the rework's foundations (build prompt v2, phase 1)

Adds what the rework's later parts build on, with no change on screen yet: equipment loans, role kits, the Calendar's
reminders, the bell's notifications, the email queue and Google calendar links (each an empty list), a "template" mark
on storyboards and shot lists (all of today's are a project's own), and a switch for each part of the rework (all off
until that part is built).

The first time a version with data version 21 starts, it keeps a copy (`hub_items_before_v21` and
`hub_meta_before_v21`; in the demo and desktop app, `dof-hub-db-before-v21`), then adds those. Nothing is moved or
deleted, and running it again changes nothing. **General Use records are not touched.** `npm run db:upgrade` now also
reports, for a decision before the lending part is built: every General Use record, with its checkouts, call sheets,
documents and storage entries, and a proposal (one with gear checkouts becomes a loan; any other is archived; Content
IDs keep working either way); and what is stored of reminders (only the log of reminders sent and each person's email
and text choices, which carry over as they are: reminders themselves are worked out from dates). Going back is as for
version 15 above, with `v21` in the names.

**The daily cron moves to the morning.** vercel.json now runs `/api/cron/daily` at 03:45 UTC (06:45 in Nairobi), so
reminder emails arrive at the start of the day. On the free plan Vercel runs it once a day, at some point within that
hour.

**What Vercel's free plan cannot do, so it is not built:**
- Emails at an exact time. The server only runs on its own once a day, so an email reminder must be at least a day
  ahead; it goes out in the morning run before it is due. "At the time" and "1 hour before" reminders reach the bell
  only (exact whenever anyone has the app open: the bell is checked on every request, at most once a minute).
- Instant retries of a failed email. A failed email is tried again with later requests (at most every five minutes)
  or the next morning, five tries in all.
- Live updates pushed to every screen at once (for the Live Control view later): screens refresh every 15 seconds,
  as now.
- Email from the demo or the desktop app: they have no server. Their reminders reach the bell only.

### The rework, phase 2: the shell, call sheets and keys (no data change)

Nothing to set up and no data version: the new menu (Settings in the profile menu, Ctrl+K search) ships on, and the
Head of Production can switch it off in Settings, The rework, which goes back to the old menu without changing any
data. Call sheets now stay open to edit after they are published, until their work reaches Post production, and are
locked after that (a closed session's sheet, a show day in Post Production); existing published sheets become
editable again, with their change log kept, and existing sheets of closed sessions show as locked. Nothing is
rewritten in the data either way.

## What this does not do yet

- The **desktop app** is the local demo. The hosted site is the real one.
- Reminders are still sent by a person pressing a button. Sending on a schedule is not built.
- Google is tested with a stand-in. Your real MongoDB is checked by step 3 and by the storage tests in CI, and
  Google by trying it once.
