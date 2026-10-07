import { useEffect, useState } from "react";
import { api, isRemote } from "../data/remote";
import { useApp } from "../ui/AppContext";

// Whether the hub can send email, for everyone to see, and for the Head of Production a test send and how the queue
// stands (build prompt v4, section 12). The account itself is set only in the server's environment (SMTP_USER and
// SMTP_PASS in Vercel), never in the app or the code.

interface EmailStatusInfo {
  available: boolean;
  queued: number;
  failed: { to: string; subject: string; error: string }[];
}

export function EmailStatus() {
  const { actor, me, toast } = useApp();
  const [info, setInfo] = useState<EmailStatusInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isRemote()) return;
    let live = true;
    api
      .get<{ email: EmailStatusInfo }>("/api/email-status")
      .then((r) => live && setInfo(r.email))
      .catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, []);
  if (!isRemote() || !info) return null;
  const hop = actor.role === "HOP";
  return (
    <section className="glass panel" aria-label="Email">
      <h2>Email</h2>
      <div className="stack">
        <p>
          <span className={`badge ${info.available ? "ok" : "warn"}`}>{info.available ? "Set up" : "Not set up"}</span>{" "}
          {info.available
            ? "Reminder emails go out from the workspace's email account, each morning and as the hub is used."
            : "The hub sends no email yet: reminders still show in the bell."}
        </p>
        {!info.available && hop && (
          <p className="muted">
            To switch it on, add SMTP_USER (the sending address, a Google Workspace mailbox) and SMTP_PASS (an app password for it) in
            Vercel, under the project&apos;s Settings, Environment Variables, then redeploy. They are kept there, never in the app.
          </p>
        )}
        {hop && info.available && (
          <>
            <p className="muted">
              {info.queued} email{info.queued === 1 ? "" : "s"} waiting to go out
              {info.failed.length ? `; ${info.failed.length} could not be sent after five tries` : ""}.
            </p>
            {info.failed.length > 0 && (
              <ul className="cs-warn" aria-label="Emails that could not be sent">
                {info.failed.slice(0, 5).map((f, i) => (
                  <li key={i}>
                    {f.subject} to {f.to}: {f.error || "no reason given"}
                  </li>
                ))}
              </ul>
            )}
            <div>
              <button
                className="btn"
                disabled={busy || !me.email}
                title={me.email ? undefined : "Add your email address to your profile first"}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await api.post<{ to: string }>("/api/email-test");
                    toast(`Test email sent to ${r.to}. Check your inbox.`, "success");
                  } catch (e) {
                    toast(e instanceof Error ? e.message : String(e), "error");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Send a test email to me
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
