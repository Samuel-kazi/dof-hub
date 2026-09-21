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

## 4. Create the Head of Production

Open the site. It shows **Set up the Production Hub**. Enter the setup code, your name, a username and a password (10 or more characters). Choose blank or sample data. This can only be done once.

Afterwards, delete `SETUP_TOKEN` in Vercel. Setup is then switched off completely.

## 5. Add everyone else

People, choose the person, **Login access**. Pick a username. The app shows a one-time password. Send it to them privately. They choose their own password when they first sign in.

Forgotten password: the same panel has **Reset password**. Someone leaves: **Switch login off** signs them out at once.

## 6. Google (optional, whenever you want)

Nothing needs this. Do it only if people want reminders in their Google Calendar or sent from their Gmail.

1. console.cloud.google.com: create a project.
2. APIs and Services, Library: enable **Google Calendar API** and **Gmail API**.
3. OAuth consent screen: type External, add the app name and your email.
4. Credentials, Create credentials, OAuth client ID, type **Web application**. Under Authorised redirect URIs add exactly:
   `https://YOUR-SITE.vercel.app/api/google/callback`
   (add your own domain the same way if you use one).
5. Copy the client ID and secret into Vercel as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Redeploy.

Then each person opens Settings, Connected accounts, ticks what they allow, and links their own account.

While the consent screen says "Testing", only people you add as test users can link, and Google ends their link after 7 days. For a small team, set publishing status to "In production". Google will show an "unverified app" notice at linking, which is expected for an internal tool.

## What this does not do yet

- The **desktop app** is still the local demo. The hosted site is the real one.
- Reminders are still sent by a person pressing a button. Sending on a schedule is not built.
- Equipment photos are still kept inside the data. Fine for now; a separate file store is the next step before there are many.
- Everything was tested here with a stand-in database and a stand-in Google. Your real MongoDB is checked by step 3, and Google by trying it once.
