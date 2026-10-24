// GET /api/v0/hr/onboard: everyone in the roster with how far they are (migration 0147 onboarding_roster()).
export type OnboardPerson = {
  id: string; name: string; role: string | null; pod: string | null; joinedOn: string | null;
  invite: { status: "prepared" | "blocked" | "sending" | "sent" | "used" | "failed"; at: string; blocked: string | null } | null;
  canSignIn: boolean; signedInAt: string | null; missing: string[]; percent: number;
  apps: { phone: boolean; desktop: boolean; chrome: boolean } | null;
  firstCheckIn: string | null; lastCheckIn: string | null; outcome: boolean; consent: boolean;
  nudged: { checkin?: string; profile?: string; bank?: string } | null; proposals: number; completedAt: string | null;
  /** PEOPLE-CONTACTS: whether bank details are on file and checked by HR (never what they are), and name or birth-date
   *  changes waiting for HR. */
  bank?: "missing" | "pending" | "confirmed"; changes?: number;
};
export type DocKindSetting = { kind: string; label: string; required: boolean; idNumber: "aadhaar" | "pan" | null; sort: number; active: boolean };
export type CheckinSettings = {
  arrival: "off" | "ask" | "auto"; dwellMinutes: number; leaveMinutes: number; cutoffDay: number | null; onboardingReminders: boolean;
  shift: { start: string; end: string };
  reminders: { enabled: boolean; approvedBy: string | null; startOffset: number; longBreak: number };
  offices: { count: number; withNetworks: number }; attendanceEnabled: boolean; canEdit?: boolean;
};
export type Onboard = { people: OnboardPerson[]; kinds: DocKindSetting[]; settings: CheckinSettings; sendEnabled: boolean; canEdit: boolean;
  /** False while the server has no document keyring: ID files and bank details cannot be saved or opened. */
  filesReady?: boolean };

/** Where a person is in the rollout, in HR's words, and what HR can do next. */
export function stage(p: OnboardPerson): { key: "invite" | "invited" | "profile" | "app" | "checkin" | "ready"; label: string } {
  if (!p.signedInAt) return p.invite && ["sent", "used"].includes(p.invite.status) ? { key: "invited", label: "Invited, not signed in" } : { key: "invite", label: p.canSignIn ? "Not signed in yet" : "Not invited" };
  if (p.percent < 100) return { key: "profile", label: `Profile ${p.percent}%` };
  if (!p.apps?.phone && !p.apps?.desktop && !p.apps?.chrome) return { key: "app", label: "No app yet" };
  if (!p.firstCheckIn && !p.outcome) return { key: "checkin", label: "Never checked in" };
  return { key: "ready", label: "Ready" };
}
