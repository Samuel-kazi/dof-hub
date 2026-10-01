# Making a change

Every change reaches the live site through a pull request on GitHub, so someone can read the diff and the checks can
run before anything is deployed. Please do not copy files over the project from a zip, or push straight to `main`.

## The steps

1. Make a branch from `main`, and make the change there.
2. Run the same checks CI runs:

   ```
   npm run check         # types, for the app and the server
   npm run lint          # ESLint: errors fail CI, warnings do not
   npm run format        # Prettier rewrites the files; CI only checks them (format:check)
   npm test              # every test file, with the clock fixed so results do not depend on the day
   npm run db:upgrade    # with MONGODB_URI set: what upgrading a real database would change (a dry run)
   ```

   If you changed anything under `server/` or `src/services/`, `npm run build` regenerates `api/_server.mjs`, the
   server bundle Vercel runs. Commit it with your change.

3. Push the branch and open a pull request. Fill in the template: what changed, why, and how you checked it.
4. CI must pass, and someone other than the author should read the change before it is merged. Vercel builds a
   preview of every pull request, so it can be tried before it goes live.
5. Add a line to `CHANGELOG.md` for anything people using the app would notice.

## Rules of the code

- **Changes go through services.** Screens never change the data themselves. A service function takes the person
  first (`actor`) and checks what they may do.
- **The server checks every change.** A new service function that changes data must be listed in
  `server/schemas.ts` with the exact shape of its arguments (run `npm run gen` first). `tests/actions.test.ts`
  fails until it is, and names it.
- **Patches list their fields.** An "update" function copies only the fields it is meant to change, with
  `pickKeys` (see `updateRecord`). TypeScript types are not checked at run time; the server receives whatever the
  request contains.
- **New IDs go through `src/data/ids.ts`.** `claimId` for IDs people see, `localId` for internal ones, and `logId`
  for log entries, so the browser and the server always agree.
- **Tests for what matters.** A rule gets a test. A security fix gets a test in `tests/security.test.ts` that
  tries the attack and checks it fails.

## Protecting `main` (once, on GitHub)

Repository Settings, Branches, add a rule for `main`: require a pull request before merging, require one approval,
and require the `test` check to pass.
