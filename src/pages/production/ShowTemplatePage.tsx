import type { SheetContent } from "../../types";
import { getDb, useDb } from "../../data/store";
import { getRecord } from "../../services/access";
import { describeRule, occurrencesBetween } from "../../services/recurrence";
import { addDaysIso, fmtDate, todayIso } from "../../services/utils";
import { roleOn } from "../../services/wrapped/team";
import { canPlanShow, daysOfShow, getTemplate, updateShowTemplate } from "../../services/wrapped/production";
import { listLocations } from "../../services/wrapped/locations";
import { useApp } from "../../ui/AppContext";
import { LevelField } from "../../ui/LevelField";
import { Empty, Field } from "../../ui/parts";
import { CrewSelect } from "../../ui/workflow/shared";
import {
  ContactsSection,
  CrewSection,
  LocationSection,
  LogisticsSection,
  PlannedGear,
  RehearsalSection,
  RunOfShowSection,
  ScheduleSection,
  Section,
  SectionNav,
  TalentSection,
  TechnicalCheckSection,
  crewCandidates,
  crewContactRows,
} from "./SheetSections";

// A recurring show's Show Template: its standard crew, gear, workflow, run of show and call sheet. A change here
// reaches every coming day still following the template; a day whose call sheet was changed by hand, or is final,
// keeps its own. The sections are the call sheet's own (src/pages/production/SheetSections.tsx).

export function ShowTemplatePage({ id }: { id: string }) {
  const { actor, attempt, go, toast } = useApp();
  useDb();
  const t = getTemplate(id);
  const show = t ? getRecord(t.contentId) : undefined;
  if (!t || !show)
    return (
      <div className="page">
        <Empty>This template does not exist, or is not part of a show you are attached to.</Empty>
      </div>
    );
  const plan = canPlanShow(actor, show) && !show.archived;
  const today = todayIso();
  const coming = daysOfShow(show.contentId).filter((d) => d.instance?.templateId === t.id && (d.scheduledDate ?? "") >= today);
  const following = coming.filter(
    (d) => !d.instance!.locked && getDb().callSheets.find((c) => c.instanceId === d.contentId)?.status !== "final",
  );
  const next = occurrencesBetween(t.rule, today, addDaysIso(today, 366))[0] ?? today;
  const report = (r: { updated: string[]; kept: string[] } | undefined) =>
    r &&
    toast(
      r.kept.length
        ? `Saved. ${r.updated.length} coming days follow it; ${r.kept.length} changed by hand or final keep their own.`
        : `Saved. ${r.updated.length} coming days follow it.`,
      "success",
    );
  const saveSheet = (patch: Partial<SheetContent>) => report(attempt(() => updateShowTemplate(actor, t.id, { sheet: patch })));
  const props = { value: t.sheet, editable: plan, onChange: saveSheet };
  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <button onClick={() => go({ n: "pipeline", category: "live" })}>Live Shows</button>
        <span aria-hidden> / </span>
        <button onClick={() => go({ n: "record", id: show.contentId })}>{show.title}</button>
        <span aria-hidden> / </span>
        <span>Template</span>
      </nav>
      <div className="page-head">
        <div className="grow">
          <h1>Template: {show.title}</h1>
          <p className="sub">
            {describeRule(t.rule, fmtDate)}. A change here reaches the {following.length} coming day{following.length === 1 ? "" : "s"} that
            follow{following.length === 1 ? "s" : ""} it
            {coming.length > following.length ? `; ${coming.length - following.length} changed by hand or final keep their own` : ""}.
          </p>
        </div>
        <button className="btn" onClick={() => go({ n: "record", id: show.contentId })}>
          The show and its days
        </button>
      </div>
      {!plan && (
        <p className="banner">
          Only the Head of Production, someone who manages the pipeline, or the show's responsible person can change the template.
        </p>
      )}
      <section className="glass panel" aria-label="Workflow">
        <h2>Workflow</h2>
        <div className="cs-grid wide">
          <LevelField
            disabled={!plan}
            value={t.productionLevel}
            onChange={(level) => report(attempt(() => updateShowTemplate(actor, t.id, { productionLevel: level })))}
          />
          <Field label="Responsible for each day">
            <CrewSelect
              label="Responsible for each day"
              value={t.ownerPersonId}
              disabled={!plan}
              onChange={(p) => report(attempt(() => updateShowTemplate(actor, t.id, { ownerPersonId: p })))}
            />
          </Field>
          <Field label="Days made ahead (weeks)">
            <input
              type="number"
              aria-label="Days made ahead, in weeks"
              min={1}
              max={26}
              defaultValue={t.horizonWeeks}
              disabled={!plan}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (n !== t.horizonWeeks) report(attempt(() => updateShowTemplate(actor, t.id, { horizonWeeks: n })));
              }}
            />
          </Field>
        </div>
        <p className="muted">
          Each day runs through the live pipeline (Prep, Build, Rehearse, Show, Wrap, Review, Post Production), due around its own date.
        </p>
      </section>
      <SectionNav />
      <ScheduleSection {...props} />
      <CrewSection
        {...props}
        candidates={crewCandidates(show.contentId, t.sheet.crewPersonIds)}
        roleHint={(pid) => roleOn(pid, show) || null}
      />
      <TalentSection {...props} />
      <LocationSection {...props} saved={{ list: listLocations() }} />
      <Section id="equipment" title="Equipment">
        <PlannedGear {...props} pickDate={next} template />
      </Section>
      <LogisticsSection {...props} />
      <ContactsSection {...props} crewRows={crewContactRows(t.sheet, actor, (pid) => roleOn(pid, show) || null)} />
      <RunOfShowSection {...props} />
      <TechnicalCheckSection {...props} canTick={false} />
      <RehearsalSection {...props} canTick={false} />
    </div>
  );
}
