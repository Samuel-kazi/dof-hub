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
| `CRON_SECRET` | A long secret you make up (`openssl rand -base64 24`). Vercel uses it to run the daily check at 00:05 Nairobi time, which moves projects whose review window passed with no decision to Hold. Without it, the check still runs the first time anyone opens the site each day |
| `PUBLIC_BASE_URL` | Your site's address, for example `https://hub.dawnoffaith.tv`, if share links should use it rather than the address each person opened the site on |

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
  for, which must be zero. The old forms are not changed or removed. A project whose documents were already started
  by hand is left alone. Running it again changes nothing.
- **To undo only the documents,** keeping the move into the workflow:

      MONGODB_URI="mongodb+srv://..." npm run migrate:workflow -- --undo-documents
      MONGODB_URI="mongodb+srv://..." npm run migrate:workflow -- --undo-documents --apply

  The first is a dry run. The second keeps a copy (`hub_items_before_undo_documents` and
  `hub_meta_before_undo_documents`) and removes exactly the documents, pages, reviews, comments and shot lists the
  move wrote. A document or shot list written in since the move is kept and listed; add `--force` to remove it too.

### Trying the document screens (documents rework, phases 2 and 3)

Nothing changes on screen until it is turned on. In Settings, Documents (preview), tick the kinds of project that
should show their documents: devotions, series, documentaries (it needs the "change system settings" right). Each
project of that kind then opens on its Project Home. Each person can switch a project back with "Earlier screens" at
any time; the data is the same either way. Untick a kind to turn it off for everyone.

Storyboard and shot list pictures: on the hosted site they are stored like equipment photos. In the desktop app they
are written to a `media` folder inside the app's own data folder on that computer (for example
`%APPDATA%\tv.dawnoffaith.productionhub\media` on Windows), one folder per project; back that folder up with the computer.
A picture kept on one desktop computer does not show anywhere else.

Turning a kind on also changes how its projects leave Development: the short list of hard gates (phase 3) instead of
the earlier form's long list. A project already past Development is not affected. Turning the kind off again brings
the earlier gates back.

## What this does not do yet

- The **desktop app** is the local demo. The hosted site is the real one.
- Reminders are still sent by a person pressing a button. Sending on a schedule is not built.
- Google is tested with a stand-in. Your real MongoDB is checked by step 3 and by the storage tests in CI, and
  Google by trying it once.
