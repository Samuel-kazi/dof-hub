import type { CategoryKey, ContentRecord } from "../../types";
import { formTypeOf } from "../../config/workflow";
import { nameOf } from "../../services/wrapped/people";
import { workflowBoard, type WorkItem } from "../../services/workItems";
import { fmtShort } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { Empty } from "../../ui/parts";
import { ReviewDueTag } from "../../ui/ReviewCheck";

// The board for series, devotions and documentaries: a column per stage of the five-stage workflow, with the card
// at the level that stage works at. A project shows in Development and Pre-production, a recording session in
// Production, and each episode on its own in Post production and Marketing and distribution. A card opens the
// page where it is worked on; its Done buttons are there, behind their gates.

const PLACEHOLDER: Record<string, string> = {
  Development: "No projects in Development.",
  "Pre-production": "No projects waiting on pre-production.",
  Production: "No session is recording.",
  "Post production": "No episodes in post production.",
  "Marketing and distribution": "No episodes waiting to be published.",
};

/** What the card's next Done button still needs, in a word, with the full list on hover. */
function GateBadge({ item }: { item: WorkItem }) {
  if (item.reviews.length && !item.gate)
    return <span className="badge warn">Waiting for {item.reviews.map((r) => r.label.toLowerCase()).join(" and ")}</span>;
  if (!item.gate) return null;
  if (item.gate.passed) return <span className="badge ok">Ready to move on</span>;
  const n = item.gate.missing.length;
  return (
    <span className="badge" title={`Still needed:\n${item.gate.missing.join("\n")}`}>
      {n} thing{n === 1 ? "" : "s"} to do
    </span>
  );
}

export function WorkCard({ item }: { item: WorkItem }) {
  const { go, menu } = useApp();
  const owner = item.ownerId ? nameOf(item.ownerId) : item.level === "episode" ? "No editor" : "No producer";
  const when = item.due ? (item.level === "session" ? ` on ${fmtShort(item.due)}` : `, due ${fmtShort(item.due)}`) : "";
  const context = item.level === "project" ? formTypeOf(item.project.workflow.formType).label : item.context;
  return (
    <div
      className="card"
      tabIndex={0}
      role="link"
      aria-label={`${item.title}, ${item.id}`}
      onClick={() => go(item.open)}
      onKeyDown={(e) => e.key === "Enter" && go(item.open)}
      onContextMenu={(e) =>
        menu(e, [
          { label: "Open", onClick: () => go(item.open) },
          ...(item.level === "project"
            ? []
            : [{ label: "Open the project", onClick: () => go({ n: "record", id: item.project.contentId }) }]),
        ])
      }
    >
      <span className="t">{item.title}</span>
      <span className="cid">{item.id}</span>
      <span className="muted" style={{ fontSize: ".82rem" }}>
        {context}
      </span>
      <span style={{ fontSize: ".86rem" }}>{item.step}</span>
      <span className="muted" style={{ fontSize: ".82rem" }}>
        {owner}
        {when}
      </span>
      <span className="wf-chips">
        {item.overdue && <span className="badge bad">Overdue</span>}
        <GateBadge item={item} />
        {item.level === "project" && <ReviewDueTag contentId={item.project.contentId} />}
      </span>
    </div>
  );
}

function ClosedCard({ r }: { r: ContentRecord }) {
  const { go } = useApp();
  return (
    <div
      className="card"
      tabIndex={0}
      role="link"
      onClick={() => go({ n: "record", id: r.contentId })}
      onKeyDown={(e) => e.key === "Enter" && go({ n: "record", id: r.contentId })}
    >
      <span className="t">{r.title}</span>
      <span className="cid">{r.contentId}</span>
      <span className="muted" style={{ fontSize: ".82rem" }}>
        {r.workflow?.status === "Advice only" ? "Advice only" : "Closed"}: {r.closedReason}
      </span>
    </div>
  );
}

export function WorkflowBoard({
  category,
  items,
  closed,
  showPublished,
}: {
  category: CategoryKey;
  items: WorkItem[];
  closed: ContentRecord[] | null;
  showPublished: boolean;
}) {
  const mine = items.filter((i) => i.category === category);
  const columns = workflowBoard(mine);
  const published = mine.filter((i) => i.level === "episode" && i.done);
  return (
    <div className="board" aria-label="Board">
      {columns.map((col) => (
        <section key={col.stage} className="col glass" aria-label={col.stage}>
          <h3>
            {col.stage}
            <span className="muted">{col.cards.length}</span>
          </h3>
          {col.cards.length === 0 ? <Empty>{PLACEHOLDER[col.stage]}</Empty> : col.cards.map((i) => <WorkCard key={i.key} item={i} />)}
        </section>
      ))}
      {showPublished && (
        <section className="col glass" aria-label="Published">
          <h3>
            Published<span className="muted">{published.length}</span>
          </h3>
          {published.length === 0 ? <Empty>Nothing published yet.</Empty> : published.map((i) => <WorkCard key={i.key} item={i} />)}
        </section>
      )}
      {closed && (
        <section className="col glass" aria-label="Closed">
          <h3>
            Closed<span className="muted">{closed.length}</span>
          </h3>
          {closed.length === 0 ? <Empty>Nothing closed.</Empty> : closed.map((r) => <ClosedCard key={r.contentId} r={r} />)}
        </section>
      )}
    </div>
  );
}
