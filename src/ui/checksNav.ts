import type { WorkflowStage } from "../types";

// How the Checks panel's "Go to" reaches what it points at (build prompt v4, section 14A): a project's document is
// opened by the project's page (which may need to be opened first), and a field on the page is scrolled to and
// focused. The panel is opened from a Done button whose checks are not met, the same way.

const OPEN_DOC = "dof-open-doc";
const OPEN_CHECKS = "dof-open-checks";

interface DocRequest {
  projectId: string;
  stage: WorkflowStage;
  key: string;
}

let pending: DocRequest | null = null;
const taken = (): boolean => pending === null;

/** Asks the project's page to open one of its documents: now, if it is on screen (true), or once it is opened (false). */
export function openDoc(projectId: string, stage: WorkflowStage, key: string): boolean {
  pending = { projectId, stage, key };
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<DocRequest>(OPEN_DOC, { detail: pending }));
  return taken();
}

/** For the project's page when it opens: the document asked for, once. */
export function takePendingDoc(projectId: string): { stage: WorkflowStage; key: string } | null {
  if (!pending || pending.projectId !== projectId) return null;
  const { stage, key } = pending;
  pending = null;
  return { stage, key };
}

/** Listens for documents asked for while the project's page is open. Returns the way to stop. */
export function onOpenDoc(projectId: string, open: (stage: WorkflowStage, key: string) => void): () => void {
  const listen = (e: Event) => {
    const d = (e as CustomEvent<DocRequest>).detail;
    if (d.projectId !== projectId) return;
    pending = null;
    open(d.stage, d.key);
  };
  window.addEventListener(OPEN_DOC, listen);
  return () => window.removeEventListener(OPEN_DOC, listen);
}

/** Scrolls to an element on the page and puts the cursor in its first field. */
export function goToAnchor(anchor: string): boolean {
  const el = typeof document !== "undefined" ? document.getElementById(anchor) : null;
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  const field = el.querySelector<HTMLElement>("input, select, textarea, button");
  (field ?? el).focus?.({ preventScroll: true });
  return true;
}

/** Opens the Checks panel for an owner (a project, session, episode or call sheet): a Done button whose checks fail. */
export function openChecks(ownerId: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<string>(OPEN_CHECKS, { detail: ownerId }));
}

/** Listens for the panel being asked to open. Returns the way to stop. */
export function onOpenChecks(ownerId: string, open: () => void): () => void {
  const listen = (e: Event) => (e as CustomEvent<string>).detail === ownerId && open();
  window.addEventListener(OPEN_CHECKS, listen);
  return () => window.removeEventListener(OPEN_CHECKS, listen);
}
