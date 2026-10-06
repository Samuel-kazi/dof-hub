import type { IncomingMessage, ServerResponse } from "node:http";
import { RuleError } from "../src/types";
import { runAction } from "./actions";
import {
  authenticate,
  changePassword,
  createAccount,
  login,
  logout,
  MAX_MS,
  needsSetup,
  publicUser,
  resetPassword,
  setDisabled,
  setup,
  signOutEverywhere,
  type Authed,
} from "./accounts";
import { HttpError } from "./errors";
import * as google from "./google";
import { assertSameSite, clearCookie, COOKIE, readRequest, redirect, send, sendFile, sendLarge, sessionCookie, type Req } from "./http";
import { docHistory, headOf, loadDb, snapshotFor } from "./state";
import type { Store } from "./stores";
import { createShareLink, dailyChecks, followShareLink } from "./workflow";
import { alertChecks, emailAvailable, smtpSender } from "./email";
import { migrateWorkflowRequest } from "./migrateWorkflow";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Every address the app answers on. One function handles them all, so the site stays within Vercel's free limits. */
async function dispatch(store: Store, req: Req, res: ServerResponse): Promise<void> {
  // One-segment addresses (/api/accounts-create) are what the app uses, because they need no special routing on Vercel. The older two-segment forms still work.
  const route = `${req.method} ${req.path.replace(/^\/api/, "").replace(/^\/(accounts|account|google)-/, "/$1/")}`;
  const cookieToken = req.cookies[COOKIE];
  const ok = (body: Record<string, unknown> = {}, extra: Record<string, string | string[]> = {}) =>
    send(res, 200, { ok: true, ...body }, extra);

  const signedIn = async (allowMustChange = false): Promise<Authed> => {
    const who = await authenticate(store, cookieToken);
    if (!who) throw new HttpError(401, "Please sign in.", "signed-out");
    if (who.user.mustChange && !allowMustChange) throw new HttpError(403, "Choose your own password first.", "must-change");
    return who;
  };

  // A share link, /share/<token> (vercel.json sends it here as /api/share/<token>). Open to anyone with the link.
  const share = /^GET \/share\/([^/]+)$/.exec(route);
  if (share) return followShareLink(store, share[1], res);

  switch (route) {
    case "GET /health": {
      await headOf(store);
      return ok({ message: "Connected to MongoDB.", ...(store.diagnose ? await store.diagnose() : {}), setUp: !(await needsSetup(store)) });
    }
    case "GET /session": {
      const who = await authenticate(store, cookieToken);
      return ok({
        remote: true,
        needsSetup: !who && (await needsSetup(store)),
        user: who ? publicUser(who) : null,
        google: { available: google.googleAvailable() },
      });
    }
    case "POST /setup": {
      const r = await setup(
        store,
        {
          token: str(req.body.token),
          name: str(req.body.name),
          username: str(req.body.username),
          password: str(req.body.password),
          samples: req.body.samples === true,
        },
        req.ip,
        req.agent,
      );
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
      await dailyChecks(store);
      await alertChecks(store);
      // "Has anything changed?" is answered from one small document, without loading the data.
      const head = await headOf(store);
      if (!head) throw new HttpError(503, "The app has not been set up yet.");
      if (req.query.get("rev") === String(head.revision)) return ok({ unchanged: true, revision: head.revision });
      const snap = await snapshotFor(store, who.actor);
      if (!snap) throw new HttpError(503, "The app has not been set up yet.");
      return sendLarge(req, res, { ok: true, revision: snap.revision, db: snap.db });
    }
    case "GET /doc-history": {
      const revisions = await docHistory(store, (await signedIn()).actor, str(req.query.get("docId")));
      if (!revisions) throw new HttpError(404, "Not found.");
      return ok({ revisions });
    }
    case "GET /file": {
      await signedIn();
      const id = str(req.query.get("id"));
      const file = /^[a-f0-9]{32}$/.test(id) ? await store.files.get(id) : null;
      if (!file) throw new HttpError(404, "Not found.");
      return sendFile(res, file.type, Buffer.from(file.data, "base64"));
    }
    case "POST /action": {
      const who = await signedIn();
      await dailyChecks(store);
      await alertChecks(store);
      const result = await runAction(store, who, req.body.name, req.body.args, req.body.ids);
      return ok({ result: result ?? null });
    }
    case "POST /share-links": {
      const who = await signedIn();
      return ok(
        await createShareLink(store, who, req.origin, {
          episodeId: str(req.body.episodeId),
          note: str(req.body.note).slice(0, 500),
          replaces: str(req.body.replaces) || null,
        }),
      );
    }
    case "POST /migrate-workflow": {
      // Moving the existing projects into the five-stage workflow: a dry run, or with apply, the move itself.
      const who = await signedIn();
      return ok({ report: await migrateWorkflowRequest(store, who, req.body) });
    }
    case "GET /cron/daily": {
      // Vercel's daily cron sends "Authorization: Bearer <CRON_SECRET>". Without the secret set, only app use runs the check.
      const secret = process.env.CRON_SECRET;
      if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, "Not allowed.");
      const movedToHold = await dailyChecks(store, true);
      await alertChecks(store, { morning: true });
      return ok({ movedToHold });
    }
    case "GET /email/status": {
      // Whether the workspace's email account is set up (SMTP_USER and SMTP_PASS on the server), and for the Head of
      // Production, how the queue stands.
      const who = await signedIn();
      const loaded = await loadDb(store);
      const queue = who.actor.role === "HOP" ? (loaded?.db.emailQueue ?? []) : [];
      return ok({
        email: {
          available: emailAvailable(),
          queued: queue.filter((m) => m.status === "queued").length,
          failed: queue.filter((m) => m.status === "failed").map((m) => ({ to: m.to, subject: m.subject, error: m.lastError })),
        },
      });
    }
    case "POST /email/test": {
      // The Head of Production sends a test email to themself, straight away, to check the account works.
      const who = await signedIn();
      if (who.actor.role !== "HOP") throw new HttpError(403, "Only the Head of Production can send a test email.");
      if (!emailAvailable()) throw new HttpError(400, "Email is not set up: add SMTP_USER and SMTP_PASS to the server's environment.");
      const loaded = await loadDb(store);
      const me = loaded?.db.people.find((p) => p.personId === who.actor.personId);
      if (!me?.email) throw new HttpError(400, "Add your own email address to your profile first.");
      try {
        await smtpSender({
          to: me.email,
          subject: "Production Hub: test email",
          text: "This is a test from the Dawn of Faith Production Hub. Email reminders will come from this address.",
        });
      } catch (e) {
        throw new HttpError(502, `The email could not be sent: ${e instanceof Error ? e.message : String(e)}`);
      }
      return ok({ to: me.email });
    }
    case "POST /account/password": {
      const who = await signedIn(true);
      await changePassword(store, who, str(req.body.current), str(req.body.next));
      return ok();
    }
    case "POST /accounts/create":
      return ok(
        await createAccount(store, await signedIn(), {
          personId: str(req.body.personId),
          username: str(req.body.username),
          password: str(req.body.password) || undefined,
        }),
      );
    case "POST /accounts/reset":
      return ok(await resetPassword(store, await signedIn(), str(req.body.personId)));
    case "POST /accounts/disable": {
      await setDisabled(store, await signedIn(), str(req.body.personId), req.body.disabled === true);
      return ok();
    }
    case "POST /accounts/signout": {
      await signOutEverywhere(store, await signedIn(), str(req.body.personId));
      return ok();
    }

    case "GET /google/status":
      return ok({ google: await google.status(store, await signedIn()) });
    case "POST /google/link":
      return ok({
        url: await google.startLink(store, await signedIn(), req.origin, {
          calendar: req.body.calendar === true,
          gmail: req.body.gmail === true,
        }),
      });
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
    case "POST /google/unlink": {
      await google.unlink(store, await signedIn());
      return ok();
    }
    case "POST /google/calendar":
      return ok(await google.addToCalendar(store, await signedIn()));
    case "POST /google/email":
      return ok(await google.sendReminderEmail(store, await signedIn(), str(req.body.personId)));
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
