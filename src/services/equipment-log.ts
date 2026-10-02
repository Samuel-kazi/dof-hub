import type { Actor, Attachment, EquipmentHistory } from "../types";
import { RuleError } from "../types";
import { getDb } from "../data/store";
import { localId, logId } from "../data/ids";
import { STORED_FILE } from "./utils";

// Two small helpers shared by equipment-items.ts and equipment-manifests.ts. This file is not one the server
// exposes: only the actions listed in server/schemas.ts can be called from a browser.

/** Adds a line to an item's history. */
export function hist(
  by: Actor,
  equipmentId: string,
  kind: EquipmentHistory["kind"],
  detail: string,
  extra: { contentId?: string; manifestId?: string } = {},
): void {
  getDb().equipmentHistory.push({
    id: logId("H"),
    equipmentId,
    at: new Date().toISOString(),
    byPersonId: by.personId,
    kind,
    detail,
    contentId: extra.contentId ?? null,
    manifestId: extra.manifestId ?? null,
  });
}

/** A photo, receipt or link, checked before it is kept. */
export function makeAttachment(by: Actor, input: { url: string; caption?: string }): Attachment {
  const url = input.url.trim();
  if (!url) throw new RuleError("Add a photo or paste a link.");
  if (url.startsWith("data:")) {
    if (!url.startsWith("data:image/")) throw new RuleError("Only images can be attached.");
    if (url.length > 420_000) throw new RuleError("That image is too large. Try a smaller photo.");
  } else if (!STORED_FILE.test(url) && !/^https?:\/\//i.test(url)) {
    throw new RuleError("Links must start with http:// or https://.");
  }
  return { id: localId("ATT"), url, caption: (input.caption ?? "").trim(), at: new Date().toISOString(), byPersonId: by.personId };
}
