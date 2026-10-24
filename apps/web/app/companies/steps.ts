// UX-TENANT: the setup wizard's steps (shared by the server page and the client wizard). R53 adds the source registry
// and the handover with activation for staff.
export const STEPS = [
  { key: "company", label: "Company and address" }, { key: "brand", label: "Logo and colours" }, { key: "admin", label: "First admin" },
  { key: "people", label: "People" }, { key: "structure", label: "Pods, teams and roles" }, { key: "settings", label: "Modules and rules" },
  { key: "sources", label: "Sources" }, { key: "open", label: "Check and open" }, { key: "activate", label: "Hand over and activate" },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];
/** R53: the data categories a source may bring; the last three need the company admin's specific approval. */
export const CATEGORIES = ["people", "structure", "projects", "clients", "tasks", "documents", "finance", "attendance_history", "payroll", "chat_history"] as const;
export const SENSITIVE = ["attendance_history", "payroll", "chat_history"] as const;
export const SOURCE_KINDS = [
  { key: "csv", label: "A file (CSV)" }, { key: "google_drive", label: "Google Drive (EA Connect)" }, { key: "plugin", label: "The company's own plugin" },
  { key: "directory", label: "A directory" }, { key: "manual", label: "Typed in by hand" },
] as const;
