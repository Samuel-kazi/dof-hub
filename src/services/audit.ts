import type { Actor } from "../types";
import { getDb, nextCounter } from "../data/store";

// Every write goes through here. Callers commit() after.
export function logAudit(actor: Actor, action: string, entity: string, entityId: string, detail = ""): void {
  const db = getDb();
  db.audit.push({
    id: `A-${String(nextCounter("audit")).padStart(5, "0")}`,
    at: new Date().toISOString(),
    byPersonId: actor.personId,
    action,
    entity,
    entityId,
    detail,
  });
}
