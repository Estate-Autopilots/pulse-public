// GET /api/v0/onboarding (and /onboarding/:person for HR): the shape migration 0147's onboarding_state() returns.
export type IdDocument = { id: string; status: "on_file" | "verified" | "rejected"; source: "self" | "hr" | "drive"; addedAt: string; checkedAt: string | null;
  masked: string | null; hasFile: boolean; fileName: string | null; mime: string | null; size: number | null; drive: string | null; note: string | null };
export type DocKind = { kind: string; label: string; required: boolean; idNumber: "aadhaar" | "pan" | null; document: IdDocument | null };
export type Proposal = { id: string; field: string; value: string | null; documentKind: string | null; source: "roster" | "hr_sheet" | "drive" | "workspace"; sourceLabel: string; proposedAt: string };
export type OnboardingState = {
  person: { id: string; name: string; firstName: string; role: string | null; pod: string | null; joinedOn: string | null; workPhone: string | null; photo: boolean; skills?: string[] };
  self: boolean; canSeeDetails: boolean; canSeeIds: boolean;
  details: Record<string, string | null> | null; bank: string | null; documents: DocKind[];
  steps: Record<string, { state: "done" | "skipped" | "later"; at: string }>;
  consent: { version?: string | null; at?: string | null; auto?: boolean; withdrawnAt?: string | null; given?: boolean };
  notice: { id: string; version: string; title: string; summary: string | null; readAt: string | null } | null;
  apps: { phone: boolean | null; desktop: boolean | null; chrome: boolean | null } | null;
  missing: string[]; percent: number; completedAt: string | null; proposals: Proposal[]; attendanceEnabled?: boolean;
  /** False while the server has no document keyring: no ID files or bank details can be saved or opened. */
  filesReady?: boolean;
};
/** Shown wherever an ID file or bank detail would be saved or opened while the keyring is missing. */
export const FILES_PAUSED = "Saving files and bank details is paused until the Pulse administrator installs this server’s document encryption key.";
const LABEL: Record<string, string> = { dob: "date of birth", phone: "phone", email: "personal email", address: "address", emergency: "emergency contact", bank: "bank details", photo: "photo",
  legalName: "legal name", preferredName: "preferred name", city: "city", work: "role and team confirmation", skills: "skills and tools" };
/** "date of birth, Aadhaar (masked), bank details" */
export const missingText = (s: Pick<OnboardingState, "missing" | "documents">) =>
  s.missing.map((k) => k.startsWith("doc:") ? s.documents.find((d) => d.kind === k.slice(4))?.label ?? k.slice(4) : LABEL[k] ?? k).join(", ");
