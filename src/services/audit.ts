import type { Actor } from "../types";
import { getDb } from "../data/store";
import { logId } from "../data/ids";

// Every write goes through here. Callers commit() after.
export function logAudit(actor: Actor, action: string, entity: string, entityId: string, detail = ""): void {
  const db = getDb();
  db.audit.push({
    id: logId("A"),
    at: new Date().toISOString(),
    byPersonId: actor.personId,
    action,
    entity,
    entityId,
    detail,
  });
}
