import type { Attachment, Database, Drive, DriveAllocation, EquipCategoryKey, EquipCondition, EquipmentHistory, EquipmentItem, Incident, Manifest, ManifestLine, StorageSnapshot } from "../types";
import { isoDay } from "./seed";
import { fmtShort } from "../services/utils";

// Demo gear and storage. Drive names and sizes come from the production team's own list;
// rename anything that does not match reality in the Storage module.

const stamp = (daysAgo: number, hour = 10): string => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

type GearParts = Pick<Database, "equipment" | "manifests" | "incidents" | "equipmentHistory" | "drives" | "allocations" | "snapshots"> & { counters: Record<string, number> };

export function buildGearSeed(): GearParts {
  const equipment: EquipmentItem[] = [];
  const history: EquipmentHistory[] = [];
  let h = 0;
  const hist = (equipmentId: string, daysAgo: number, kind: EquipmentHistory["kind"], detail: string, contentId: string | null = null, manifestId: string | null = null, by = "DOF-P-HOP-001") =>
    history.push({ id: `H-${String(++h).padStart(5, "0")}`, equipmentId, at: stamp(daysAgo), byPersonId: by, kind, detail, contentId, manifestId });

  const serial = (id: string, cat: EquipCategoryKey, name: string, make: string, model: string, sn: string, cost: number, condition: EquipCondition, ageDays: number, extra: Partial<EquipmentItem> = {}) => {
    equipment.push({
      id, trackingType: "serialized", name, make, model, category: cat, itemFamily: null, serialNumber: sn, unitLabel: null, quantityTotal: 1, quantityDamaged: 0, quantityLost: 0,
      unitCost: cost, purchaseDate: isoDay(-ageDays), vendor: "", condition, packaging: "", accessories: "", info: "", photos: [], receipts: [], baseStatus: "active", createdAt: stamp(ageDays), ...extra,
    });
    hist(id, ageDays, "created", "Added to inventory");
  };
  const batch = (id: string, cat: EquipCategoryKey, family: string, name: string, make: string, qty: number, unitCost: number, ageDays: number, vendor: string) => {
    equipment.push({
      id, trackingType: "aggregate", name, make, model: "", category: cat, itemFamily: family, serialNumber: null, unitLabel: null, quantityTotal: qty, quantityDamaged: 0, quantityLost: 0,
      unitCost, purchaseDate: isoDay(-ageDays), vendor, condition: "Good", packaging: "", accessories: "", info: "", photos: [], receipts: [], baseStatus: "active", createdAt: stamp(ageDays),
    });
    hist(id, ageDays, "created", `New batch of ${qty}`);
  };

  serial("DOF-EQ-CAM-001", "camera", "Sony FX3 camera body", "Sony", "FX3", "S-FX3-0412", 3900, "Good", 400, { unitLabel: "A-cam", accessories: "2 batteries, cage, top handle", packaging: "Pelican 1620" });
  serial("DOF-EQ-CAM-002", "camera", "Sony FX3 camera body", "Sony", "FX3", "S-FX3-0433", 3900, "Good", 380, { unitLabel: "B-cam", accessories: "2 batteries, cage" });
  serial("DOF-EQ-CAM-003", "camera", "Sony 24-70mm f/2.8 GM lens", "Sony", "SEL2470GM", "S-2470-7781", 2200, "Fair", 300, { accessories: "Hood, front and rear caps" });
  serial("DOF-EQ-CAM-004", "camera", "Fluid-head tripod", "Manfrotto", "MVK504", "M-504-2210", 420, "Good", 500);
  serial("DOF-EQ-AUD-001", "audio", "Wireless lavalier kit", "Rode", "Wireless PRO", "R-WP-3309", 700, "Good", 200, { accessories: "2 transmitters, receiver, charging case" });
  serial("DOF-EQ-AUD-002", "audio", "Broadcast microphone", "Shure", "SM7B", "SH-SM7B-118", 400, "Good", 450);
  serial("DOF-EQ-AUD-003", "audio", "Field recorder", "Zoom", "H6", "Z-H6-5521", 350, "Good", 350);
  serial("DOF-EQ-AUD-004", "audio", "Analog mixer (old)", "Behringer", "X1622", "B-1622-004", 260, "Poor", 900, { baseStatus: "retired" });
  serial("DOF-EQ-LGT-001", "lighting", "LED key light", "Aputure", "300d II", "AP-300D-882", 1000, "Good", 320, { accessories: "Softbox, stand, reflector" });
  serial("DOF-EQ-LGT-002", "lighting", "LED fill light", "Aputure", "120d II", "AP-120D-731", 640, "Fair", 320, { baseStatus: "in-repair" });
  serial("DOF-EQ-LIV-001", "live", "Live production switcher", "Blackmagic", "ATEM Mini Extreme ISO", "BM-ATEM-2204", 1100, "Good", 260);
  serial("DOF-EQ-CMP-001", "computing", "Editing laptop 16-inch", "Apple", "MacBook Pro", "AP-MBP-C02X", 3000, "Good", 240);
  serial("DOF-EQ-TRN-001", "transport", "Hard case", "Pelican", "1620", "PL-1620-0091", 300, "Good", 400);
  batch("DOF-EQ-CAB-XLR10M-B01", "cabling", "XLR-10M", "XLR cable 10 m", "Generic", 12, 18, 300, "Nairobi Pro Audio");
  batch("DOF-EQ-CAB-XLR10M-B02", "cabling", "XLR-10M", "XLR cable 10 m", "Generic", 8, 20, 60, "Nairobi Pro Audio");
  batch("DOF-EQ-CAB-HDMI3M-B01", "cabling", "HDMI-3M", "HDMI cable 3 m", "Generic", 10, 9, 200, "Online");
  batch("DOF-EQ-PWR-SANDBAG-B01", "power", "SANDBAG", "Sandbag 7 kg", "Generic", 6, 12, 350, "Local");

  // Repair and retirement history for the two items out of service.
  hist("DOF-EQ-LGT-002", 5, "repair-start", "Fan noise. Sent to the vendor for service");
  hist("DOF-EQ-AUD-004", 120, "retired", "Channel 3 faulty. Retired from inventory");

  const line = (equipmentId: string, quantity: number, conditionOut: EquipCondition, extra: Partial<ManifestLine> = {}): ManifestLine => ({
    equipmentId, quantity, conditionOut, photosOut: [] as Attachment[], conditionIn: null, photosIn: [] as Attachment[], returnedGood: 0, damaged: 0, lost: 0, ...extra,
  });

  const incidents: Incident[] = [];
  const manifests: Manifest[] = [
    // Two past shoots that each left a scratch on the same lens.
    {
      id: "DOF-MF-003", contentId: "DOF-DOC-001", callSheetId: null, destination: "outside", status: "returned", date: isoDay(-72), expectedReturn: isoDay(-69),
      responsiblePersonId: "DOF-P-CRW-002", notes: "", createdAt: stamp(73), createdBy: "DOF-P-CRW-002", checkedOutAt: stamp(72), returnedAt: stamp(69),
      lines: [line("DOF-EQ-CAM-003", 1, "New", { conditionIn: "Good", returnedGood: 0, damaged: 1 })],
    },
    {
      id: "DOF-MF-004", contentId: "DOF-DOC-001", callSheetId: null, destination: "outside", status: "returned", date: isoDay(-35), expectedReturn: isoDay(-32),
      responsiblePersonId: "DOF-P-CRW-002", notes: "", createdAt: stamp(36), createdBy: "DOF-P-CRW-002", checkedOutAt: stamp(35), returnedAt: stamp(32),
      lines: [line("DOF-EQ-CAM-003", 1, "Good", { conditionIn: "Fair", returnedGood: 0, damaged: 1 })],
    },
    // Out now and late.
    {
      id: "DOF-MF-002", contentId: "DOF-DOC-001", callSheetId: null, destination: "outside", status: "checked-out", date: isoDay(-8), expectedReturn: isoDay(-2),
      responsiblePersonId: "DOF-P-CRW-002", notes: "Samburu field trip", createdAt: stamp(9), createdBy: "DOF-P-CRW-002", checkedOutAt: stamp(8), returnedAt: null,
      lines: [line("DOF-EQ-CAM-002", 1, "Good"), line("DOF-EQ-CAM-004", 1, "Good"), line("DOF-EQ-AUD-003", 1, "Good")],
    },
    // Reserved in the studio for the upcoming Season 1 recording day.
    {
      id: "DOF-MF-001", contentId: "DOF-SER-001", callSheetId: "DOF-CS-001", destination: "studio", status: "assigned", date: isoDay(2), expectedReturn: null,
      responsiblePersonId: "DOF-P-CRW-002", notes: "", createdAt: stamp(1), createdBy: "DOF-P-CRW-002", checkedOutAt: null, returnedAt: null,
      lines: [line("DOF-EQ-CAM-001", 1, "Good"), line("DOF-EQ-CAM-003", 1, "Fair"), line("DOF-EQ-AUD-001", 1, "Good"), line("DOF-EQ-CAB-XLR10M-B01", 4, "Good")],
    },
  ];

  const inc = (n: number, equipmentId: string, daysAgo: number, description: string, contentId: string, manifestId: string) => {
    incidents.push({ id: `DOF-INC-${String(n).padStart(3, "0")}`, equipmentId, at: stamp(daysAgo), type: "damage", quantity: 1, description, personId: "DOF-P-CRW-002", contentId, manifestId });
    hist(equipmentId, daysAgo, "incident", `Damaged: ${description}`, contentId, manifestId, "DOF-P-CRW-002");
  };
  hist("DOF-EQ-CAM-003", 73, "assigned", "DOF-DOC-001", "DOF-DOC-001", "DOF-MF-003", "DOF-P-CRW-002");
  hist("DOF-EQ-CAM-003", 72, "checked-out", `DOF-DOC-001, back by ${fmtShort(isoDay(-69))}`, "DOF-DOC-001", "DOF-MF-003", "DOF-P-CRW-002");
  inc(1, "DOF-EQ-CAM-003", 69, "Light scratch on the front element from dust at the shoot.", "DOF-DOC-001", "DOF-MF-003");
  hist("DOF-EQ-CAM-003", 69, "checked-in", "DOF-DOC-001, back in Good condition", "DOF-DOC-001", "DOF-MF-003", "DOF-P-CRW-002");
  hist("DOF-EQ-CAM-003", 36, "assigned", "DOF-DOC-001", "DOF-DOC-001", "DOF-MF-004", "DOF-P-CRW-002");
  hist("DOF-EQ-CAM-003", 35, "checked-out", `DOF-DOC-001, back by ${fmtShort(isoDay(-32))}`, "DOF-DOC-001", "DOF-MF-004", "DOF-P-CRW-002");
  inc(2, "DOF-EQ-CAM-003", 32, "Second scratch near the edge of the front element.", "DOF-DOC-001", "DOF-MF-004");
  hist("DOF-EQ-CAM-003", 32, "checked-in", "DOF-DOC-001, back in Fair condition", "DOF-DOC-001", "DOF-MF-004", "DOF-P-CRW-002");
  for (const id of ["DOF-EQ-CAM-002", "DOF-EQ-CAM-004", "DOF-EQ-AUD-003"]) hist(id, 8, "checked-out", `DOF-DOC-001, back by ${fmtShort(isoDay(-2))}`, "DOF-DOC-001", "DOF-MF-002", "DOF-P-CRW-002");
  for (const id of ["DOF-EQ-CAM-001", "DOF-EQ-CAM-003", "DOF-EQ-AUD-001", "DOF-EQ-CAB-XLR10M-B01"]) hist(id, 1, "assigned", `${id.includes("XLR") ? "4 units, " : ""}DOF-SER-001, ${fmtShort(isoDay(2))}`, "DOF-SER-001", "DOF-MF-001", "DOF-P-CRW-002");

  // Storage. Sizes are in GB.
  const drives: Drive[] = [
    { id: "DRV-001", name: "Added", capacityGB: 4000, otherUsedGB: 120, notes: "" },
    { id: "DRV-002", name: "Taji", capacityGB: 4000, otherUsedGB: 0, notes: "" },
    { id: "DRV-003", name: "T9", capacityGB: 4000, otherUsedGB: 0, notes: "" },
    { id: "DRV-004", name: "Transcend 1", capacityGB: 4000, otherUsedGB: 0, notes: "" },
    { id: "DRV-005", name: "Transcend 2", capacityGB: 4000, otherUsedGB: 0, notes: "" },
    { id: "DRV-006", name: "Extreme Pro", capacityGB: 4000, otherUsedGB: 0, notes: "" },
    { id: "DRV-007", name: "Symphony", capacityGB: 4000, otherUsedGB: 200, notes: "" },
    { id: "DRV-008", name: "Any", capacityGB: 2000, otherUsedGB: 0, notes: "" },
    { id: "DRV-009", name: "Extreme Pro 1TB", capacityGB: 1000, otherUsedGB: 0, notes: "" },
  ];
  let a = 0;
  const alloc = (driveId: string, contentId: string, sizeGB: number, kind: DriveAllocation["kind"], note = ""): DriveAllocation => ({ id: `ALC-${String(++a).padStart(4, "0")}`, driveId, contentId, sizeGB, kind, note, updatedAt: isoDay(-3) });
  const allocations: DriveAllocation[] = [
    alloc("DRV-001", "DOF-DOC-001", 1450, "raw", "Samburu field footage"),
    alloc("DRV-001", "DOF-SER-001", 900, "raw"),
    alloc("DRV-002", "DOF-SER-001-S1-E01", 780, "project"),
    alloc("DRV-002", "DOF-SER-001", 300, "delivered"),
    alloc("DRV-003", "DOF-LIVE-001", 1200, "raw", "Sunday service recordings"),
    alloc("DRV-004", "DOF-MUS-001", 640, "project"),
    alloc("DRV-005", "DOF-DEV-001", 210, "raw"),
    alloc("DRV-006", "DOF-DOC-001", 2600, "project", "Proxies and edit project"),
    alloc("DRV-006", "DOF-LIVE-001", 1000, "raw"),
    alloc("DRV-008", "DOF-DEV-001", 90, "delivered"),
    alloc("DRV-009", "DOF-MUS-001", 320, "raw"),
  ];

  const capacity = drives.reduce((n, d) => n + d.capacityGB, 0);
  const used = drives.reduce((n, d) => n + d.otherUsedGB, 0) + allocations.reduce((n, x) => n + x.sizeGB, 0);
  const snapshots: StorageSnapshot[] = [];
  for (let w = 10; w >= 0; w--) snapshots.push({ date: isoDay(-7 * w), usedGB: Math.round(used * (0.55 + 0.045 * (10 - w))), capacityGB: capacity });

  return {
    equipment, manifests, incidents, equipmentHistory: history, drives, allocations, snapshots,
    counters: { manifest: 4, incident: incidents.length, history: h, attachment: 0, drive: drives.length, allocation: a },
  };
}
