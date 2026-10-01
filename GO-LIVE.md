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

## What this does not do yet

- The **desktop app** is the local demo. The hosted site is the real one.
- Reminders are still sent by a person pressing a button. Sending on a schedule is not built.
- Google is tested with a stand-in. Your real MongoDB is checked by step 3 and by the storage tests in CI, and
  Google by trying it once.
