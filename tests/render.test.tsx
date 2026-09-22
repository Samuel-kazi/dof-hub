// Render smoke test: every page, for every role, must render without throwing.
import React from "react";
// Run with: npx tsx tests/render.test.tsx
import { renderToString } from "react-dom/server";
import { AppProvider } from "../src/ui/AppContext";
import { Shell } from "../src/ui/Shell";
import { Dashboard } from "../src/pages/Dashboard";
import { Pipeline } from "../src/pages/Pipeline";
import { RecordPage } from "../src/pages/RecordPage";
import { CallSheets, CallSheetPage } from "../src/pages/CallSheets";
import { CalendarPage } from "../src/pages/Calendar";
import { Crew, PersonPage } from "../src/pages/Crew";
import { Settings } from "../src/pages/Settings";
import { Soon } from "../src/pages/Soon";
import { Login } from "../src/pages/Login";
import { Equipment } from "../src/pages/Equipment";
import { EquipmentItemPage } from "../src/pages/EquipmentItem";
import { ManifestPage } from "../src/pages/Manifest";
import { Storage, DrivePage } from "../src/pages/Storage";
import { GearPicker } from "../src/ui/GearPicker";
import { ReportDialog } from "../src/ui/ReportDialog";
import { Access } from "../src/pages/Access";
import { Reminders } from "../src/pages/Reminders";
import { Documents, DocPage, NewDocModal } from "../src/pages/Documents";
import { AllocationModal } from "../src/pages/Storage";
import { getItem } from "../src/services/equipment";
import { ItemFormModal, NewCheckoutModal } from "../src/pages/EquipmentForms";
import { login } from "../src/services/auth";
import { resetDemoData } from "../src/data/store";

resetDemoData();
const PersonWorkloadHost = () => <PersonPage id="DOF-P-CRW-002" />;
const roles = { hop: "hop@dof.demo", crew: "crew2@dof.demo", vol: "volunteer1@dof.demo", ptr: "partner1@dof.demo" };
let n = 0;
const render = (label: string, actorEmail: string, el: JSX.Element) => {
  const actor = login(actorEmail, "demo");
  try {
    const html = renderToString(<AppProvider actor={actor} onLogout={() => {}}>{el}</AppProvider>);
    if (!html.length) throw new Error("empty render");
    n++;
  } catch (e) {
    console.error("FAIL", label, (e as Error).message);
    process.exitCode = 1;
  }
};

renderToString(<Login onLogin={() => {}} />); n++;
for (const [role, email] of Object.entries(roles)) {
  render(`${role} shell`, email, <Shell />);
  render(`${role} dashboard`, email, <Dashboard />);
  render(`${role} pipeline all`, email, <Pipeline />);
  for (const c of ["series", "devotional", "live", "documentary", "music"] as const) render(`${role} pipeline ${c}`, email, <Pipeline category={c} />);
  for (const id of ["DOF-SER-001", "DOF-SER-001-S1", "DOF-SER-001-S1-E01", "DOF-SER-001-S1-E02", "DOF-LIVE-001", "DOF-LIVE-001-D1", "DOF-LIVE-002", "DOF-LIVE-002-D1", "DOF-DOC-001", "DOF-DEV-001", "DOF-MUS-001-A1-T01", "DOF-MUS-001-A1-T02"]) render(`${role} record ${id}`, email, <RecordPage id={id} />);
  render(`${role} callsheets`, email, <CallSheets />);
  render(`${role} callsheet`, email, <CallSheetPage id="DOF-CS-001" />);
  render(`${role} callsheet run of show`, email, <CallSheetPage id="DOF-CS-002" />);
  render(`${role} documents`, email, <Documents />);
  for (const id of ["DOF-DCS-001", "DOF-DCS-002", "DOF-DCS-004"]) render(`${role} doc ${id}`, email, <DocPage id={id} />);
  render(`${role} crew`, email, <Crew />);
  render(`${role} workload`, email, <Crew tab="workload" />);
  render(`${role} person workload`, email, <PersonWorkloadHost />);
  render(`${role} person`, email, <PersonPage id="DOF-P-VOL-001" />);
  render(`${role} settings`, email, <Settings />);
  render(`${role} soon`, email, <Soon module="documents" />);
  for (const tab of ["inventory", "checkouts", "incidents"] as const) render(`${role} equipment ${tab}`, email, <Equipment tab={tab} />);
  for (const id of ["DOF-EQ-CAM-001", "DOF-EQ-CAM-003", "DOF-EQ-CAB-XLR10M-B01", "DOF-EQ-LGT-002", "DOF-EQ-AUD-004"]) render(`${role} item ${id}`, email, <EquipmentItemPage id={id} />);
  for (const id of ["DOF-MF-001", "DOF-MF-002", "DOF-MF-003"]) render(`${role} manifest ${id}`, email, <ManifestPage id={id} />);
  render(`${role} storage`, email, <Storage />);
  for (const [scope, params] of [["storage", {}], ["drive", { driveId: "DRV-001" }], ["equipment", {}], ["manifest", { manifestId: "DOF-MF-001" }], ["project", { contentId: "DOF-SER-001" }], ["pipeline", {}], ["workload", {}], ["document", { docId: "DOF-DCS-001" }], ["audit", {}]] as const) render(`${role} report dialog ${scope}`, email, <ReportDialog scope={scope} params={params} onClose={() => {}} />);
  render(`${role} access`, email, <Access />);
  render(`${role} reminders`, email, <Reminders />);
  render(`${role} calendar`, email, <CalendarPage />);
  for (const id of ["DRV-001", "DRV-006", "DRV-008"]) render(`${role} drive ${id}`, email, <DrivePage id={id} />);
  if (role === "hop" || role === "crew") {
    render(`${role} picker`, email, <GearPicker from="2099-01-01" to="2099-01-02" onConfirm={() => {}} onClose={() => {}} />);
    render(`${role} add item form`, email, <ItemFormModal onClose={() => {}} onSaved={() => {}} />);
    render(`${role} edit item form`, email, <ItemFormModal item={getItem("DOF-EQ-CAM-001")} onClose={() => {}} onSaved={() => {}} />);
    render(`${role} new checkout`, email, <NewCheckoutModal onClose={() => {}} onCreated={() => {}} />);
    render(`${role} assign drive`, email, <AllocationModal contentId="DOF-SER-001-S1-E02" onClose={() => {}} />);
    render(`${role} new doc`, email, <NewDocModal contentId="DOF-SER-001-S1-E02" onClose={() => {}} onCreated={() => {}} />);
  }
}
console.log(`${n} renders ok`);
