import type { ContentRecord } from "../../types";
import { getDb } from "../../data/store";
import { getRecord } from "../../services/access";
import { fmtDate, todayIso } from "../../services/utils";
import { nameOf } from "../../services/wrapped/people";
import { getTemplate, resetToTemplate } from "../../services/wrapped/production";
import { useApp } from "../../ui/AppContext";

// Where a day of a recurring show stands with its template: following it (template changes reach it), or changed
// by hand and keeping its own, with the way back. Shown on the day's call sheet and on the day itself.

export function InstanceStrip({ day, write }: { day: ContentRecord; write: boolean }) {
  const { actor, attempt, confirm, go } = useApp();
  const info = day.instance;
  if (!info) return null;
  const show = getRecord(day.parentId ?? "");
  const t = getTemplate(info.templateId);
  const sheet = getDb().callSheets.find((c) => c.instanceId === day.contentId);
  const past = (day.scheduledDate ?? "") < todayIso();
  return (
    <section className={`cs-instance ${info.locked ? "locked" : ""}`} aria-label="Template">
      <span className="grow">
        {info.locked ? (
          <>
            <b>Changed by hand</b>
            {info.lockedBy ? ` by ${info.lockedBy === "system" ? "the app" : nameOf(info.lockedBy)}` : ""}
            {info.lockedAt ? ` on ${fmtDate(info.lockedAt.slice(0, 10))}` : ""}. It keeps its own: changes to the template of{" "}
            {show?.title ?? "the show"} pass it by.
          </>
        ) : (
          <>
            <b>Follows the template</b> of {show?.title ?? "the show"}: a change to the template reaches this day, until someone changes its
            call sheet by hand.
          </>
        )}
      </span>
      {t && (
        <button className="btn small" onClick={() => go({ n: "template", id: t.id })}>
          Open the template
        </button>
      )}
      {info.locked && write && t && !past && sheet?.status !== "final" && (
        <button
          className="btn small"
          onClick={async () => {
            if (
              await confirm({
                title: "Put this day back on the template?",
                body: "Its call sheet takes the template's content again (its date stays), and gear the template does not have is released. Later template changes reach it again.",
                confirmLabel: "Put back",
              })
            )
              attempt(() => resetToTemplate(actor, day.contentId), "Back on the template");
          }}
        >
          Put back on the template
        </button>
      )}
    </section>
  );
}
