# Going live: real sign-in on the hosted site

This turns the site on Vercel from the demo into the real thing. It uses the MongoDB you already connected.

## 1. Put the files in place

Unzip and copy these into your project, replacing what is there:
`src`, `tests`, `server`, `api`, `scripts`, `package.json`, `package-lock.json`, `vercel.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `README.md`, `GO-LIVE.md`.
Do not touch `src-tauri` or `node_modules`.

Delete the old test page: `api/health.ts` (the new server answers `/api/health` itself).

`package-lock.json` matters: it pins the tools to versions that install cleanly on Vercel.

Then, in the project folder:

    npm install
    npm test
    npm run build

`npm test` should end with "249 renders ok". Then upload:

    git add .
    git commit -m "Real sign-in, passwords and server"
    git push

## 2. Add two settings in Vercel

Project, Settings, Environment Variables. You already have `MONGODB_URI` and `MONGODB_DB`. Add:

| Name | Value |
|---|---|
| `SETUP_TOKEN` | A long secret you make up. Used once. Make one with `openssl rand -base64 24` |
| `TOKEN_ENCRYPTION_KEY` | Exactly this: `openssl rand -base64 32`. Only needed for Google. Never change it later, or linked Google accounts must be linked again |

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

Open the site. It shows **Set up the Production Hub**. Enter the setup code, your name, a username and a password (10 or more characters). Choose blank or sample data. This can only be done once.

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

## What this does not do yet

- The **desktop app** is still the local demo. The hosted site is the real one.
- Reminders are still sent by a person pressing a button. Sending on a schedule is not built.
- Equipment photos are still kept inside the data. Fine for now; a separate file store is the next step before there are many.
- Everything was tested here with a stand-in database and a stand-in Google. Your real MongoDB is checked by step 3, and Google by trying it once.


## Several identical units at once (v6)

Adding equipment now supports several units of the same model in one go — for example three Sony FX6 bodies with different serial numbers. Pick **One or more units**, type the shared details once, then list a serial number for each (type them one by one, or paste a list, one per line). Units that share a make and model group together in the inventory list and on each other's page, so opening one FX6 shows the other two. **Add another** on a group, or **Add another unit** on a single item's page, adds more later with the shared details already filled in.


## v7: dashboard, call sheets, equipment reports

- **Production metric**: a live show with several days now counts as one production on the Dashboard, not one per day.
- **Call sheets**: each call sheet has its own **Download…** button (on the sheet itself, and on the list's right-click menu), producing a PDF with shoot details, crew, gear and run of show. This no longer goes through Documents.
- **Equipment reports**: downloading the equipment list now offers optional columns — Vendor, Purchase date, Cost, and Packaging & accessories — so you can include only what you need.


## v8: the live-show workflow rebuilt

- **New stages**: a live day now goes Prep → Build → Rehearse → Show → Wrap → Review → Post Production, in place of the old Idea/Scripting/Streaming/Review/Post Production. Existing saved data upgrades automatically; nothing needs doing by hand.
- **Strike plan**: on the show itself (not each day), set whether the rig is struck down every day or built once and struck only on the last day, and list what comes down nightly versus what stays up until the end. Each day's Wrap checklist is built from this automatically.
- **Post-production fork**: each day's Post Production stage now asks whether anything was recorded. If yes, split the recording into a Music track or a Series episode before the day can be marked done — it starts already past the stages that assume there's no footage yet. If no, the day can be marked done straight away.


## v9: merged with the Calendar and personalisation work

This brings your `main` branch's Calendar module and personalisation (workspace accent colour, font pairing, per-person font size, density and profile photo) together with everything built in this update batch (the live-show workflow rebuild, equipment units, branding, dashboard and report changes). Nothing from either side was dropped.

One thing worth knowing: both sets of changes had separately used "version 9" for a database migration, for two different things. This update keeps your appearance migration at version 9 and moves the live-show migration to version 10, layered on top, so real saved data upgrades correctly either way.


## v10: CI, a self-checking codegen step, the equipment file split, and stage staleness

- **Continuous integration**: every push and pull request now runs automatically on GitHub (`.github/workflows/ci.yml`) — install, type-check, confirm the generated server-replay code is current, then the full test suite. A failing step blocks the run (and blocks merging, if branch protection is turned on for the repo).
- **`npm run gen:check`**: catches a service function that was added or renamed without running `npm run gen` afterwards, before it reaches GitHub. Run it yourself any time with `npm run gen:check`.
- **`src/services/equipment.ts`** is now three files under the hood (`equipment-items.ts`, `equipment-manifests.ts`, `equipment-reports.ts`), with `equipment.ts` kept as a plain pass-through so nothing elsewhere in the app needed to change. Behaviour is identical — this was purely a file-organisation change, checked against the original file's full export list to confirm nothing moved or went missing.
- **Stalled work is now flagged on its own**, separately from missed deadlines: a project that has sat in one stage for a long time — 2.5× longer than that stage normally takes — now shows a **Stalled** badge on the Pipeline board and on its own page, and nudges whoever is responsible for it with a reminder that says "no update in X days" rather than "due", since the cause is different. This catches stalls even when nobody set a deadline in the first place. Advancing or sending back a stage resets the clock. A longer effort estimate (Settings) raises the bar before something counts as stalled.

### To set up branch protection (optional, on GitHub)
Repo Settings → Branches → add a rule for `main` → **Require status checks to pass before merging** → select the `test` check once it has run at least once.


## v11: Gantt-style bars on the Calendar

Multi-day items now draw as horizontal bars across the days they cover, instead of a dot on every day. Single-day items — a shoot day, a published call sheet, a gear booking — stay as small dots, exactly as before.

- **Production windows:** a live show running more than one day shows as one bar across its whole run, with its title readable right on the bar.
- **Stages in progress:** whatever stage an item is in now shows as a bar from when it entered that stage to its deadline, so you can see how long something has actually been sitting there, not just when it's due. A stage that hasn't started yet still shows as a plain dot on its deadline, since there's no start to draw a bar from.
- **Overlapping bars stack** into separate lanes automatically, so two things happening at once never collide.
- A bar that runs into the next week shows a small `‹`/`›` instead of a rounded end, so it reads as "still going".
- Bar label color (light or dark text) is chosen automatically per category color, so it stays readable whichever of the five category colors it is, in both light and dark mode.


## v12: fixed a live show cluttering the calendar with a bar for every day

A live show with several days was showing a separate stage bar for each of its days ("Medical Missionary Movement, Day 2: Prep", "Day 3: Prep"...), stacking into a wall of near-duplicate bars. Now, same as the Dashboard, a multi-day live show shows as one bar with just the show's name — its days no longer add bars of their own. A show with only one day is unaffected.


## v13: the Devotional pipeline is wired in

Kanban and Calendar now show the new Devotional flow (Creation → Guest → Prep/Scripting → Recording → Editing → Review → Published):

- **Guest** shows a reviewer-name field and an Approve button, plus a "Guest is non-compliant" action that requires a reason and closes the project. The ordinary advance button is turned off here on purpose — those two are the only ways forward.
- **Closed** projects vanish from the Pipeline board and the Calendar by default. A **Closed (N)** filter next to the category chips brings them back into view, each showing its reason.
- **Editing** shows the ready-for-review checkbox; **Review** shows Approve (only once that checkbox is ticked) and Send back, which requires a reason and resets the checkbox.
- No deadlines, overdue badges, staleness, or reminders anywhere in this pipeline, as asked — checked through the Dashboard, the reminders bell, the Calendar's deadline bars, and workload scheduling, not just the obvious places.
