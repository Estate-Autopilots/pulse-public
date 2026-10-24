// EST-1474: the Creative Strategy API's shapes (services/api/src/creative.ts).
export type Person = { id: string; name: string };
export type HomeRow = { kind: "due" | "alert"; sprintId: string; project: string; key: string; title: string; detail: string;
  state: "overdue" | "today" | "upcoming" | "alert"; due: string | null; href: string };
export type Home = { person: Person; rows: HomeRow[]; sprints: number; canChoosePerson: boolean };
export type Sprint = { id: string; projectId: string; project: string; package: string; dayOne: string; approver: string | null;
  gsPersonId: string | null; gs: string | null; csPersonId: string | null; cs: string | null; status: string; editedAt: string };
export type SprintRow = Sprint & { day: number; shift: number; missingInputs: number; overdue: number; next: { label: string; due: string; state: string } | null };
export type Input = { key: string; label: string; ownerPersonId: string | null; owner: string | null; receivedOn: string | null; note: string | null };
export type Milestone = { key: string; label: string; stage: number; where: string; dueDay: number; day: number; due: string; doneOn: string | null;
  state: "done" | "overdue" | "today" | "upcoming"; ownerPersonId: string | null; owner: string | null; note: string | null };
export type SprintView = { sprint: Sprint; inputs: Input[]; milestones: Milestone[]; approvalWorkingDays: number; link: string; canReassign?: boolean;
  clock: { dayOne: string; today: string; day: number; shift: number; lateInputs: number; missingInputs: number } };
export type Config = { packages: { key: string; label: string }[]; canStart: boolean };

/** "Thu 5 Nov" for a calendar date. */
export const dayName = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
export const packageLabel = (config: Config | null, key: string) => config?.packages.find((p) => p.key === key)?.label ?? key;
