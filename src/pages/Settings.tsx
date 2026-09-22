export const isoDay = (offset = 0): string => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

const person = (personId: string, category: RoleCode, name: string, skills: string[], hasLogin: boolean): Person => ({
  personId,
  category,
  name,
  email: `${name.split(" ")[0].toLowerCase()}@dof.demo`,
  phone: "+254 700 000 000",
  skills,
  equipmentFamiliarity: [],
  hasLogin,
  status: "active",
  createdAt: isoDay(-90),
  notifyEmail: category === "CRW" || category === "HOP",
  notifySms: personId === "DOF-P-CRW-001",
  appearance: { fontSize: "default", density: "comfortable", photoUrl: null },
});

export function buildSeed(): Database {
  const people: Person[] = [
    person("DOF-P-HOP-001", "HOP", "Head of Production", ["Producing", "Directing"], true),
    person("DOF-P-CRW-001", "CRW", "Wanjiru Kamau", ["Directing", "Editing"], true),
    person("DOF-P-CRW-002", "CRW", "Brian Otieno", ["Camera", "Lighting"], true),
    person("DOF-P-CRW-003", "CRW", "Faith Mwangi", ["Audio", "Live switching"], true),
    person("DOF-P-VOL-001", "VOL", "Joseph Kiptoo", ["Floor crew"], true),
    person("DOF-P-VOL-002", "VOL", "Grace Achieng", ["Logging", "Runner"], false),
    person("DOF-P-PTR-001", "PTR", "Partner Representative", [], true),
  ];

  return {
    schemaVersion: 8,
    people,
    users,
    members: [],
    records: [],
    callSheets: [],
    comments: [],
    audit: [],
    equipment: [],
    manifests: [],
    incidents: [],
    equipmentHistory: [],
    drives: [],
    allocations: [],
    snapshots: [],
    docs: [],
    docRevisions: [],
    outbox: [],
    settings: {
      stageReminderHours: 24,
      storageWarningThreshold: 85,
      checkoutReturnDays: 3,
      workDays: [1, 2, 3, 4, 5],
      effortOverrides: {},
      workspaceAppearance: { accentColor: "terracotta", fontPairing: "modern" },
    },
    counters: { ...gear.counters },
  };
}
