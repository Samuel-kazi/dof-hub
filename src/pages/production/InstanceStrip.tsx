import type { RecordingSession } from "../../types";
import { getDb } from "../../data/store";
import { getRecord } from "../../services/access";
import { fmtDate, todayIso } from "../../services/utils";
import { nameOf } from "../../services/wrapped/people";
import { applyDayToFuture, cancelDay, DAY_LABELS, getTemplate, resetToTemplate, setDayLabel } from "../../services/wrapped/production";
import { useReason } from "../workflow/common";
import { useApp } from "../../ui/AppContext";
import { isSheetLocked } from "../../services/sheetLock";

// Where a day of a recurring show stands with its template: following it (template changes reach it), or changed
// by hand and keeping its own, with the way back. Shown on the day's call sheet and on the day itself.

export function InstanceStrip({ day, write }: { day: RecordingSession; write: boolean }) {
  const { actor, attempt, confirm, go } = useApp();
  const [ask, reasonModal] = useReason();
  const info = day.instance;
  if (!info) return null;
  const show = getRecord(day.contentId);
  const t = getTemplate(info.templateId);
  const sheet = getDb().callSheets.find((c) => c.id === day.callSheetId || c.instanceId === day.id);
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
      {info.locked && write && t && !past && sheet && !isSheetLocked(sheet) && (
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
              attempt(() => resetToTemplate(actor, day.id), "Back on the template");
          }}
        >
          Put back on the template
        </button>
      )}
      {info.locked && write && t && !past && sheet && !isSheetLocked(sheet) && (
        <button
          className="btn small"
          onClick={async () => {
            if (
              await confirm({
                title: "Make this day's call sheet the template from here on?",
                body: "This and future occurrences: the template takes this day's call sheet, and every later day still following the template takes it too. Days before this one keep what they have. This day follows the template again.",
                confirmLabel: "This and future",
              })
            )
              attempt(() => applyDayToFuture(actor, day.id), "The template and the days after this one have this call sheet");
          }}
        >
          Apply to this and future days
        </button>
      )}
      {write && t && !past && !day.archivedAt && day.status === "Planned" && (
        <>
          <select
            aria-label="Label of this day"
            className="btn small"
            value={info.label ?? ""}
            onChange={(e) => attempt(() => setDayLabel(actor, day.id, e.target.value), "Label saved")}
          >
            <option value="">No label</option>
            {DAY_LABELS.map((l) => (
              <option key={l}>{l}</option>
            ))}
            {info.label && !DAY_LABELS.includes(info.label) && <option>{info.label}</option>}
          </select>
          <button
            className="btn small danger"
            onClick={async () => {
              const why = await ask(
                `Cancel ${fmtDate(day.scheduledDate ?? "")}?`,
                "Why is this date cancelled? The day is kept, marked cancelled, and the schedule leaves the date out.",
                "Cancel this date",
              );
              if (why) attempt(() => cancelDay(actor, day.id, why), "Date cancelled");
            }}
          >
            Cancel this date
          </button>
        </>
      )}
      {reasonModal}
    </section>
  );
}
