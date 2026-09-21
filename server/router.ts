import type { IncomingMessage, ServerResponse } from "node:http";
import { RuleError } from "../src/types";
import { runAction } from "./actions";
import { authenticate, changePassword, createAccount, login, logout, MAX_MS, needsSetup, publicUser, resetPassword, setDisabled, setup, signOutEverywhere, type Authed } from "./accounts";
import { HttpError } from "./errors";
import * as google from "./google";
import { assertSameSite, clearCookie, COOKIE, readRequest, redirect, send, sessionCookie, type Req } from "./http";
import { loadDb, snapshotFor } from "./state";
import type { Store } from "./stores";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Every address the app answers on. One function handles them all, so the site stays within Vercel's free limits. */
async function dispatch(store: Store, req: Req, res: ServerResponse): Promise<void> {
  // One-segment addresses (/api/accounts-create) are what the app uses, because they need no special routing on Vercel. The older two-segment forms still work.
  const route = `${req.method} ${req.path.replace(/^\/api/, "").replace(/^\/(accounts|account|google)-/, "/$1/")}`;
  const cookieToken = req.cookies[COOKIE];
  const ok = (body: Record<string, unknown> = {}, extra: Record<string, string | string[]> = {}) => send(res, 200, { ok: true, ...body }, extra);

  const signedIn = async (allowMustChange = false): Promise<Authed> => {
    const who = await authenticate(store, cookieToken);
    if (!who) throw new HttpError(401, "Please sign in.", "signed-out");
    if (who.user.mustChange && !allowMustChange) throw new HttpError(403, "Choose your own password first.", "must-change");
    return who;
  };

  switch (route) {
    case "GET /health": {
      await store.state.load(["settings"]);
      return ok({ message: "Connected to MongoDB.", ...(store.diagnose ? await store.diagnose() : {}), setUp: !(await needsSetup(store)) });
    }
    case "GET /session": {
      const who = await authenticate(store, cookieToken);
      return ok({ remote: true, needsSetup: !who && (await needsSetup(store)), user: who ? publicUser(who) : null, google: { available: google.googleAvailable() } });
    }
    case "POST /setup": {
      const r = await setup(store, { token: str(req.body.token), name: str(req.body.name), username: str(req.body.username), password: str(req.body.password), samples: req.body.samples === true }, req.ip, req.agent);
      return ok({ user: r.user }, { "Set-Cookie": sessionCookie(r.token, req.secure, MAX_MS / 1000) });
    }
    case "POST /login": {
      const r = await login(store, { username: str(req.body.username), password: str(req.body.password) }, req.ip, req.agent);
      return ok({ user: r.user }, { "Set-Cookie": sessionCookie(r.token, req.secure, MAX_MS / 1000) });
    }
    case "POST /logout": {
      await logout(store, cookieToken);
      return ok({}, { "Set-Cookie": clearCookie(req.secure) });
    }
    case "GET /state": {
      const who = await signedIn();
      const loaded = await loadDb(store);
      if (!loaded) throw new HttpError(503, "The app has not been set up yet.");
      if (req.query.get("rev") === String(loaded.revision)) return ok({ unchanged: true, revision: loaded.revision });
      return ok({ revision: loaded.revision, db: snapshotFor(loaded.db, who.actor) });
    }
    case "POST /action": {
      const who = await signedIn();
      const result = await runAction(store, who, req.body.name, req.body.args);
      return ok({ result: result ?? null });
    }
    case "POST /account/password": {
      const who = await signedIn(true);
      await changePassword(store, who, str(req.body.current), str(req.body.next));
      return ok();
    }
    case "POST /accounts/create": return ok(await createAccount(store, await signedIn(), { personId: str(req.body.personId), username: str(req.body.username), password: str(req.body.password) || undefined }));
    case "POST /accounts/reset": return ok(await resetPassword(store, await signedIn(), str(req.body.personId)));
    case "POST /accounts/disable": { await setDisabled(store, await signedIn(), str(req.body.personId), req.body.disabled === true); return ok(); }
    case "POST /accounts/signout": { await signOutEverywhere(store, await signedIn(), str(req.body.personId)); return ok(); }

    case "GET /google/status": return ok({ google: await google.status(store, await signedIn()) });
    case "POST /google/link": return ok({ url: await google.startLink(store, await signedIn(), req.origin, { calendar: req.body.calendar === true, gmail: req.body.gmail === true }) });
    case "GET /google/callback": {
      try {
        const who = await signedIn();
        if (req.query.get("error")) return redirect(res, "/?google=denied");
        await google.finishLink(store, who, req.origin, str(req.query.get("code")), str(req.query.get("state")));
        return redirect(res, "/?google=linked");
      } catch {
        return redirect(res, "/?google=failed");
      }
    }
    case "POST /google/unlink": { await google.unlink(store, await signedIn()); return ok(); }
    case "POST /google/calendar": return ok(await google.addToCalendar(store, await signedIn()));
    case "POST /google/email": return ok(await google.sendReminderEmail(store, await signedIn(), str(req.body.personId)));
    default:
      throw new HttpError(404, "Not found.");
  }
}

/** The one function Vercel runs. `getStore` says where data lives: MongoDB on Vercel, memory when trying it out. */
export function createHandler(getStore: () => Promise<Store>) {
  return async (nodeReq: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const req = await readRequest(nodeReq);
      assertSameSite(req);
      await dispatch(await getStore(), req, res);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { ok: false, remote: true, error: e.message, code: e.code });
      if (e instanceof RuleError) return send(res, 400, { ok: false, remote: true, error: e.message, code: "rule" });
      if (e instanceof SyntaxError) return send(res, 400, { ok: false, remote: true, error: "That request is not valid." });
      console.error("Server error", e); // the detail stays in Vercel's logs
      return send(res, 500, { ok: false, remote: true, error: "Something went wrong on the server. Nothing was changed." });
    }
  };
}
