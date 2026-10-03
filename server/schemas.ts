import { z } from "zod";
import { CATEGORIES } from "../src/config/categories";
import { ACCENTS, FONT_PAIRINGS } from "../src/config/appearance";
import { CONDITIONS, EQUIP_CATEGORIES } from "../src/config/equipment";
import { ALL_CAPABILITIES } from "../src/config/permissions";
import { CRITERIA, FORM_TYPES, PROJECT_ROLE_DEFS, SERIES_TYPES } from "../src/config/workflow";

// Every change the browser may ask the server to make, and the exact shape of what it may send.
//
// The service functions declare their arguments as TypeScript types, but types are gone by the time the
// server runs: the server receives whatever JSON the request contains. Each argument is checked here before
// the service runs, and objects keep only the fields listed (anything else is dropped). An action that is
// not listed here does not exist, whatever is exported from src/services.
//
// Adding a new action: write the service function (actor first), run `npm run gen`, then add it here.
// tests/actions.test.ts fails until every generated name is either listed here or in NOT_ACTIONS below.

const enumOf = <T extends string>(values: readonly T[]) => z.enum(values as unknown as [T, ...T[]]);

const id = z.string().min(1).max(120);
/** A reference to a person, sheet or template that may be left empty; the services treat empty as not set. */
const ref = z.string().max(120);
const ids = (max = 500) => z.array(id).max(max);
const short = (max = 300) => z.string().max(max);
const text = (max = 20_000) => z.string().max(max);
/** A calendar date as an <input type="date"> gives it (2026-09-26), or empty. A time part is tolerated for older data. */
const date = z.string().regex(/^(\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?)?$/, "Expected a date.");
const time = z.string().max(20);
const version = z.number().int().min(0);
const count = (max = 1_000_000) => z.number().int().min(0).max(max);
const amount = (max = 1e9) => z.number().min(0).max(max);
const roles = z.array(short(100)).max(30);
/** A link (http or https), or a photo as a data: URL. The services check which is allowed where. */
const url = z.string().max(450_000);

const category = enumOf(CATEGORIES.map((c) => c.key));
const level = z.enum(["small", "medium", "large"]);
const equipCategory = enumOf(EQUIP_CATEGORIES.map((c) => c.key));
const condition = enumOf(CONDITIONS);
const capability = enumOf(ALL_CAPABILITIES);
const staffCategory = z.enum(["CRW", "VOL", "PTR"]);

const photo = z.object({ url, caption: short(500).optional() });
const line = z.object({ equipmentId: id, quantity: count(100_000) });

// ── Argument lists ───────────────────────────────────────────

export interface ActionSpec {
  required: z.ZodType[];
  optional: z.ZodType[];
}
const args = (required: z.ZodType[], optional: z.ZodType[] = []): ActionSpec => ({ required, optional });

export class InvalidArgs extends Error {}

/** Checks the arguments after the actor. Missing or null optional arguments become undefined, so defaults apply. */
export function parseArgs(spec: ActionSpec, raw: unknown[]): unknown[] {
  const max = spec.required.length + spec.optional.length;
  // A trailing undefined arrives as null after JSON; it is the same as not passing the argument.
  let n = raw.length;
  while (n > spec.required.length && (raw[n - 1] === null || raw[n - 1] === undefined)) n--;
  if (n < spec.required.length) throw new InvalidArgs(`expected at least ${spec.required.length} arguments, got ${raw.length}`);
  if (n > max) throw new InvalidArgs(`expected at most ${max} arguments, got ${raw.length}`);
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const schema = i < spec.required.length ? spec.required[i] : spec.optional[i - spec.required.length];
    const value = raw[i];
    if (i >= spec.required.length && (value === null || value === undefined)) {
      out.push(undefined);
      continue;
    }
    const r = schema.safeParse(value);
    if (!r.success) {
      const issue = r.error.issues[0];
      const where = [`argument ${i + 1}`, ...issue.path.map(String)].join(".");
      throw new InvalidArgs(`${where}: ${issue.message}`);
    }
    out.push(r.data);
  }
  return out;
}

// ── The actions ──────────────────────────────────────────────

const recordFields = {
  title: short(),
  scheduledDate: date.nullable(),
  deadline: date.nullable(),
  assigneePersonId: ref.nullable(),
  notes: text(),
  productionLevel: level.nullable(),
  showStart: date.nullable(),
  showEnd: date.nullable(),
};

// The five-stage workflow. Development form sections are checked again, field by field and strictly, against
// src/config/devForms.ts by the service, since their shape depends on the form type and section.
const seriesType = enumOf(SERIES_TYPES.map((t) => t.key));
const formType = enumOf(FORM_TYPES.map((t) => t.key));
const outcome = z.enum(["Greenlight", "Revise and resubmit", "Hold", "Decline", "Advice only"]);
const criterion = enumOf(CRITERIA.map((c) => c.key));
const roleKey = enumOf(PROJECT_ROLE_DEFS.map((r) => r.key));
const logStatus = z.enum(["Recorded", "Pickup needed", "Not recorded"]);
/** IDs that join several parts, such as DOF-SER-001-S1-R01|DOF-SER-001-S1-P07. */
const compound = z.string().min(1).max(260);
const sectionValues = z.record(z.string().max(60), z.union([z.string().max(20_000), amount(1e12), z.null(), z.array(short(100)).max(20)]));
const plannedDetails = z.record(z.string().max(60), z.string().max(20_000));
const plannedFields = {
  workingTitle: short(),
  question: text(2000),
  guest: short(),
  notes: text(5000),
  details: plannedDetails,
};
const runSheetItem = z.object({
  time,
  title: short(),
  durationMin: count(600),
  ownerPersonId: ref.nullable().optional(),
  notes: text(2000).optional(),
});
const logFields = { itemLabel: short(), guest: short(), status: logStatus.nullable(), notesForPost: text() };
const webLink = z.string().max(2048);
const workflowStage = z.enum(["Development", "Pre-production", "Production", "Post production", "Marketing and distribution"]);
/** A storyboard or shot list's picture: a stored file's address, or a photo just shrunk in the browser (filed by the server). */
const image = z.string().max(2_000_000).nullable();
const newBoard = z.object({ name: short(500), episodeId: id.nullable().optional(), copyFrom: id.nullable().optional() });
const frameEdit = z
  .object({ scene: short(40), imagePath: image, description: short(500), soundEffects: short(500), videoLink: webLink })
  .partial();
const rowEdit = z
  .object({
    imagePath: image,
    description: short(500),
    shotSize: short(60),
    shotType: short(60),
    movement: short(60),
    estMinutes: z.number().min(0).max(600).nullable(),
  })
  .partial();
const distribution = z.object({
  platform: short(100),
  status: z.enum(["Planned", "Scheduled", "Published"]),
  link: webLink.optional(),
  date: date.nullable().optional(),
});

export const ACTIONS: Record<string, ActionSpec> = {
  // Call sheets
  "callsheets.createCallSheet": args([
    z.object({
      contentId: id,
      date,
      title: short().optional(),
      location: short(500).optional(),
      callTime: time.optional(),
      crewPersonIds: ids(200).optional(),
      format: short().optional(),
      notes: text().optional(),
    }),
  ]),
  "callsheets.openOrCreateForRecord": args([id]),
  "callsheets.duplicateCallSheet": args([id, date]),
  "callsheets.resolveMismatches": args([id], [version]),
  "callsheets.updateCallSheet": args(
    [
      id,
      z.object({
        title: short().optional(),
        location: short(500).optional(),
        callTime: time.optional(),
        crewPersonIds: ids(200).optional(),
        format: short().optional(),
        notes: text().optional(),
        date: date.optional(),
      }),
    ],
    [version],
  ),
  "callsheets.attachCallSheet": args([id, id], [version]),
  "callsheets.finalizeCallSheet": args([id], [version]),
  "callsheets.reopenCallSheet": args([id]),
  "callsheets.deleteCallSheet": args([id]),
  "callsheets.addRunItem": args([
    id,
    z.object({ time, title: short(), durationMin: count(600), ownerPersonId: ref.nullable().optional(), notes: text(2000).optional() }),
  ]),
  "callsheets.updateRunItem": args([
    id,
    id,
    z.object({
      time: time.optional(),
      title: short().optional(),
      durationMin: count(600).optional(),
      ownerPersonId: ref.nullable().optional(),
      notes: text(2000).optional(),
    }),
  ]),
  "callsheets.removeRunItem": args([id, id]),

  // Projects and their pipeline
  "content.createRecord": args([
    z
      .object({ category, ...recordFields })
      .partial()
      .required({ category: true, title: true }),
  ]),
  "content.createChildRecord": args([id, z.object(recordFields).partial().required({ title: true })]),
  "content.splitRecording": args([id, z.object({ destCategory: z.enum(["music", "series"]), parentId: id, title: short() })]),
  "content.setStrikePlan": args(
    [id, z.enum(["daily", "continuous"]), z.array(short(500)).max(200), z.array(short(500)).max(200)],
    [version],
  ),
  "content.updateRecord": args(
    [
      id,
      z
        .object({
          ...recordFields,
          guestName: short(),
          guestContact: short(500),
          cardStorage: short(500),
          publishDate: date.nullable(),
          recordingDurationMin: amount(100_000).nullable(),
          recordingNotes: text(),
          editorNotes: text(),
        })
        .partial(),
    ],
    [version],
  ),
  "content.setStageDeadline": args([id, short(100), date], [version]),
  "content.setPostProductionNeeded": args([id, z.boolean()], [version]),
  "content.setStageOutput": args([id, z.boolean()], [version]),
  "content.advanceStage": args([id], [version]),
  "content.sendBackStage": args([id], [version]),
  "content.approveGuestReview": args([id, short()], [version]),
  "content.closeDevotional": args([id, text(5000)], [version]),
  "content.setDevotionalReadyForReview": args([id, z.boolean()], [version]),
  "content.approveDevotionalReview": args([id], [version]),
  "content.sendBackDevotionalToEditing": args([id, text(5000)], [version]),
  "content.addStageOwner": args([id, short(100), id, roles], [version]),
  "content.setOwnerRoles": args([id, short(100), id, roles]),
  "content.removeStageOwner": args([id, short(100), id]),
  "content.addTask": args([
    id,
    z.object({
      stage: short(100).optional(),
      label: short(),
      dueDate: date.nullable().optional(),
      assigneePersonId: ref.nullable().optional(),
    }),
  ]),
  "content.updateTask": args([
    id,
    id,
    z.object({
      label: short().optional(),
      dueDate: date.nullable().optional(),
      assigneePersonId: ref.nullable().optional(),
      done: z.boolean().optional(),
    }),
  ]),
  "content.removeTask": args([id, id]),
  "content.addFeatured": args([id, z.object({ kind: z.enum(["host", "guest"]), name: short(), note: short(500).optional() })]),
  "content.updateFeatured": args([
    id,
    id,
    z.object({ kind: z.enum(["host", "guest"]).optional(), name: short().optional(), note: short(500).optional() }),
  ]),
  "content.removeFeatured": args([id, id]),
  "content.addLinks": args([
    id,
    z.object({
      stage: short(100).optional(),
      kind: z.enum(["review", "final", "analysis", "reference"]),
      links: z.array(z.object({ url: short(2000).optional(), note: text(5000).optional() })).max(50),
    }),
  ]),
  "content.removeLink": args([id, id]),
  "content.deleteRecord": args([id]),
  "content.addComment": args([id, text(5000)], [ref.nullable()]),

  // Documents
  "docs.createDoc": args([
    z.object({ contentId: id, title: short().optional(), templateKey: ref.nullable().optional(), body: text(250_000).optional() }),
  ]),
  "docs.attachDoc": args([id, id]),
  "docs.saveDoc": args([id, z.object({ title: short().optional(), body: text(250_000).optional() }), version]),
  "docs.restoreRevision": args([id, id]),
  "docs.archiveDoc": args([id]),

  // Equipment
  "equipment.createItem": args([
    z.object({
      trackingType: z.enum(["serialized", "aggregate"]),
      name: short(),
      make: short(),
      model: short(),
      category: equipCategory,
      itemFamily: short(100).optional(),
      serialNumber: short(200).optional(),
      unitLabel: short(100).optional(),
      quantity: count(100_000).optional(),
      unitCost: amount(),
      purchaseDate: date.nullable().optional(),
      vendor: short(),
      condition,
      packaging: short(2000),
      accessories: short(2000),
      info: text(5000),
    }),
  ]),
  "equipment.createSerializedUnits": args([
    z.object({
      name: short(),
      make: short(),
      model: short(),
      category: equipCategory,
      unitCost: amount(),
      purchaseDate: date.nullable().optional(),
      vendor: short(),
      condition,
      packaging: short(2000),
      accessories: short(2000),
      info: text(5000),
      units: z
        .array(z.object({ serialNumber: short(200), label: short(100).optional() }))
        .min(1)
        .max(200),
    }),
  ]),
  "equipment.updateItem": args([
    id,
    z
      .object({
        name: short(),
        make: short(),
        model: short(),
        vendor: short(),
        packaging: short(2000),
        accessories: short(2000),
        info: text(5000),
        unitCost: amount(),
        purchaseDate: date.nullable(),
        serialNumber: short(200).nullable(),
        unitLabel: short(100).nullable(),
        condition,
        quantityTotal: count(100_000),
        category: equipCategory,
      })
      .partial(),
  ]),
  "equipment.setConditionBreakdown": args([
    id,
    z.object({ New: count(100_000), Good: count(100_000), Fair: count(100_000), Poor: count(100_000) }).partial(),
  ]),
  "equipment.addAttachment": args([id, z.enum(["photo", "receipt"]), photo]),
  "equipment.removeAttachment": args([id, id]),
  "equipment.startRepair": args([id, text(5000)]),
  "equipment.finishRepair": args([id, condition, text(5000)]),
  "equipment.retireItem": args([id, z.enum(["retired", "lost"]), text(5000)]),
  "equipment.reinstateItem": args([id]),
  "equipment.deleteItem": args([id]),
  "equipment.createManifest": args([
    z.object({
      contentId: id,
      date,
      expectedReturn: date.nullable().optional(),
      destination: z.enum(["studio", "outside"]),
      status: z.enum(["assigned", "checked-out"]),
      responsiblePersonId: ref.optional(),
      lines: z.array(line).max(500),
      notes: text(5000).optional(),
      callSheetId: ref.nullable().optional(),
    }),
  ]),
  "equipment.addLines": args([id, z.array(line).max(500)]),
  "equipment.removeLine": args([id, id]),
  "equipment.markGoneOut": args(
    [id],
    [
      z.object({
        expectedReturn: date.optional(),
        responsiblePersonId: ref.optional(),
        photos: z.record(id, z.array(photo).max(20)).optional(),
      }),
    ],
  ),
  "equipment.checkIn": args([
    id,
    z
      .array(
        z.object({
          equipmentId: id,
          returnedGood: count(100_000),
          damaged: count(100_000),
          lost: count(100_000),
          conditionIn: condition.optional(),
          description: text(5000).optional(),
          sendToRepair: z.boolean().optional(),
          photos: z.array(photo).max(20).optional(),
        }),
      )
      .max(500),
  ]),
  "equipment.attachManifest": args([id, id]),
  "equipment.releaseManifest": args([id]),
  "equipment.addGearToSheet": args([z.object({ id, contentId: id, date }), z.array(line).max(500)]),
  "equipment.removeGearFromSheet": args([id, id]),

  // People
  "people.createPerson": args([
    z.object({
      category: staffCategory,
      name: short(),
      email: short(),
      phone: short(100),
      skills: z.array(short(100)).max(100),
      equipmentFamiliarity: z.array(short(100)).max(200),
    }),
  ]),
  "people.updatePerson": args([
    id,
    z
      .object({
        name: short(),
        email: short(),
        phone: short(100),
        skills: z.array(short(100)).max(100),
        equipmentFamiliarity: z.array(short(100)).max(200),
      })
      .partial(),
  ]),
  "people.updateOwnProfile": args([
    z
      .object({
        name: short(),
        email: short(),
        phone: short(100),
        notifyEmail: z.boolean(),
        notifySms: z.boolean(),
        photoUrl: url.nullable(),
        fontSize: z.enum(["small", "default", "large", "xl"]),
        density: z.enum(["comfortable", "compact"]),
      })
      .partial(),
  ]),
  "people.updatePersonCategory": args([id, staffCategory]),
  "people.deactivatePerson": args([id]),
  "people.reactivatePerson": args([id]),
  "people.assignToProject": args([id, id, short(500), z.boolean()]),
  "people.removeFromProject": args([id, id]),

  // Access (the services allow these for the Head of Production only)
  "permissions.setRoleGrant": args([staffCategory, capability, z.boolean().nullable()]),
  "permissions.setPersonGrant": args([id, capability, z.boolean().nullable()]),
  "permissions.resetPermissions": args([]),

  // Reminders
  "reminders.logSent": args([id, z.enum(["email", "calendar", "text"]), short(500), text(20_000), z.array(short(300)).max(500)]),

  // Settings
  "settings.updateSettings": args([
    z
      .object({
        stageReminderHours: z.number().min(0).max(10_000),
        storageWarningThreshold: z.number().min(0).max(100),
        checkoutReturnDays: count(1000),
        workDays: z.array(z.number().int().min(0).max(6)).max(7),
        effortOverrides: z.record(short(200), z.number().min(0).max(1000)),
      })
      .partial(),
  ]),
  "settings.updateWorkspaceAppearance": args([
    z.object({ accent: enumOf(ACCENTS.map((a) => a.key)), fontPairing: enumOf(FONT_PAIRINGS.map((f) => f.key)) }).partial(),
  ]),

  // Storage
  "storage.createDrive": args([
    z.object({ name: short(), capacityGB: amount(1e8), otherUsedGB: amount(1e8).optional(), notes: text(5000).optional() }),
  ]),
  "storage.updateDrive": args([
    id,
    z.object({ name: short(), capacityGB: amount(1e8), otherUsedGB: amount(1e8), notes: text(5000) }).partial(),
  ]),
  "storage.deleteDrive": args([id]),
  "storage.addAllocation": args([
    z.object({
      driveId: id,
      contentId: ref.nullable(),
      sizeGB: amount(1e8),
      kind: z.enum(["raw", "project", "delivered", "other"]),
      note: text(5000).optional(),
      label: short().optional(),
    }),
  ]),
  "storage.updateAllocation": args([
    id,
    z
      .object({
        sizeGB: amount(1e8),
        kind: z.enum(["raw", "project", "delivered", "other"]),
        note: text(5000),
        label: short(),
        driveId: id,
      })
      .partial(),
  ]),
  "storage.moveAllocation": args([id, id]),
  "storage.removeAllocation": args([id]),
  "storage.clearRecordFromDrives": args([id]),

  // The five-stage workflow: projects and Development
  "workflow.createWorkflowProject": args([
    z.object({
      category: z.enum(["series", "devotional", "documentary"]),
      title: short(),
      seriesType: seriesType.nullable().optional(),
      seriesId: ref.nullable().optional(),
      formType: formType.nullable().optional(),
      deadline: date.nullable().optional(),
    }),
  ]),
  "workflow.assignProducer": args([id, ref.nullable()]),
  "workflow.closeProject": args([id, text(2000)]),
  "workflow.setWorkflowDeadline": args([id, short(60), date.nullable()]),
  "workflow.advanceProject": args([id]),
  "workflow.saveFormSection": args([id, short(60), sectionValues]),
  "workflow.setCriterion": args([id, criterion, z.object({ met: z.boolean().nullable(), note: text(2000) })]),
  "workflow.setReviewWindow": args([id, date.nullable()]),
  "workflow.decideGreenlight": args([id, z.object({ outcome, notes: text(5000), date: date.nullable().optional() })]),
  "workflow.addPlannedEpisode": args([id, z.object(plannedFields).partial().required({ workingTitle: true })]),
  "workflow.updatePlannedEpisode": args([id, z.object(plannedFields).partial()]),
  "workflow.archivePlannedEpisode": args([id, text(2000)]),
  "workflow.setCheckpointReviewers": args([compound, ids(10)]),
  "workflow.decideCheckpoint": args([compound, z.object({ status: z.enum(["Approved", "Changes requested"]), note: text(5000) })]),
  // Pre-production
  "workflow.assignRole": args([id, roleKey, z.object({ crewId: ref.nullable().optional(), guestName: short(120).nullable().optional() })]),
  "workflow.removeRole": args([compound]),
  "workflow.setChecklistItem": args([compound, z.object({ done: z.boolean().optional(), note: text(2000).optional() })]),
  "workflow.createSession": args([id], [z.object({ scheduledDate: date.nullable().optional(), venue: short().optional() })]),
  "workflow.updateSession": args([id, z.object({ scheduledDate: date.nullable(), venue: short(), dailyLog: text() }).partial()]),
  "workflow.archiveSession": args([id, text(2000)]),
  "workflow.resetRunSheet": args([id], [count(240)]),
  "workflow.addRunSheetItem": args([id, runSheetItem]),
  "workflow.updateRunSheetItem": args([id, id, runSheetItem.partial()]),
  "workflow.removeRunSheetItem": args([id, id]),
  "workflow.createSessionCallSheet": args([id]),
  // Production
  "workflow.addLogRow": args([id, z.object({ plannedEpisodeId: ref.nullable(), logDate: date.nullable(), ...logFields }).partial()]),
  "workflow.updateLogRow": args([compound, z.object({ logDate: date, ...logFields }).partial()]),
  "workflow.removeLogRow": args([compound]),
  "workflow.openSession": args([id]),
  "workflow.closeSession": args([id]),
  "workflow.reopenSession": args([id]),
  "workflow.sendToPostProduction": args([id]),
  // Post production, and Marketing and distribution
  "workflow.setEpisodeEditor": args([id, ref.nullable()]),
  "workflow.setEpisodeLinks": args([id, z.object({ reviewLink: webLink, finalFileLink: webLink }).partial()]),
  "workflow.startEditing": args([id]),
  "workflow.setReadyForReview": args([id, z.boolean()]),
  "workflow.sendForReview": args([id]),
  "workflow.moveToMarketing": args([id]),
  "workflow.approveReleasePlan": args([id]),
  "workflow.publishEpisode": args([id]),
  "workflow.addDistribution": args([id, distribution]),
  "workflow.updateDistribution": args([id, id, distribution]),
  "workflow.removeDistribution": args([id, id]),
  "workflow.setLearningNotes": args([id, text()]),
  // Share links. A link with a token is made by POST /api/share-links, never by an action.
  "workflow.copyShareLink": args([id], [short(500)]),
  "workflow.revokeShareLink": args([id]),

  // ── Project documents, storyboards and shot lists (src/services/documents.ts) ──
  "documents.ensureDocument": args([id, workflowStage, short(60)], [compound.nullable()]),
  "documents.syncReviewThread": args([id]),
  "documents.addPage": args([compound], [z.object({ title: short(300), subtitle: short(300), afterPageId: id.nullable() }).partial()]),
  // A page body can be long; the service refuses anything over its limit (MAX_PAGE_HTML) with a clear message.
  "documents.savePage": args([
    id,
    z.object({ title: short(300), subtitle: short(300), bodyHtml: z.string().max(450_000) }).partial(),
    version,
  ]),
  "documents.movePage": args([id, count(10_000)]),
  "documents.archivePage": args([id]),
  "documents.restorePage": args([id]),
  "documents.addDocumentLink": args([compound, webLink, short(300)]),
  "documents.removeDocumentLink": args([id]),
  "documents.setDocumentReviewers": args([compound, ids(10)]),
  "documents.decideDocumentReview": args([compound, z.object({ status: z.enum(["approved", "changes_requested"]), note: text(5000) })]),
  "documents.addReviewComment": args([id, text(5000)]),
  "documents.resolveReviewComment": args([id], [z.boolean()]),
  "documents.createStoryboard": args([id, newBoard]),
  "documents.renameStoryboard": args([id, short(500)]),
  "documents.addFrame": args([id], [frameEdit]),
  "documents.updateFrame": args([id, frameEdit]),
  "documents.moveFrame": args([id, count(10_000)]),
  "documents.duplicateFrame": args([id]),
  "documents.deleteFrames": args([ids(500)]),
  "documents.moveFramesTo": args([ids(500), id]),
  "documents.createShotList": args([id, newBoard]),
  "documents.renameShotList": args([id, short(500)]),
  "documents.addShotRow": args([id, z.enum(["shot", "setup", "banner"])], [rowEdit]),
  "documents.updateShotRow": args([id, rowEdit]),
  "documents.moveShotRow": args([id, count(10_000)]),
  "documents.duplicateShotRow": args([id]),
  "documents.deleteShotRows": args([ids(500)]),
  "documents.makeDevotionEpisodes": args([id]),
  "documents.acceptDevotion": args([id, text(2000)]),
  "documents.askForReviewAgain": args([compound]),
  "documents.setGateOverride": args([id, z.enum(["idea", "review", "greenlight", "guest", "pages"]), short(300).nullable()]),
};

/**
 * Generated wrappers the server deliberately does not run, with the reason. They either only read data
 * (the browser answers those itself from what it was sent), or are steps other actions take internally.
 */
export const NOT_ACTIONS: Record<string, string> = {
  "workflow.canShare": "read only",
  "content.deletionImpact": "read only",
  "content.devotionalsOnRecordingDate": "read only",
  "content.getReminders": "read only",
  "content.getBlockedOnUser": "read only",
  "content.addLink": "screens use addLinks",
  "docs.canViewDoc": "read only",
  "docs.canEditDoc": "read only",
  "docs.listDocs": "read only",
  "docs.docsForRecord": "read only",
  "docs.attachStageDocs": "internal step of advancing a stage",
  "docs.archiveDocsFor": "internal step of deleting a project",
  "equipment.requireGearAccess": "read only",
  "equipment.hasGearAccess": "read only",
  "equipment.projectLabel": "read only",
  "equipment.listManifests": "read only",
  "equipment.addLine": "screens use addLines",
  "equipment.addLinePhoto": "not used by any screen",
  "equipment.releaseReservedFor": "internal step of deleting a project",
  "equipment.copyGearBetweenSheets": "internal step of duplicating a call sheet",
  "equipment.rebookSheetGear": "internal step of moving a call sheet",
  "equipment.releaseSheetGear": "internal step of deleting a call sheet",
  "permissions.can": "read only",
  "permissions.requireCan": "read only",
  "permissions.modulesFor": "read only",
  "permissions.capabilitiesBeyond": "read only",
  "permissions.requireNotBeyond": "read only",
  "storage.standaloneAllocations": "read only",
  "storage.hasStorageAccess": "read only",
  "team.addTeamMember": "not used by any screen",
  "team.setMemberRoles": "not used by any screen",
};
